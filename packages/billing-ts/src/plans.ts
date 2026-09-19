/**
 * Plan catalog (T13). Plans are DATA, not logic: the price a customer pays is
 * snapshotted onto their subscription at creation, so catalog edits (raising
 * the standard price, changing quotas) can never move an existing customer —
 * and founding customers are price-locked for life by construction.
 */
import type { PlanConfig, PlanId } from "./types.js";

export const GRACE_PERIOD_DAYS = 7;
export const DISPUTE_DEPOSIT_CENTS = 2500; // $25 refundable filing deposit

const CATALOG: Record<PlanId, PlanConfig> = {
  founding: {
    id: "founding",
    name: "Founding",
    price_cents: 4900, // $49/mo, locked forever
    included_api_units: 1000,
    overage_cents_per_unit: 5, // $0.05 / metered call
    price_locked: true,
  },
  standard: {
    id: "standard",
    name: "Standard",
    price_cents: 7900, // $79/mo
    included_api_units: 5000,
    overage_cents_per_unit: 3, // $0.03 / metered call
    price_locked: false,
  },
};

export function getPlan(id: PlanId): PlanConfig {
  const plan = CATALOG[id];
  if (!plan) throw new Error(`unknown plan ${id}`);
  return { ...plan };
}

/** Test hook: simulate a catalog price change (e.g. standard $79 → $99). */
export function setPlanPrice(id: PlanId, price_cents: number): void {
  CATALOG[id].price_cents = price_cents;
}

export function listPlans(): PlanConfig[] {
  return (Object.keys(CATALOG) as PlanId[]).map(getPlan);
}
