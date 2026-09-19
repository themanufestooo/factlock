/**
 * Subscription lifecycle (T13).
 *
 *   active --(invoice.payment_failed)--> past_due (grace_until = +7d)
 *   past_due --(payment recovered)--> active (grace cleared)
 *   past_due --(grace expires)--> badge "lapsed" (subscription stays past_due
 *                                  until Stripe reports updated/deleted)
 *   any --(customer.subscription.deleted)--> canceled
 *
 * The badge NEVER goes silently dark: failed payment → 7-day grace → the
 * badge shows "verification lapsed", not a silent 404.
 */
import { randomUUID } from "node:crypto";
import { GRACE_PERIOD_DAYS, getPlan } from "./plans.js";
import type {
  BadgeBillingState,
  Customer,
  PlanId,
  Subscription,
  SubscriptionStatus,
} from "./types.js";
import { BillingError } from "./types.js";

export type Clock = () => Date;

export interface SubscriptionStore {
  get(id: string): Promise<Subscription | null>;
  getByCustomer(customer_id: string): Promise<Subscription | null>;
  getByStripeId(stripe_subscription_id: string): Promise<Subscription | null>;
  save(sub: Subscription): Promise<void>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private subs = new Map<string, Subscription>();
  async get(id: string) {
    return this.subs.get(id) ?? null;
  }
  async getByCustomer(customer_id: string) {
    for (const s of this.subs.values()) if (s.customer_id === customer_id) return s;
    return null;
  }
  async getByStripeId(stripe_subscription_id: string) {
    for (const s of this.subs.values())
      if (s.stripe_subscription_id === stripe_subscription_id) return s;
    return null;
  }
  async save(sub: Subscription) {
    this.subs.set(sub.id, { ...sub });
  }
}

function iso(d: Date): string {
  return d.toISOString();
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export async function createSubscription(
  store: SubscriptionStore,
  customer: Customer,
  plan_id: PlanId,
  clock: Clock = () => new Date(),
): Promise<Subscription> {
  const existing = await store.getByCustomer(customer.id);
  if (existing && existing.status !== "canceled") {
    throw new BillingError("subscription_exists", "customer already has a subscription", 409);
  }
  const plan = getPlan(plan_id);
  const now = clock();
  const sub: Subscription = {
    id: `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    customer_id: customer.id,
    plan_id,
    price_cents: plan.price_cents, // locked at creation — the founding guarantee
    status: "active",
    current_period_start: iso(now),
    current_period_end: iso(addDays(now, 30)),
    grace_until: null,
    stripe_subscription_id: null,
    created_at: iso(now),
  };
  await store.save(sub);
  return sub;
}

/** checkout.session.completed → bind the Stripe subscription id. */
export async function bindStripeSubscription(
  store: SubscriptionStore,
  sub: Subscription,
  stripe_subscription_id: string,
): Promise<Subscription> {
  const next = { ...sub, stripe_subscription_id };
  await store.save(next);
  return next;
}

/** invoice.payment_failed → past_due with a 7-day grace window. */
export async function applyPaymentFailed(
  store: SubscriptionStore,
  sub: Subscription,
  clock: Clock = () => new Date(),
): Promise<Subscription> {
  if (sub.status === "canceled") return sub;
  const next: Subscription = {
    ...sub,
    status: "past_due",
    grace_until: iso(addDays(clock(), GRACE_PERIOD_DAYS)),
  };
  await store.save(next);
  return next;
}

/** Payment recovered (invoice.paid / subscription.updated back to active). */
export async function applyPaymentRecovered(
  store: SubscriptionStore,
  sub: Subscription,
): Promise<Subscription> {
  const next: Subscription = { ...sub, status: "active", grace_until: null };
  await store.save(next);
  return next;
}

export async function applyCanceled(
  store: SubscriptionStore,
  sub: Subscription,
): Promise<Subscription> {
  const next: Subscription = { ...sub, status: "canceled", grace_until: null };
  await store.save(next);
  return next;
}

export function setStatus(
  sub: Subscription,
  status: SubscriptionStatus,
): Subscription {
  return { ...sub, status, grace_until: status === "active" ? null : sub.grace_until };
}

/** What should the badge show for this subscription's billing state? */
export function badgeBillingState(
  sub: Subscription | null,
  clock: Clock = () => new Date(),
): BadgeBillingState {
  if (!sub || sub.status === "canceled") return "lapsed";
  if (sub.status === "past_due") {
    if (sub.grace_until && clock() < new Date(sub.grace_until)) return "grace";
    return "lapsed";
  }
  return "active";
}
