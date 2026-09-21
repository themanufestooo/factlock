/**
 * Tamper-evident append-only audit log (audit H-04): every high-risk ops
 * action (dispute open/resolve, suspend, revoke, clear, correction) writes
 * an entry hash-chained to its predecessor. verifyChain() detects any
 * post-hoc edit, reorder, or deletion.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "@factlock/attestation-core";
import type { AuditLog } from "./stores.js";
import type { AuditEntry } from "./types.js";

export interface AuditedEntry extends AuditEntry {
  /** Hash of the previous entry ("GENESIS" for the first). */
  prev: string;
  /** Hash over {prev, at, actor, action, subject}. */
  hash: string;
}

function entryHash(prev: string, entry: Omit<AuditEntry, "entry_id">): string {
  return createHash("sha256")
    .update(canonicalize({ prev, at: entry.at, actor: entry.actor, action: entry.action, subject: entry.subject }))
    .digest("hex");
}

export class HashChainedAuditLog implements AuditLog {
  private readonly entries: AuditedEntry[] = [];
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async append(entry: Omit<AuditEntry, "entry_id" | "at">): Promise<AuditEntry> {
    const at = this.clock().toISOString().replace(/\.\d{3}Z$/, "Z");
    const prev = this.entries.length === 0 ? "GENESIS" : this.entries[this.entries.length - 1].hash;
    const hash = entryHash(prev, { at, ...entry });
    const full: AuditedEntry = { entry_id: `aud_${hash.slice(0, 24)}`, at, ...entry, prev, hash };
    this.entries.push(full);
    return full;
  }

  async list(): Promise<AuditEntry[]> {
    // Deep copies: callers (even well-meaning ones) cannot mutate the
    // stored entries and silently break the chain.
    return this.entries.map((e) => structuredClone(e));
  }

  /** Returns false if any entry was edited, reordered, or removed. */
  verifyChain(): boolean {
    let prev = "GENESIS";
    for (const e of this.entries) {
      if (e.prev !== prev) return false;
      if (entryHash(prev, { at: e.at, actor: e.actor, action: e.action, subject: e.subject }) !== e.hash) {
        return false;
      }
      prev = e.hash;
    }
    return true;
  }

  get size(): number {
    return this.entries.length;
  }
}
