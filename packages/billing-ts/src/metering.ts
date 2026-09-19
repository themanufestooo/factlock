/**
 * Metered API billing (T14): key issuance, per-query metering, monthly rollups,
 * reconciliation against log replay, and projected bills.
 *
 * Accuracy AC: rollups must reconcile to ±0.1% against a replay of the raw
 * usage records. We store the raw records immutably and recompute from them;
 * `reconcile()` asserts the stored rollup matches the replay exactly.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiKey, MonthlyRollup, UsageRecord } from "./types.js";
import { BillingError } from "./types.js";

export type Clock = () => Date;

export interface MeteringStore {
  saveKey(key: ApiKey): Promise<void>;
  getKey(id: string): Promise<ApiKey | null>;
  listKeys(customer_id: string): Promise<ApiKey[]>;
  saveUsage(record: UsageRecord): Promise<void>;
  usageForMonth(customer_id: string, month: string): Promise<UsageRecord[]>;
  saveRollup(rollup: MonthlyRollup): Promise<void>;
  getRollup(customer_id: string, month: string): Promise<MonthlyRollup | null>;
}

export class InMemoryMeteringStore implements MeteringStore {
  private keys = new Map<string, ApiKey>();
  private usage: UsageRecord[] = [];
  private rollups = new Map<string, MonthlyRollup>();

  async saveKey(key: ApiKey) {
    this.keys.set(key.id, { ...key });
  }
  async getKey(id: string) {
    return this.keys.get(id) ?? null;
  }
  async listKeys(customer_id: string) {
    return [...this.keys.values()].filter((k) => k.customer_id === customer_id);
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
    return this.rollups.get(`${customer_id}/${month}`) ?? null;
  }
}

/** Issue an API key. The secret is returned once — only its hash is stored. */
export async function issueApiKey(
  store: MeteringStore,
  customer_id: string,
  clock: Clock = () => new Date(),
): Promise<{ key: ApiKey; secret: string }> {
  const id = `vk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const secret = `veritas_sk_${randomBytes(24).toString("base64url")}`;
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

export async function ingestUsage(
  store: MeteringStore,
  key_id: string,
  endpoint: string,
  units: number,
  clock: Clock = () => new Date(),
): Promise<UsageRecord> {
  const key = await store.getKey(key_id);
  if (!key) throw new BillingError("key_not_found", "unknown API key", 404);
  if (key.revoked_at) throw new BillingError("key_revoked", "API key is revoked", 403);
  if (!Number.isInteger(units) || units <= 0) {
    throw new BillingError("invalid_units", "units must be a positive integer", 400);
  }
  const record: UsageRecord = {
    id: `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    key_id,
    customer_id: key.customer_id,
    endpoint,
    units,
    at: clock().toISOString(),
  };
  await store.saveUsage(record);
  return record;
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
