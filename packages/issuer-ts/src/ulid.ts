/** Minimal ULID generator (Crockford base32) for attestation ids. No deps. */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let out = "";
  let v = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

function encodeRand(rand: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of rand) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** `fla_01K5EXAMPLE…` — 26-char ULID, lexicographically sortable by time. */
export function newAttestationId(nowMs?: number): string {
  return `fla_${encodeTime(nowMs ?? Date.now())}${encodeRand(randomBytes(10))}`;
}
