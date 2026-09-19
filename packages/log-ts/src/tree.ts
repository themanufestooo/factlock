/**
 * RFC 6962 Merkle transparency log (T4).
 *
 * Append-only log of attestation leaf bytes. Internal layout keeps every tree
 * level in memory (level j holds the RFC 6962 subtree hashes of each aligned
 * 2^j-leaf block, odd nodes carried up unchanged), so inclusion-proof
 * generation is O(log n) array lookups.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { HASH_LEN, fromHex, leafHash, nodeHash, toHex } from "./hash.js";
import { canonicalizeBytes } from "@veritas/attestation-core";

export interface ProofStep {
  /** Sibling subtree hash, hex. */
  hash: string;
  /** True when the sibling sits on the left during recombination. */
  left: boolean;
}

export interface InclusionProof {
  /** Raw leaf bytes, hex. */
  leaf: string;
  index: number;
  /** Tree size this proof is valid against. */
  size: number;
  /** Sibling hashes ordered leaf-up (closest to the leaf first). */
  path: ProofStep[];
  /** Expected tree root, hex. */
  root: string;
}

export interface ConsistencyBlock {
  /** Number of leaves covered; always a power of two. */
  size: number;
  /** Perfect-subtree hash, hex. */
  hash: string;
}

export interface ConsistencyProof {
  oldSize: number;
  newSize: number;
  oldRoot: string;
  newRoot: string;
  /** Blocks partitioning [0, newSize): first oldSize leaves, then the rest. */
  blocks: ConsistencyBlock[];
}

/** Largest power of two strictly smaller than n (n >= 2). */
function lpow2Lt(n: number): number {
  let p = 1;
  while (p * 2 < n) p *= 2;
  return p;
}

/** Growable vector of 32-byte hashes backed by a single Buffer. */
class HashVec {
  private buf: Buffer = Buffer.alloc(0);
  len = 0;
  private cap = 0;

  private ensure(i: number): void {
    if (i < this.cap) return;
    const ncap = Math.max(1, this.cap * 2);
    const nb = Buffer.alloc(ncap * HASH_LEN);
    this.buf.copy(nb, 0, 0, this.len * HASH_LEN);
    this.buf = nb;
    this.cap = ncap;
  }

  set(i: number, h: Uint8Array): void {
    if (h.length !== HASH_LEN) throw new Error("HashVec.set: expected 32 bytes");
    this.ensure(i);
    if (i >= this.len) this.len = i + 1;
    this.buf.set(h, i * HASH_LEN);
  }

  get(i: number): Buffer {
    if (i < 0 || i >= this.len) throw new Error(`HashVec.get: index ${i} out of bounds`);
    return this.buf.subarray(i * HASH_LEN, (i + 1) * HASH_LEN);
  }
}

export class MerkleLog {
  private levels: HashVec[] = [new HashVec()]; // levels[0] = leaf hashes
  private leafData: Buffer[] = [];
  private count = 0;
  private readonly journalPath: string | null;
  private journaling = true;

  /**
   * @param journalPath optional JSONL journal; every append is fsync-free
   * appended as {"index":N,"leaf":"hex"}. `MerkleLog.load(path)` replays it.
   */
  constructor(journalPath?: string) {
    this.journalPath = journalPath ?? null;
    if (this.journalPath) mkdirSync(dirname(this.journalPath), { recursive: true });
  }

  get size(): number {
    return this.count;
  }

  private levelLen(j: number): number {
    return j < this.levels.length ? this.levels[j].len : 0;
  }

  private setLevel(j: number, i: number, h: Uint8Array): void {
    while (this.levels.length <= j) this.levels.push(new HashVec());
    this.levels[j].set(i, h);
  }

  private getLevel(j: number, i: number): Buffer {
    return this.levels[j].get(i);
  }

