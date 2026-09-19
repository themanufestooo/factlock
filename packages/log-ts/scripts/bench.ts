#!/usr/bin/env node
/**
 * T4 acceptance benchmark: proof-generation p99 < 50ms at 1M leaves.
 *
 * Builds an in-memory log of 1,000,000 leaves (JCS-canonical small payloads,
 * as real attestation leaves would be), then times 2,000 random inclusion
 * proofs. Exits non-zero if p99 >= 50ms.
 */
import { MerkleLog, verifyInclusionProof } from "../src/index.js";
// See src/tree.ts note on this deep relative import.
import { canonicalizeBytes } from "@veritas/attestation-core";

const N = 1_000_000;
const SAMPLES = 2000;
const P99_BUDGET_MS = 50;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main(): void {
  const log = new MerkleLog(); // in-memory: journaling would dominate I/O
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    log.append(canonicalizeBytes({ kind: "bench", seq: i }));
  }
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const rand = mulberry32(0x5eed);
  const times: number[] = new Array(SAMPLES);
  for (let k = 0; k < SAMPLES; k++) {
    const idx = Math.floor(rand() * N);
    const s = process.hrtime.bigint();
    const proof = log.getProof(idx);
    times[k] = Number(process.hrtime.bigint() - s) / 1e6;
    if (!verifyInclusionProof(proof)) {
      console.error(`bench: proof failed to verify at index ${idx}`);
      process.exit(1);
    }
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(SAMPLES * 0.5)];
  const p99 = times[Math.floor(SAMPLES * 0.99)];
  const max = times[SAMPLES - 1];

  const report = {
    leaves: N,
    build_ms: Math.round(buildMs),
    append_per_sec: Math.round(N / (buildMs / 1000)),
    proof_samples: SAMPLES,
    proof_p50_ms: +p50.toFixed(4),
    proof_p99_ms: +p99.toFixed(4),
    proof_max_ms: +max.toFixed(4),
    p99_budget_ms: P99_BUDGET_MS,
    root: log.getRoot(),
    pass: p99 < P99_BUDGET_MS,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) {
    console.error("BENCH FAIL: p99 >= 50ms");
    process.exit(1);
  }
}

main();
