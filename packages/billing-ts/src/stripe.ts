/**
 * Stripe integration (T13). ALL Stripe calls go through `StripeClientLike`;
 * tests use a stub that records calls. Webhook signature verification uses
 * the official `stripe` package's `webhooks.constructEvent`, which is pure
 * HMAC — fully offline, no network in tests or in the verify path.
 *
 * Handled events:
 *   checkout.session.completed      → create subscription (plan/customer from metadata)
 *   customer.subscription.updated   → sync status (active/past_due/canceled)
 *   customer.subscription.deleted   → canceled
 *   invoice.payment_failed          → past_due + 7-day grace
 *   invoice.paid                    → payment recovered (active, grace cleared)
 */
import Stripe from "stripe";
import {
  applyCanceled,
  applyPaymentFailed,
  applyPaymentRecovered,
  bindStripeSubscription,
  createSubscription,
  setStatus,
  type Clock,
  type SubscriptionStore,
} from "./subscriptions.js";
import type { Customer, PlanId, StripeClientLike, Subscription } from "./types.js";
import { BillingError } from "./types.js";

export type { StripeClientLike };

export interface CustomerStore {
  get(id: string): Promise<Customer | null>;
  save(customer: Customer): Promise<void>;
}

export class InMemoryCustomerStore implements CustomerStore {
  private customers = new Map<string, Customer>();
  async get(id: string) {
    return this.customers.get(id) ?? null;
  }
  async save(customer: Customer) {
    this.customers.set(customer.id, { ...customer });
  }
}

export interface WebhookDeps {
  stripe: Stripe;
  webhookSecret: string;
  customers: CustomerStore;
  subscriptions: SubscriptionStore;
  clock?: Clock;
}

export interface WebhookOutcome {
  handled: boolean;
  event: string;
  subscription_id: string | null;
}

/**
 * Verify the Stripe signature header over the RAW request body and route the
 * event. Throws BillingError(400, "invalid_signature") on tampering —
 * unverifiable payloads are rejected before any state changes.
 */
export async function handleWebhook(
  deps: WebhookDeps,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
): Promise<WebhookOutcome> {
  if (!signatureHeader) {
    throw new BillingError("missing_signature", "stripe-signature header required", 400);
  }
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signatureHeader, deps.webhookSecret);
  } catch {
    throw new BillingError("invalid_signature", "webhook signature verification failed", 400);
  }
  const clock = deps.clock ?? (() => new Date());

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const customer_id = session.metadata?.customer_id;
      const plan_id = session.metadata?.plan_id as PlanId | undefined;
      if (!customer_id || (plan_id !== "founding" && plan_id !== "standard")) {
        throw new BillingError("bad_metadata", "checkout session missing customer_id/plan_id", 400);
      }
      const customer = await deps.customers.get(customer_id);
      if (!customer) throw new BillingError("customer_not_found", "unknown customer", 404);
      const stripeSubId =
        typeof session.subscription === "string" ? session.subscription : null;
      let sub = await deps.subscriptions.getByCustomer(customer_id);
      if (!sub) {
        sub = await createSubscription(deps.subscriptions, customer, plan_id, clock);
      }
      if (stripeSubId) sub = await bindStripeSubscription(deps.subscriptions, sub, stripeSubId);
      return { handled: true, event: event.type, subscription_id: sub.id };
    }

    case "customer.subscription.updated": {
      const s = event.data.object as Stripe.Subscription;
      const sub = await deps.subscriptions.getByStripeId(s.id);
      if (!sub) return { handled: false, event: event.type, subscription_id: null };
      const stripeStatus = s.status;
      let next: Subscription = sub;
      if (stripeStatus === "active" || stripeStatus === "trialing") {
        next = sub.status === "past_due"
          ? await applyPaymentRecovered(deps.subscriptions, sub)
          : sub;
      } else if (stripeStatus === "past_due" || stripeStatus === "unpaid") {
        next = await applyPaymentFailed(deps.subscriptions, sub, clock);
      } else if (
        stripeStatus === "canceled" ||
        stripeStatus === "incomplete_expired"
      ) {
        next = await applyCanceled(deps.subscriptions, sub);
      } else {
        await deps.subscriptions.save(setStatus(sub, sub.status));
      }
      return { handled: true, event: event.type, subscription_id: next.id };
    }

    case "customer.subscription.deleted": {
      const s = event.data.object as Stripe.Subscription;
      const sub = await deps.subscriptions.getByStripeId(s.id);
      if (!sub) return { handled: false, event: event.type, subscription_id: null };
      const next = await applyCanceled(deps.subscriptions, sub);
      return { handled: true, event: event.type, subscription_id: next.id };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // `subscription` is present on invoice webhook payloads across API
      // versions; the v18 TS types renamed the field, so read it loosely.
      const stripeSubId =
        typeof (invoice as unknown as { subscription?: unknown }).subscription === "string"
          ? ((invoice as unknown as { subscription: string }).subscription)
          : null;
      if (!stripeSubId) return { handled: false, event: event.type, subscription_id: null };
      const sub = await deps.subscriptions.getByStripeId(stripeSubId);
      if (!sub) return { handled: false, event: event.type, subscription_id: null };
      const next = await applyPaymentFailed(deps.subscriptions, sub, clock);
      return { handled: true, event: event.type, subscription_id: next.id };
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeSubId =
        typeof (invoice as unknown as { subscription?: unknown }).subscription === "string"
          ? ((invoice as unknown as { subscription: string }).subscription)
          : null;
      if (!stripeSubId) return { handled: false, event: event.type, subscription_id: null };
      const sub = await deps.subscriptions.getByStripeId(stripeSubId);
      if (!sub || sub.status !== "past_due") {
        return { handled: false, event: event.type, subscription_id: sub?.id ?? null };
      }
      const next = await applyPaymentRecovered(deps.subscriptions, sub);
      return { handled: true, event: event.type, subscription_id: next.id };
    }

    default:
      return { handled: false, event: event.type, subscription_id: null };
  }
}

/** Test double: records every Stripe call so tests can assert call counts. */
export class RecordingStripeClient implements StripeClientLike {
  calls: Array<{ method: string; params: unknown }> = [];
  nextUrl = "https://checkout.stripe.test/session_123";
  async createCheckoutSession(params: {
    customer_id: string;
    plan_id: PlanId;
    price_cents: number;
    success_url: string;
    cancel_url: string;
  }) {
    this.calls.push({ method: "createCheckoutSession", params });
    return { id: "cs_test_123", url: this.nextUrl };
  }
  async createPortalSession(params: { customer_id: string; return_url: string }) {
    this.calls.push({ method: "createPortalSession", params });
    return { id: "bps_test_123", url: "https://billing.stripe.test/portal_123" };
  }
}
