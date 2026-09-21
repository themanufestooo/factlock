/**
 * Metered API billing (T14): key issuance, per-query metering, monthly rollups,
 * reconciliation against log replay, and projected bills.
 *
 * Accuracy AC: rollups must reconcile to ±0.1% against a replay of the raw
 * usage records. We store the raw records immutably and recompute from them;
 * `reconcile()` asserts the stored rollup matches the replay exactly.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiKey, MonthlyRollup, ProcessedEvent, UsageRecord } from "./types.js";
import { BillingError } from "./types.js";
import { verifySecretHash } from "./auth.js";

export type Clock = () => Date;

export interface MeteringStore {
  saveKey(key: ApiKey): Promise<void>;
  getKey(id: string): Promise<ApiKey | null>;
  listKeys(customer_id: string): Promise<ApiKey[]>;
  saveUsage(record: UsageRecord): Promise<void>;
  usageForMonth(customer_id: string, month: string): Promise<UsageRecord[]>;
  saveRollup(rollup: MonthlyRollup): Promise<void>;
  getRollup(customer_id: string, month: string): Promise<MonthlyRollup | null>;
  /** Idempotency ledger for usage ingestion (audit H-05). */
  saveProcessedEvent(event: ProcessedEvent): Promise<void>;
  getProcessedEvent(event_id: string): Promise<ProcessedEvent | null>;
  /**
   * Atomically persist the idempotency marker AND the usage record.
   * Implementations MUST make both writes in one atomic unit (e.g. a DB
   * transaction): a crash between the two writes would otherwise leave the
   * marker without the ledger entry, silently dropping billable usage on
   * retry. The in-memory store is atomic by single-threaded execution.
   */
  recordUsage(event: ProcessedEvent): Promise<void>;
}

export class InMemoryMeteringStore implements MeteringStore {
  private keys = new Map<string, ApiKey>();
  private usage: UsageRecord[] = [];
  private rollups = new Map<string, MonthlyRollup>();
  private processedEvents = new Map<string, ProcessedEvent>();

  async saveKey(key: ApiKey) {
    this.keys.set(key.id, { ...key });
  }
  async getKey(id: string) {
    // Copies on read: callers must not be able to mutate the stored record
    // (e.g. clearing revoked_at) to bypass tenant/key checks.
    const k = this.keys.get(id);
    return k ? { ...k } : null;
  }
  async listKeys(customer_id: string) {
    return [...this.keys.values()]
      .filter((k) => k.customer_id === customer_id)
      .map((k) => ({ ...k }));
  }
  async saveUsage(record: UsageRecord) {
    this.usage.push({ ...record });
  }
  async usageForMonth(customer_id: string, month: string) {
    return this.usage.filter(
      (r) => r.customer_id === customer_id && r.at.slice(0, 7) === month,
    );
  }
  async saveRollup(rollup: MonthlyRollup) {
    this.rollups.set(`${rollup.customer_id}/${rollup.month}`, { ...rollup });
  }
  async getRollup(customer_id: string, month: string) {
    const r = this.rollups.get(`${customer_id}/${month}`);
    return r ? { ...r } : null;
  }
  async saveProcessedEvent(event: ProcessedEvent) {
    this.processedEvents.set(event.event_id, structuredClone(event));
  }
  async getProcessedEvent(event_id: string) {
    const e = this.processedEvents.get(event_id);
    return e ? structuredClone(e) : null;
  }
  async recordUsage(event: ProcessedEvent) {
    // Single-threaded: both writes land together, no crash window between.
    this.processedEvents.set(event.event_id, structuredClone(event));
    this.usage.push({ ...event.record });
  }
}

