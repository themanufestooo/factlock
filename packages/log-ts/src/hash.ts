import { createHash } from "node:crypto";

const DOMAIN_LEAF = new Uint8Array([0x00]);
const DOMAIN_NODE = new Uint8Array([0x01]);

export const HASH_LEN = 32;

/** SHA-256 over arbitrary bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

/** RFC 6962 leaf hash: SHA256(0x00 || leaf). */
export function leafHash(leaf: Uint8Array): Uint8Array {
  return createHash("sha256").update(DOMAIN_LEAF).update(leaf).digest();
}

/** RFC 6962 node hash: SHA256(0x01 || left || right). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash("sha256").update(DOMAIN_NODE).update(left).update(right).digest();
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("fromHex: expected even-length hex string");
  }
  return Buffer.from(hex, "hex");
}
