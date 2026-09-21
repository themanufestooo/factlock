/**
 * Anchor record types (T5).
 *
 * One record per day: the Merkle root of the transparency log, hash-chained to
 * the previous day's record. Anyone holding the log journal can recompute any
 * historical root and check it against the chain.
 */
export interface AnchorRecord {
  version: "factlock-anchor/1";
  /** UTC date this anchor covers, YYYY-MM-DD. */
  date: string;
  /** Transparency-log tree name (default "factlock-main"). */
  tree: string;
  /** Hex Merkle root as of this anchor. */
  root: string;
  /** Number of leaves in the log when anchored. */
  leaf_count: number;
  /** Hex hash of the previous anchor record (genesis = 64 zeros). */
  prev_anchor_hash: string;
  /** RFC 3339 UTC time the anchor was written. */
  anchored_at: string;
  /** Provider that carried the anchor (e.g. "local", "opentimestamps"). */
  provider: string;
  /** Provider-side reference (txid, OTS digest ref, ...). */
  provider_ref?: string;
  /** Hex SHA-256 over the JCS canonicalization of this record minus record_hash. */
  record_hash: string;
}

export interface AnchorReceipt {
  provider: string;
  /** Opaque provider reference to store on the record. */
  ref: string;
  /** RFC 3339 UTC. */
  at: string;
}

/** Carries an anchor record to an external commitment medium. */
export interface AnchorProvider {
  readonly name: string;
  anchor(record: AnchorRecord): Promise<AnchorReceipt>;
}

/** Hash-chained anchor log (JSONL, one record per line). */
export interface AnchorLog {
  records(): Promise<AnchorRecord[]>;
  append(record: AnchorRecord): Promise<void>;
}
