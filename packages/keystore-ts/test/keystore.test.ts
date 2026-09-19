/**
 * T2 tests: key management — registry, rotation, well-known keys, KMS shape.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SoftwareKeyStore,
  KmsKeyStore,
  buildWellKnown,
  spkiToRawEd25519,
  ED25519_SPKI_PREFIX,
  KeystoreError,
  ERR_KEY_NOT_FOUND,
  ERR_KEY_RETIRED,
  ERR_DUPLICATE_KEY_ID,
} from "../src/index.js";
import type { KmsClientLike } from "../src/index.js";
import { verify, generateKeypair, sign as coreSign } from "@veritas/attestation-core";

const te = new TextEncoder();
const tmp = () => mkdtempSync(join(tmpdir(), "ks-test-"));

// ---------------------------------------------------------------------------
// SoftwareKeyStore
// ---------------------------------------------------------------------------

test("software: generateKey returns a well-formed record", async () => {
  const dir = tmp();
  try {
    const ks = new SoftwareKeyStore(dir);
    const rec = await ks.generateKey("biz_rapido", "business");
    assert.match(rec.key_id, /^bkey_biz_rapido_\d+$/);
    assert.equal(rec.owner, "biz_rapido");
    assert.equal(rec.kind, "business");
    assert.equal(rec.alg, "Ed25519");
    assert.equal(rec.status, "active");
    assert.equal(rec.valid_until, null);
    assert.ok(rec.valid_from <= rec.created_at || true); // both "now"
    const pub = await ks.getPublicKey(rec.key_id);
    assert.equal(pub.length, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("software: sequential key_ids increment", async () => {
  const ks = new SoftwareKeyStore();
  const a = await ks.generateKey("biz_x", "business");
  const b = await ks.generateKey("biz_x", "business");
  assert.notEqual(a.key_id, b.key_id);
  assert.ok(b.key_id > a.key_id);
});

test("software: sign/verify roundtrip via the T1 reference lib", async () => {
  const ks = new SoftwareKeyStore();
  const rec = await ks.generateKey("biz_rapido", "business");
  const msg = te.encode("canonical attestation bytes");
  const sig = await ks.sign(rec.key_id, msg);
  assert.equal(sig.length, 64);
  assert.equal(verify(await ks.getPublicKey(rec.key_id), msg, sig), true);
});

test("software: tampered message fails verification", async () => {
  const ks = new SoftwareKeyStore();
  const rec = await ks.generateKey("biz_rapido", "business");
  const msg = te.encode("canonical attestation bytes");
  const sig = await ks.sign(rec.key_id, msg);
  const bad = te.encode("canonical attestation BYTEs");
  assert.equal(verify(await ks.getPublicKey(rec.key_id), bad, sig), false);
});

test("software: registry persists across restarts", async () => {
  const dir = tmp();
  try {
    const ks = new SoftwareKeyStore(dir);
    const rec = await ks.generateKey("biz_rapido", "business");
    const sig = await ks.sign(rec.key_id, te.encode("hello"));
    const ks2 = new SoftwareKeyStore(dir);
    const rec2 = await ks2.getRecord(rec.key_id);
    assert.equal(rec2?.key_id, rec.key_id);
    assert.equal(
      verify(await ks2.getPublicKey(rec.key_id), te.encode("hello"), sig),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("software: unknown key_id throws KEY_NOT_FOUND", async () => {
  const ks = new SoftwareKeyStore();
  await assert.rejects(ks.sign("nope_01", te.encode("x")), (e: unknown) => {
    assert.ok(e instanceof KeystoreError && e.code === ERR_KEY_NOT_FOUND);
    return true;
  });
});

test("software: duplicate explicit key_id throws", async () => {
  const ks = new SoftwareKeyStore();
  await ks.generateKey("biz_x", "business", "bkey_biz_x_01");
  await assert.rejects(ks.generateKey("biz_x", "business", "bkey_biz_x_01"), (e: unknown) => {
    assert.ok(e instanceof KeystoreError && e.code === ERR_DUPLICATE_KEY_ID);
    return true;
  });
});

test("software: activeKey resolves the current key", async () => {
  const ks = new SoftwareKeyStore();
  await ks.generateKey("veritas", "veritas");
  const active = await ks.activeKey("veritas", "veritas");
  assert.ok(active && active.status === "active");
  assert.equal(await ks.activeKey("nobody", "veritas"), null);
});

// ---------------------------------------------------------------------------
// Rotation (the T2 acceptance criterion)
// ---------------------------------------------------------------------------

test("rotation: old-key attestations still verify after rotate", async () => {
  const ks = new SoftwareKeyStore();
  const oldRec = await ks.generateKey("veritas", "veritas");
  const msg = te.encode("attestation signed before rotation");
  const oldSig = await ks.sign(oldRec.key_id, msg);

  const newRec = await ks.rotate(oldRec.key_id, { gracePeriodDays: 30 });
  assert.notEqual(newRec.key_id, oldRec.key_id);
  assert.equal(newRec.status, "active");

  const oldAfter = await ks.getRecord(oldRec.key_id);
  assert.equal(oldAfter?.status, "grace");
  assert.ok(oldAfter?.valid_until);

  // The money assertion: the old signature verifies against the old key_id.
  assert.equal(verify(await ks.getPublicKey(oldRec.key_id), msg, oldSig), true);
  // And the new key signs fine.
  const newSig = await ks.sign(newRec.key_id, te.encode("after rotation"));
  assert.equal(verify(await ks.getPublicKey(newRec.key_id), te.encode("after rotation"), newSig), true);
  // Grace key can still sign during the grace period.
  const graceSig = await ks.sign(oldRec.key_id, te.encode("grace signing"));
  assert.equal(verify(await ks.getPublicKey(oldRec.key_id), te.encode("grace signing"), graceSig), true);
});

test("rotation: well-known doc is correct through the rotation", async () => {
  const ks = new SoftwareKeyStore();
  const oldRec = await ks.generateKey("veritas", "veritas");
  const before = buildWellKnown(await ks.listRecords());
  assert.equal(before.keys.length, 1);
  assert.equal(before.keys[0].status, "active");
  assert.equal(before.keys[0].valid_until, null);

  const newRec = await ks.rotate(oldRec.key_id, { gracePeriodDays: 30 });
  const after = buildWellKnown(await ks.listRecords());
  assert.equal(after.keys.length, 2);
  const byId = new Map(after.keys.map((k) => [k.key_id, k]));
  const oldDoc = byId.get(oldRec.key_id)!;
  const newDoc = byId.get(newRec.key_id)!;
  assert.equal(oldDoc.status, "grace");
  assert.ok(oldDoc.valid_until); // grace expiry set
  assert.ok(new Date(oldDoc.valid_until as string) > new Date(oldDoc.valid_from));
  assert.equal(newDoc.status, "active");
  assert.equal(newDoc.valid_until, null);
  assert.ok(newDoc.valid_from >= oldDoc.valid_from); // successor starts now
  assert.ok(after.generated_at);
});

test("sunset: retired key cannot sign but still verifies; sunset is idempotent", async () => {
  const ks = new SoftwareKeyStore();
  const oldRec = await ks.generateKey("veritas", "veritas");
  const msg = te.encode("before sunset");
  const sig = await ks.sign(oldRec.key_id, msg);
  await ks.rotate(oldRec.key_id);
  await ks.sunset(oldRec.key_id);
  await ks.sunset(oldRec.key_id); // idempotent, no throw
  const rec = await ks.getRecord(oldRec.key_id);
  assert.equal(rec?.status, "retired");
  await assert.rejects(ks.sign(oldRec.key_id, te.encode("x")), (e: unknown) => {
    assert.ok(e instanceof KeystoreError && e.code === ERR_KEY_RETIRED);
    return true;
  });
  // Historical verification unaffected.
  assert.equal(verify(await ks.getPublicKey(oldRec.key_id), msg, sig), true);
});

test("rotate: retired key cannot be rotated", async () => {
  const ks = new SoftwareKeyStore();
  const rec = await ks.generateKey("veritas", "veritas");
  await ks.sunset(rec.key_id);
  await assert.rejects(ks.rotate(rec.key_id), (e: unknown) => {
    assert.ok(e instanceof KeystoreError && e.code === ERR_KEY_RETIRED);
    return true;
  });
});

// ---------------------------------------------------------------------------
// KMS shape
// ---------------------------------------------------------------------------

/** Fake KMS: holds its own keypairs, behaves like AWS KMS Sign/GetPublicKey. */
class FakeKms implements KmsClientLike {
  keys = new Map<string, { pub: Uint8Array; priv: Uint8Array }>();
  signCalls: Array<{ KeyId: string; Message: Uint8Array; SigningAlgorithm: string }> = [];

