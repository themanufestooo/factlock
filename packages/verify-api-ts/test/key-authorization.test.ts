/**
 * P0 hardening tests (audit H-11): the verifier resolves key RECORDS and
 * enforces owner, role, and validity window at issuance time. Unknown,
 * wrong-owner, wrong-role, not-yet-valid, or expired-at-issuance keys must
 * all produce valid:false — even when the raw signature would verify.
 * Run compiled: node --test dist/test/key-authorization.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SoftwareKeyStore } from "@factlock/keystore";
import type { KeyRecord } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "@factlock/issuer";
import type { Attestation } from "@factlock/issuer";

import {
  verifyAttestation,
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
} from "../src/index.js";
import type { VerifyDeps } from "../src/index.js";

const T0 = new Date("2026-09-19T12:00:00Z");

interface Harness {
  store: InMemoryAttestationStore;
  keystore: SoftwareKeyStore;
  log: MerkleLog;
  statuses: InMemoryStatusRegistry;
  att: Attestation;
  bizKeyId: string;
  factlockKeyId: string;
}

async function makeHarness(): Promise<Harness> {
  const keystore = new SoftwareKeyStore();
  const factlockRec = await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  // P0 (H-11): key records carry a real-time valid_from, but this harness
  // freezes issuance in the past — backdate the windows so the keys are
  // valid at the frozen verified_at.
  for (const rec of (keystore as unknown as { records: Array<{ valid_from: string }> }).records) {
    rec.valid_from = "2026-01-01T00:00:00Z";
  }

  const request = {
    subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
    claims: [
      { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
    ],
    verification_method: "field_visit",
    verifier_id: "ver_007",
    evidence_refs: ["evidence_keys"],
    authorization_id: "auth_keys_1",
    business_key_id: bizRec.key_id,
  };
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  authorizations.put({
    authorization_id: "auth_keys_1", business_id: "biz_rapido", principal: "owner_rapido",
    claim_digest: digestClaims(request.claims), method: "authenticated_session",
    authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file",
    expires_at: new Date(T0.getTime() + 600_000).toISOString(),
  });
  evidence.put({
    evidence_ref: "evidence_keys", business_id: "biz_rapido", claim_types: ["price"],
    verified_at: "2026-09-19T11:58:00Z", expires_at: new Date(T0.getTime() + 86_400_000).toISOString(),
    verification_method: "field_visit", verifier_id: "ver_007",
  });
  const att = await issueAttestation(request, { keystore, log, clock: () => new Date(T0), authorizations, evidence }, { principal: "owner_rapido" });
  const store = new InMemoryAttestationStore();
  await store.put(att);
  return {
    store, keystore, log, statuses: new InMemoryStatusRegistry(), att,
    bizKeyId: bizRec.key_id, factlockKeyId: factlockRec.key_id,
  };
}

/** Mutate a stored key record in place (simulates registry tampering). */
function mutateRecord(keystore: SoftwareKeyStore, keyId: string, patch: Partial<KeyRecord>): void {
  const internal = keystore as unknown as { records: KeyRecord[] };
  const rec = internal.records.find((r) => r.key_id === keyId);
  if (!rec) throw new Error(`no record ${keyId}`);
  Object.assign(rec, patch);
}

function deps(h: Harness): VerifyDeps {
  return { keystore: h.keystore, log: h.log, statuses: h.statuses, clock: () => new Date(T0) };
}

async function mustVerify(h: Harness, store: InMemoryAttestationStore) {
  const r = await verifyAttestation(h.att.attestation_id, store, deps(h));
  assert.ok(r, "expected a verification result");
  return r;
}

test("happy path still verifies with correct owner/role/window", async () => {
  const h = await makeHarness();
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, true);
  assert.equal(r.signatures_ok, true);
});

test("business key owned by another business → valid:false", async () => {
  const h = await makeHarness();
  mutateRecord(h.keystore, h.bizKeyId, { owner: "biz_impostor" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("business key with wrong role (factlock) → valid:false", async () => {
  const h = await makeHarness();
  mutateRecord(h.keystore, h.bizKeyId, { kind: "factlock" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("countersigning key that is not a FactLock key → valid:false", async () => {
  const h = await makeHarness();
  mutateRecord(h.keystore, h.factlockKeyId, { kind: "business", owner: "biz_rapido" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("countersigning key with kind factlock but business owner → valid:false", async () => {
  const h = await makeHarness();
  // generateKey() does not restrict kind by owner: a business could register
  // a kind="factlock" key under its own owner. Owner must be checked too.
  mutateRecord(h.keystore, h.factlockKeyId, { owner: "biz_rapido" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("business key expired before issuance → valid:false", async () => {
  const h = await makeHarness();
  mutateRecord(h.keystore, h.bizKeyId, { valid_until: "2026-09-01T00:00:00Z" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("business key not yet valid at issuance → valid:false", async () => {
  const h = await makeHarness();
  mutateRecord(h.keystore, h.bizKeyId, { valid_from: "2026-10-01T00:00:00Z" });
  const r = await mustVerify(h, h.store);
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});

test("unknown business key_id → valid:false", async () => {
  const h = await makeHarness();
  const evil = structuredClone(h.att);
  evil.signatures.business.key_id = "key_does_not_exist";
  const evilStore = new InMemoryAttestationStore();
  await evilStore.put(evil);
  const r = await verifyAttestation(evil.attestation_id, evilStore, deps(h));
  assert.ok(r, "expected a verification result");
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, false);
});
