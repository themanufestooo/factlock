/**
 * Billing HTTP server (T13/T14) — node:http only.
 *
 *   POST /v1/billing/webhook                    Stripe webhook (raw body; signature-verified)
 *   POST /v1/billing/checkout {plan_id, success_url, cancel_url}  (customer)
 *   POST /v1/billing/portal   {return_url}                        (customer)
 *   GET  /v1/billing/status?customer_id=        (customer, own tenant only)
 *   GET  /v1/billing/preview?customer_id=[&month=]                 (customer, own tenant only)
 *   GET  /v1/plans                              public catalog
 *   POST /v1/api-keys                           issue key (customer, own tenant)
 *   POST /v1/api-keys/:id/revoke                (customer, own key)
 *   POST /v1/usage/ingest {key_id, endpoint, units, event_id}
 *        Authorization: Bearer <api_secret> — secret verified against the
 *        stored hash in constant time; key_id alone never authenticates.
 *        event_id makes ingestion idempotent (replay → 200, same record).
 *   GET  /v1/usage/summary?customer_id=[&month=]                   (customer, own tenant only)
 *   POST /v1/deposits/hold {dispute_id, customer_id, amount_cents} (service)
 *   POST /v1/deposits/:id/release | /forfeit                      (service)
 *   GET  /healthz                               public
 *
 * 401 = missing/invalid credential, 403 = cross-tenant or wrong role,
 * 404 = unknown id, 409 = event_id reused across keys.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import Stripe from "stripe";
import { getPlan, listPlans } from "./plans.js";
import {
  badgeBillingState,
  InMemorySubscriptionStore,
  type Clock,
  type SubscriptionStore,
} from "./subscriptions.js";
import { isEntitled } from "./entitlements.js";
import {
  forfeitDeposit,
  holdDeposit,
  InMemoryDepositStore,
  releaseDeposit,
  type DepositStore,
} from "./deposits.js";
import {
  ingestUsage,
  InMemoryMeteringStore,
  issueApiKey,
  monthOf,
  projectUnits,
  revokeApiKey,
  rollupMonth,
  type MeteringStore,
} from "./metering.js";
import { previewInvoice } from "./invoice.js";
import {
  handleWebhook,
  InMemoryCustomerStore,
  type CustomerStore,
  type WebhookDeps,
} from "./stripe.js";
import {
  authenticateBilling,
  enforceTenant,
  parseBillingTokens,
  requireBillingRole,
  type BillingAuthContext,
  type BillingTokenRecord,
} from "./auth.js";
import { BillingError, type Feature, type StripeClientLike } from "./types.js";

export interface BillingServerOptions {
  customers: CustomerStore;
  subscriptions: SubscriptionStore;
  metering: MeteringStore;
  deposits: DepositStore;
  stripeClient: StripeClientLike;
  stripe: Stripe; // for webhook signature verification
  webhookSecret: string;
  /** Bearer-token map; defaults to FACTLOCK_BILLING_TOKENS. */
  tokens?: Map<string, BillingTokenRecord>;
  clock?: Clock;
  maxBodyBytes?: number;
}

const FEATURES: Feature[] = ["badge", "issuance", "api", "portal"];

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BillingError("body_too_large", "request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerSecret(req: IncomingMessage): string {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    throw new BillingError("unauthorized", "Authorization: Bearer <api_secret> is required", 401);
  }
  return h.slice("Bearer ".length).trim();
}

