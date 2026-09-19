/**
 * T10 flag tests. Run compiled: node --test dist/test/flags.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openFlag, resolveFlag } from "../src/flags.js";
import { OpsError } from "../src/types.js";
import { makeStack } from "./helpers.js";

async function flagged() {
  const s = await makeStack();
  const att = await s.issue();
  await s.attestations.put(att);
  const deps = {
    flags: s.flags,
    audit: s.audit,
    attestations: s.attestations,
    clock: s.clock,
    disputes: s.disputeDeps,
  };
  return { s, att, deps };
}

test("open → list(open) → resolve(confirm) writes audit entry", async () => {
  const { att, deps, s } = await flagged();
  const f = await openFlag(
    { attestation_id: att.attestation_id, source: "mystery-shopper", reason: "price mismatch on site" },
    deps,
  );
  assert.equal(f.status, "open");
  assert.equal((await deps.flags.list("open")).length, 1);
  assert.equal((await deps.flags.list()).length, 1);

  const { flag, dispute_id } = await resolveFlag(
    f.flag_id,
    { decision: "confirm", reviewer_id: "rev_1", notes: "checked, all good" },
    deps,
  );
  assert.equal(flag.status, "resolved");
  assert.equal(dispute_id, undefined);

  const audit = await s.audit.list();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "rev_1");
  assert.equal(audit[0].action, "flag.confirm");
  assert.deepEqual(audit[0].subject, { flag_id: f.flag_id, attestation_id: att.attestation_id });
});

test("resolve(dispute) escalates into the lifecycle engine", async () => {
  const { att, deps, s } = await flagged();
  const f = await openFlag(
    { attestation_id: att.attestation_id, source: "anomaly-detector", reason: "amount outlier" },
    deps,
  );
  const { dispute_id } = await resolveFlag(
    f.flag_id,
    { decision: "dispute", reviewer_id: "rev_2" },
    deps,
  );
  assert.ok(dispute_id, "expected a dispute to be opened");
  const d = await s.disputes.get(dispute_id!);
  assert.equal(d?.attestation_id, att.attestation_id);
  assert.equal(d?.status, "open");
  // Status flip is immediate — the verifier sees DISPUTED.
  const v = await s.verify(att.attestation_id);
  assert.equal(v?.status, "DISPUTED");
  assert.equal(v?.valid, false);
});

test("unknown attestation → 404; resolving twice → 422", async () => {
  const { deps } = await flagged();
  await assert.rejects(
    () => openFlag({ attestation_id: "vat_nope", source: "public-report", reason: "x" }, deps),
    (e: unknown) => e instanceof OpsError && e.status === 404,
  );
  const s2 = await makeStack();
  const att = await s2.issue();
  await s2.attestations.put(att);
  const deps2 = { flags: s2.flags, audit: s2.audit, attestations: s2.attestations, clock: s2.clock };
  const f = await openFlag({ attestation_id: att.attestation_id, source: "public-report", reason: "x" }, deps2);
  await resolveFlag(f.flag_id, { decision: "clear", reviewer_id: "rev_1" }, deps2);
  await assert.rejects(
    () => resolveFlag(f.flag_id, { decision: "clear", reviewer_id: "rev_1" }, deps2),
    (e: unknown) => e instanceof OpsError && e.status === 422 && e.code === "flag_closed",
  );
});

test("bad source / bad decision → 400", async () => {
  const { att, deps } = await flagged();
  await assert.rejects(
    () => openFlag({ attestation_id: att.attestation_id, source: "gossip" as never, reason: "x" }, deps),
    (e: unknown) => e instanceof OpsError && e.status === 400,
  );
  const f = await openFlag({ attestation_id: att.attestation_id, source: "public-report", reason: "x" }, deps);
  await assert.rejects(
    () => resolveFlag(f.flag_id, { decision: "maybe" as never, reviewer_id: "rev_1" }, deps),
    (e: unknown) => e instanceof OpsError && e.status === 400,
  );
});
