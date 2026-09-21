/**
 * Dispute lifecycle engine (T11).
 *
 *   ACTIVE → DISPUTED → CORRECTED | SUSPENDED | CLEARED
 *                              ↘ third strike → REVOKED (permanent)
 *
 * Status flips write to the verify-api StatusRegistry, so verification sees
 * them within one write — no re-issuance needed (spec §7, 60-second rule).
 * Strikes are counted per business across resolved disputes; outcomes
 * corrected/suspended/revoked increment the count, cleared never does.
 * Revocation appends a revocation record to the transparency log and marks
 * the CDN mirror entry.
 */
import { canonicalizeBytes } from "@factlock/attestation-core";
import type { Attestation, IssueRequest } from "@factlock/issuer";
import type { KeyStore } from "@factlock/keystore";
import { MerkleLog, verifyInclusionProof, toHex } from "@factlock/merkle-log";
import type { AttestationStore, StatusRegistry } from "@factlock/verify-api";
import {
  OpsError,
  type CdnMirror,
  type Dispute,
  type DisputeOutcome,
  type RevocationRecord,
} from "./types.js";
import type { DisputeStore } from "./stores.js";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

let disputeSeq = 0;
export function newDisputeId(nowMs: number): string {
  disputeSeq += 1;
  return `dsp_${nowMs.toString(36)}_${String(disputeSeq).padStart(4, "0")}`;
}

const OUTCOMES: DisputeOutcome[] = ["corrected", "suspended", "cleared", "revoked"];
const STRIKE_OUTCOMES: DisputeOutcome[] = ["corrected", "suspended", "revoked"];

export interface DisputeDeps {
  attestations: AttestationStore;
  statuses: StatusRegistry;
  disputes: DisputeStore;
  keystore: KeyStore;
  log: MerkleLog;
  cdn: CdnMirror;
  /** Trusted issuance boundary; production must bind server-held authorization and evidence stores. */
  issueCorrection: (request: IssueRequest) => Promise<Attestation>;
  clock?: () => Date;
}

export async function openDispute(
  input: { attestation_id: string; opened_by: string; reason: string },
  deps: DisputeDeps,
): Promise<Dispute> {
  const clock = deps.clock ?? (() => new Date());
  if (!input || typeof input.attestation_id !== "string" || !input.attestation_id) {
    throw new OpsError(400, "bad_request", "attestation_id is required");
  }
  if (typeof input.opened_by !== "string" || !input.opened_by) {
    throw new OpsError(400, "bad_request", "opened_by is required");
  }
  if (typeof input.reason !== "string" || !input.reason) {
    throw new OpsError(400, "bad_request", "reason is required");
  }
  const att = await deps.attestations.get(input.attestation_id);
  if (!att) throw new OpsError(404, "attestation_unknown", `no attestation ${input.attestation_id}`);

  const existing = await deps.disputes.listByAttestation(input.attestation_id);
  if (existing.some((d) => d.status === "open")) {
    throw new OpsError(422, "dispute_already_open", `attestation ${input.attestation_id} already has an open dispute`);
  }
  const current = (await deps.statuses.get(input.attestation_id))?.status ?? att.status;
  if (current === "REVOKED") {
    throw new OpsError(422, "attestation_revoked", `attestation ${input.attestation_id} is permanently revoked`);
  }

  const now = clock();
  await deps.statuses.set(input.attestation_id, {
    status: "DISPUTED",
    reason: input.reason,
    at: iso(now),
  });

  const dispute: Dispute = {
    dispute_id: newDisputeId(now.getTime()),
    attestation_id: input.attestation_id,
    business_id: String((att.subject as Record<string, unknown>).business_id),
    status: "open",
    opened_by: input.opened_by,
    opened_at: iso(now),
    reason: input.reason,
  };
  await deps.disputes.put(dispute);
  return dispute;
}

export interface ResolveInput {
  outcome: DisputeOutcome;
  reviewer_id: string;
  notes?: string;
  /** Required when outcome=corrected: re-issued through the issuer. */
  corrected_request?: IssueRequest;
}

export interface ResolveResult {
  dispute: Dispute;
  /** Effective lifecycle status of the disputed attestation after resolution. */
  attestation_status: string;
  strikes_after: number;
  corrected_attestation_id?: string;
  /** Merkle leaf index of the revocation record (outcome forced to revoked). */
  revocation_leaf_index?: number;
}

