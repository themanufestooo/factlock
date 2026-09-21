/**
 * Re-verification scheduler (T12).
 *
 * Not a daemon: `dueForReverification(now)` scans attestations and returns
 * those past 70% of their re-verification interval (the AGING threshold,
 * spec §8), most urgent first. The CLI script runs it on a cron schedule.
 */
import type { Attestation } from "@factlock/issuer";
import type { DueAttestation } from "./types.js";

const DUE_FRACTION = 0.7;

export function dueForReverification(
  now: Date,
  attestations: Attestation[],
): DueAttestation[] {
  const nowMs = now.getTime();
  const due: DueAttestation[] = [];
  for (const a of attestations) {
    const verifiedMs = new Date(a.verified_at).getTime();
    const untilMs = new Date(a.valid_until).getTime();
    if (!Number.isFinite(verifiedMs) || !Number.isFinite(untilMs) || untilMs <= verifiedMs) {
      continue; // malformed interval — skip rather than crash the run
    }
    const intervalMs = untilMs - verifiedMs;
    const fraction = (nowMs - verifiedMs) / intervalMs;
    if (fraction >= DUE_FRACTION) {
      due.push({
        attestation_id: a.attestation_id,
        business_id: String((a.subject as Record<string, unknown>).business_id ?? ""),
        fraction_elapsed: Math.round(fraction * 10_000) / 10_000,
        age_days: Math.floor((nowMs - verifiedMs) / 86_400_000),
        interval_days: Math.round(intervalMs / 86_400_000),
      });
    }
  }
  // Most urgent first.
  due.sort((x, y) => y.fraction_elapsed - x.fraction_elapsed);
  return due;
}

export { DUE_FRACTION };
