/**
 * T13/T14 HTTP tests: routes, shapes, and error mapping end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import {
  createBillingServer,
  InMemoryCustomerStore,
  InMemoryDepositStore,
  InMemoryMeteringStore,
  InMemorySubscriptionStore,
  RecordingStripeClient,
  createSubscription,
  ingestUsage,
  type BillingServerOptions,
  type Customer,
} from "../src/index.js";

const SECRET = "whsec_test_server_abcdef1234567890";
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

async function startServer() {
  const customers = new InMemoryCustomerStore();
  await customers.save(customer());
  const opts: BillingServerOptions = {
    customers,
    subscriptions: new InMemorySubscriptionStore(),
    metering: new InMemoryMeteringStore(),
    deposits: new InMemoryDepositStore(),
    stripeClient: new RecordingStripeClient(),
    stripe,
    webhookSecret: SECRET,
    clock: CLOCK,
  };
  const server = createBillingServer(opts);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    opts,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /v1/plans lists the catalog", async () => {
  const s = await startServer();
  try {
    const { status, body } = await get(s.base, "/v1/plans");
    assert.equal(status, 200);
    const plans = body.plans as Array<{ id: string; price_cents: number }>;
    assert.equal(plans.length, 2);
    assert.deepEqual(
      plans.map((p) => [p.id, p.price_cents]),
      [["founding", 4900], ["standard", 7900]],
    );
  } finally {
    await s.stop();
  }
});

test("webhook: tampered body → 400, no subscription created", async () => {
  const s = await startServer();
  try {
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          subscription: "sub_s1",
          metadata: { customer_id: "cus_1", plan_id: "founding" },
        },
      },
    });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const { status } = await post(s.base, "/v1/billing/webhook", payload + " ", {
      "stripe-signature": sig,
    });
    assert.equal(status, 400);
    const st = await get(s.base, "/v1/billing/status?customer_id=cus_1");
    assert.equal((st.body.subscription as unknown), null);
  } finally {
    await s.stop();
  }
});

test("webhook happy path → status shows active + entitled", async () => {
  const s = await startServer();
  try {
    const payload = JSON.stringify({
      id: "evt_2",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_2",
          object: "checkout.session",
          subscription: "sub_s2",
          metadata: { customer_id: "cus_1", plan_id: "founding" },
        },
      },
    });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const { status } = await post(s.base, "/v1/billing/webhook", payload, {
      "stripe-signature": sig,
    });
    assert.equal(status, 200);
    const st = await get(s.base, "/v1/billing/status?customer_id=cus_1");
    assert.equal(st.status, 200);
    assert.equal(st.body.badge, "active");
    assert.deepEqual(st.body.entitled, { badge: true, issuance: true, api: true, portal: true });
  } finally {
    await s.stop();
  }
});

test("api keys → ingest → usage summary with projection", async () => {
  const s = await startServer();
  try {
    await createSubscription(s.opts.subscriptions, customer(), "standard", CLOCK);
    const k = await post(s.base, "/v1/api-keys", { customer_id: "cus_1" });
    assert.equal(k.status, 201);
    const key_id = k.body.key_id as string;
    assert.ok((k.body.secret as string).startsWith("factlock_sk_"));

    for (let i = 0; i < 60; i++) {
      const r = await post(s.base, "/v1/usage/ingest", { key_id, endpoint: "verify", units: 1 });
      assert.equal(r.status, 201);
    }
    const sum = await get(s.base, "/v1/usage/summary?customer_id=cus_1");
    assert.equal(sum.status, 200);
    assert.equal(sum.body.units_to_date, 60);
    assert.equal(sum.body.plan_id, "standard");
    // 60 units by day 19 of 30 → projected 95; standard includes 5000 → no overage.
    assert.equal(sum.body.projected_units, 95);
    assert.equal(sum.body.projected_total_cents, 7900);

    const preview = await get(s.base, "/v1/billing/preview?customer_id=cus_1");
    assert.equal(preview.body.total_cents, 7900);
    assert.equal(preview.body.charged, false);
  } finally {
    await s.stop();
  }
});

test("deposits: hold → release over HTTP", async () => {
  const s = await startServer();
  try {
    const h = await post(s.base, "/v1/deposits/hold", {
      dispute_id: "dsp_1",
      customer_id: "cus_1",
      amount_cents: 2500,
    });
    assert.equal(h.status, 201);
    assert.equal(h.body.state, "held");
    const r = await post(s.base, `/v1/deposits/${h.body.id}/release`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "released");
    const again = await post(s.base, `/v1/deposits/${h.body.id}/forfeit`, {});
    assert.equal(again.status, 422);
  } finally {
    await s.stop();
  }
});

test("checkout + portal go through the Stripe client", async () => {
  const s = await startServer();
  try {
    const co = await post(s.base, "/v1/billing/checkout", {
      customer_id: "cus_1",
      plan_id: "standard",
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/no",
    });
    assert.equal(co.status, 200);
    assert.ok((co.body.url as string).startsWith("https://"));
    const po = await post(s.base, "/v1/billing/portal", {
      customer_id: "cus_1",
      return_url: "https://example.com/acct",
    });
    assert.equal(po.status, 200);
    const stub = s.opts.stripeClient as RecordingStripeClient;
    assert.equal(stub.calls.length, 2);
  } finally {
    await s.stop();
  }
});

test("usage summary for unknown customer → zeroed", async () => {
  const s = await startServer();
  try {
    const sum = await get(s.base, "/v1/usage/summary?customer_id=cus_nobody");
    assert.equal(sum.status, 200);
    assert.equal(sum.body.units_to_date, 0);
  } finally {
    await s.stop();
  }
});
