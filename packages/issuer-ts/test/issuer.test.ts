/**
 * T3 tests: attestation issuance core.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SoftwareKeyStore } from "@veritas/keystore";
import { MerkleLog, verifyInclusionProof } from "@veritas/merkle-log";
import {
  canonicalize,
  canonicalizeBytes,
  verify,
} from "@veritas/attestation-core";

import { issueAttestation, type IssuerOptions } from "../src/issuer.js";
import { IssueError, type IssueRequest } from "../src/types.js";

const te = new TextEncoder();
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

const FIXED_NOW = new Date("2026-09-19T12:00:05Z");

interface Harness {
  opts: IssuerOptions;
  keystore: SoftwareKeyStore;
  log: MerkleLog;
  bizKeyId: string;
  veritasKeyId: string;
}

async function makeHarness(clockNow: Date = FIXED_NOW, dir?: string): Promise<Harness> {
  const keystore = new SoftwareKeyStore(dir);
  const veritasRec = await keystore.generateKey("veritas", "veritas");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const opts: IssuerOptions = {
    keystore,
    log,
    clock: () => new Date(clockNow),
  };
  if (dir) opts.authJournalPath = join(dir, "auth.jsonl");
  return { opts, keystore, log, bizKeyId: bizRec.key_id, veritasKeyId: veritasRec.key_id };
}

function validRequest(h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: {
      business_id: "biz_rapido",
      legal_name: "Rapido Plumbing LLC",
      dba: "Rapido Plumbing",
      phone: "+1-954-555-0142",
    },
    claims: [
      {
        type: "price",
        item: "service_call_diagnostic",
        amount: 8900,
        currency: "USD",
        unit: "per_visit",
        disclosed: true,
      },
      {
        type: "license",
        authority: "FL DBPR",
        license_number: "CFC1423456",
        status: "active",
        checked_at: "2026-09-19T12:00:00Z",
      },
    ],
    verification_method: "field_visit",
    verifier_id: "ver_007",
    evidence_refs: ["photo:storefront_hours_sign", "gps:26.1224,-80.1373"],
    authorization: {
      auth_id: "auth_9f31ab",
      session_id: "sess_71c0d2",
      sms_confirmation_ref: "sms_55e019",
      authorized_at: "2026-09-19T11:59:58Z",
      authorized_by: "owner-on-file",
    },
    business_key_id: h.bizKeyId,
    ...overrides,
  };
}

async function issueErrorOf(p: Promise<unknown>): Promise<IssueError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof IssueError);
    return e;
  }
  assert.fail("expected IssueError");
}

// ---------------------------------------------------------------------------

test("happy path: attestation shape, server time, signatures, log", async () => {
  const h = await makeHarness();
  const a = await issueAttestation(validRequest(h), h.opts);

  assert.match(a.attestation_id, /^vat_[A-Z0-9]{26}$/);
  assert.equal(a.protocol_version, "1.1");
  assert.equal(a.status, "ACTIVE");
  // verified_at is the SERVER clock, exactly.
  assert.equal(a.verified_at, "2026-09-19T12:00:05Z");
  // valid_until = min claim interval: price/license -> 30 days.
  assert.equal(a.valid_until, "2026-10-19T12:00:05Z");
  assert.ok(!("device_time" in a));

  // Both signatures verify with T1 against the keys resolved by key_id.
  // They were computed over the canonical bytes WITHOUT signatures/log.
  const { signatures, log: _omitLog } = a as unknown as {
    signatures: Record<string, { alg: string; key_id: string; sig: string }>;
    log: unknown;
  };
  const { signatures: _omitSigs, log: _omitLog2, ...unsigned } = a as unknown as Record<
    string,
    unknown
  >;
  const msg = te.encode(canonicalize(unsigned));
  assert.equal(signatures.business.key_id, h.bizKeyId);
  assert.equal(signatures.veritas.key_id, h.veritasKeyId);
  assert.equal(
    verify(await h.keystore.getPublicKey(h.bizKeyId), msg, b64d(signatures.business.sig)),
    true,
  );
  assert.equal(
    verify(await h.keystore.getPublicKey(h.veritasKeyId), msg, b64d(signatures.veritas.sig)),
    true,
  );

  // Log leaf commits to the signed attestation (minus the log block).
  assert.equal(a.log.tree, "veritas-main");
  assert.equal(a.log.leaf_index, 0);
  assert.equal(a.log.root, h.log.getRoot());
  const proof = h.log.getProof(0);
  assert.equal(verifyInclusionProof(proof), true);
  assert.equal(proof.root, a.log.root);
  const { log: _omitLog3, ...signedNoLog } = a as unknown as Record<string, unknown>;
  assert.deepEqual(
    Buffer.from(proof.leaf, "hex").toString(),
    Buffer.from(canonicalizeBytes(signedNoLog)).toString(),
  );
});

test("AC: skewed client clock cannot move verified_at", async () => {
  const h = await makeHarness();
  const past = await issueAttestation(
    validRequest(h, { device_time: "2026-09-17T12:00:05Z" }),
    h.opts,
  );
  assert.equal(past.verified_at, "2026-09-19T12:00:05Z");
  assert.equal(past.device_time, "2026-09-17T12:00:05Z"); // preserved as metadata

  const future = await issueAttestation(
    validRequest(h, { device_time: "2026-09-25T00:00:00Z" }),
    h.opts,
  );
  assert.equal(future.verified_at, "2026-09-19T12:00:05Z");
});

test("AC: missing authorization record -> 422", async () => {
  const h = await makeHarness();
  const req = validRequest(h);
  delete req.authorization;
  const err = await issueErrorOf(issueAttestation(req, h.opts));
  assert.equal(err.status, 422);
  assert.equal(err.code, "authorization_required");
});

test("malformed authorization record -> 422 with field errors", async () => {
  const h = await makeHarness();
  const req = validRequest(h, {
    authorization: { auth_id: "x", session_id: "y" }, // missing sms ref etc.
  });
  const err = await issueErrorOf(issueAttestation(req, h.opts));
  assert.equal(err.status, 422);
  assert.equal(err.code, "authorization_invalid");
  assert.ok(err.fields && err.fields.length > 0);
  assert.ok(err.fields.some((f) => f.path === "/authorization/sms_confirmation_ref"));
});

test("future authorized_at -> 422", async () => {
  const h = await makeHarness();
  const req = validRequest(h, {
    authorization: {
      auth_id: "a",
      session_id: "s",
      sms_confirmation_ref: "sms_1",
      authorized_at: "2026-09-19T13:00:00Z", // 1h after server now
      authorized_by: "owner-on-file",
    },
  });
  const err = await issueErrorOf(issueAttestation(req, h.opts));
  assert.equal(err.status, 422);
});

test("AC: invalid schema rejected with field-level errors", async () => {
  const h = await makeHarness();
  const req = validRequest(h, {
    claims: [{ type: "price", item: "x", currency: "USD", disclosed: true }], // amount missing
  });
  const err = await issueErrorOf(issueAttestation(req, h.opts));
  assert.equal(err.status, 400);
  assert.equal(err.code, "schema_validation");
  assert.ok(err.fields && err.fields.some((f) => f.path === "/claims/0/amount"));
});

test("bad claim type rejected with field errors", async () => {
  const h = await makeHarness();
  const err = await issueErrorOf(
    issueAttestation(validRequest(h, { claims: [{ type: "quantum" }] }), h.opts),
  );
  assert.equal(err.status, 400);
  assert.ok(err.fields && err.fields.length > 0);
});

test("negative price amount rejected", async () => {
  const h = await makeHarness();
  const err = await issueErrorOf(
    issueAttestation(
      validRequest(h, {
        claims: [{ type: "price", item: "x", amount: -5, currency: "USD", disclosed: true }],
      }),
      h.opts,
    ),
  );
  assert.equal(err.status, 400);
});

test("business key for a different business -> 422", async () => {
  const h = await makeHarness();
  const other = await h.keystore.generateKey("biz_other", "business");
  const err = await issueErrorOf(
    issueAttestation(validRequest(h, { business_key_id: other.key_id }), h.opts),
  );
  assert.equal(err.status, 422);
  assert.equal(err.code, "business_key_invalid");
});

test("retired business key cannot issue -> 422", async () => {
  const h = await makeHarness();
  await h.keystore.sunset(h.bizKeyId);
  const err = await issueErrorOf(issueAttestation(validRequest(h), h.opts));
  assert.equal(err.status, 422);
});

test("no active veritas key -> 503", async () => {
  const keystore = new SoftwareKeyStore();
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const opts: IssuerOptions = { keystore, log: new MerkleLog(), clock: () => new Date(FIXED_NOW) };
  const req = validRequest({ bizKeyId: bizRec.key_id } as Harness);
  const err = await issueErrorOf(issueAttestation(req, opts));
  assert.equal(err.status, 503);
  assert.equal(err.code, "no_veritas_key");
});

test("valid_until uses the shortest claim interval", async () => {
  const h = await makeHarness();
  const a = await issueAttestation(
    validRequest(h, {
      claims: [
        { type: "availability", service: "emergency_same_day", available: true }, // 7d
        { type: "identity", legal_name: "Rapido Plumbing LLC" }, // 365d
      ],
    }),
    h.opts,
  );
  assert.equal(a.valid_until, "2026-09-26T12:00:05Z"); // +7 days
});

test("explicit veritas_key_id is honored", async () => {
  const h = await makeHarness();
  const v2 = await h.keystore.generateKey("veritas", "veritas");
  const a = await issueAttestation(validRequest(h, { veritas_key_id: v2.key_id }), h.opts);
  assert.equal(a.signatures.veritas.key_id, v2.key_id);
});

test("authorization records are journaled immutably", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issuer-test-"));
  try {
    const h = await makeHarness(FIXED_NOW, dir);
    const a = await issueAttestation(validRequest(h), h.opts);
    const lines = readFileSync(join(dir, "auth.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.attestation_id, a.attestation_id);
    assert.equal(entry.authorization.auth_id, "auth_9f31ab");
    assert.ok(entry.received_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC: issuance throughput >= 50/min", async () => {
  const h = await makeHarness();
  const N = 120;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await issueAttestation(validRequest(h), h.opts);
  }
  const elapsedMin = (Date.now() - t0) / 60000;
  const perMin = N / elapsedMin;
  assert.ok(perMin >= 50, `only ${perMin.toFixed(0)}/min`);
  assert.equal(h.log.size, N);
});

test("sequential issuances get increasing leaf indices and a growing root", async () => {
  const h = await makeHarness();
  const a1 = await issueAttestation(validRequest(h), h.opts);
  const a2 = await issueAttestation(validRequest(h), h.opts);
  assert.equal(a1.log.leaf_index, 0);
  assert.equal(a2.log.leaf_index, 1);
  assert.notEqual(a1.log.root, a2.log.root);
  assert.notEqual(a1.attestation_id, a2.attestation_id);
});
