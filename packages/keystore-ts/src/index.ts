/** Veritas key management — TypeScript (T2). */
export {
  KeystoreError,
  ERR_KEY_NOT_FOUND,
  ERR_KEY_RETIRED,
  ERR_DUPLICATE_KEY_ID,
} from "./types.js";
export type {
  KeyKind,
  KeyStatus,
  KeyRecord,
  KeyStore,
  KmsClientLike,
  WellKnownKeys,
} from "./types.js";
export { SoftwareKeyStore, nowIso, successorKeyId } from "./software.js";
export { KmsKeyStore, spkiToRawEd25519, ED25519_SPKI_PREFIX } from "./kms.js";
export { buildWellKnown } from "./wellknown.js";