export async function resolveDispute(
  dispute_id: string,
  input: ResolveInput,
  deps: DisputeDeps,
): Promise<ResolveResult> {
  const clock = deps.clock ?? (() => new Date());
  const dispute = await deps.disputes.get(dispute_id);
  if (!dispute) throw new OpsError(404, "dispute_unknown", `no dispute ${dispute_id}`);
  if (dispute.status !== "open") throw new OpsError(422, "dispute_closed", `dispute ${dispute_id} is already resolved`);
  if (!OUTCOMES.includes(input?.outcome)) {
    throw new OpsError(400, "bad_request", `outcome must be one of ${OUTCOMES.join("|")}`);
  }
  if (typeof input?.reviewer_id !== "string" || !input.reviewer_id) {
    throw new OpsError(400, "bad_request", "reviewer_id is required");
  }

  const now = clock();
  const prior = await deps.disputes.listByBusiness(dispute.business_id);
  const priorStrikes = prior.filter(
    (d) => d.status === "resolved" && d.resolution && STRIKE_OUTCOMES.includes(d.resolution.outcome),
  ).length;
  const strikes_after = STRIKE_OUTCOMES.includes(input.outcome) ? priorStrikes + 1 : priorStrikes;

  // Third strike → permanent revocation, whatever the requested outcome
  // (spec: REVOKED on third strike). An explicit "revoked" outcome revokes now.
  const forceRevoke = strikes_after >= 3 || input.outcome === "revoked";

  let attestation_status: string;
  let corrected_attestation_id: string | undefined;
  let revocation_leaf_index: number | undefined;

  if (forceRevoke) {
    const revoked_at = iso(now);
    const reason = `revoked after ${strikes_after} strikes${input.notes ? `: ${input.notes}` : ""}`;
    const record: RevocationRecord = {
      record_type: "revocation",
      attestation_id: dispute.attestation_id,
      business_id: dispute.business_id,
      revoked_at,
      reason,
      strike: strikes_after,
    };
    const { index } = deps.log.append(canonicalizeBytes(record));
    revocation_leaf_index = index;
    await deps.cdn.markRevoked(dispute.attestation_id, { revoked_at, reason });
    await deps.statuses.set(dispute.attestation_id, { status: "REVOKED", reason, at: revoked_at });
    attestation_status = "REVOKED";
  } else if (input.outcome === "corrected") {
    if (!input.corrected_request || typeof input.corrected_request !== "object") {
      throw new OpsError(422, "corrected_request_required", "outcome=corrected requires corrected_request (re-issued through the issuer)");
    }
    const original = await deps.attestations.get(dispute.attestation_id);
    if (!original) throw new OpsError(404, "attestation_unknown", `no attestation ${dispute.attestation_id}`);
    const req = {
      ...input.corrected_request,
      subject: {
        ...((input.corrected_request.subject ?? {}) as Record<string, unknown>),
        business_id: dispute.business_id,
        supersedes_id: dispute.attestation_id,
      },
      verification_method: "document_review",
      verifier_id: input.reviewer_id,
      business_key_id: original.signatures.business.key_id,
    };
    const corrected = await deps.issueCorrection(req as IssueRequest);
    await deps.attestations.put(corrected);
    corrected_attestation_id = corrected.attestation_id;
    await deps.statuses.set(dispute.attestation_id, {
      status: "CORRECTED",
      reason: `superseded by ${corrected.attestation_id}${input.notes ? `: ${input.notes}` : ""}`,
      at: iso(now),
    });
    attestation_status = "CORRECTED";
  } else if (input.outcome === "suspended") {
    await deps.statuses.set(dispute.attestation_id, {
      status: "SUSPENDED",
      reason: input.notes ?? "suspended pending re-verification",
      at: iso(now),
    });
    attestation_status = "SUSPENDED";
  } else {
    await deps.statuses.set(dispute.attestation_id, {
      status: "CLEARED",
      reason: input.notes ?? "dispute cleared after review",
      at: iso(now),
    });
    attestation_status = "CLEARED";
  }

  dispute.status = "resolved";
  dispute.resolution = {
    outcome: forceRevoke ? "revoked" : input.outcome,
    reviewer_id: input.reviewer_id,
    ...(input.notes ? { notes: input.notes } : {}),
    resolved_at: iso(now),
    strikes_after,
    ...(corrected_attestation_id ? { corrected_attestation_id } : {}),
  };
  await deps.disputes.put(dispute);

  return {
    dispute,
    attestation_status,
    strikes_after,
    ...(corrected_attestation_id ? { corrected_attestation_id } : {}),
    ...(revocation_leaf_index !== undefined ? { revocation_leaf_index } : {}),
  };
}

/** Verify a revocation record's inclusion proof against the log's current root. */
export function revocationInclusionOk(log: MerkleLog, leafIndex: number, record: RevocationRecord): boolean {
  try {
    const proof = log.getProof(leafIndex);
    return (
      proof.leaf === toHex(canonicalizeBytes(record)) &&
      verifyInclusionProof(proof) &&
      proof.root.toLowerCase() === log.getRoot().toLowerCase()
    );
  } catch {
    return false;
  }
}
