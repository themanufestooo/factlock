/**
 * T12 scheduler tests. Run compiled: node --test dist/test/scheduler.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueForReverification, DUE_FRACTION } from "../src/scheduler.js";
import { BIZ, T0, DAY, makeStack } from "./helpers.js";
import type { Attestation } from "@veritas/issuer";

test("DUE_FRACTION is the 70% AGING threshold", () => {
  assert.equal(DUE_FRACTION, 0.7);
});

test("boundary: 69% not due, 70% due", async () => {
  const s = await makeStack();
  // price claims → 30-day interval.
  const a = await s.issue();
  // verified_at = T0, valid_until = T0 + 30d.
  const at69 = new Date(T0.getTime() + 0.69 * 30 * DAY);
  const at70 = new Date(T0.getTime() + 0.7 * 30 * DAY);
  assert.equal(dueForReverification(at69, [a]).length, 0);
  const due = dueForReverification(at70, [a]);
  assert.equal(due.length, 1);
  assert.equal(due[0].attestation_id, a.attestation_id);
  assert.equal(due[0].business_id, BIZ);
  assert.equal(due[0].interval_days, 30);
});

test("most urgent first; malformed intervals skipped", async () => {
  const s = await makeStack();
  const fresh = await s.issue(); // 30d interval
  const hoursOnly = await s.issue({
    claims: [{ type: "hours", timezone: "America/New_York", schedule: [{ day: "mon", open: "08:00", close: "18:00" }] }],
  }); // 90d interval
  const now = new Date(T0.getTime() + 25 * DAY);
  // fresh: 25/30 = 83% → due. hoursOnly: 25/90 = 28% → not due.
  const due = dueForReverification(now, [fresh, hoursOnly]);
  assert.equal(due.length, 1);
  assert.equal(due[0].attestation_id, fresh.attestation_id);

  const bad = { ...fresh, verified_at: "not-a-date" } as Attestation;
  const zero = { ...fresh, valid_until: fresh.verified_at } as Attestation;
  assert.equal(dueForReverification(now, [bad, zero]).length, 0);
});

test("ordering: higher fraction first", async () => {
  const s = await makeStack();
  const a1 = await s.issue(); // 30d
  const a2 = await s.issue({
    claims: [{ type: "availability", service: "drain_cleaning", available: true }],
  }); // 7d interval
  const now = new Date(T0.getTime() + 25 * DAY);
  const due = dueForReverification(now, [a1, a2]);
  assert.equal(due.length, 2);
  assert.equal(due[0].attestation_id, a2.attestation_id); // 25/7 = 357% first
  assert.equal(due[1].attestation_id, a1.attestation_id); // 25/30 = 83% second
  assert.ok(due[0].fraction_elapsed > due[1].fraction_elapsed);
});