export function createBillingServer(opts: BillingServerOptions): Server {
  const clock: Clock = opts.clock ?? (() => new Date());
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const tokens = opts.tokens ?? parseBillingTokens(process.env.FACTLOCK_BILLING_TOKENS);

  const webhookDeps: WebhookDeps = {
    stripe: opts.stripe,
    webhookSecret: opts.webhookSecret,
    customers: opts.customers,
    subscriptions: opts.subscriptions,
    clock,
  };

  const auth = (req: IncomingMessage): BillingAuthContext =>
    authenticateBilling(req.headers.authorization, tokens);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      // Stripe webhook needs the RAW body for signature verification.
      if (method === "POST" && path === "/v1/billing/webhook") {
        const raw = await readRaw(req, maxBody);
        const sig = req.headers["stripe-signature"] as string | undefined;
        const outcome = await handleWebhook(webhookDeps, raw, sig);
        json(res, 200, outcome);
        return;
      }

      if (method === "GET" && path === "/v1/plans") {
        json(res, 200, { plans: listPlans() });
        return;
      }

      if (method === "POST" && path === "/v1/billing/checkout") {
        const a = auth(req);
        const body = JSON.parse((await readRaw(req, maxBody)).toString("utf-8"));
        enforceTenant(a, a.customerId!);
        const customer = await opts.customers.get(a.customerId!);
        if (!customer) throw new BillingError("customer_not_found", "unknown customer", 404);
        const sub = await opts.subscriptions.getByCustomer(customer.id);
        const plan_id = body.plan_id;
        if (plan_id !== "founding" && plan_id !== "standard") {
          throw new BillingError("bad_plan", "plan_id must be founding|standard", 400);
        }
        const session = await opts.stripeClient.createCheckoutSession({
          customer_id: customer.id,
          plan_id,
          price_cents: sub?.price_cents ?? 0,
          success_url: body.success_url,
          cancel_url: body.cancel_url,
        });
        json(res, 200, session);
        return;
      }

      if (method === "POST" && path === "/v1/billing/portal") {
        const a = auth(req);
        const body = JSON.parse((await readRaw(req, maxBody)).toString("utf-8"));
        enforceTenant(a, a.customerId!);
        const customer = await opts.customers.get(a.customerId!);
        if (!customer) throw new BillingError("customer_not_found", "unknown customer", 404);
        const session = await opts.stripeClient.createPortalSession({
          customer_id: customer.id,
          return_url: body.return_url,
        });
        json(res, 200, session);
        return;
      }

      if (method === "GET" && path === "/v1/billing/status") {
        const a = auth(req);
        const customer_id = url.searchParams.get("customer_id");
        if (!customer_id) throw new BillingError("bad_request", "customer_id required", 400);
        enforceTenant(a, customer_id);
        const sub = await opts.subscriptions.getByCustomer(customer_id);
        const entitled = Object.fromEntries(
          FEATURES.map((f) => [f, isEntitled(sub, f, clock)]),
        );
        json(res, 200, {
          customer_id,
          subscription: sub,
          badge: badgeBillingState(sub, clock),
          entitled,
        });
        return;
      }

      if (method === "GET" && path === "/v1/billing/preview") {
        const a = auth(req);
        const customer_id = url.searchParams.get("customer_id");
        if (!customer_id) throw new BillingError("bad_request", "customer_id required", 400);
        enforceTenant(a, customer_id);
        const month = url.searchParams.get("month") ?? undefined;
        const sub = await opts.subscriptions.getByCustomer(customer_id);
        json(res, 200, await previewInvoice(opts.metering, sub, customer_id, month, clock));
        return;
      }

      if (method === "POST" && path === "/v1/api-keys") {
        const a = auth(req);
        const body = JSON.parse((await readRaw(req, maxBody)).toString("utf-8"));
        // The key is issued for the token's own tenant — a forged
        // customer_id in the body is ignored.
        enforceTenant(a, a.customerId!);
        const { key, secret } = await issueApiKey(opts.metering, a.customerId!, clock);
        json(res, 201, { key_id: key.id, prefix: key.prefix, secret });
        return;
      }

      {
        const m = path.match(/^\/v1\/api-keys\/([^/]+)\/revoke$/);
        if (method === "POST" && m) {
          const a = auth(req);
          const key = await opts.metering.getKey(m[1]);
          if (!key) throw new BillingError("key_not_found", "unknown API key", 404);
          enforceTenant(a, key.customer_id);
          json(res, 200, await revokeApiKey(opts.metering, m[1], clock));
          return;
        }
      }

      if (method === "POST" && path === "/v1/usage/ingest") {
        // Key-scoped authentication: the metered API key's secret itself, as
        // `Authorization: Bearer <secret>`, verified against the stored hash
        // in constant time. This is intentionally NOT the service-role
        // operator token (FACTLOCK_BILLING_TOKENS): usage is reported by the
        // key holder and bound to that key, while the service role is
        // reserved for deposit hold/release. A key_id alone never
        // authenticates.
        const secret = bearerSecret(req);
        const body = JSON.parse((await readRaw(req, maxBody)).toString("utf-8"));
        const { record, duplicate } = await ingestUsage(
          opts.metering,
          {
            key_id: body.key_id,
            secret,
            endpoint: body.endpoint,
            units: body.units,
            event_id: body.event_id,
          },
          clock,
        );
        json(res, duplicate ? 200 : 201, { id: record.id, at: record.at, duplicate });
        return;
      }

      if (method === "GET" && path === "/v1/usage/summary") {
        const a = auth(req);
        const customer_id = url.searchParams.get("customer_id");
        if (!customer_id) throw new BillingError("bad_request", "customer_id required", 400);
        enforceTenant(a, customer_id);
        const month = url.searchParams.get("month") ?? monthOf(clock());
        const sub = await opts.subscriptions.getByCustomer(customer_id);
        const rollup = await rollupMonth(opts.metering, customer_id, month, clock);
        const plan = sub ? getPlan(sub.plan_id) : null;
        const included = plan?.included_api_units ?? 0;
        const overage_units = Math.max(0, rollup.total_units - included);
        const projected_units = projectUnits(rollup.total_units, clock());
        const projected_overage = Math.max(0, projected_units - included);
        json(res, 200, {
          customer_id,
          month,
          units_to_date: rollup.total_units,
          units_by_endpoint: rollup.units_by_endpoint,
          included_units: included,
          overage_units_to_date: overage_units,
          projected_units,
          projected_total_cents:
            (sub?.price_cents ?? 0) + projected_overage * (plan?.overage_cents_per_unit ?? 0),
          plan_id: sub?.plan_id ?? null,
        });
        return;
      }

      if (method === "POST" && path === "/v1/deposits/hold") {
        const a = auth(req);
        requireBillingRole(a, "service");
        const body = JSON.parse((await readRaw(req, maxBody)).toString("utf-8"));
        const entry = await holdDeposit(
          opts.deposits,
          body.dispute_id,
          body.customer_id,
          body.amount_cents,
          clock,
        );
        json(res, 201, entry);
        return;
      }

      {
        const m = path.match(/^\/v1\/deposits\/([^/]+)\/(release|forfeit)$/);
        if (method === "POST" && m) {
          const a = auth(req);
          requireBillingRole(a, "service");
          const entry =
            m[2] === "release"
              ? await releaseDeposit(opts.deposits, m[1], clock)
              : await forfeitDeposit(opts.deposits, m[1], clock);
          json(res, 200, entry);
          return;
        }
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof BillingError) {
        json(res, err.httpStatus, { error: err.code, message: err.message });
      } else if (err instanceof SyntaxError) {
        json(res, 400, { error: "bad_json", message: "invalid JSON body" });
      } else {
        json(res, 500, { error: "internal", message: "internal error" });
      }
    }
  });
}

export {
  InMemoryCustomerStore,
  InMemoryDepositStore,
  InMemoryMeteringStore,
  InMemorySubscriptionStore,
};
