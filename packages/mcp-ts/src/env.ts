/**
 * Server environment loader (T8).
 *
 * Loads a running FactLock state from a data directory so the MCP server can
 * verify against the real keystore, transparency log, attestation store and
 * lifecycle registry. Layout:
 *
 *   <dataDir>/
 *     log.jsonl            Merkle log journal (T4; created if missing)
 *     keystore/            SoftwareKeyStore registry dir (T2)
 *     attestations.jsonl   one attestation JSON per line
 *     statuses.jsonl       one {attestation_id, status, reason, at} per line
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { InMemoryStatusRegistry } from "@factlock/verify-api";
import type { StatusOverride } from "@factlock/verify-api";
import type { Attestation } from "@factlock/issuer";
import type { FactLockEnv } from "./tool.js";
import { IndexedAttestationStore } from "./indexedStore.js";

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function loadEnv(
  dataDir: string,
  opts: { publicBaseUrl?: string } = {},
): Promise<FactLockEnv> {
  mkdirSync(dataDir, { recursive: true });
  const keystore = new SoftwareKeyStore(join(dataDir, "keystore"));
  const log = MerkleLog.load(join(dataDir, "log.jsonl"));

  const store = new IndexedAttestationStore();
  for (const row of readJsonl(join(dataDir, "attestations.jsonl"))) {
    await store.put(row as unknown as Attestation);
  }

  const statuses = new InMemoryStatusRegistry();
  for (const row of readJsonl(join(dataDir, "statuses.jsonl"))) {
    const id = String(row.attestation_id);
    await statuses.set(id, {
      status: row.status,
      reason: String(row.reason ?? ""),
      at: String(row.at ?? new Date().toISOString()),
    } as StatusOverride);
  }

  return {
    store,
    index: store,
    deps: { keystore, log, statuses },
    publicBaseUrl: opts.publicBaseUrl ?? "https://verify.factlock.example",
  };
}
