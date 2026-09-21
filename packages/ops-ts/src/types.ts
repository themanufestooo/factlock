/**
 * Ops types (T9–T12): verifier visits, review flags, disputes, scheduler.
 */
import type { LifecycleStatus } from "@factlock/verify-api";

export class OpsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Array<{ path: string; message: string }>;
  constructor(status: number, code: string, message: string, fields?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "OpsError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------- T9: visits

export interface GpsPoint {
  lat: number;
  lng: number;
}

export interface ChecklistItem {
  /** Claim type checked on site, e.g. "price", "hours", "license". */
  claim_type: string;
  result: "pass" | "fail" | "na";
  note?: string;
}

export interface VisitInput {
  business_id: string;
  verifier_id: string;
  gps: GpsPoint;
  /** Opaque photo references (e.g. content hashes / storage keys). No uploads in v1. */
  evidence_refs?: string[];
  checklist: ChecklistItem[];
  /** Attestation this visit produced, when the visit led to an issuance. */
  attestation_id?: string;
  device_time?: string;
}

export interface Visit {
  visit_id: string;
  business_id: string;
  verifier_id: string;
  /** Server-stamped (injectable clock). device_time is metadata only. */
  arrived_at: string;
  device_time?: string;
  gps: GpsPoint;
  /** Meters from the business's registered coordinates. */
  distance_m: number;
  evidence_refs: string[];
  checklist: ChecklistItem[];
  attestation_id?: string;
}

export interface BusinessRecord {
  business_id: string;
  name: string;
  /** Registered coordinates (spec §3: visit must be within 500 m). */
  lat: number;
  lng: number;
}

export interface VerifierAccuracy {
  verifier_id: string;
  visits_total: number;
  /** Visits old enough to judge (arrived_at > 30 days ago). */
  visits_matured: number;
  /** Matured visits with no dispute opened within 30 days of the visit. */
  visits_clean: number;
  /** visits_clean / visits_matured, or null when nothing has matured. */
  accuracy: number | null;
}

// ---------------------------------------------------------------- T10: flags

export type FlagSource = "anomaly-detector" | "mystery-shopper" | "public-report";
export type FlagStatus = "open" | "resolved";
export type FlagDecision = "confirm" | "dispute" | "clear";

export interface Flag {
  flag_id: string;
  attestation_id: string;
  source: FlagSource;
  reason: string;
  evidence_refs: string[];
  status: FlagStatus;
  created_at: string;
  resolution?: {
    decision: FlagDecision;
    reviewer_id: string;
    notes?: string;
    resolved_at: string;
  };
}

/** Immutable audit-trail entry written on every flag resolution (spec §1.1). */
export interface AuditEntry {
  entry_id: string;
  at: string;
  actor: string;
  action: string;
  subject: Record<string, unknown>;
}

// ---------------------------------------------------------------- T11: disputes

export type DisputeStatus = "open" | "resolved";
export type DisputeOutcome = "corrected" | "suspended" | "cleared" | "revoked";

export interface Dispute {
  dispute_id: string;
  attestation_id: string;
  business_id: string;
  status: DisputeStatus;
  opened_by: string;
  opened_at: string;
  reason: string;
  resolution?: {
    outcome: DisputeOutcome;
    reviewer_id: string;
    notes?: string;
    resolved_at: string;
    /** Strike count for the business after this resolution. */
    strikes_after: number;
    /** Attestation id of the corrected re-issuance (outcome=corrected). */
    corrected_attestation_id?: string;
  };
}

/** Revocation record appended to the transparency log (spec §7). */
export interface RevocationRecord {
  record_type: "revocation";
  attestation_id: string;
  business_id: string;
  revoked_at: string;
  reason: string;
  strike: number;
}

/** CDN mirror entry marker — the real CDN purge implements this interface. */
export interface CdnMirror {
  markRevoked(attestation_id: string, entry: { revoked_at: string; reason: string }): Promise<void>;
  get(attestation_id: string): Promise<{ revoked_at: string; reason: string } | null>;
}

// ---------------------------------------------------------------- T12: scheduler

export interface DueAttestation {
  attestation_id: string;
  business_id: string;
  /** (now - verified_at) / (valid_until - verified_at); due when >= 0.70. */
  fraction_elapsed: number;
  age_days: number;
  interval_days: number;
}

export type { LifecycleStatus };
