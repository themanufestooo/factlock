/**
 * Pluggable stores (T9–T11). In-memory implementations for v1; the interfaces
 * are what the ops logic depends on, so Postgres can slot in later.
 */
import type {
  AuditEntry,
  BusinessRecord,
  CdnMirror,
  Dispute,
  Flag,
  FlagStatus,
  Visit,
} from "./types.js";

export interface BusinessDirectory {
  get(business_id: string): Promise<BusinessRecord | null>;
  put(r: BusinessRecord): Promise<void>;
}

export class InMemoryBusinessDirectory implements BusinessDirectory {
  private readonly map = new Map<string, BusinessRecord>();
  async get(id: string): Promise<BusinessRecord | null> {
    return this.map.get(id) ?? null;
  }
  async put(r: BusinessRecord): Promise<void> {
    this.map.set(r.business_id, { ...r });
  }
}

export interface VisitStore {
  put(v: Visit): Promise<void>;
  get(visit_id: string): Promise<Visit | null>;
  listByVerifier(verifier_id: string): Promise<Visit[]>;
}

export class InMemoryVisitStore implements VisitStore {
  private readonly map = new Map<string, Visit>();
  async put(v: Visit): Promise<void> {
    this.map.set(v.visit_id, structuredClone(v));
  }
  async get(id: string): Promise<Visit | null> {
    return this.map.get(id) ?? null;
  }
  async listByVerifier(verifier_id: string): Promise<Visit[]> {
    return [...this.map.values()].filter((v) => v.verifier_id === verifier_id);
  }
}

export interface FlagStore {
  put(f: Flag): Promise<void>;
  get(flag_id: string): Promise<Flag | null>;
  list(status?: FlagStatus): Promise<Flag[]>;
}

export class InMemoryFlagStore implements FlagStore {
  private readonly map = new Map<string, Flag>();
  async put(f: Flag): Promise<void> {
    this.map.set(f.flag_id, structuredClone(f));
  }
  async get(id: string): Promise<Flag | null> {
    return this.map.get(id) ?? null;
  }
  async list(status?: FlagStatus): Promise<Flag[]> {
    const all = [...this.map.values()];
    return status ? all.filter((f) => f.status === status) : all;
  }
}

export interface AuditLog {
  /**
   * Append an entry. The log assigns entry_id and at (server-stamped);
   * callers supply actor, action, and subject. Returns the stored entry.
   */
  append(e: Omit<AuditEntry, "entry_id" | "at">): Promise<AuditEntry>;
  list(): Promise<AuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async append(e: Omit<AuditEntry, "entry_id" | "at">): Promise<AuditEntry> {
    const at = this.clock().toISOString().replace(/\.\d{3}Z$/, "Z");
    const entry: AuditEntry = { entry_id: `aud_${this.entries.length.toString(36)}`, at, ...e };
    this.entries.push(structuredClone(entry));
    return structuredClone(entry);
  }
  async list(): Promise<AuditEntry[]> {
    return this.entries.map((e) => ({ ...e }));
  }
}

export interface DisputeStore {
  put(d: Dispute): Promise<void>;
  get(dispute_id: string): Promise<Dispute | null>;
  listByAttestation(attestation_id: string): Promise<Dispute[]>;
  listByBusiness(business_id: string): Promise<Dispute[]>;
  listOpen(): Promise<Dispute[]>;
}

export class InMemoryDisputeStore implements DisputeStore {
  private readonly map = new Map<string, Dispute>();
  async put(d: Dispute): Promise<void> {
    this.map.set(d.dispute_id, structuredClone(d));
  }
  async get(id: string): Promise<Dispute | null> {
    return this.map.get(id) ?? null;
  }
  async listByAttestation(attestation_id: string): Promise<Dispute[]> {
    return [...this.map.values()].filter((d) => d.attestation_id === attestation_id);
  }
  async listByBusiness(business_id: string): Promise<Dispute[]> {
    return [...this.map.values()].filter((d) => d.business_id === business_id);
  }
  async listOpen(): Promise<Dispute[]> {
    return [...this.map.values()].filter((d) => d.status === "open");
  }
}

/**
 * CDN mirror (spec §7: revocations must propagate to the CDN mirror within
 * the cache TTL). v1 is in-memory; production implements this interface with
 * real CDN purge calls.
 */
export class InMemoryCdnMirror implements CdnMirror {
  private readonly map = new Map<string, { revoked_at: string; reason: string }>();
  async markRevoked(
    attestation_id: string,
    entry: { revoked_at: string; reason: string },
  ): Promise<void> {
    this.map.set(attestation_id, { ...entry });
  }
  async get(attestation_id: string): Promise<{ revoked_at: string; reason: string } | null> {
    return this.map.get(attestation_id) ?? null;
  }
}
