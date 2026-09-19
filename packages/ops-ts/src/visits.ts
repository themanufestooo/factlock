/**
 * Verifier visits (T9).
 *
 * Rules enforced (spec §3):
 *  - the business must exist in the directory;
 *  - the visit GPS must be within 500 m of the registered coordinates;
 *  - any price claim on the checklist requires photo evidence_refs.
 * arrived_at is stamped from the server clock; device_time is metadata only.
 */
import { haversineMeters, MAX_DISTANCE_M } from "./geo.js";
import { OpsError, type VerifierAccuracy, type Visit, type VisitInput } from "./types.js";
import type {
  BusinessDirectory,
  DisputeStore,
  VisitStore,
} from "./stores.js";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

let visitSeq = 0;
export function newVisitId(nowMs: number): string {
  visitSeq += 1;
  return `vst_${nowMs.toString(36)}_${String(visitSeq).padStart(4, "0")}`;
}

export interface VisitDeps {
  directory: BusinessDirectory;
  visits: VisitStore;
  disputes: DisputeStore;
  clock?: () => Date;
}

function bad(status: number, code: string, message: string): OpsError {
  return new OpsError(status, code, message);
}

export async function recordVisit(input: VisitInput, deps: VisitDeps): Promise<Visit> {
  const clock = deps.clock ?? (() => new Date());
  if (!input || typeof input !== "object") throw bad(400, "bad_request", "visit body must be an object");
  const { business_id, verifier_id, gps, evidence_refs, checklist } = input;
  if (typeof business_id !== "string" || !business_id) throw bad(400, "bad_request", "business_id is required");
  if (typeof verifier_id !== "string" || !verifier_id) throw bad(400, "bad_request", "verifier_id is required");
  if (!gps || typeof gps.lat !== "number" || typeof gps.lng !== "number") {
    throw bad(400, "bad_request", "gps.lat/gps.lng are required numbers");
  }
  if (!Array.isArray(checklist) || checklist.length === 0) {
    throw bad(400, "bad_request", "checklist must be a non-empty array");
  }
  for (const [i, item] of checklist.entries()) {
    if (!item || typeof item.claim_type !== "string" || !["pass", "fail", "na"].includes(item.result)) {
      throw bad(400, "bad_request", `checklist[${i}] must have claim_type and result pass|fail|na`);
    }
  }

  const business = await deps.directory.get(business_id);
  if (!business) throw bad(404, "business_unknown", `no business ${business_id} in directory`);

  const distance_m = haversineMeters(gps, { lat: business.lat, lng: business.lng });
  if (distance_m > MAX_DISTANCE_M) {
    throw bad(
      422,
      "gps_out_of_range",
      `visit GPS is ${Math.round(distance_m)} m from the registered address — ` +
        `must be within ${MAX_DISTANCE_M} m (spec §3)`,
    );
  }

  const refs = Array.isArray(evidence_refs) ? evidence_refs : [];
  const hasPriceClaim = checklist.some((c) => c.claim_type === "price");
  if (hasPriceClaim && refs.length === 0) {
    throw bad(
      422,
      "evidence_required",
      "price claims require photo evidence_refs (spec §3: in-app evidence rules)",
    );
  }

  const now = clock();
  const visit: Visit = {
    visit_id: newVisitId(now.getTime()),
    business_id,
    verifier_id,
    arrived_at: iso(now),
    ...(input.device_time ? { device_time: input.device_time } : {}),
    gps: { lat: gps.lat, lng: gps.lng },
    distance_m: Math.round(distance_m * 10) / 10,
    evidence_refs: [...refs],
    checklist: checklist.map((c) => ({ ...c })),
    ...(input.attestation_id ? { attestation_id: input.attestation_id } : {}),
  };
  await deps.visits.put(visit);
  return visit;
}

/**
 * Verifier accuracy (spec §3.2: accuracy-based compensation input).
 *
 * accuracy = (matured visits with no dispute opened within 30 days of the
 * visit) / (matured visits), where a visit is "matured" once it is older
 * than 30 days. A dispute counts against a visit when it targets the visit's
 * attestation_id, or — when the visit produced no attestation — any dispute
 * for the same business opened within 30 days after the visit.
 */
const MATURITY_MS = 30 * 86_400_000;

export async function verifierAccuracy(
  verifier_id: string,
  deps: VisitDeps,
): Promise<VerifierAccuracy> {
  const clock = deps.clock ?? (() => new Date());
  const nowMs = clock().getTime();
  const visits = await deps.visits.listByVerifier(verifier_id);
  const matured = visits.filter((v) => nowMs - new Date(v.arrived_at).getTime() > MATURITY_MS);

  let clean = 0;
  for (const v of matured) {
    const visitMs = new Date(v.arrived_at).getTime();
    let hit = false;
    if (v.attestation_id) {
      const disputes = await deps.disputes.listByAttestation(v.attestation_id);
      hit = disputes.some((d) => {
        const openedMs = new Date(d.opened_at).getTime();
        return openedMs >= visitMs && openedMs - visitMs <= MATURITY_MS;
      });
    } else {
      const disputes = await deps.disputes.listByBusiness(v.business_id);
      hit = disputes.some((d) => {
        const openedMs = new Date(d.opened_at).getTime();
        return openedMs >= visitMs && openedMs - visitMs <= MATURITY_MS;
      });
    }
    if (!hit) clean += 1;
  }

  return {
    verifier_id,
    visits_total: visits.length,
    visits_matured: matured.length,
    visits_clean: clean,
    accuracy: matured.length > 0 ? clean / matured.length : null,
  };
}
