/**
 * Billing domain types (T13/T14). Money is integer cents everywhere.
 * All timestamps are ISO-8601 UTC strings; time comes from an injected
 * clock so tests can pin it.
 */

export type PlanId = "founding" | "standard";

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Monthly base price in cents — snapshotted onto the subscription at creation. */
  price_cents: number;
  /** Metered API units included per month before overage. */
  included_api_units: number;
  /** Overage price per metered unit, in cents. */
  overage_cents_per_unit: number;
  /** Founding plan: price is locked for life, immune to catalog changes. */
  price_locked: boolean;
}

export type SubscriptionStatus = "active" | "past_due" | "canceled";

export interface Subscription {
  id: string;
  customer_id: string;
  plan_id: PlanId;
  /** Locked at creation — the founding-price guarantee. */
  price_cents: number;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  /** Set on failed payment; badge lapses after this passes. */
  grace_until: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
}

export type BadgeBillingState = "active" | "grace" | "lapsed";

export interface Customer {
  id: string;
  business_id: string;
  email: string;
  stripe_customer_id: string | null;
  created_at: string;
}

export type Feature = "badge" | "issuance" | "api" | "portal";

export interface ApiKey {
  id: string;
  customer_id: string;
  /** Public prefix shown in dashboards; the secret is shown once at creation. */
  prefix: string;
  secret_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export interface UsageRecord {
  id: string;
  key_id: string;
  customer_id: string;
  endpoint: string;
  units: number;
  at: string;
}

/**
 * Idempotency ledger entry (audit H-05): the caller-supplied event_id is
 * the dedupe key. The first ingest wins; replays return the stored record.
 */
export interface ProcessedEvent {
  event_id: string;
  record: UsageRecord;
  processed_at: string;
}

export interface MonthlyRollup {
  customer_id: string;
  month: string; // "YYYY-MM"
  units_by_endpoint: Record<string, number>;
  total_units: number;
  recomputed_at: string;
}

export type DepositState = "held" | "released" | "forfeited";

export interface DepositEntry {
  id: string;
  dispute_id: string; // opaque — ties to @factlock/ops dispute ids
  customer_id: string;
  amount_cents: number;
  state: DepositState;
  created_at: string;
  settled_at: string | null;
}

export interface InvoicePreview {
  customer_id: string;
  month: string;
  plan_id: PlanId;
  plan_name: string;
  base_cents: number;
  subscription_status: SubscriptionStatus;
  usage_units: number;
  included_units: number;
  overage_units: number;
  overage_cents: number;
  total_cents: number;
  /** Preview is computed locally — it never touches Stripe. */
  charged: false;
}

export interface UsageSummary {
  customer_id: string;
  month: string;
  units_to_date: number;
  included_units: number;
  overage_units_to_date: number;
  projected_units: number;
  projected_total_cents: number;
  plan_id: PlanId;
}

/** Minimal Stripe surface we actually use — everything else is out of scope. */
export interface StripeClientLike {
  createCheckoutSession(params: {
    customer_id: string;
    plan_id: PlanId;
    price_cents: number;
    success_url: string;
    cancel_url: string;
  }): Promise<{ id: string; url: string }>;
  createPortalSession(params: {
    customer_id: string;
    return_url: string;
  }): Promise<{ id: string; url: string }>;
}

export class BillingError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
