/**
 * Public verification API types (T6).
 *
 * Implements spec §5 (verification algorithm) as a free, keyless HTTP API.
 */
import type { InclusionProof } from "@factlock/merkle-log";
import type { Attestation } from "@factlock/issuer";
import type { KeyStore } from "@factlock/keystore";

export type FreshnessVerdict = "FRESH" | "AGING" | "STALE";

/** Lifecycle states an attestation can be in (spec §7.1). */
export type LifecycleStatus =
  | "ACTIVE"
  | "DISPUTED"
  | "CORRECTED"
  | "SUSPENDED"
  | "CLEARED"
  | "REVOKED";

export interface ClaimFreshness {
  type: string;
  item?: string;
  age_days: number;
  interval_days: number;
  verdict: FreshnessVerdict;
}

export interface VerificationResult {
  attestation_id: string;
  /** True only when signatures + inclusion + status + freshness all check out. */
  valid: boolean;
  /** Effective lifecycle status (registry override wins over the attestation). */
  status: LifecycleStatus;
  freshness: FreshnessVerdict;
  age_days: number;
  /** Re-verification interval in days (from verified_at → valid_until). */
  interval_days: number;
  verified_at: string;
  valid_until: string;
  signatures_ok: boolean;
  inclusion_ok: boolean;
  expired: boolean;
  key_ids: { business: string; factlock: string };
  /** Claims with undisclosed price amounts redacted (spec §2). */
  claims: Array<Record<string, unknown>>;
  claims_freshness: ClaimFreshness[];
  /** Human-readable one-line summary. */
  message: string;
}

/** Pluggable attestation store (in-memory v1; Postgres later). */
export interface AttestationStore {
  get(id: string): Promise<Attestation | null>;
  put(a: Attestation): Promise<void>;
}

/** Lifecycle override set by disputes/operator action (spec §7). */
export interface StatusOverride {
  status: LifecycleStatus;
  reason: string;
  /** RFC 3339 UTC. */
  at: string;
}

/** Pluggable lifecycle registry (in-memory v1). */
export interface StatusRegistry {
  get(id: string): Promise<StatusOverride | null>;
  set(id: string, o: StatusOverride): Promise<void>;
}

/** Minimal log surface the verifier needs (MerkleLog satisfies this). */
export interface LogReader {
  readonly size: number;
  getProof(index: number): InclusionProof;
  getRoot(): string;
}

export interface VerifyDeps {
  keystore: KeyStore;
  log: LogReader;
  statuses?: StatusRegistry;
  /** Defaults to real time. Tests inject a fixed clock. */
  clock?: () => Date;
}

export interface VerifyServerOptions extends VerifyDeps {
  store: AttestationStore;
  /** Free-tier cap. Default 60 requests per 60s per IP. */
  rateLimit?: { capacity: number; windowMs: number };
  maxBodyBytes?: number;
}
