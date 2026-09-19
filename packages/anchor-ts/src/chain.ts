/**
 * Anchor hash chain (T5).
 *
 * record_hash = SHA256( JCS(record minus record_hash) )
 * Each record commits to the previous record's hash, so the chain is
 * tamper-evident: rewriting history requires rewriting every later record.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "@veritas/attestation-core";
import type { AnchorRecord } from "./types.js";

export const GENESIS_HASH = "00".repeat(32);

const te = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The exact bytes the record_hash commits to (JCS, deterministic).
 * provider_ref is deliberately EXCLUDED: receipts arrive after the hash is
 * computed, so they can never be part of it. */
export function recordPreimageBytes(
  record: Omit<AnchorRecord, "record_hash" | "provider_ref">,
): Uint8Array {
  return te.encode(
    canonicalize({
      version: record.version,
      date: record.date,
      tree: record.tree,
      root: record.root,
      leaf_count: record.leaf_count,
      prev_anchor_hash: record.prev_anchor_hash,
      anchored_at: record.anchored_at,
      provider: record.provider,
    }),
  );
}

export function computeRecordHash(
  record: Omit<AnchorRecord, "record_hash" | "provider_ref">,
): string {
  return sha256Hex(recordPreimageBytes(record));
}

/**
 * Verify a chain of anchor records: every record_hash recomputes correctly
 * and every prev_anchor_hash links to the previous record (genesis first).
 */
export function verifyChain(records: AnchorRecord[]): {
  ok: boolean;
  reason: string;
} {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (computeRecordHash(r) !== r.record_hash) {
      return { ok: false, reason: `record_hash_mismatch at index ${i} (date ${r.date})` };
    }
    const wantPrev = i === 0 ? GENESIS_HASH : records[i - 1].record_hash;
    if (r.prev_anchor_hash !== wantPrev) {
      return { ok: false, reason: `chain_link_broken at index ${i} (date ${r.date})` };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
      return { ok: false, reason: `bad_date at index ${i}` };
    }
  }
  return { ok: true, reason: "ok" };
}
