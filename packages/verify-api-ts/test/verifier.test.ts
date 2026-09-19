/**
 * T6 tests: verification core — signatures, inclusion, status, freshness.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SoftwareKeyStore } from "@veritas/keystore";
import { MerkleLog } from "@veritas/merkle-log";
import { issueAttestation } from "@veritas/issuer";
import type { Attestation } from "@veritas/issuer";

import {
  verifyAttestation,
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
  verdictFor,
} from "../src/index.js";
import type { VerifyDeps } from "../src/index.js";

const T0 = new Date("2026-09-19T12:00:00Z");
const DAY = 86_400_000;

interface Harness {
  store: InMemoryAttestationStore;
  statuses: InMemoryStatusRegistry;
  keystore: SoftwareKeyStore;
  log: MerkleLog;
  att: Attestation;
  bizKeyId: string;
}

async function makeHarness(now: Date = T0): Promise<Harness> {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("veritas", "veritas");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const att = await issueAttestation(
    {
      subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        { type: "price", item: "secret_sauce", amount: 100, currency: "USD", disclosed: false },
        { type: "hours", timezone: "America/New_York", schedule: [{ day: "mon", open: "08:00", close: "18:00" }] },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      authorization: {
        auth_id: "auth_1",
        session_id: "sess_1",
        sms_confirmation_ref: "sms_1",
        authorized_at: "2026-09-19T11:59:00Z",
        authorized_by: "owner-on-file",
      },
      business_key_id: bizRec.key_id,
    },
    { keystore, log, clock: () => new Date(now) },
  );
  const store = new InMemoryAttestationStore();
  await store.put(att);
  return {
    store,
    statuses: new InMemoryStatusRegistry(),
    keystore,
    log,
    att,
    bizKeyId: bizRec.key_id,
  };
}

function deps(h: Harness, now: Date = T0): VerifyDeps {
  return { keystore: h.keystore, log: h.log, statuses: h.statuses, clock: () => new Date(now) };
}

test("happy path: valid, FRESH, both proofs ok", async () => {
  const h = await makeHarness();
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  assert.equal(r.valid, true);
  assert.equal(r.status, "ACTIVE");
  assert.equal(r.freshness, "FRESH");
  assert.equal(r.signatures_ok, true);
  assert.equal(r.inclusion_ok, true);
  assert.equal(r.age_days, 0);
  assert.equal(r.key_ids.business, h.bizKeyId);
  assert.match(r.message, /VERIFIED/);
});

test("undisclosed price amounts are redacted from the result", async () => {
  const h = await makeHarness();
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  const secret = r.claims.find((c) => c.item === "secret_sauce")!;
  assert.equal(secret.withheld, true);
  assert.ok(!("amount" in secret) && !("currency" in secret));
  const open = r.claims.find((c) => c.item === "service_call")!;
  assert.equal(open.amount, 8900);
});

test("tampered claim breaks the business signature", async () => {
  const h = await makeHarness();
  const evil = structuredClone(h.att);
  (evil.claims[0] as Record<string, unknown>).amount = 1;
  await h.store.put(evil); // overwrites by id
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  assert.equal(r.signatures_ok, false);
  assert.equal(r.valid, false);
  assert.match(r.message, /INVALID SIGNATURE/);
});

test("inclusion proof fails against a different log root", async () => {
  const h = await makeHarness();
  const otherLog = new MerkleLog(); // empty, different root
  const r = await verifyAttestation(h.att.attestation_id, h.store, {
    ...deps(h),
    log: otherLog,
  });
  assert.ok(r);
  assert.equal(r.inclusion_ok, false);
  assert.equal(r.valid, false);
  assert.match(r.message, /NOT IN TRANSPARENCY LOG/);
});

test("unknown key_id breaks signatures", async () => {
  const h = await makeHarness();
  const keystore = new SoftwareKeyStore(); // fresh: knows no keys
  const r = await verifyAttestation(h.att.attestation_id, h.store, {
    ...deps(h),
    keystore,
  });
  assert.ok(r);
  assert.equal(r.signatures_ok, false);
  assert.equal(r.valid, false);
});

test("retired keys still verify old attestations", async () => {
  const h = await makeHarness();
  await h.keystore.rotate(h.bizKeyId);
  await h.keystore.sunset(h.bizKeyId);
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  assert.equal(r.signatures_ok, true);
  assert.equal(r.valid, true);
});

test("freshness boundaries: AGING at exactly 70%, STALE at 100%", async () => {
  const h = await makeHarness(); // price interval 30d → valid_until = T0+30d
  const at21 = await verifyAttestation(
    h.att.attestation_id,
    h.store,
    deps(h, new Date(T0.getTime() + 21 * DAY)),
  );
  assert.ok(at21);
  assert.equal(at21.freshness, "AGING");
  assert.equal(at21.age_days, 21);
  assert.equal(at21.valid, true); // AGING is still usable
  assert.match(at21.message, /AGING/);

  const at30 = await verifyAttestation(
    h.att.attestation_id,
    h.store,
    deps(h, new Date(T0.getTime() + 30 * DAY)),
  );
  assert.ok(at30);
  assert.equal(at30.freshness, "STALE");
  assert.equal(at30.expired, false); // exactly AT valid_until: stale, not expired
  assert.match(at30.message, /STALE/);
});

test("past valid_until: expired and invalid", async () => {
  const h = await makeHarness();
  const r = await verifyAttestation(
    h.att.attestation_id,
    h.store,
    deps(h, new Date(T0.getTime() + 30 * DAY + 1000)),
  );
  assert.ok(r);
  assert.equal(r.expired, true);
  assert.equal(r.valid, false);
  assert.match(r.message, /EXPIRED/);
});

test("DISPUTED override: invalid, treated as untrusted", async () => {
  const h = await makeHarness();
  await h.statuses.set(h.att.attestation_id, {
    status: "DISPUTED",
    reason: "customer filed dispute #42",
    at: new Date(T0.getTime() + DAY).toISOString(),
  });
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  assert.equal(r.status, "DISPUTED");
  assert.equal(r.valid, false);
  assert.equal(r.signatures_ok, true); // crypto still fine — trust is not
  assert.match(r.message, /UNDER REVIEW/);
});

test("REVOKED override: rejected", async () => {
  const h = await makeHarness();
  await h.statuses.set(h.att.attestation_id, {
    status: "REVOKED",
    reason: "3 strikes — permanent revocation",
    at: new Date(T0.getTime() + DAY).toISOString(),
  });
  const r = await verifyAttestation(h.att.attestation_id, h.store, deps(h));
  assert.ok(r);
  assert.equal(r.status, "REVOKED");
  assert.equal(r.valid, false);
  assert.match(r.message, /REVOKED/);
});

test("unknown attestation id → null", async () => {
  const h = await makeHarness();
  assert.equal(await verifyAttestation("vat_nope", h.store, deps(h)), null);
});

test("verdictFor unit boundaries", () => {
  assert.equal(verdictFor(0, 100), "FRESH");
  assert.equal(verdictFor(69, 100), "FRESH");
  assert.equal(verdictFor(70, 100), "AGING");
  assert.equal(verdictFor(99, 100), "AGING");
  assert.equal(verdictFor(100, 100), "STALE");
  assert.equal(verdictFor(150, 100), "STALE");
});

test("per-claim freshness uses the §2 table", async () => {
  const h = await makeHarness();
  // 10 days in: price (30d) → 33% FRESH; hours (90d) → 11% FRESH
  const r = await verifyAttestation(
    h.att.attestation_id,
    h.store,
    deps(h, new Date(T0.getTime() + 10 * DAY)),
  );
  assert.ok(r);
  const price = r.claims_freshness.find((c) => c.type === "price")!;
  assert.equal(price.interval_days, 30);
  assert.equal(price.verdict, "FRESH");
  const hours = r.claims_freshness.find((c) => c.type === "hours")!;
  assert.equal(hours.interval_days, 90);
  assert.equal(hours.verdict, "FRESH");
  // 25 days in: price (30d) → 83% AGING; hours (90d) → 28% FRESH
  const r2 = await verifyAttestation(
    h.att.attestation_id,
    h.store,
    deps(h, new Date(T0.getTime() + 25 * DAY)),
  );
  assert.ok(r2);
  assert.equal(r2.claims_freshness.find((c) => c.type === "price")!.verdict, "AGING");
  assert.equal(r2.claims_freshness.find((c) => c.type === "hours")!.verdict, "FRESH");
});
