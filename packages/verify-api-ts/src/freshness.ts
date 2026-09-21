/**
 * Freshness verdicts (T6) — spec §2, §5 step 4.
 *
 * AGING begins at 70% of the re-verification interval, STALE at 100%.
 * Past valid_until the attestation is rejected outright, never silently trusted.
 * The verdict always carries the age. Computed from verified_at + interval —
 * never from client input.
 */
import { CLAIM_INTERVAL_DAYS } from "@factlock/issuer";
import type { FreshnessVerdict } from "./types.js";

const DAY_MS = 86_400_000;

export function verdictFor(ageMs: number, intervalMs: number): FreshnessVerdict {
  const ratio = ageMs / intervalMs;
  if (ratio >= 1) return "STALE";
  if (ratio >= 0.7) return "AGING";
  return "FRESH";
}

/** Per-claim freshness against the §2 re-verification table. */
export function claimFreshness(
  claims: Array<Record<string, unknown>>,
  verifiedAtMs: number,
  nowMs: number,
): Array<{ type: string; item?: string; age_days: number; interval_days: number; verdict: FreshnessVerdict }> {
  return claims.map((c) => {
    const type = String(c.type ?? "unknown");
    const intervalDays = CLAIM_INTERVAL_DAYS[type] ?? 30;
    const ageMs = nowMs - verifiedAtMs;
    return {
      type,
      ...(typeof c.item === "string" ? { item: c.item } : {}),
      age_days: Math.floor(ageMs / DAY_MS),
      interval_days: intervalDays,
      verdict: verdictFor(ageMs, intervalDays * DAY_MS),
    };
  });
}

/**
 * Attestation-level freshness: the interval is the attestation's own
 * verified_at → valid_until span (the issuer sets it to the shortest claim
 * interval), so no external table is needed and drift is impossible.
 */
export function attestationFreshness(
  verifiedAtMs: number,
  validUntilMs: number,
  nowMs: number,
): { verdict: FreshnessVerdict; age_days: number; interval_days: number; expired: boolean } {
  const intervalMs = validUntilMs - verifiedAtMs;
  const ageMs = nowMs - verifiedAtMs;
  return {
    verdict: verdictFor(ageMs, intervalMs),
    age_days: Math.floor(ageMs / DAY_MS),
    interval_days: intervalMs / DAY_MS,
    expired: nowMs > validUntilMs,
  };
}
