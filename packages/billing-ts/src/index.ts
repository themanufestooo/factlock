/** Veritas billing — Stripe subscriptions, metered API billing, dispute deposits (T13/T14). */
export { getPlan, listPlans, setPlanPrice, GRACE_PERIOD_DAYS, DISPUTE_DEPOSIT_CENTS } from "./plans.js";
export {
  createSubscription,
  bindStripeSubscription,
  applyPaymentFailed,
  applyPaymentRecovered,
  applyCanceled,
  setStatus,
  badgeBillingState,
  InMemorySubscriptionStore,
} from "./subscriptions.js";
export type { Clock, SubscriptionStore } from "./subscriptions.js";
export { isEntitled } from "./entitlements.js";
export {
  holdDeposit,
  releaseDeposit,
  forfeitDeposit,
  InMemoryDepositStore,
} from "./deposits.js";
export type { DepositStore } from "./deposits.js";
export {
  issueApiKey,
  revokeApiKey,
  ingestUsage,
  rollupMonth,
  reconcile,
  monthOf,
  projectUnits,
  InMemoryMeteringStore,
} from "./metering.js";
export type { MeteringStore } from "./metering.js";
export { previewInvoice } from "./invoice.js";
export {
  handleWebhook,
  InMemoryCustomerStore,
  RecordingStripeClient,
} from "./stripe.js";
export type { CustomerStore, StripeClientLike, WebhookDeps, WebhookOutcome } from "./stripe.js";
export { createBillingServer } from "./server.js";
export type { BillingServerOptions } from "./server.js";
export { BillingError } from "./types.js";
export type {
  PlanId,
  PlanConfig,
  Subscription,
  SubscriptionStatus,
  BadgeBillingState,
  Customer,
  Feature,
  ApiKey,
  UsageRecord,
  MonthlyRollup,
  DepositEntry,
  DepositState,
  InvoicePreview,
  UsageSummary,
} from "./types.js";
