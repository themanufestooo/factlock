/**
 * Key management types (T2).
 *
 * v1 is custodial: FactLock generates and holds business keypairs in an
 * HSM/KMS; the business authorizes use via a verified channel (login + SMS).
 * The protocol says this plainly (spec §1.1, §3) — the safety property is
 * *detectability* via the authorization trail + transparency log, not
 * pretending the business holds keys it does not. v2 (month 6): business
 * self-custody / bring-your-own-key.
 */

export type KeyKind = "business" | "factlock";
export type KeyStatus = "active" | "grace" | "retired";

/** One row of the key_id registry. Serialized to JSONL, one per line. */
export interface KeyRecord {
  key_id: string;
  /** business_id, or "factlock" for FactLock signing keys. */
  owner: string;
  kind: KeyKind;
  alg: "Ed25519";
  /** Raw 32-byte public key, base64. */
  public_key: string;
  /** RFC 3339 UTC. */
  created_at: string;
  /** RFC 3339 UTC — key may be used for signing from here. */
  valid_from: string;
  /** RFC 3339 UTC, or null while the key is current. */
  valid_until: string | null;
  status: KeyStatus;
}

/** Minimal AWS-KMS-shaped client. Inject the real AWS SDK v3 KMSClient
 *  (or a stub in tests) — see README for the production wiring. */
export interface KmsClientLike {
  sign(params: {
    KeyId: string;
    Message: Uint8Array;
    SigningAlgorithm: "ED25519";
  }): Promise<{ Signature: Uint8Array }>;
  getPublicKey(params: { KeyId: string }): Promise<{ PublicKey: Uint8Array }>;
}

/** Errors thrown by KeyStore implementations. */
export class KeystoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KeystoreError";
    this.code = code;
  }
}
export const ERR_KEY_NOT_FOUND = "KEY_NOT_FOUND";
export const ERR_KEY_RETIRED = "KEY_RETIRED";
export const ERR_KEY_NOT_YET_VALID = "KEY_NOT_YET_VALID";
export const ERR_KEY_EXPIRED = "KEY_EXPIRED";
export const ERR_DUPLICATE_KEY_ID = "DUPLICATE_KEY_ID";

/**
 * Signing backend. Implementations:
 * - SoftwareKeyStore: dev/test only. Private keys live in process memory.
 * - KmsKeyStore: production. Private key material NEVER leaves the KMS/HSM;
 *   this class only ever sees public keys and detached signatures.
 */
export interface KeyStore {
  /** Generate a keypair; returns the registry record (public half only). */
  generateKey(owner: string, kind: KeyKind, keyId?: string): Promise<KeyRecord>;
  /** 64-byte detached Ed25519 signature over message. */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  /** Raw 32-byte public key for keyId. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  getRecord(keyId: string): Promise<KeyRecord | null>;
  listRecords(owner?: string): Promise<KeyRecord[]>;
  /**
   * Rotation: mint a successor key, move the old key to "grace" (it keeps
   * verifying AND signing until the grace period ends), return the new record.
   * Old-key attestations verify forever — verification resolves by key_id.
   */
  rotate(keyId: string, opts?: { gracePeriodDays?: number }): Promise<KeyRecord>;
  /** End grace early: old key becomes "retired" (verify still works, sign refuses). */
  sunset(keyId: string): Promise<void>;
  /** The currently-active key for an owner+kind (for countersigning). */
  activeKey(owner: string, kind: KeyKind): Promise<KeyRecord | null>;
}

/** `/.well-known/factlock-keys.json` document shape. */
export interface WellKnownKeys {
  generated_at: string;
  keys: Array<{
    key_id: string;
    owner: string;
    kind: KeyKind;
    alg: "Ed25519";
    public_key: string;
    valid_from: string;
    valid_until: string | null;
    status: KeyStatus;
  }>;
}
