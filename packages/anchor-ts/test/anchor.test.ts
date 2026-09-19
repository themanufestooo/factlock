/**
 * T5 tests: daily anchoring — hash chain, historical verification, tamper
 * detection, provider safety.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MerkleLog } from "@veritas/merkle-log";
import { anchorDay } from "../src/anchor.js";
import { verifyAnchorForDate, recomputeRootAt } from "../src/verify.js";
import { verifyChain, GENESIS_HASH, computeRecordHash } from "../src/chain.js";
import { FileAnchorLog, LocalAnchorProvider } from "../src/providers/local.js";
import {
  OpenTimestampsProvider,
  otsDigestHex,
  buildCalendarPayload,
} from "../src/providers/opentimestamps.js";

const te = new TextEncoder();
const leaf = (s: string) => te.encode(s);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "anchor-test-"));
  const journal = join(dir, "log.jsonl");
  const anchorsPath = join(dir, "anchors.jsonl");
  const log = new MerkleLog(journal);
  const anchors = new FileAnchorLog(anchorsPath);
  const provider = new LocalAnchorProvider();
  return { dir, journal, anchorsPath, log, anchors, provider };
}

async function threeDays() {
  const s = setup();
  const { log, anchors, provider } = s;
  log.append(leaf("day1-a"));
  log.append(leaf("day1-b"));
  const r1 = await anchorDay({ date: "2026-09-17", log, provider, anchors });
  log.append(leaf("day2-a"));
  const r2 = await anchorDay({ date: "2026-09-18", log, provider, anchors });
  log.append(leaf("day3-a"));
  log.append(leaf("day3-b"));
  log.append(leaf("day3-c"));
  const r3 = await anchorDay({ date: "2026-09-19", log, provider, anchors });
  return { ...s, r1, r2, r3 };
}

test("anchor chain: genesis, links, recomputed hashes", async () => {
  const { anchors, r1, r2, r3 } = await threeDays();
  assert.equal(r1.prev_anchor_hash, GENESIS_HASH);
  assert.equal(r1.leaf_count, 2);
  assert.equal(r2.leaf_count, 3);
  assert.equal(r3.leaf_count, 6);
  assert.equal(r2.prev_anchor_hash, r1.record_hash);
  assert.equal(r3.prev_anchor_hash, r2.record_hash);
  assert.equal(r1.record_hash, computeRecordHash(r1));
  const records = await anchors.records();
  assert.deepEqual(verifyChain(records), { ok: true, reason: "ok" });
  assert.ok(r1.provider_ref!.startsWith("local:2026-09-17:"));
});

test("verify each of 3 days from the journal alone", async () => {
  const { journal, anchors } = await threeDays();
  for (const d of ["2026-09-17", "2026-09-18", "2026-09-19"]) {
    const v = await verifyAnchorForDate({ date: d, journalPath: journal, anchors });
    assert.deepEqual(v, { ok: true, reason: "ok" }, d);
  }
});

test("unknown date → no_anchor_for_date", async () => {
  const { journal, anchors } = await threeDays();
  const v = await verifyAnchorForDate({ date: "2026-09-20", journalPath: journal, anchors });
  assert.equal(v.ok, false);
  assert.ok(v.reason.includes("no_anchor_for_date"));
});

test("tampered journal leaf → root_mismatch", async () => {
  const s = await threeDays();
  // Corrupt the first journal leaf (flip one hex char).
  const lines = readFileSync(s.journal, "utf-8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[0]) as { index: number; leaf: string };
  rec.leaf = (rec.leaf[0] === "0" ? "1" : "0") + rec.leaf.slice(1);
  lines[0] = JSON.stringify(rec);
  writeFileSync(s.journal, lines.join("\n") + "\n");
  const v = await verifyAnchorForDate({
    date: "2026-09-17",
    journalPath: s.journal,
    anchors: s.anchors,
  });
  assert.equal(v.ok, false);
  assert.ok(v.reason.includes("root_mismatch"), v.reason);
});

test("tampered anchor record → chain broken", async () => {
  const s = await threeDays();
  const lines = readFileSync(s.anchorsPath, "utf-8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[1]) as { root: string };
  rec.root = "ff".repeat(32);
  lines[1] = JSON.stringify(rec);
  writeFileSync(s.anchorsPath, lines.join("\n") + "\n");
  const anchors = new FileAnchorLog(s.anchorsPath);
  const v = await verifyAnchorForDate({
    date: "2026-09-18",
    journalPath: s.journal,
    anchors,
  });
  assert.equal(v.ok, false);
  assert.ok(v.reason.includes("record_hash_mismatch"), v.reason);
});

test("anchor refuses to go backwards in time", async () => {
  const { log, anchors, provider } = setup();
  log.append(leaf("a"));
  await anchorDay({ date: "2026-09-19", log, provider, anchors });
  await assert.rejects(
    anchorDay({ date: "2026-09-18", log, provider, anchors }),
    /would not advance the chain/,
  );
  await assert.rejects(
    anchorDay({ date: "not-a-date", log, provider, anchors }),
    /bad date/,
  );
});

test("recomputeRootAt matches the live log root at that prefix", async () => {
  const { journal, r2 } = await threeDays();
  assert.equal(recomputeRootAt(journal, 3), r2.root);
});

test("OpenTimestamps provider: disabled by default, never touches network", async () => {
  const p = new OpenTimestampsProvider();
  const { log, anchors } = setup();
  log.append(leaf("a"));
  const records = await anchors.records();
  assert.equal(records.length, 0);
  const body = {
    version: "veritas-anchor/1" as const,
    date: "2026-09-19",
    tree: "veritas-main",
    root: "ab".repeat(32),
    leaf_count: 1,
    prev_anchor_hash: GENESIS_HASH,
    anchored_at: "2026-09-19T00:00:00Z",
    provider: "opentimestamps",
  };
  await assert.rejects(
    p.anchor({ ...body, record_hash: computeRecordHash(body) }),
    /disabled/,
  );
  // Payload builders are pure and deterministic.
  const d1 = otsDigestHex("ab".repeat(32));
  assert.equal(d1, otsDigestHex("ab".repeat(32)));
  assert.equal(d1.length, 64);
  const payload = buildCalendarPayload(d1);
  assert.equal(payload.method, "POST");
  assert.ok(payload.body.includes(d1));
});