  /** Append raw leaf bytes. Leaves SHOULD be JCS-canonical attestation bytes. */
  append(leaf: Uint8Array): { index: number; root: string } {
    const index = this.count;
    const data = Buffer.from(leaf);
    this.levels[0].set(index, leafHash(data));
    this.leafData.push(data);
    this.count++;

    // Recompute the path to the root. A node that previously had no right
    // sibling (carried up) is recomputed once the sibling arrives.
    let child = index;
    for (let j = 1; ; j++) {
      const q = child >> 1;
      const base = child & ~1;
      const left = this.getLevel(j - 1, base);
      const sib = base + 1;
      const h =
        sib < this.levelLen(j - 1)
          ? nodeHash(left, this.getLevel(j - 1, sib))
          : left; // carried up unchanged
      this.setLevel(j, q, h);
      child = q;
      if (q === 0) break;
    }

    if (this.journalPath && this.journaling) {
      appendFileSync(
        this.journalPath,
        JSON.stringify({ index, leaf: data.toString("hex") }) + "\n",
      );
    }
    return { index, root: this.getRoot() };
  }

  /**
   * Append an attestation-shaped object: JCS-canonicalized with the T1
   * reference library (@veritas/attestation-core) before hashing.
   */
  appendAttestation(value: unknown): { index: number; root: string } {
    return this.append(canonicalizeBytes(value));
  }

  /** Current tree root, hex. Throws on an empty log. */
  getRoot(): string {
    if (this.count === 0) throw new Error("MerkleLog: empty log has no root");
    const top = this.levels.length - 1;
    if (this.levelLen(top) !== 1) throw new Error("MerkleLog: corrupt top level");
    return toHex(this.getLevel(top, 0));
  }

  /** RFC 6962 inclusion (audit) proof for a leaf. O(log n). */
  getProof(index: number): InclusionProof {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new Error(`MerkleLog.getProof: index ${index} out of range [0, ${this.count})`);
    }
    const path: ProofStep[] = [];
    let pos = index;
    for (let j = 0; j < this.levels.length - 1; j++) {
      const sib = pos ^ 1;
      if (sib < this.levelLen(j)) {
        path.push({ hash: toHex(this.getLevel(j, sib)), left: sib < pos });
      }
      pos >>= 1;
    }
    return {
      leaf: this.leafData[index].toString("hex"),
      index,
      size: this.count,
      path,
      root: this.getRoot(),
    };
  }

  /**
   * RFC 6962-style consistency proof that the tree of `oldSize` leaves is a
   * prefix of the tree of `newSize` leaves (defaults to current size).
   * Proof = perfect aligned blocks partitioning [0, newSize), split at oldSize.
   */
  getConsistencyProof(oldSize: number, newSize?: number): ConsistencyProof {
    const n = newSize ?? this.count;
    if (
      !Number.isInteger(oldSize) ||
      !Number.isInteger(n) ||
      oldSize < 1 ||
      oldSize > n ||
      n > this.count
    ) {
      throw new Error(
        `MerkleLog.getConsistencyProof: need 1 <= oldSize <= newSize <= size (${this.count})`,
      );
    }
    const oldBlocks = this.greedyBlocks(0, oldSize);
    const newBlocks = this.greedyBlocks(oldSize, n - oldSize);
    const blocks = [...oldBlocks, ...newBlocks];
    return {
      oldSize,
      newSize: n,
      oldRoot: MerkleLog.foldBlocks(oldBlocks),
      newRoot: MerkleLog.foldBlocks(blocks),
      blocks,
    };
  }

  /**
   * Fold an ordered perfect-aligned block partition into the RFC 6962 root.
   * Splits recursively at the largest power of two < total size, mirroring §2.1.
   */
  static foldBlocks(blocks: ConsistencyBlock[]): string {
    const hs = blocks.map((b) => ({ size: b.size, hash: fromHex(b.hash) }));
    const rec = (bs: { size: number; hash: Uint8Array }[]): Uint8Array => {
      if (bs.length === 1) return bs[0].hash;
      const total = bs.reduce((a, b) => a + b.size, 0);
      const k = lpow2Lt(total);
      let acc = 0;
      const left: typeof bs = [];
      for (const b of bs) {
        if (acc + b.size <= k) {
          left.push(b);
          acc += b.size;
        } else break;
      }
      const right = bs.slice(left.length);
      if (left.length === 0 || right.length === 0 || acc !== k) {
        throw new Error("foldBlocks: blocks do not partition the range");
      }
      return nodeHash(rec(left), rec(right));
    };
    if (hs.length === 0) throw new Error("foldBlocks: empty block list");
    return toHex(rec(hs));
  }

  /** Maximal perfect aligned blocks partitioning [lo, lo+n). */
  private greedyBlocks(lo: number, n: number): ConsistencyBlock[] {
    const blocks: ConsistencyBlock[] = [];
    let p = lo;
    let rem = n;
    while (rem > 0) {
      let s = 1;
      while (s * 2 <= rem) s *= 2; // largest power of two <= rem
      while (p % s !== 0) s /= 2; // align to p
      let j = 0;
      for (let t = s; t > 1; t /= 2) j++;
      blocks.push({ size: s, hash: toHex(this.getLevel(j, p >> j)) });
      p += s;
      rem -= s;
    }
    return blocks;
  }

  /**
   * Replay a JSONL journal (as written by append with a journalPath) into a
   * fresh in-memory log. The journal is NOT re-attached: replay() is for
   * auditing. Use load() to resume appending to the same journal.
   */
  static replay(journalPath: string): MerkleLog {
    const log = new MerkleLog();
    const text = readFileSync(journalPath, "utf-8");
    let expect = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line) as { index: number; leaf: string };
      if (rec.index !== expect) {
        throw new Error(`journal corrupt: expected index ${expect}, got ${rec.index}`);
      }
      log.append(fromHex(rec.leaf));
      expect++;
    }
    return log;
  }

  /** Replay a journal and keep appending to it. */
  static load(journalPath: string): MerkleLog {
    const log = new MerkleLog(journalPath);
    log.journaling = false;
    try {
      const replayed = MerkleLog.replay(journalPath);
      // Move replayed state over (keeps levels, leaf data, count).
      log.levels = replayed.levels;
      log.leafData = replayed.leafData;
      log.count = replayed.count;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No journal yet: start empty, journaling stays armed.
    }
    log.journaling = true;
    return log;
  }
}