/** Issue an API key. The secret is returned once — only its hash is stored. */
export async function issueApiKey(
  store: MeteringStore,
  customer_id: string,
  clock: Clock = () => new Date(),
): Promise<{ key: ApiKey; secret: string }> {
  const id = `vk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const secret = `factlock_sk_${randomBytes(24).toString("base64url")}`;
  const key: ApiKey = {
    id,
    customer_id,
    prefix: secret.slice(0, 14),
    secret_hash: createHash("sha256").update(secret).digest("hex"),
    created_at: clock().toISOString(),
    revoked_at: null,
  };
  await store.saveKey(key);
  return { key, secret };
}

export async function revokeApiKey(
  store: MeteringStore,
  id: string,
  clock: Clock = () => new Date(),
): Promise<ApiKey> {
  const key = await store.getKey(id);
  if (!key) throw new BillingError("key_not_found", "unknown API key", 404);
  const next = { ...key, revoked_at: clock().toISOString() };
  await store.saveKey(next);
  return next;
}

export interface IngestUsageInput {
  key_id: string;
  /** Raw API secret; verified against the stored hash (constant-time). */
  secret: string;
  endpoint: string;
  units: number;
  /** Caller-supplied idempotency key; replays return the first result. */
  event_id: string;
}

export interface IngestUsageResult {
  record: UsageRecord;
  /** True when event_id was already processed — no new usage recorded. */
  duplicate: boolean;
}

/**
 * Ingest one metered usage event (audit H-05).
 *
 * Authentication: the raw API secret must be presented (HTTP layer passes
 * it as `Authorization: Bearer <secret>`) and is verified against the
 * stored hash in constant time. A key_id alone never authenticates.
 *
 * Idempotency: event_id is the dedupe key. The first ingest wins and the
 * processed event is persisted; a replay returns the original record
 * without recording duplicate usage.
 */
export async function ingestUsage(
  store: MeteringStore,
  input: IngestUsageInput,
  clock: Clock = () => new Date(),
): Promise<IngestUsageResult> {
  const { key_id, secret, endpoint, units, event_id } = input;
  if (typeof event_id !== "string" || event_id === "" || event_id.length > 200) {
    throw new BillingError("invalid_event_id", "event_id is required (max 200 chars)", 400);
  }
  const key = await store.getKey(key_id);
  if (!key) throw new BillingError("key_not_found", "unknown API key", 404);
  if (!secret || !verifySecretHash(secret, key.secret_hash)) {
    throw new BillingError("invalid_api_secret", "API secret is invalid", 401);
  }
  if (key.revoked_at) throw new BillingError("key_revoked", "API key is revoked", 403);

  const existing = await store.getProcessedEvent(event_id);
  if (existing) {
    if (existing.record.key_id !== key_id) {
      // The same event_id must not be recycled across keys — fail closed.
      throw new BillingError("event_id_conflict", "event_id was already used for a different key", 409);
    }
    return { record: existing.record, duplicate: true };
  }

  if (!Number.isInteger(units) || units <= 0) {
    throw new BillingError("invalid_units", "units must be a positive integer", 400);
  }
  const now = clock().toISOString();
  const record: UsageRecord = {
    id: `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    key_id,
    customer_id: key.customer_id,
    endpoint,
    units,
    at: now,
  };
  // Atomic idempotency write: the marker and the ledger entry land together,
  // so a crash can never leave a processed event_id without its usage
  // record (lost billable usage) or a usage record without its marker
  // (double-count on retry). A replay of the same event_id returns the
  // original record without recording duplicate usage.
  await store.recordUsage({ event_id, record, processed_at: now });
  return { record, duplicate: false };
}

/** Roll up a month from the raw records and persist the result. */
export async function rollupMonth(
  store: MeteringStore,
  customer_id: string,
  month: string,
  clock: Clock = () => new Date(),
): Promise<MonthlyRollup> {
  const records = await store.usageForMonth(customer_id, month);
  const units_by_endpoint: Record<string, number> = {};
  for (const r of records) {
    units_by_endpoint[r.endpoint] = (units_by_endpoint[r.endpoint] ?? 0) + r.units;
  }
  const total_units = Object.values(units_by_endpoint).reduce((a, b) => a + b, 0);
  const rollup: MonthlyRollup = {
    customer_id,
    month,
    units_by_endpoint,
    total_units,
    recomputed_at: clock().toISOString(),
  };
  await store.saveRollup(rollup);
  return rollup;
}

/**
 * Reconciliation (T14 AC): replay the raw usage records for the month and
 * assert the stored rollup matches. Tolerance is ±0.1%; in practice the
 * replay is exact — any drift means records were mutated or lost.
 */
export async function reconcile(
  store: MeteringStore,
  customer_id: string,
  month: string,
): Promise<{ ok: boolean; replayed_units: number; stored_units: number | null }> {
  const stored = await store.getRollup(customer_id, month);
  const records = await store.usageForMonth(customer_id, month);
  const replayed = records.reduce((a, r) => a + r.units, 0);
  if (!stored) return { ok: false, replayed_units: replayed, stored_units: null };
  const drift = Math.abs(replayed - stored.total_units) / Math.max(1, replayed);
  return { ok: drift <= 0.001, replayed_units: replayed, stored_units: stored.total_units };
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Days in the month of `d` (UTC). */
function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Project the end-of-month unit total from usage so far (linear projection).
 * Used by the live usage dashboard (T14 AC: "integrator can see live usage
 * and projected bill").
 */
export function projectUnits(units_to_date: number, now: Date): number {
  const day = now.getUTCDate();
  const dim = daysInMonth(now);
  if (day <= 0) return units_to_date;
  return Math.ceil((units_to_date / day) * dim);
}
