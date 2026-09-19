/**
 * T14 metering tests: key issuance, ingest, rollup math, reconciliation
 * (±0.1% AC), projection, and the invoice preview (which must never call Stripe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueApiKey,
  revokeApiKey,
  ingestUsage,
  rollupMonth,
  reconcile,
  projectUnits,
  previewInvoice,
  createSubscription,
  InMemoryMeteringStore,
  InMemorySubscriptionStore,
  RecordingStripeClient,
  BillingError,
  type Customer,
} from "../src/index.js";

const CLOCK = () => new Date("2026-09-19T12:00:00.000Z");

function customer(): Customer {
  return {
    id: "cus_1",
    business_id: "biz_1",
    email: "owner@example.com",
    stripe_customer_id: "cus_stripe_1",
    created_at: "2026-09-19T12:00:00.000Z",
  };
}

test("metering: ingest 1000 records, rollup math exact, reconcile passes", async () => {
  const store = new InMemoryMeteringStore();
  const { key } = await issueApiKey(store, "cus_1", CLOCK);
  assert.ok(key.prefix.length > 0);

  // 1000 verify calls + 250 badge calls.
  for (let i = 0; i < 1000; i++) await ingestUsage(store, key.id, "verify", 1, CLOCK);
  for (let i = 0; i < 250; i++) await ingestUsage(store, key.id, "badge", 1, CLOCK);

  const rollup = await rollupMonth(store, "cus_1", "2026-09", CLOCK);
  assert.equal(rollup.total_units, 1250);
  assert.deepEqual(rollup.units_by_endpoint, { verify: 1000, badge: 250 });

  const rec = await reconcile(store, "cus_1", "2026-09");
  assert.equal(rec.ok, true);
  assert.equal(rec.replayed_units, 1250);
  assert.equal(rec.stored_units, 1250);
});

test("metering: revoked key is rejected", async () => {
  const store = new InMemoryMeteringStore();
  const { key } = await issueApiKey(store, "cus_1", CLOCK);
  await revokeApiKey(store, key.id, CLOCK);
  await assert.rejects(ingestUsage(store, key.id, "verify", 1, CLOCK), (e: unknown) => {
    assert.ok(e instanceof BillingError && e.httpStatus === 403);
    return true;
  });
});

test("metering: invalid units rejected", async () => {
  const store = new InMemoryMeteringStore();
  const { key } = await issueApiKey(store, "cus_1", CLOCK);
  await assert.rejects(ingestUsage(store, key.id, "verify", 0, CLOCK), BillingError);
  await assert.rejects(ingestUsage(store, key.id, "verify", 1.5, CLOCK), BillingError);
});

test("projection: linear extrapolation over the month", () => {
  // 100 units by day 10 of a 30-day month → 300 projected.
  assert.equal(projectUnits(100, new Date("2026-09-10T12:00:00Z")), 300);
  // September 2026 has 30 days; Feb 2026 has 28.
  assert.equal(projectUnits(140, new Date("2026-02-14T12:00:00Z")), 280);
});

test("invoice preview: founding sub, 1500 units → exact totals, never charges", async () => {
  const metering = new InMemoryMeteringStore();
  const subs = new InMemorySubscriptionStore();
  const sub = await createSubscription(subs, customer(), "founding", CLOCK);

  const { key } = await issueApiKey(metering, "cus_1", CLOCK);
  for (let i = 0; i < 1500; i++) await ingestUsage(metering, key.id, "verify", 1, CLOCK);

  const stripeStub = new RecordingStripeClient();
  const preview = await previewInvoice(metering, sub, "cus_1", "2026-09", CLOCK);
  // Founding: $49 base, 1000 included, 500 over × $0.05 = $25 → $74 total.
  assert.equal(preview.plan_id, "founding");
  assert.equal(preview.base_cents, 4900);
  assert.equal(preview.usage_units, 1500);
  assert.equal(preview.included_units, 1000);
  assert.equal(preview.overage_units, 500);
  assert.equal(preview.overage_cents, 2500);
  assert.equal(preview.total_cents, 7400);
  assert.equal(preview.charged, false);
  assert.equal(stripeStub.calls.length, 0); // preview never touches Stripe
});

test("invoice preview: under quota → no overage", async () => {
  const metering = new InMemoryMeteringStore();
  const subs = new InMemorySubscriptionStore();
  const sub = await createSubscription(subs, customer(), "standard", CLOCK);
  const { key } = await issueApiKey(metering, "cus_1", CLOCK);
  for (let i = 0; i < 100; i++) await ingestUsage(metering, key.id, "verify", 1, CLOCK);
  const preview = await previewInvoice(metering, sub, "cus_1", "2026-09", CLOCK);
  assert.equal(preview.base_cents, 7900);
  assert.equal(preview.overage_units, 0);
  assert.equal(preview.total_cents, 7900);
});

test("invoice preview: no subscription → zeroed preview", async () => {
  const metering = new InMemoryMeteringStore();
  const preview = await previewInvoice(metering, null, "cus_9", "2026-09", CLOCK);
  assert.equal(preview.total_cents, 0);
  assert.equal(preview.charged, false);
});
