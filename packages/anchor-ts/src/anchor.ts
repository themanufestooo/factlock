/**
 * Daily anchoring (T5): take the Merkle log's current root, hash-chain it to
 * yesterday's anchor, and hand it to the provider.
 */
import type { MerkleLog } from "@factlock/merkle-log";
import { computeRecordHash, GENESIS_HASH } from "./chain.js";
import type {
  AnchorLog,
  AnchorProvider,
  AnchorRecord,
} from "./types.js";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export interface AnchorDayOptions {
  /** UTC date this anchor covers (YYYY-MM-DD). Defaults to today. */
  date?: string;
  log: MerkleLog;
  provider: AnchorProvider;
  anchors: AnchorLog;
  tree?: string;
  clock?: () => Date;
}

export async function anchorDay(opts: AnchorDayOptions): Promise<AnchorRecord> {
  const clock = opts.clock ?? (() => new Date());
  const date =
    opts.date ?? clock().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`anchorDay: bad date ${date}`);
  }
  const existing = await opts.anchors.records();
  const prev = existing.length > 0 ? existing[existing.length - 1] : null;
  if (prev && prev.date >= date) {
    throw new Error(
      `anchorDay: anchor for ${date} would not advance the chain (last is ${prev.date})`,
    );
  }

  const body = {
    version: "factlock-anchor/1" as const,
    date,
    tree: opts.tree ?? "factlock-main",
    root: opts.log.getRoot(),
    leaf_count: opts.log.size,
    prev_anchor_hash: prev ? prev.record_hash : GENESIS_HASH,
    anchored_at: iso(clock()),
    provider: opts.provider.name,
  };
  const record: AnchorRecord = { ...body, record_hash: computeRecordHash(body) };
  const receipt = await opts.provider.anchor(record);
  // provider_ref arrives after the hash is computed and is NOT covered by it
  // (see recordPreimageBytes) — it is receipt metadata, not consensus data.
  record.provider_ref = receipt.ref;
  await opts.anchors.append(record);
  return record;
}
