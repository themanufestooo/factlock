/**
 * T8 tests: factlock_check tool handler — fixtures via T2/T3/T4 in-process.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "@factlock/issuer";
import type { Attestation } from "@factlock/issuer";
import { InMemoryStatusRegistry } from "@factlock/verify-api";

import { handleFactLockCheck } from "../src/tool.js";
import { IndexedAttestationStore } from "../src/indexedStore.js";
import type { FactLockEnv } from "../src/tool.js";

const T0 = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;

async function makeEnv(now: Date = T0): Promise<{
  env: FactLockEnv;
  statuses: InMemoryStatusRegistry;
  att: Attestation;
}> {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const request = {
      subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        { type: "hours", timezone: "America/New_York", schedule: [{ day: "mon", open: "08:00", close: "18:00" }] },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      evidence_refs: ["evidence_mcp"],
      authorization_id: "auth_1",
      business_key_id: bizRec.key_id,
  };
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  authorizations.put({ authorization_id: "auth_1", business_id: "biz_rapido", principal: "owner_rapido", claim_digest: digestClaims(request.claims), method: "authenticated_session", authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file", expires_at: "2026-09-19T12:10:00Z" });
  evidence.put({ evidence_ref: "evidence_mcp", business_id: "biz_rapido", claim_types: ["price", "hours"], verified_at: "2026-09-19T11:58:00Z", expires_at: "2026-09-20T12:00:00Z", verification_method: "field_visit", verifier_id: "ver_007" });
  const att = await issueAttestation(request, { keystore, log, clock: () => new Date(T0), authorizations, evidence }, { principal: "owner_rapido" });
  const store = new IndexedAttestationStore();
  await store.put(att);
  const statuses = new InMemoryStatusRegistry();
  const env: FactLockEnv = {
    store,
    index: store,
    deps: { keystore, log, statuses, clock: () => new Date(now) },
    publicBaseUrl: "https://verify.factlock.example",
  };
  return { env, statuses, att };
}

test("fresh ACTIVE attestation → valid:true with details_url", async () => {
  const { env, att } = await makeEnv();
  const r = await handleFactLockCheck({ attestation_id: att.attestation_id }, env);
  assert.equal(r.valid, true);
  assert.equal(r.status, "ACTIVE");
  assert.equal(r.freshness, "FRESH");
  assert.equal(r.reason, null);
  assert.equal(r.business!.id, "biz_rapido");
  assert.equal(r.details_url, `https://verify.factlock.example/v1/verify/${att.attestation_id}`);
  assert.ok(r.summary_line.startsWith("VERIFIED"));
  assert.deepEqual(
    r.claims.map((c) => c.type).sort(),
    ["hours", "price"],
  );
});

test("business_id resolves the latest attestation", async () => {
  const { env, att } = await makeEnv();
  const r = await handleFactLockCheck({ business_id: "biz_rapido" }, env);
  assert.equal(r.valid, true);
  assert.equal(r.attestation_id, att.attestation_id);
});

test("REVOKED → valid:false with reason revoked", async () => {
  const { env, statuses, att } = await makeEnv();
  await statuses.set(att.attestation_id, {
    status: "REVOKED",
    reason: "fraud",
    at: T0.toISOString(),
  });
  const r = await handleFactLockCheck({ attestation_id: att.attestation_id }, env);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "revoked");
  assert.ok(r.summary_line.includes("REVOKED"));
});

test("validity boundary → valid:false with reason expired", async () => {
  // Fail closed at the exact valid_until boundary.
  const { env, att } = await makeEnv(new Date(T0.getTime() + 30 * DAY));
  const r = await handleFactLockCheck({ attestation_id: att.attestation_id }, env);
  assert.equal(r.freshness, "STALE");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "expired");
});

test("unknown id → clean invalid verdict, not a crash", async () => {
  const { env } = await makeEnv();
  const r = await handleFactLockCheck({ attestation_id: "fla_nope" }, env);
  assert.equal(r.valid, false);
  assert.ok(r.reason!.includes("No attestation found"));
  assert.equal(r.details_url, null);
});

test("unknown business → clean invalid verdict", async () => {
  const { env } = await makeEnv();
  const r = await handleFactLockCheck({ business_id: "biz_ghost" }, env);
  assert.equal(r.valid, false);
  assert.ok(r.reason!.includes("No attestation found"));
});

test("claim_type mismatch → valid:false", async () => {
  const { env, att } = await makeEnv();
  const r = await handleFactLockCheck(
    { attestation_id: att.attestation_id, claim_type: "license" },
    env,
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason!.includes('no claim of type "license"'));
});

test("claim_type match → valid", async () => {
  const { env, att } = await makeEnv();
  const r = await handleFactLockCheck(
    { attestation_id: att.attestation_id, claim_type: "price" },
    env,
  );
  assert.equal(r.valid, true);
});

test("both ids → clean error, not a crash", async () => {
  const { env, att } = await makeEnv();
  const r = await handleFactLockCheck(
    { attestation_id: att.attestation_id, business_id: "biz_rapido" },
    env,
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason!.includes("not both"));
});

test("neither id → clean error", async () => {
  const { env } = await makeEnv();
  const r = await handleFactLockCheck({}, env);
  assert.equal(r.valid, false);
});
