/**
 * Pluggable stores (T6). In-memory implementations for v1; the interfaces
 * are what the verifier depends on, so Postgres can slot in later.
 */
import type { Attestation } from "@factlock/issuer";
import type {
  AttestationStore,
  LifecycleStatus,
  StatusOverride,
  StatusRegistry,
} from "./types.js";

export class InMemoryAttestationStore implements AttestationStore {
  private readonly map = new Map<string, Attestation>();

  async get(id: string): Promise<Attestation | null> {
    return this.map.get(id) ?? null;
  }

  async put(a: Attestation): Promise<void> {
    // Uniqueness is enforced (audit H-10): attestation IDs are
    // server-generated and immutable — a duplicate put is a caller bug,
    // never a silent overwrite.
    if (this.map.has(a.attestation_id)) {
      const err = new Error(`duplicate attestation_id ${a.attestation_id}`);
      (err as Error & { code?: string }).code = "DUPLICATE_ATTESTATION_ID";
      throw err;
    }
    this.map.set(a.attestation_id, structuredClone(a));
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Lifecycle registry. Dispute filings / operator actions write overrides
 * here; verification resolves effective status = override ?? attestation.status.
 * The 60-second flip requirement (spec §7) is met because this is a single
 * write read by every verifier — no re-issuance or re-signing needed.
 */
export class InMemoryStatusRegistry implements StatusRegistry {
  private readonly map = new Map<string, StatusOverride>();

  async get(id: string): Promise<StatusOverride | null> {
    return this.map.get(id) ?? null;
  }

  async set(id: string, o: StatusOverride): Promise<void> {
    const valid: LifecycleStatus[] = [
      "ACTIVE",
      "DISPUTED",
      "CORRECTED",
      "SUSPENDED",
      "CLEARED",
      "REVOKED",
    ];
    if (!valid.includes(o.status)) {
      throw new Error(`StatusRegistry: unknown status ${o.status}`);
    }
    this.map.set(id, { ...o });
  }
}
