#!/usr/bin/env node
/**
 * anchor-daily — the cron job (T5).
 *
 * Reads the transparency-log journal, anchors today's root, appends to the
 * anchor chain, prints the root. See README for the cron/systemd entries.
 *
 *   node dist/scripts/anchor-daily.js \
 *     --journal /var/lib/factlock/log.jsonl \
 *     --anchors /var/lib/factlock/anchors.jsonl \
 *     [--date 2026-09-19] [--tree factlock-main] [--verify]
 */
import { MerkleLog } from "@factlock/merkle-log";
import { anchorDay } from "../src/anchor.js";
import { verifyAnchorForDate } from "../src/verify.js";
import { FileAnchorLog, LocalAnchorProvider } from "../src/providers/local.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const journalPath = arg("journal");
const anchorsPath = arg("anchors");
if (!journalPath || !anchorsPath) {
  console.error("usage: anchor-daily.js --journal <path> --anchors <path> [--date YYYY-MM-DD] [--tree name] [--verify]");
  process.exit(2);
}

const date = arg("date");
const tree = arg("tree");

const log = MerkleLog.load(journalPath);
const anchors = new FileAnchorLog(anchorsPath);
const record = await anchorDay({
  date,
  log,
  tree,
  provider: new LocalAnchorProvider(),
  anchors,
});
console.log(
  `anchored ${record.date}: root=${record.root} leaves=${record.leaf_count} hash=${record.record_hash.slice(0, 16)}…`,
);

if (process.argv.includes("--verify")) {
  const v = await verifyAnchorForDate({ date: record.date, journalPath, anchors });
  console.log(`verify ${record.date}: ${v.ok ? "OK" : "FAIL — " + v.reason}`);
  if (!v.ok) process.exit(1);
}
