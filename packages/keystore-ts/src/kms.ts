/**
 * KMS-backed KeyStore — PRODUCTION.
 *
 * Private key material NEVER leaves the KMS/HSM. This class holds no private
 * bytes at all: signing is a remote `Sign` call, public keys are fetched via
 * `GetPublicKey`. The registry (public records only) is still JSONL on disk so
 * the well-known document and rotation state stay auditable.
 *
 * The KMS client is injected (KmsClientLike), so unit tests run against a stub
 * and production passes the real AWS SDK v3 KMSClient — see README.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ERR_DUPLICATE_KEY_ID,
  ERR_KEY_NOT_FOUND,
  ERR_KEY_RETIRED,
  KeyRecord,
  KeyKind,
  KeyStatus,
  KeyStore,
  KeystoreError,
  KmsClientLike,
} from "./types.js";
import { nowIso, successorKeyId } from "./software.js";

const b64e = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/**
 * AWS GetPublicKey returns a DER SubjectPublicKeyInfo. For Ed25519 that is a
 * fixed 12-byte prefix followed by the raw 32-byte key:
 *   30 2a 30 05 06 03 2b 65 70 03 21 00 || pubkey(32)
 */
export const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

export function spkiToRawEd25519(spki: Uint8Array): Uint8Array {
  const hex = Buffer.from(spki).toString("hex");
  if (
    !hex.startsWith(ED25519_SPKI_PREFIX) ||
    hex.length !== ED25519_SPKI_PREFIX.length + 64
  ) {
    throw new KeystoreError("BAD_SPKI", "GetPublicKey did not return Ed25519 SPKI");
  }
  return new Uint8Array(Buffer.from(hex.slice(ED25519_SPKI_PREFIX.length), "hex"));
}

