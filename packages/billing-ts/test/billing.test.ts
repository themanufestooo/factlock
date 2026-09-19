/**
 * T13 unit tests: plan catalog, subscription lifecycle, entitlements, deposits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPlan,
  setPlanPrice,
  badgeBillingState,
  createSubscription,
  applyPaymentFailed,
  applyPaymentRecovered,
  applyCanceled,
  isEntitled,
  holdDeposit,
  releaseDeposit,
  forfeitDeposit,
  InMemorySubscriptionStore,
  InMemoryDepositStore,
  BillingError,
  type Customer,
  type Feature,
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

test("founding price is locked permanently against catalog changes", async () => {
  const store = new InMemorySubscriptionStore();
  const sub = await createSubscription(store, customer(), "founding", CLOCK);
  assert.equal(sub.price_cents, 4900);
  // Operator raises the standard price to $99 — founders must not move.
  setPlanPrice("standard", 9900);
  try {
    const again = await store.get(sub.id);
    assert.equal(again?.price_cents, 4900);
    const std = await createSubscription(
      store,
      { ...customer(), id: "cus_2" },
      "standard",
      CLOCK,
    );
    assert.equal(std.price_cents, 9900);
    assert.equal(getPlan("founding").price_cents, 4900);
  } finally {
    setPlanPrice("standard", 7900); // restore catalog for other tests
  }
});

test("failed payment → past_due with 7-day grace; badge lapses after", async () => {
  const store = new InMemorySubscriptionStore();
  let sub = await createSubscription(store, customer(), "standard", CLOCK);
  assert.equal(badgeBillingState(sub, CLOCK), "active");

  sub = await applyPaymentFailed(store, sub, CLOCK);
  assert.equal(sub.status, "past_due");
  assert.equal(sub.grace_until, "2026-09-26T12:00:00.000Z"); // +7d
  assert.equal(badgeBillingState(sub, CLOCK), "grace");

  // Day 8: grace expired → lapsed (badge shows "verification lapsed").
  const late = () => new Date("2026-09-27T12:00:01.000Z");
  assert.equal(badgeBillingState(sub, late), "lapsed");

  // Payment recovers → active again, grace cleared.
  sub = await applyPaymentRecovered(store, sub);
  assert.equal(sub.status, "active");
  assert.equal(sub.grace_until, null);
  assert.equal(badgeBillingState(sub, CLOCK), "active");
});

test("canceled subscription → badge lapsed", async () => {
  const store = new InMemorySubscriptionStore();
  let sub = await createSubscription(store, customer(), "standard", CLOCK);
  sub = await applyCanceled(store, sub);
  assert.equal(badgeBillingState(sub, CLOCK), "lapsed");
  assert.equal(badgeBillingState(null, CLOCK), "lapsed");
});

test("entitlements gate paid surfaces", async () => {
  const store = new InMemorySubscriptionStore();
  const features: Feature[] = ["badge", "issuance", "api", "portal"];

  let sub = await createSubscription(store, customer(), "standard", CLOCK);
  for (const f of features) assert.equal(isEntitled(sub, f, CLOCK), true);

  // In grace: badge + portal stay live; issuance and metered API pause.
  sub = await applyPaymentFailed(store, sub, CLOCK);
  assert.equal(isEntitled(sub, "badge", CLOCK), true);
  assert.equal(isEntitled(sub, "portal", CLOCK), true);
  assert.equal(isEntitled(sub, "issuance", CLOCK), false);
  assert.equal(isEntitled(sub, "api", CLOCK), false);

  // Grace expired or canceled: everything paid is off.
  sub = await applyCanceled(store, sub);
  for (const f of features) assert.equal(isEntitled(sub, f, CLOCK), false);
  for (const f of features) assert.equal(isEntitled(null, f, CLOCK), false);
});

test("dispute deposit: hold → release", async () => {
  const store = new InMemoryDepositStore();
  const dep = await holdDeposit(store, "dsp_1", "cus_1", 2500, CLOCK);
  assert.equal(dep.state, "held");
  const released = await releaseDeposit(store, dep.id, CLOCK);
  assert.equal(released.state, "released");
  assert.ok(released.settled_at);
});

test("dispute deposit: hold → forfeit; settlement is one-way", async () => {
  const store = new InMemoryDepositStore();
  const dep = await holdDeposit(store, "dsp_2", "cus_1", 2500, CLOCK);
  const forfeited = await forfeitDeposit(store, dep.id, CLOCK);
  assert.equal(forfeited.state, "forfeited");
  await assert.rejects(releaseDeposit(store, dep.id, CLOCK), (e: unknown) => {
    assert.ok(e instanceof BillingError && e.httpStatus === 422);
    return true;
  });
});

test("dispute deposit: invalid amount rejected", async () => {
  const store = new InMemoryDepositStore();
  await assert.rejects(holdDeposit(store, "dsp_3", "cus_1", 0, CLOCK), BillingError);
  await assert.rejects(holdDeposit(store, "dsp_3", "cus_1", -100, CLOCK), BillingError);
});
