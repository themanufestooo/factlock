import { createHash } from "node:crypto";
import { canonicalize } from "@factlock/attestation-core";
import type { AuthRecord } from "./types.js";

export interface AuthorizationRecord extends AuthRecord {
  business_id: string;
  principal: string;
  claim_digest: string;
  expires_at: string;
  consumed_at?: string;
}

export interface AuthorizationCheck {
  authorizationId: string;
  businessId: string;
  principal: string;
  claimDigest: string;
  now: Date;
}

export interface AuthorizationStore {
  /** Resolve, validate, and atomically consume a one-time authorization. */
  consume(check: AuthorizationCheck): Promise<AuthRecord | null>;
}

export interface EvidenceRecord {
  evidence_ref: string;
  business_id: string;
  claim_types: string[];
  verified_at: string;
  expires_at?: string;
  verification_method?: string;
  verifier_id?: string;
}

export interface EvidenceCheck {
  evidenceRefs: string[];
  businessId: string;
  claimTypes: string[];
  verificationMethod: string;
  verifierId: string;
  now: Date;
}

export interface EvidenceStore {
  /** Accept only current, server-held evidence bound to the business and claims. */
  verify(check: EvidenceCheck): Promise<boolean>;
}

export function digestClaims(claims: Array<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalize(claims)).digest("hex");
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  private readonly records = new Map<string, AuthorizationRecord>();

  put(record: AuthorizationRecord): void {
    this.records.set(record.authorization_id, structuredClone(record));
  }

  async consume(check: AuthorizationCheck): Promise<AuthRecord | null> {
    const record = this.records.get(check.authorizationId);
    if (
      !record || record.consumed_at || record.business_id !== check.businessId ||
      record.principal !== check.principal || record.claim_digest !== check.claimDigest ||
      new Date(record.authorized_at).getTime() > check.now.getTime() + 5 * 60_000 ||
      new Date(record.expires_at).getTime() <= check.now.getTime()
    ) return null;
    record.consumed_at = check.now.toISOString();
    return {
      authorization_id: record.authorization_id,
      method: record.method,
      authorized_at: record.authorized_at,
      authorized_by: record.authorized_by,
    };
  }
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();

  put(record: EvidenceRecord): void {
    this.records.set(record.evidence_ref, structuredClone(record));
  }

  async verify(check: EvidenceCheck): Promise<boolean> {
    if (check.evidenceRefs.length === 0 || new Set(check.evidenceRefs).size !== check.evidenceRefs.length) return false;
    const records = check.evidenceRefs.map((ref) => this.records.get(ref));
    if (records.some((record) => !record)) return false;
    const valid = records as EvidenceRecord[];
    if (valid.some((record) =>
      record.business_id !== check.businessId ||
      (record.expires_at && new Date(record.expires_at).getTime() <= check.now.getTime()) ||
      (record.verification_method && record.verification_method !== check.verificationMethod) ||
      (record.verifier_id && record.verifier_id !== check.verifierId)
    )) return false;
    const covered = new Set(valid.flatMap((record) => record.claim_types));
    return check.claimTypes.every((type) => covered.has(type));
  }
}
