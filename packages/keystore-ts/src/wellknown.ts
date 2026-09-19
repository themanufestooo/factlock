/**
 * `/.well-known/veritas-keys.json` builder.
 *
 * Agents resolving a signature's key_id fetch this document (CDN-cached) and
 * find the public key by key_id. Current keys carry `"status": "active"` with
 * `valid_until: null`; keys in rotation grace or retired remain listed so old
 * attestations keep verifying (spec: rotation must not break verification).
 */
import { KeyRecord, WellKnownKeys } from "./types.js";
import { nowIso } from "./software.js";

export function buildWellKnown(records: KeyRecord[]): WellKnownKeys {
  const keys = [...records]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => ({
      key_id: r.key_id,
      owner: r.owner,
      kind: r.kind,
      alg: r.alg,
      public_key: r.public_key,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      status: r.status,
    }));
  return { generated_at: nowIso(), keys };
}
