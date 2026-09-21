#!/usr/bin/env node
/**
 * Third-party audit tool for a FactLock transparency-log journal.
 *
 * Replays every leaf in the JSONL journal from scratch and recomputes the
 * Merkle root independently of the log operator's API. Anyone holding a copy
 * of the journal (or the CDN mirror) can run this to check the published root.
 *
 * Usage:
 *   node dist/scripts/audit-log.js <log.jsonl> [expected-root-hex]
 *
 * Exit 0 when the recomputed root matches the expected root (or when no
 * expected root is given and replay succeeds). Exit 1 on mismatch or error.
 */
import { MerkleLog } from "../src/index.js";

function main(): void {
  const [journal, expected] = process.argv.slice(2);
  if (!journal) {
    console.error("usage: audit-log.js <log.jsonl> [expected-root-hex]");
    process.exit(2);
  }
  let log: MerkleLog;
  try {
    log = MerkleLog.replay(journal);
  } catch (err) {
    console.error(`audit-log: replay failed: ${(err as Error).message}`);
    process.exit(1);
  }
  const root = log.getRoot();
  console.log(JSON.stringify({ journal, leaves: log.size, root }, null, 2));
  if (expected !== undefined) {
    if (root.toLowerCase() === expected.toLowerCase()) {
      console.log("OK: recomputed root matches expected root");
    } else {
      console.error("MISMATCH: recomputed root does not match expected root");
      process.exit(1);
    }
  }
}

main();
