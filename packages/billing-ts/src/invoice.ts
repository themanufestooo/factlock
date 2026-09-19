/**
 * Invoice preview (T14): compute what a customer WOULD be charged for a month
 * without charging anything. Pure function over subscription + usage — the
 * Stripe stub in tests asserts zero outbound calls during preview.
 */
import { getPlan } from "./plans.js";
import { monthOf, rollupMonth, type Clock, type MeteringStore } from "./metering.js";
import type { InvoicePreview, Subscription } from "./types.js";

export async function previewInvoice(
  metering: MeteringStore,
  sub: Subscription | null,
  customer_id: string,
  month?: string,
  clock: Clock = () => new Date(),
): Promise<InvoicePreview> {
  const now = clock();
  const m = month ?? monthOf(now);
  if (!sub) {
    return {
      customer_id,
      month: m,
      plan_id: "standard",
      plan_name: "Standard",
      base_cents: 0,
      subscription_status: "canceled",
      usage_units: 0,
      included_units: 0,
      overage_units: 0,
      overage_cents: 0,
      total_cents: 0,
      charged: false,
    };
  }
  const plan = getPlan(sub.plan_id);
  const rollup = await rollupMonth(metering, customer_id, m, clock);
  const overage_units = Math.max(0, rollup.total_units - plan.included_api_units);
  const overage_cents = overage_units * plan.overage_cents_per_unit;
  return {
    customer_id,
    month: m,
    plan_id: sub.plan_id,
    plan_name: plan.name,
    base_cents: sub.price_cents, // locked price, not the catalog price
    subscription_status: sub.status,
    usage_units: rollup.total_units,
    included_units: plan.included_api_units,
    overage_units,
    overage_cents,
    total_cents: sub.price_cents + overage_cents,
    charged: false,
  };
}
