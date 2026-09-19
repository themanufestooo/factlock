/**
 * T13 webhook tests: real `stripe` package signature verification, offline.
 * Payloads are signed with generateTestHeaderString; tampering must 400.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  handleWebhook,
  badgeBillingState,
  isEntitled,
  InMemoryCustomerStore,
  InMemorySubscriptionStore,
  BillingError,
  type Customer,
  type WebhookDeps,
} from "../src/index.js";

const SECRET = "whsec_test_1234567890abcdef";
const CLOCK = () => new Date("2026-09-19T12:00:00.000Z");
const stripe = new Stripe("sk_test_123");

function customer(): Customer {
  return {
    id: "cus_1",
    business_id: "biz_1",
    email: "owner@example.com",
    stripe_customer_id: "cus_stripe_1",
    created_at: "2026-09-19T12:00:00.000Z",
  };
}

async function deps(): Promise<WebhookDeps> {
  const customers = new InMemoryCustomerStore();
  await customers.save(customer());
  return {
    stripe,
    webhookSecret: SECRET,
    customers,
    subscriptions: new InMemorySubscriptionStore(),
    clock: CLOCK,
  };
}

function sign(payload: string): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
}

test("checkout.session.completed creates the subscription", async () => {
  const d = await deps();
  const payload = JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        subscription: "sub_stripe_1",
        metadata: { customer_id: "cus_1", plan_id: "founding" },
      },
    },
  });
  const out = await handleWebhook(d, payload, sign(payload));
  assert.equal(out.handled, true);
  const sub = await d.subscriptions.getByCustomer("cus_1");
  assert.ok(sub);
  assert.equal(sub.plan_id, "founding");
  assert.equal(sub.price_cents, 4900);
  assert.equal(sub.status, "active");
  assert.equal(sub.stripe_subscription_id, "sub_stripe_1");
});

test("tampered payload is rejected before any state change", async () => {
  const d = await deps();
  const payload = JSON.stringify({
    id: "evt_2",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_2",
        object: "checkout.session",
        subscription: "sub_stripe_2",
        metadata: { customer_id: "cus_1", plan_id: "standard" },
      },
    },
  });
  const sig = sign(payload);
  const tampered = payload.replace("cus_1", "cus_9");
  await assert.rejects(handleWebhook(d, tampered, sig), (e: unknown) => {
    assert.ok(e instanceof BillingError && e.httpStatus === 400);
    return true;
  });
  assert.equal(await d.subscriptions.getByCustomer("cus_1"), null);
  assert.equal(await d.subscriptions.getByCustomer("cus_9"), null);
});

test("missing signature header is rejected", async () => {
  const d = await deps();
  await assert.rejects(handleWebhook(d, "{}", undefined), BillingError);
});

test("invoice.payment_failed → past_due + 7-day grace; invoice.paid recovers", async () => {
  const d = await deps();
  // Seed an active subscription bound to a Stripe id.
  const payload0 = JSON.stringify({
    id: "evt_3",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_3",
        object: "checkout.session",
        subscription: "sub_stripe_3",
        metadata: { customer_id: "cus_1", plan_id: "standard" },
      },
    },
  });
  await handleWebhook(d, payload0, sign(payload0));

  const failed = JSON.stringify({
    id: "evt_4",
    object: "event",
    type: "invoice.payment_failed",
    data: { object: { id: "in_1", object: "invoice", subscription: "sub_stripe_3" } },
  });
  await handleWebhook(d, failed, sign(failed));
  let sub = await d.subscriptions.getByCustomer("cus_1");
  assert.equal(sub?.status, "past_due");
  assert.equal(sub?.grace_until, "2026-09-26T12:00:00.000Z");
  assert.equal(badgeBillingState(sub, CLOCK), "grace");

  const paid = JSON.stringify({
    id: "evt_5",
    object: "event",
    type: "invoice.paid",
    data: { object: { id: "in_2", object: "invoice", subscription: "sub_stripe_3" } },
  });
  await handleWebhook(d, paid, sign(paid));
  sub = await d.subscriptions.getByCustomer("cus_1");
  assert.equal(sub?.status, "active");
  assert.equal(sub?.grace_until, null);
});

test("customer.subscription.deleted → canceled; entitlements off", async () => {
  const d = await deps();
  const payload0 = JSON.stringify({
    id: "evt_6",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_6",
        object: "checkout.session",
        subscription: "sub_stripe_6",
        metadata: { customer_id: "cus_1", plan_id: "standard" },
      },
    },
  });
  await handleWebhook(d, payload0, sign(payload0));
  const deleted = JSON.stringify({
    id: "evt_7",
    object: "event",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_stripe_6", object: "subscription" } },
  });
  await handleWebhook(d, deleted, sign(deleted));
  const sub = await d.subscriptions.getByCustomer("cus_1");
  assert.equal(sub?.status, "canceled");
  assert.equal(isEntitled(sub, "badge", CLOCK), false);
  assert.equal(isEntitled(sub, "issuance", CLOCK), false);
});

test("unknown event type is ignored, not an error", async () => {
  const d = await deps();
  const payload = JSON.stringify({
    id: "evt_8",
    object: "event",
    type: "customer.created",
    data: { object: { id: "cus_stripe_1", object: "customer" } },
  });
  const out = await handleWebhook(d, payload, sign(payload));
  assert.equal(out.handled, false);
});