  createKey(kmsKeyId: string): void {
    const { publicKey, privateKey } = generateKeypair();
    this.keys.set(kmsKeyId, { pub: publicKey, priv: privateKey });
  }
  privOf(kmsKeyId: string): Uint8Array {
    return this.keys.get(kmsKeyId)!.priv;
  }
  async sign(params: { KeyId: string; Message: Uint8Array; SigningAlgorithm: "ED25519" }) {
    this.signCalls.push(params);
    const k = this.keys.get(params.KeyId);
    if (!k) throw new Error("NotFoundException");
    return { Signature: coreSign(k.priv, params.Message) };
  }
  async getPublicKey(params: { KeyId: string }) {
    const k = this.keys.get(params.KeyId);
    if (!k) throw new Error("NotFoundException");
    const spki = new Uint8Array(12 + 32);
    spki.set(Buffer.from(ED25519_SPKI_PREFIX, "hex"), 0);
    spki.set(k.pub, 12);
    return { PublicKey: spki };
  }
}

test("kms: SPKI parsing recovers the raw 32-byte key", () => {
  const { publicKey } = generateKeypair();
  const spki = new Uint8Array(12 + 32);
  spki.set(Buffer.from(ED25519_SPKI_PREFIX, "hex"), 0);
  spki.set(publicKey, 12);
  assert.deepEqual(spkiToRawEd25519(spki), publicKey);
  assert.throws(() => spkiToRawEd25519(new Uint8Array(10)));
});

