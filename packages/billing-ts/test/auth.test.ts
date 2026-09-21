/**
 * Billing auth tests (audit H-05): bearer tokens, tenant isolation, API
 * secret verification, and idempotent usage ingestion.
 * Run compiled: node --test dist/test/auth.test.js
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
  ingestUsage,
  issueApiKey,
  BillingError,
  type BillingServerOptions,
  type BillingTokenRecord,
  type Customer,
} from "../src/index.js";

const SECRET = "whsec_test_auth_abcdef1234567890";
const CLOCK = () => new Date("2026-09-19T12:00:00.000Z");
const stripe = new Stripe("sk_test_123");

const CUSTOMER_TOKEN = "billing_test_customer_token_0123456789";
const OTHER_CUSTOMER_TOKEN = "billing_test_other_customer_0123456789";
const SERVICE_TOKEN = "billing_test_service_token_0123456789";

function billingTokens(): Map<string, BillingTokenRecord> {
  return new Map([
    [CUSTOMER_TOKEN, { roles: ["customer"], customer_id: "cus_1" }],
    [OTHER_CUSTOMER_TOKEN, { roles: ["customer"], customer_id: "cus_2" }],
    [SERVICE_TOKEN, { roles: ["service"] }],
  ]);
}

function customer(id: string): Customer {
  return {
    id,
    business_id: "biz_1",
    email: "owner@example.com",
    stripe_customer_id: `cus_stripe_${id}`,
    created_at: "2026-09-19T12:00:00.000Z",
  };
}

async function startServer() {
  const customers = new InMemoryCustomerStore();
  await customers.save(customer("cus_1"));
  await customers.save(customer("cus_2"));
  const opts: BillingServerOptions = {
    customers,
    subscriptions: new InMemorySubscriptionStore(),
    metering: new InMemoryMeteringStore(),
    deposits: new InMemoryDepositStore(),
    stripeClient: new RecordingStripeClient(),
    stripe,
    webhookSecret: SECRET,
    tokens: billingTokens(),
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

const asCustomer = { authorization: `Bearer ${CUSTOMER_TOKEN}` };
const asOther = { authorization: `Bearer ${OTHER_CUSTOMER_TOKEN}` };
const asService = { authorization: `Bearer ${SERVICE_TOKEN}` };

async function req(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("unauthenticated customer endpoints → 401; plans stay public", async () => {
  const s = await startServer();
  try {
    for (const [method, path] of [
      ["GET", "/v1/billing/status?customer_id=cus_1"],
      ["GET", "/v1/billing/preview?customer_id=cus_1"],
      ["POST", "/v1/api-keys"],
      ["GET", "/v1/usage/summary?customer_id=cus_1"],
      ["POST", "/v1/deposits/hold"],
    ] as const) {
      const r = await req(s.base, method, path, {}, method === "POST" ? {} : undefined);
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.body.error, "unauthorized");
    }
    const plans = await req(s.base, "GET", "/v1/plans");
    assert.equal(plans.status, 200);
  } finally {
    await s.stop();
  }
});

test("cross-tenant access → 403", async () => {
  const s = await startServer();
  try {
    const st = await req(s.base, "GET", "/v1/billing/status?customer_id=cus_2", asCustomer);
    assert.equal(st.status, 403);
    assert.equal(st.body.error, "forbidden");

    const sum = await req(s.base, "GET", "/v1/usage/summary?customer_id=cus_2", asCustomer);
    assert.equal(sum.status, 403);

    // The reverse direction is blocked too.
    const own = await req(s.base, "GET", "/v1/billing/status?customer_id=cus_2", asOther);
    assert.equal(own.status, 200);
  } finally {
    await s.stop();
  }
});

test("forged customer_id in key issuance is ignored — key binds to the token's tenant", async () => {
  const s = await startServer();
  try {
    const k = await req(s.base, "POST", "/v1/api-keys", asCustomer, { customer_id: "cus_2" });
    assert.equal(k.status, 201);
    const stored = await s.opts.metering.getKey(k.body.key_id as string);
    assert.equal(stored?.customer_id, "cus_1");
  } finally {
    await s.stop();
  }
});

test("usage ingest: key_id alone fails; wrong secret fails; right secret works", async () => {
  const s = await startServer();
  try {
    const k = await req(s.base, "POST", "/v1/api-keys", asCustomer, {});
    const key_id = k.body.key_id as string;
    const secret = k.body.secret as string;

    // No credential at all → 401.
    const none = await req(s.base, "POST", "/v1/usage/ingest", {}, { key_id, endpoint: "verify", units: 1, event_id: "e1" });
    assert.equal(none.status, 401);

    // key_id alone (wrong/missing secret) → 401.
    const wrong = await req(s.base, "POST", "/v1/usage/ingest", { authorization: "Bearer wrong_secret_value" }, { key_id, endpoint: "verify", units: 1, event_id: "e1" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "invalid_api_secret");

    // A valid customer token is NOT an API secret → 401.
    const custTok = await req(s.base, "POST", "/v1/usage/ingest", asCustomer, { key_id, endpoint: "verify", units: 1, event_id: "e1" });
    assert.equal(custTok.status, 401);

    // The real secret works.
    const ok = await req(
      s.base,
      "POST",
      "/v1/usage/ingest",
      { authorization: `Bearer ${secret}` },
      { key_id, endpoint: "verify", units: 3, event_id: "e1" },
    );
    assert.equal(ok.status, 201);
    assert.equal(ok.body.duplicate, false);
  } finally {
    await s.stop();
  }
});

test("usage ingest: duplicate event_id is processed once (replay → 200, same record)", async () => {
  const s = await startServer();
  try {
    const k = await req(s.base, "POST", "/v1/api-keys", asCustomer, {});
    const key_id = k.body.key_id as string;
    const secret = k.body.secret as string;
    const authz = { authorization: `Bearer ${secret}` };

    const first = await req(s.base, "POST", "/v1/usage/ingest", authz, { key_id, endpoint: "verify", units: 5, event_id: "evt_once" });
    assert.equal(first.status, 201);

    const replay = await req(s.base, "POST", "/v1/usage/ingest", authz, { key_id, endpoint: "verify", units: 5, event_id: "evt_once" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.id, first.body.id);

    // A DIFFERENT event is still recorded.
    const second = await req(s.base, "POST", "/v1/usage/ingest", authz, { key_id, endpoint: "verify", units: 5, event_id: "evt_twice" });
    assert.equal(second.status, 201);

    const sum = await req(s.base, "GET", "/v1/usage/summary?customer_id=cus_1", asCustomer);
    assert.equal(sum.body.units_to_date, 10); // 5 + 5, not 15
  } finally {
    await s.stop();
  }
});

test("usage ingest: event_id reuse across keys → 409", async () => {
  const s = await startServer();
  try {
    const k1 = await req(s.base, "POST", "/v1/api-keys", asCustomer, {});
    const k2 = await req(s.base, "POST", "/v1/api-keys", asCustomer, {});
    const a1 = { authorization: `Bearer ${k1.body.secret}` };
    const a2 = { authorization: `Bearer ${k2.body.secret}` };

    const r1 = await req(s.base, "POST", "/v1/usage/ingest", a1, { key_id: k1.body.key_id, endpoint: "verify", units: 1, event_id: "shared_evt" });
    assert.equal(r1.status, 201);
    const r2 = await req(s.base, "POST", "/v1/usage/ingest", a2, { key_id: k2.body.key_id, endpoint: "verify", units: 1, event_id: "shared_evt" });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, "event_id_conflict");
  } finally {
    await s.stop();
  }
});

test("usage ingest: revoked key → 403 even with the right secret", async () => {
  const s = await startServer();
  try {
    const k = await req(s.base, "POST", "/v1/api-keys", asCustomer, {});
    const key_id = k.body.key_id as string;
    const authz = { authorization: `Bearer ${k.body.secret}` };
    const rev = await req(s.base, "POST", `/v1/api-keys/${key_id}/revoke`, asCustomer, {});
    assert.equal(rev.status, 200);
    const ing = await req(s.base, "POST", "/v1/usage/ingest", authz, { key_id, endpoint: "verify", units: 1, event_id: "e_rev" });
    assert.equal(ing.status, 403);
    assert.equal(ing.body.error, "key_revoked");
  } finally {
    await s.stop();
  }
});

test("deposits require the service role — customer tokens → 403", async () => {
  const s = await startServer();
  try {
    const denied = await req(s.base, "POST", "/v1/deposits/hold", asCustomer, {
      dispute_id: "dsp_1",
      customer_id: "cus_1",
      amount_cents: 2500,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "forbidden");

    const allowed = await req(s.base, "POST", "/v1/deposits/hold", asService, {
      dispute_id: "dsp_1",
      customer_id: "cus_1",
      amount_cents: 2500,
    });
    assert.equal(allowed.status, 201);
  } finally {
    await s.stop();
  }
});

test("domain: ingestUsage is idempotent at the store level", async () => {
  const store = new InMemoryMeteringStore();
  const { key, secret } = await issueApiKey(store, "cus_1", CLOCK);
  const input = { key_id: key.id, secret, endpoint: "verify", units: 2, event_id: "dom_once" };
  const first = await ingestUsage(store, input, CLOCK);
  assert.equal(first.duplicate, false);
  const second = await ingestUsage(store, input, CLOCK);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.id, first.record.id);

  const month = await store.usageForMonth("cus_1", "2026-09");
  assert.equal(month.length, 1);
  assert.equal(month[0].units, 2);

  // Processed-event ledger persists the dedupe key.
  const evt = await store.getProcessedEvent("dom_once");
  assert.equal(evt?.record.id, first.record.id);

  // Wrong secret is rejected at the domain layer too.
  await assert.rejects(
    ingestUsage(store, { ...input, secret: "nope", event_id: "dom_other" }, CLOCK),
    (e: unknown) => e instanceof BillingError && e.httpStatus === 401,
  );
});
