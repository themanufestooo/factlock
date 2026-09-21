/**
 * Ed25519 signing/verification for the FactLock attestation protocol.
 * Thin wrapper over tweetnacl. Deterministic: same key + bytes => same sig.
 */
import nacl from "tweetnacl";

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const PRIVATE_KEY_BYTES = 64;
export const SIGNATURE_BYTES = 64;

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Random keypair. Private key material: keep in KMS/HSM, never log it. */
export function generateKeypair(): Keypair {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** Deterministic keypair from a 32-byte seed (tests, vectors — never prod). */
export function keypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== SEED_BYTES) throw new Error("seed must be 32 bytes");
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** 64-byte detached signature over message bytes. */
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (privateKey.length !== PRIVATE_KEY_BYTES) {
    throw new Error("private key must be 64 bytes");
  }
  return nacl.sign.detached(message, privateKey);
}

/** True iff the signature is valid for message under publicKey. */
export function verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES) return false;
  if (signature.length !== SIGNATURE_BYTES) return false;
  return nacl.sign.detached.verify(message, signature, publicKey);
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