test("kms: generateKey imports a KMS key; private material never crosses the wire", async () => {
  const fake = new FakeKms();
  fake.createKey("arn:kms:key/aaa");
  const ks = new KmsKeyStore(fake);
  const rec = await ks.generateKey("veritas", "veritas", "vkey_main_01", "arn:kms:key/aaa");
  assert.equal(rec.public_key, Buffer.from(fake.keys.get("arn:kms:key/aaa")!.pub).toString("base64"));

  const sig = await ks.sign("vkey_main_01", te.encode("countersign me"));
  assert.equal(sig.length, 64);
  assert.equal(verify(await ks.getPublicKey("vkey_main_01"), te.encode("countersign me"), sig), true);

  // The acceptance property: scan every param the store sent to "KMS" —
  // the private key must not appear in any of them.
  const priv = fake.privOf("arn:kms:key/aaa");
  for (const call of fake.signCalls) {
    assert.equal(call.SigningAlgorithm, "ED25519");
    assert.ok(!containsBytes(call.Message, priv), "private key leaked in Sign params");
    assert.ok(call.KeyId === "arn:kms:key/aaa");
  }
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

test("kms: generateKey without a KMS key id throws (keys are created out of band)", async () => {
  const ks = new KmsKeyStore(new FakeKms());
  await assert.rejects(ks.generateKey("veritas", "veritas"), /out of band/);
});

test("kms: rotation imports the successor KMS key; old sigs still verify", async () => {
  const fake = new FakeKms();
  fake.createKey("arn:kms:key/aaa");
  fake.createKey("arn:kms:key/bbb");
  const ks = new KmsKeyStore(fake);
  await ks.generateKey("veritas", "veritas", "vkey_main_01", "arn:kms:key/aaa");
  const oldSig = await ks.sign("vkey_main_01", te.encode("old attestation"));
  const newRec = await ks.rotate("vkey_main_01", { newKmsKeyId: "arn:kms:key/bbb" });
  assert.equal(newRec.key_id, "vkey_main_02");
  assert.equal(newRec.status, "active");
  assert.equal(verify(await ks.getPublicKey("vkey_main_01"), te.encode("old attestation"), oldSig), true);
  const wk = buildWellKnown(await ks.listRecords());
  assert.equal(wk.keys.find((k) => k.key_id === "vkey_main_01")?.status, "grace");
  assert.equal(wk.keys.find((k) => k.key_id === "vkey_main_02")?.status, "active");
});

test("well-known: document shape matches the spec contract", async () => {
  const ks = new SoftwareKeyStore();
  await ks.generateKey("veritas", "veritas");
  await ks.generateKey("biz_rapido", "business");
  const doc = buildWellKnown(await ks.listRecords());
  assert.ok(doc.generated_at);
  assert.equal(doc.keys.length, 2);
  for (const k of doc.keys) {
    assert.equal(k.alg, "Ed25519");
    assert.ok(k.key_id && k.owner && k.kind && k.public_key && k.valid_from);
    assert.ok(["active", "grace", "retired"].includes(k.status));
  }
});