/** Verify an inclusion proof against its stated root. Pure function. */
export function verifyInclusionProof(p: InclusionProof): boolean {
  try {
    if (
      !p ||
      !Number.isInteger(p.index) ||
      !Number.isInteger(p.size) ||
      p.index < 0 ||
      p.index >= p.size ||
      !Array.isArray(p.path)
    ) {
      return false;
    }
    let h: Uint8Array = leafHash(fromHex(p.leaf));
    for (const s of p.path) {
      const sib = fromHex(s.hash);
      if (sib.length !== HASH_LEN) return false;
      h = s.left ? nodeHash(sib, h) : nodeHash(h, sib);
    }
    return toHex(h) === String(p.root).toLowerCase();
  } catch {
    return false;
  }
}

/** Verify a consistency proof: both roots recompute from the blocks. */
export function verifyConsistencyProof(p: ConsistencyProof): boolean {
  try {
    if (!p) return false;
    const { oldSize: m, newSize: n } = p;
    if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || m > n) return false;
    if (!Array.isArray(p.blocks) || p.blocks.length === 0) return false;
    let total = 0;
    for (const b of p.blocks) {
      if (!Number.isInteger(b.size) || b.size < 1 || (b.size & (b.size - 1)) !== 0) {
        return false;
      }
      total += b.size;
    }
    if (total !== n) return false;
    let acc = 0;
    const oldBlocks: ConsistencyBlock[] = [];
    for (const b of p.blocks) {
      if (acc < m) {
        oldBlocks.push(b);
        acc += b.size;
      } else break;
    }
    if (acc !== m) return false;
    return (
      MerkleLog.foldBlocks(oldBlocks) === String(p.oldRoot).toLowerCase() &&
      MerkleLog.foldBlocks(p.blocks) === String(p.newRoot).toLowerCase()
    );
  } catch {
    return false;
  }
}
