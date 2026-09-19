/**
 * Software KeyStore — DEV/TEST ONLY.
 *
 * Private keys live in process memory and are persisted to the registry
 * directory as JSON (mode 0600) for dev convenience. NEVER use in production:
 * production uses KmsKeyStore (AWS KMS / HSM), where private key material
 * never leaves the hardware. The registry JSONL holds public records only;
 * private material is kept in a separate `secrets/` file so the registry can
 * be audited without exposing keys.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  generateKeypair,
  sign as edSign,
  bytesToHex,
} from "@veritas/attestation-core";
import {
  ERR_DUPLICATE_KEY_ID,
  ERR_KEY_NOT_FOUND,
  ERR_KEY_RETIRED,
  KeyRecord,
  KeyKind,
  KeyStatus,
  KeyStore,
  KeystoreError,
} from "./types.js";

const b64e = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64d = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nextKeyId(records: KeyRecord[], owner: string, kind: KeyKind): string {
  const prefix = kind === "veritas" ? "vkey_main" : `bkey_${owner}`;
  let max = 0;
  for (const r of records) {
    if (r.owner === owner && r.kind === kind) {
      const m = new RegExp(`^${prefix}_(\\d+)$`).exec(r.key_id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `${prefix}_${String(max + 1).padStart(2, "0")}`;
}

/** Bump a trailing _NN sequence, e.g. vkey_main_01 -> vkey_main_02. */
export function successorKeyId(keyId: string): string {
  const m = /^(.*)_(\d+)$/.exec(keyId);
  if (m) return `${m[1]}_${String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0")}`;
  return `${keyId}_02`;
}

interface SecretEntry {
  key_id: string;
  private_key: string; // base64, 64 bytes
}

export class SoftwareKeyStore implements KeyStore {
  private records: KeyRecord[] = [];
  private secrets = new Map<string, Uint8Array>();
  private readonly dir: string | null;

  constructor(dir?: string) {
    this.dir = dir ?? null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.load();
    }
  }

  private registryPath(): string {
    return join(this.dir!, "registry.jsonl");
  }
  private secretsPath(): string {
    return join(this.dir!, "secrets.json");
  }

  private load(): void {
    const rp = this.registryPath();
    if (existsSync(rp)) {
      for (const line of readFileSync(rp, "utf-8").split("\n")) {
        if (line.trim()) this.records.push(JSON.parse(line));
      }
    }
    const sp = this.secretsPath();
    if (existsSync(sp)) {
      const entries: SecretEntry[] = JSON.parse(readFileSync(sp, "utf-8"));
      for (const e of entries) this.secrets.set(e.key_id, b64d(e.private_key));
    }
  }

  private persist(): void {
    if (!this.dir) return;
    mkdirSync(dirname(this.registryPath()), { recursive: true });
    writeFileSync(
      this.registryPath(),
      this.records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const sp = this.secretsPath();
    const entries: SecretEntry[] = [...this.secrets.entries()].map(
      ([key_id, private_key]) => ({ key_id, private_key: b64e(private_key) }),
    );
    writeFileSync(sp, JSON.stringify(entries, null, 2));
    chmodSync(sp, 0o600);
  }

  private find(keyId: string): KeyRecord {
    const r = this.records.find((x) => x.key_id === keyId);
    if (!r) throw new KeystoreError(ERR_KEY_NOT_FOUND, `unknown key_id ${keyId}`);
    return r;
  }

  async generateKey(owner: string, kind: KeyKind, keyId?: string): Promise<KeyRecord> {
    const id = keyId ?? nextKeyId(this.records, owner, kind);
    if (this.records.some((r) => r.key_id === id)) {
      throw new KeystoreError(ERR_DUPLICATE_KEY_ID, `key_id ${id} already exists`);
    }
    const { publicKey, privateKey } = generateKeypair();
    const ts = nowIso();
    const rec: KeyRecord = {
      key_id: id,
      owner,
      kind,
      alg: "Ed25519",
      public_key: b64e(publicKey),
      created_at: ts,
      valid_from: ts,
      valid_until: null,
      status: "active" satisfies KeyStatus,
    };
    // NOTE: generateKey does NOT change the status of any existing key.
    // Grace/retirement transitions belong to rotate()/sunset() only.
    this.records.push(rec);
    this.secrets.set(id, privateKey);
    this.persist();
    return { ...rec };
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const rec = this.find(keyId);
    if (rec.status === "retired") {
      throw new KeystoreError(ERR_KEY_RETIRED, `key ${keyId} is retired and cannot sign`);
    }
    const sk = this.secrets.get(keyId);
    if (!sk) throw new KeystoreError(ERR_KEY_NOT_FOUND, `no private material for ${keyId}`);
    return edSign(sk, message);
  }

  async getPublicKey(keyId: string): Promise<Uint8Array> {
    const rec = this.find(keyId);
    return b64d(rec.public_key);
  }

  async getRecord(keyId: string): Promise<KeyRecord | null> {
    return { ...(this.find(keyId)) };
  }

  async listRecords(owner?: string): Promise<KeyRecord[]> {
    return this.records
      .filter((r) => !owner || r.owner === owner)
      .map((r) => ({ ...r }));
  }

  async activeKey(owner: string, kind: KeyKind): Promise<KeyRecord | null> {
    const found = this.records.find(
      (r) => r.owner === owner && r.kind === kind && r.status === "active",
    );
    return found ? { ...found } : null;
  }

  async rotate(keyId: string, opts?: { gracePeriodDays?: number }): Promise<KeyRecord> {
    const old = this.find(keyId);
    if (old.status === "retired") {
      throw new KeystoreError(ERR_KEY_RETIRED, `cannot rotate retired key ${keyId}`);
    }
    const graceDays = opts?.gracePeriodDays ?? 30;
    const newId = successorKeyId(keyId);
    if (this.records.some((r) => r.key_id === newId)) {
      throw new KeystoreError(
        ERR_DUPLICATE_KEY_ID,
        `successor key_id ${newId} already exists`,
      );
    }
    const { publicKey, privateKey } = generateKeypair();
    const ts = nowIso();
    const graceUntil = new Date(Date.now() + graceDays * 86400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    // Old key: grace — keeps verifying AND signing until graceUntil.
    old.status = "grace";
    old.valid_until = graceUntil;
    const rec: KeyRecord = {
      key_id: newId,
      owner: old.owner,
      kind: old.kind,
      alg: "Ed25519",
      public_key: b64e(publicKey),
      created_at: ts,
      valid_from: ts,
      valid_until: null,
      status: "active",
    };
    // Any other active key for this owner+kind moves to grace too.
    for (const r of this.records) {
      if (r.owner === old.owner && r.kind === old.kind && r.status === "active" && r.key_id !== newId) {
        r.status = "grace";
        if (!r.valid_until) r.valid_until = graceUntil;
      }
    }
    this.records.push(rec);
    this.secrets.set(newId, privateKey);
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

  /** Debug helper — hex of a public key (never logs private material). */
  async publicKeyHex(keyId: string): Promise<string> {
    return bytesToHex(await this.getPublicKey(keyId));
  }
}
