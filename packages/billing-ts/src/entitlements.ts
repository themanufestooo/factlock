/**
 * Entitlement checks (T13). Pure functions over subscription state — other
 * services (issuance, API) call these to gate paid surfaces.
 *
 * During the 7-day grace window the badge stays live (it shows the grace
 * notice; it never goes silently dark), but new issuance is paused until
 * payment recovers. After grace or on cancel, everything paid is off.
 */
import { badgeBillingState, type Clock } from "./subscriptions.js";
import type { Feature, Subscription } from "./types.js";

export function isEntitled(
  sub: Subscription | null,
  feature: Feature,
  clock: Clock = () => new Date(),
): boolean {
  if (!sub) return false;
  if (sub.status === "canceled") return false;
  if (sub.status === "active") return true;
  // past_due:
  const badge = badgeBillingState(sub, clock);
  if (badge === "lapsed") return false;
  // in grace:
  switch (feature) {
    case "badge":
    case "portal":
      return true; // badge stays live with a grace notice; portal for paying up
    case "issuance":
    case "api":
      return false; // no new paid work until payment recovers
  }
}
