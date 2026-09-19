/**
 * Historical anchor verification (T5).
 *
 * Given a date, recompute that day's Merkle root from the log journal alone
 * (replaying only the first `leaf_count` leaves — the journal is append-only,
 * so the prefix is the log's exact historical state) and check it against the
 * anchored root and the hash chain.
 */
import { existsSync, readFileSync } from "node:fs";
import { MerkleLog, fromHex } from "@veritas/merkle-log";
import { verifyChain } from "./chain.js";
import type { AnchorLog } from "./types.js";

export interface VerifyAnchorOptions {
  /** UTC date YYYY-MM-DD. */
  date: string;
  /** Path to the transparency-log journal (T4 format: {"index":N,"leaf":"hex"}). */
  journalPath: string;
  anchors: AnchorLog;
}

/** Recompute the Merkle root of the first `count` journal leaves. */
export function recomputeRootAt(journalPath: string, count: number): string {
  const log = new MerkleLog();
  if (!existsSync(journalPath)) {
    if (count === 0) return log.getRoot();
    throw new Error(`verify: journal ${journalPath} missing`);
  }
  const lines = readFileSync(journalPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < count) {
    throw new Error(
      `verify: journal has ${lines.length} leaves, anchor claims ${count}`,
    );
  }
  for (let i = 0; i < count; i++) {
    const rec = JSON.parse(lines[i]) as { index: number; leaf: string };
    log.append(fromHex(rec.leaf));
  }
  return log.getRoot();
}

export async function verifyAnchorForDate(
  opts: VerifyAnchorOptions,
): Promise<{ ok: boolean; reason: string }> {
  const records = await opts.anchors.records();
  const idx = records.findIndex((r) => r.date === opts.date);
  if (idx < 0) return { ok: false, reason: `no_anchor_for_date ${opts.date}` };

  const chain = verifyChain(records.slice(0, idx + 1));
  if (!chain.ok) return { ok: false, reason: `chain: ${chain.reason}` };

  const record = records[idx];
  let recomputed: string;
  try {
    recomputed = recomputeRootAt(opts.journalPath, record.leaf_count);
  } catch (e) {
    return { ok: false, reason: `replay: ${(e as Error).message}` };
  }
  if (recomputed.toLowerCase() !== record.root.toLowerCase()) {
    return {
      ok: false,
      reason: `root_mismatch for ${opts.date}: journal recomputes ${recomputed}, anchor says ${record.root}`,
    };
  }
  return { ok: true, reason: "ok" };
}
