/**
 * T9 visit tests. Run compiled: node --test dist/test/visits.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordVisit, verifierAccuracy } from "../src/visits.js";
import { openDispute } from "../src/disputes.js";
import { OpsError } from "../src/types.js";
import { BIZ, BIZ_LAT, BIZ_LNG, T0, DAY, makeStack } from "./helpers.js";

const near = { lat: BIZ_LAT + 0.001, lng: BIZ_LNG }; // ~111 m
const far = { lat: BIZ_LAT + 0.006, lng: BIZ_LNG }; // ~667 m

test("happy path: visit recorded, server-stamped, distance computed", async () => {
  const s = await makeStack();
  const v = await recordVisit(
    {
      business_id: BIZ,
      verifier_id: "ver_007",
      gps: near,
      evidence_refs: ["photo:abc123"],
      checklist: [{ claim_type: "price", result: "pass" }],
    },
    { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock },
  );
  assert.equal(v.business_id, BIZ);
  assert.equal(v.arrived_at, "2026-09-19T12:00:00Z"); // server clock, not device
  assert.ok(v.distance_m < 500, `distance ${v.distance_m}`);
  assert.ok(v.visit_id.startsWith("vst_"));
});

test("GPS >500 m → 422 gps_out_of_range", async () => {
  const s = await makeStack();
  await assert.rejects(
    () =>
      recordVisit(
        {
          business_id: BIZ,
          verifier_id: "ver_007",
          gps: far,
          evidence_refs: ["photo:x"],
          checklist: [{ claim_type: "hours", result: "pass" }],
        },
        { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock },
      ),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "gps_out_of_range",
  );
});

test("price claim without photo evidence → 422 evidence_required", async () => {
  const s = await makeStack();
  await assert.rejects(
    () =>
      recordVisit(
        {
          business_id: BIZ,
          verifier_id: "ver_007",
          gps: near,
          checklist: [{ claim_type: "price", result: "pass" }],
        },
        { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock },
      ),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "evidence_required",
  );
});

test("non-price checklist without evidence is fine", async () => {
  const s = await makeStack();
  const v = await recordVisit(
    {
      business_id: BIZ,
      verifier_id: "ver_007",
      gps: near,
      checklist: [{ claim_type: "hours", result: "pass" }],
    },
    { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock },
  );
  assert.equal(v.evidence_refs.length, 0);
});

test("unknown business → 404 business_unknown", async () => {
  const s = await makeStack();
  await assert.rejects(
    () =>
      recordVisit(
        { business_id: "biz_nope", verifier_id: "v", gps: near, checklist: [{ claim_type: "hours", result: "pass" }] },
        { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock },
      ),
    (e: unknown) => e instanceof OpsError && e.status === 404 && e.code === "business_unknown",
  );
});

test("accuracy: matured clean visit = 1.0; disputed visit = 0.5", async () => {
  const s = await makeStack();
  const deps = { directory: s.directory, visits: s.visits, disputes: s.disputes, clock: s.clock };

  // Two visits 40 days ago (matured), each producing an attestation.
  const old = new Date(T0.getTime() - 40 * DAY);
  const oldDeps = { ...deps, clock: () => new Date(old) };
  const att1 = await s.issue();
  const att2 = await s.issue();
  await s.attestations.put(att1);
  await s.attestations.put(att2);
  await recordVisit(
    { business_id: BIZ, verifier_id: "ver_007", gps: near, evidence_refs: ["p1"], checklist: [{ claim_type: "price", result: "pass" }], attestation_id: att1.attestation_id },
    oldDeps,
  );
  await recordVisit(
    { business_id: BIZ, verifier_id: "ver_007", gps: near, evidence_refs: ["p2"], checklist: [{ claim_type: "price", result: "pass" }], attestation_id: att2.attestation_id },
    oldDeps,
  );

  // One fresh visit (not matured — excluded from accuracy).
  await recordVisit(
    { business_id: BIZ, verifier_id: "ver_007", gps: near, checklist: [{ claim_type: "hours", result: "pass" }] },
    deps,
  );

  // Dispute att2 within 30 days of its visit → only att1 stays clean.
  const dClock = () => new Date(old.getTime() + 10 * DAY);
  await openDispute(
    { attestation_id: att2.attestation_id, opened_by: "reviewer_1", reason: "price wrong" },
    { ...s.disputeDeps, clock: dClock },
  );

  const acc = await verifierAccuracy("ver_007", { ...deps, clock: () => new Date(T0) });
  assert.equal(acc.visits_total, 3);
  assert.equal(acc.visits_matured, 2);
  assert.equal(acc.visits_clean, 1);
  assert.equal(acc.accuracy, 0.5);
});

test("accuracy is null when nothing matured", async () => {
  const s = await makeStack();
  const acc = await verifierAccuracy("ver_nobody", {
    directory: s.directory,
    visits: s.visits,
    disputes: s.disputes,
    clock: s.clock,
  });
  assert.equal(acc.accuracy, null);
  assert.equal(acc.visits_matured, 0);
});
