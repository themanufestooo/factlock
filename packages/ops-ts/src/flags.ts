/**
 * Review console flags (T10).
 *
 * Flags come from the anomaly detector, mystery shoppers, or public reports.
 * Resolving a flag writes an immutable audit-trail entry (spec §1.1).
 * A "dispute" decision opens a dispute in the lifecycle engine (T11).
 */
import { openDispute, type DisputeDeps } from "./disputes.js";
import { OpsError, type Flag, type FlagDecision, type FlagSource } from "./types.js";
import type { AuditLog, FlagStore } from "./stores.js";
import type { AttestationStore } from "@veritas/verify-api";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

let flagSeq = 0;
export function newFlagId(nowMs: number): string {
  flagSeq += 1;
  return `flg_${nowMs.toString(36)}_${String(flagSeq).padStart(4, "0")}`;
}

const SOURCES: FlagSource[] = ["anomaly-detector", "mystery-shopper", "public-report"];
const DECISIONS: FlagDecision[] = ["confirm", "dispute", "clear"];

export interface FlagDeps {
  flags: FlagStore;
  audit: AuditLog;
  attestations: AttestationStore;
  clock?: () => Date;
}

export async function openFlag(
  input: { attestation_id: string; source: FlagSource; reason: string; evidence_refs?: string[] },
  deps: FlagDeps,
): Promise<Flag> {
  const clock = deps.clock ?? (() => new Date());
  if (!input || typeof input.attestation_id !== "string" || !input.attestation_id) {
    throw new OpsError(400, "bad_request", "attestation_id is required");
  }
  if (!SOURCES.includes(input.source)) {
    throw new OpsError(400, "bad_request", `source must be one of ${SOURCES.join("|")}`);
  }
  if (typeof input.reason !== "string" || !input.reason) {
    throw new OpsError(400, "bad_request", "reason is required");
  }
  const att = await deps.attestations.get(input.attestation_id);
  if (!att) throw new OpsError(404, "attestation_unknown", `no attestation ${input.attestation_id}`);

  const flag: Flag = {
    flag_id: newFlagId(clock().getTime()),
    attestation_id: input.attestation_id,
    source: input.source,
    reason: input.reason,
    evidence_refs: Array.isArray(input.evidence_refs) ? [...input.evidence_refs] : [],
    status: "open",
    created_at: iso(clock()),
  };
  await deps.flags.put(flag);
  return flag;
}

export async function resolveFlag(
  flag_id: string,
  input: { decision: FlagDecision; reviewer_id: string; notes?: string },
  deps: FlagDeps & { disputes?: DisputeDeps },
): Promise<{ flag: Flag; dispute_id?: string }> {
  const clock = deps.clock ?? (() => new Date());
  const flag = await deps.flags.get(flag_id);
  if (!flag) throw new OpsError(404, "flag_unknown", `no flag ${flag_id}`);
  if (flag.status !== "open") throw new OpsError(422, "flag_closed", `flag ${flag_id} is already resolved`);
  if (!DECISIONS.includes(input?.decision)) {
    throw new OpsError(400, "bad_request", `decision must be one of ${DECISIONS.join("|")}`);
  }
  if (typeof input?.reviewer_id !== "string" || !input.reviewer_id) {
    throw new OpsError(400, "bad_request", "reviewer_id is required");
  }

  const now = clock();
  flag.status = "resolved";
  flag.resolution = {
    decision: input.decision,
    reviewer_id: input.reviewer_id,
    ...(input.notes ? { notes: input.notes } : {}),
    resolved_at: iso(now),
  };
  await deps.flags.put(flag);

  await deps.audit.append({
    entry_id: `aud_${now.getTime().toString(36)}_${flag.flag_id}`,
    at: iso(now),
    actor: input.reviewer_id,
    action: `flag.${input.decision}`,
    subject: { flag_id: flag.flag_id, attestation_id: flag.attestation_id },
  });

  // A "dispute" decision escalates into the lifecycle engine (T11).
  let dispute_id: string | undefined;
  if (input.decision === "dispute") {
    if (!deps.disputes) {
      throw new OpsError(500, "no_dispute_deps", "dispute escalation needs dispute dependencies");
    }
    const d = await openDispute(
      {
        attestation_id: flag.attestation_id,
        opened_by: input.reviewer_id,
        reason: `escalated from flag ${flag.flag_id}: ${flag.reason}`,
      },
      deps.disputes,
    );
    dispute_id = d.dispute_id;
  }
  return { flag, ...(dispute_id ? { dispute_id } : {}) };
}
