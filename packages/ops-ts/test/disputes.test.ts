/**
 * T11 dispute lifecycle tests — the full walk to third-strike REVOKED,
 * verified through the real verify-api verifier.
 * Run compiled: node --test dist/test/disputes.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDispute, resolveDispute, revocationInclusionOk } from "../src/disputes.js";
import { OpsError, type RevocationRecord } from "../src/types.js";
import { BIZ, authRecord, baseIssueRequest, makeStack } from "./helpers.js";

test("full lifecycle: ACTIVE → DISPUTED → CORRECTED → SUSPENDED → REVOKED (3rd strike)", async () => {
  const s = await makeStack();

  // 1. Issue attestation A. It verifies clean.
  const a = await s.issue();
  await s.attestations.put(a);
  const v0 = await s.verify(a.attestation_id);
  assert.equal(v0?.valid, true);
  assert.equal(v0?.status, "ACTIVE");

  // 2. Dispute #1 → DISPUTED. Verifier rejects immediately.
  const d1 = await openDispute(
    { attestation_id: a.attestation_id, opened_by: "rev_1", reason: "price wrong on site" },
    s.disputeDeps,
  );
  assert.equal(d1.status, "open");
  const v1 = await s.verify(a.attestation_id);
  assert.equal(v1?.status, "DISPUTED");
  assert.equal(v1?.valid, false);

  // A second open dispute on the same attestation is rejected.
  await assert.rejects(
    () => openDispute({ attestation_id: a.attestation_id, opened_by: "rev_x", reason: "dup" }, s.disputeDeps),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "dispute_already_open",
  );

  // 3. Resolve #1 as corrected → new attestation B via the issuer, A → CORRECTED, strike 1.
  const correctedReq = {
    ...baseIssueRequest(),
    business_key_id: s.bizRec.key_id,
    claims: [
      { type: "price", item: "service_call", amount: 9900, currency: "USD", disclosed: true },
    ],
    authorization: authRecord("2"),
  };
  const r1 = await resolveDispute(
    d1.dispute_id,
    { outcome: "corrected", reviewer_id: "rev_1", notes: "price was $99 not $89", corrected_request: correctedReq },
    s.disputeDeps,
  );
  assert.equal(r1.attestation_status, "CORRECTED");
  assert.equal(r1.strikes_after, 1);
  assert.ok(r1.corrected_attestation_id);
  const b = await s.attestations.get(r1.corrected_attestation_id!);
  assert.ok(b, "corrected attestation must be in the store");
  assert.equal((b!.subject as Record<string, unknown>).supersedes_id, a.attestation_id);
  const vB = await s.verify(b!.attestation_id);
  assert.equal(vB?.valid, true);
  assert.equal(vB?.status, "ACTIVE");
  assert.equal(vB?.claims[0].amount, 9900);

  // 4. Dispute #2 on B → suspended. Strike 2. Verifier rejects.
  const d2 = await openDispute(
    { attestation_id: b!.attestation_id, opened_by: "rev_2", reason: "hours wrong" },
    s.disputeDeps,
  );
  const r2 = await resolveDispute(d2.dispute_id, { outcome: "suspended", reviewer_id: "rev_2" }, s.disputeDeps);
  assert.equal(r2.attestation_status, "SUSPENDED");
  assert.equal(r2.strikes_after, 2);
  const vB2 = await s.verify(b!.attestation_id);
  assert.equal(vB2?.status, "SUSPENDED");
  assert.equal(vB2?.valid, false);

  // 5. Dispute #3 on B → third strike → permanent REVOKED.
  const d3 = await openDispute(
    { attestation_id: b!.attestation_id, opened_by: "rev_3", reason: "still wrong" },
    s.disputeDeps,
  );
  const r3 = await resolveDispute(
    d3.dispute_id,
    { outcome: "suspended", reviewer_id: "rev_3", notes: "repeat offender" },
    s.disputeDeps,
  );
  assert.equal(r3.attestation_status, "REVOKED");
  assert.equal(r3.strikes_after, 3);
  assert.equal(r3.dispute.resolution?.outcome, "revoked");
  assert.ok(r3.revocation_leaf_index !== undefined);

  const vB3 = await s.verify(b!.attestation_id);
  assert.equal(vB3?.status, "REVOKED");
  assert.equal(vB3?.valid, false);
  assert.ok(vB3?.message.includes("REVOKED"));

  // Revocation record is IN the transparency log (inclusion proves against current root).
  const record: RevocationRecord = {
    record_type: "revocation",
    attestation_id: b!.attestation_id,
    business_id: BIZ,
    revoked_at: r3.dispute.resolution!.resolved_at,
    reason: "revoked after 3 strikes: repeat offender",
    strike: 3,
  };
  assert.equal(revocationInclusionOk(s.log, r3.revocation_leaf_index!, record), true);

  // CDN mirror entry is marked.
  const mirror = await s.cdn.get(b!.attestation_id);
  assert.ok(mirror, "CDN mirror must be marked");
  assert.equal(mirror!.reason, "revoked after 3 strikes: repeat offender");

  // No more disputes on a revoked attestation.
  await assert.rejects(
    () => openDispute({ attestation_id: b!.attestation_id, opened_by: "rev_x", reason: "late" }, s.disputeDeps),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "attestation_revoked",
  );
});

test("explicit revoked outcome revokes on first strike", async () => {
  const s = await makeStack();
  const a = await s.issue();
  await s.attestations.put(a);
  const d = await openDispute(
    { attestation_id: a.attestation_id, opened_by: "rev_1", reason: "fraud" },
    s.disputeDeps,
  );
  const r = await resolveDispute(
    d.dispute_id,
    { outcome: "revoked", reviewer_id: "rev_1", notes: "confirmed fraud" },
    s.disputeDeps,
  );
  assert.equal(r.attestation_status, "REVOKED");
  assert.equal(r.strikes_after, 1);
  const v = await s.verify(a.attestation_id);
  assert.equal(v?.valid, false);
  assert.equal(v?.status, "REVOKED");
});

test("cleared dispute: no strike, status CLEARED, still verifies", async () => {
  const s = await makeStack();
  const a = await s.issue();
  await s.attestations.put(a);
  const d = await openDispute(
    { attestation_id: a.attestation_id, opened_by: "rev_1", reason: "looks off" },
    s.disputeDeps,
  );
  const r = await resolveDispute(
    d.dispute_id,
    { outcome: "cleared", reviewer_id: "rev_1", notes: "checked out" },
    s.disputeDeps,
  );
  assert.equal(r.attestation_status, "CLEARED");
  assert.equal(r.strikes_after, 0);
  const v = await s.verify(a.attestation_id);
  assert.equal(v?.valid, true);
  assert.equal(v?.status, "CLEARED");
});

test("corrected without corrected_request → 422; unknown dispute → 404", async () => {
  const s = await makeStack();
  const a = await s.issue();
  await s.attestations.put(a);
  const d = await openDispute(
    { attestation_id: a.attestation_id, opened_by: "rev_1", reason: "x" },
    s.disputeDeps,
  );
  await assert.rejects(
    () => resolveDispute(d.dispute_id, { outcome: "corrected", reviewer_id: "rev_1" }, s.disputeDeps),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "corrected_request_required",
  );
  await assert.rejects(
    () => resolveDispute("dsp_nope", { outcome: "cleared", reviewer_id: "rev_1" }, s.disputeDeps),
    (e: unknown) => e instanceof OpsError && e.status === 404,
  );
  await assert.rejects(
    () => openDispute({ attestation_id: "vat_nope", opened_by: "rev_1", reason: "x" }, s.disputeDeps),
    (e: unknown) => e instanceof OpsError && e.status === 404,
  );
});
