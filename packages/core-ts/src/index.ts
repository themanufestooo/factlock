/** Veritas attestation protocol — TypeScript core (T1). */
export { canonicalize, canonicalizeBytes } from "./canonicalize.js";
export {
  generateKeypair,
  keypairFromSeed,
  sign,
  verify,
  hexToBytes,
  bytesToHex,
  SEED_BYTES,
  PUBLIC_KEY_BYTES,
  PRIVATE_KEY_BYTES,
  SIGNATURE_BYTES,
} from "./ed25519.js";
export type { Keypair } from "./ed25519.js";
