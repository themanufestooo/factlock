#!/usr/bin/env node
/**
 * Re-verification scheduler CLI (T12).
 *
 * Usage:
 *   node dist/scripts/scheduler-run.js --attestations ./attestations.jsonl [--now 2026-10-01T00:00:00Z]
 *
 * Reads attestations (JSON array or JSONL, one Attestation per line), prints
 * the due-for-re-verification queue as JSON, most urgent first. Exit 0.
 * Intended to run on a cron schedule (see README).
 */
import { readFileSync } from "node:fs";
import { dueForReverification } from "../src/scheduler.js";
import type { Attestation } from "@veritas/issuer";

function usage(): never {
  console.error("usage: scheduler-run.js --attestations <json|jsonl> [--now <rfc3339>]");
  process.exit(2);
}

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const path = get("--attestations");
if (!path) usage();
const nowArg = get("--now");
const now = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error("scheduler: --now is not a valid timestamp");
  process.exit(2);
}

const raw = readFileSync(path, "utf-8").trim();
let attestations: Attestation[];
try {
  if (raw.startsWith("[")) {
    attestations = JSON.parse(raw);
  } else {
    attestations = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
} catch (e) {
  console.error(`scheduler: cannot parse ${path}: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}

const due = dueForReverification(now, attestations);
console.log(JSON.stringify({ ran_at: now.toISOString(), due_count: due.length, due }, null, 2));
