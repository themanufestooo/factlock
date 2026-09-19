/**
 * Dispute deposit ledger (spec §4.4 / §9): filing a dispute holds a refundable
 * deposit. Ruled valid → released back. Ruled frivolous → forfeited.
 * Transitions are one-way; a settled deposit can never move again.
 */
import { randomUUID } from "node:crypto";
import type { DepositEntry, DepositState } from "./types.js";
import { BillingError } from "./types.js";

export type Clock = () => Date;

export interface DepositStore {
  get(id: string): Promise<DepositEntry | null>;
  getByDispute(dispute_id: string): Promise<DepositEntry[]>;
  save(entry: DepositEntry): Promise<void>;
}

export class InMemoryDepositStore implements DepositStore {
  private entries = new Map<string, DepositEntry>();
  async get(id: string) {
    return this.entries.get(id) ?? null;
  }
  async getByDispute(dispute_id: string) {
    return [...this.entries.values()].filter((e) => e.dispute_id === dispute_id);
  }
  async save(entry: DepositEntry) {
    this.entries.set(entry.id, { ...entry });
  }
}

export async function holdDeposit(
  store: DepositStore,
  dispute_id: string,
  customer_id: string,
  amount_cents: number,
  clock: Clock = () => new Date(),
): Promise<DepositEntry> {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new BillingError("invalid_amount", "deposit amount must be a positive integer", 400);
  }
  const entry: DepositEntry = {
    id: `dep_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    dispute_id,
    customer_id,
    amount_cents,
    state: "held",
    created_at: clock().toISOString(),
    settled_at: null,
  };
  await store.save(entry);
  return entry;
}

async function settle(
  store: DepositStore,
  id: string,
  to: DepositState,
  clock: Clock,
): Promise<DepositEntry> {
  const entry = await store.get(id);
  if (!entry) throw new BillingError("deposit_not_found", "unknown deposit", 404);
  if (entry.state !== "held") {
    throw new BillingError(
      "deposit_settled",
      `deposit already ${entry.state}; settlement is one-way`,
      422,
    );
  }
  const next = { ...entry, state: to, settled_at: clock().toISOString() };
  await store.save(next);
  return next;
}

/** Dispute resolved in the filer's favor (or withdrawn) → money back. */
export function releaseDeposit(
  store: DepositStore,
  id: string,
  clock: Clock = () => new Date(),
): Promise<DepositEntry> {
  return settle(store, id, "released", clock);
}

/** Dispute ruled frivolous → deposit forfeited. */
export function forfeitDeposit(
  store: DepositStore,
  id: string,
  clock: Clock = () => new Date(),
): Promise<DepositEntry> {
  return settle(store, id, "forfeited", clock);
}