function defaultKeyId(records: KeyRecord[], owner: string, kind: KeyKind): string {
  const prefix = kind === "factlock" ? "vkey_main" : `bkey_${owner}`;
  let max = 0;
  for (const r of records) {
    if (r.owner === owner && r.kind === kind) {
      const m = new RegExp(`^${prefix}_(\\d+)$`).exec(r.key_id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `${prefix}_${String(max + 1).padStart(2, "0")}`;
}

export class KmsKeyStore implements KeyStore {
  private records: KeyRecord[] = [];
  private readonly kms: KmsClientLike;
  private readonly dir: string | null;
  /** Maps our key_id -> the KMS key id/ARN used in Sign/GetPublicKey calls. */
  private kmsIds = new Map<string, string>();

  constructor(kms: KmsClientLike, dir?: string) {
    this.kms = kms;
    this.dir = dir ?? null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.load();
    }
  }

  private registryPath(): string {
    return join(this.dir!, "registry.jsonl");
  }
  private mappingPath(): string {
    return join(this.dir!, "kms-mapping.json");
  }

  private load(): void {
    const rp = this.registryPath();
    if (existsSync(rp)) {
      for (const line of readFileSync(rp, "utf-8").split("\n")) {
        if (line.trim()) this.records.push(JSON.parse(line));
      }
    }
    const mp = this.mappingPath();
    if (existsSync(mp)) {
      const entries: Array<[string, string]> = JSON.parse(readFileSync(mp, "utf-8"));
      this.kmsIds = new Map(entries);
    }
  }

  private persist(): void {
    if (!this.dir) return;
    mkdirSync(dirname(this.registryPath()), { recursive: true });
    writeFileSync(
      this.registryPath(),
      this.records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    writeFileSync(this.mappingPath(), JSON.stringify([...this.kmsIds.entries()]));
  }

  private find(keyId: string): KeyRecord {
    const r = this.records.find((x) => x.key_id === keyId);
    if (!r) throw new KeystoreError(ERR_KEY_NOT_FOUND, `unknown key_id ${keyId}`);
    return r;
  }

  private kmsIdFor(keyId: string): string {
    const id = this.kmsIds.get(keyId);
    if (!id) throw new KeystoreError(ERR_KEY_NOT_FOUND, `no KMS mapping for ${keyId}`);
    return id;
  }

  /**
   * NOTE: production key creation happens OUT OF BAND (CloudFormation/Terraform
   * creates the KMS ECC_ED25519 key). generateKey here *imports* an existing
   * KMS key into the registry — it never fabricates key material.
   */
  async generateKey(
    owner: string,
    kind: KeyKind,
    keyId?: string,
    kmsKeyId?: string,
  ): Promise<KeyRecord> {
    if (!kmsKeyId) {
      throw new KeystoreError(
        "KMS_KEY_REQUIRED",
        "KmsKeyStore.generateKey requires the KMS key id/ARN (keys are created out of band)",
      );
    }
    const id = keyId ?? defaultKeyId(this.records, owner, kind);
    if (this.records.some((r) => r.key_id === id)) {
      throw new KeystoreError(ERR_DUPLICATE_KEY_ID, `key_id ${id} already exists`);
    }
    const { PublicKey } = await this.kms.getPublicKey({ KeyId: kmsKeyId });
    const raw = spkiToRawEd25519(PublicKey);
    const ts = nowIso();
    const rec: KeyRecord = {
      key_id: id,
      owner,
      kind,
      alg: "Ed25519",
      public_key: b64e(raw),
      created_at: ts,
      valid_from: ts,
      valid_until: null,
      status: "active" satisfies KeyStatus,
    };
    this.records.push(rec);
    this.kmsIds.set(id, kmsKeyId);
    this.persist();
    return { ...rec };
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const rec = this.find(keyId);
    if (rec.status === "retired") {
      throw new KeystoreError(ERR_KEY_RETIRED, `key ${keyId} is retired and cannot sign`);
    }
    // The ONLY thing that crosses the wire: key id + message. No private bytes.
    const { Signature } = await this.kms.sign({
      KeyId: this.kmsIdFor(keyId),
      Message: message,
      SigningAlgorithm: "ED25519",
    });
    if (Signature.length !== 64) {
      throw new KeystoreError("BAD_SIGNATURE", "KMS did not return a 64-byte signature");
    }
    return Signature;
  }

  async getPublicKey(keyId: string): Promise<Uint8Array> {
    return b64d(this.find(keyId).public_key);
  }

  async getRecord(keyId: string): Promise<KeyRecord | null> {
    return { ...this.find(keyId) };
  }

  async listRecords(owner?: string): Promise<KeyRecord[]> {
    return this.records.filter((r) => !owner || r.owner === owner).map((r) => ({ ...r }));
  }

  async activeKey(owner: string, kind: KeyKind): Promise<KeyRecord | null> {
    const found = this.records.find(
      (r) => r.owner === owner && r.kind === kind && r.status === "active",
    );
    return found ? { ...found } : null;
  }

  /**
   * Rotation for KMS keys: the NEW key must already exist in KMS (created out
   * of band); pass its KMS id/ARN. The old key enters grace, then sunset().
   */
  async rotate(
    keyId: string,
    opts?: { gracePeriodDays?: number; newKmsKeyId?: string; newKeyId?: string },
  ): Promise<KeyRecord> {
    const old = this.find(keyId);
    if (old.status === "retired") {
      throw new KeystoreError(ERR_KEY_RETIRED, `cannot rotate retired key ${keyId}`);
    }
    if (!opts?.newKmsKeyId) {
      throw new KeystoreError(
        "KMS_KEY_REQUIRED",
        "KmsKeyStore.rotate requires newKmsKeyId (the successor KMS key, created out of band)",
      );
    }
    const graceDays = opts.gracePeriodDays ?? 30;
    const newId = opts.newKeyId ?? successorKeyId(keyId);
    if (this.records.some((r) => r.key_id === newId)) {
      throw new KeystoreError(ERR_DUPLICATE_KEY_ID, `key_id ${newId} already exists`);
    }
    const { PublicKey } = await this.kms.getPublicKey({ KeyId: opts.newKmsKeyId });
    const raw = spkiToRawEd25519(PublicKey);
    const ts = nowIso();
    const graceUntil = new Date(Date.now() + graceDays * 86400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    old.status = "grace";
    old.valid_until = graceUntil;
    const rec: KeyRecord = {
      key_id: newId,
      owner: old.owner,
      kind: old.kind,
      alg: "Ed25519",
      public_key: b64e(raw),
      created_at: ts,
      valid_from: ts,
      valid_until: null,
      status: "active",
    };
    this.records.push(rec);
    this.kmsIds.set(newId, opts.newKmsKeyId);
    this.persist();
    return { ...rec };
  }

  async sunset(keyId: string): Promise<void> {
    const rec = this.find(keyId);
    if (rec.status === "retired") return; // idempotent
    rec.status = "retired";
    rec.valid_until = nowIso();
    this.persist();
  }
}
