/**
 * Attestation issuance (T3).
 *
 * Flow:
 *   1. Validate the request body against issue-request.json (400, field errors).
 *   2. Require a well-formed authorization record (422 — no countersignature
 *      without one, spec §3.2). The record is the v1 custodial approval:
 *      the business authorized this issuance via logged-in session + SMS.
 *   3. Stamp verified_at from the SERVER clock (injectable for tests).
 *      device_time is metadata only — a skewed client clock cannot move it.
 *   4. valid_until = verified_at + the shortest re-verification interval
 *      across the attestation's claim types (spec §2 freshness table).
 *   5. Sign the canonical JSON (minus signatures/log) with the custodial
 *      business key, then countersign with the Veritas key (keystore T2).
 *   6. Append the canonical attestation (minus the log block) to the
 *      transparency log (T4); record leaf_index + root.
 *   7. Journal the authorization record immutably (it is also hash-committed
 *      inside the attestation's authorization block, which the log leaf covers).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, canonicalizeBytes } from "@veritas/attestation-core";
import type { KeyStore } from "@veritas/keystore";
import { MerkleLog } from "@veritas/merkle-log";
import { IssueError, type Attestation, type AuthRecord, type IssueRequest } from "./types.js";
import { validateUnsignedShape, validateAttestationShape, validateIssueRequest } from "./validate.js";
import { newAttestationId } from "./ulid.js";

/** Re-verification intervals per claim type, days (spec §2). */
export const CLAIM_INTERVAL_DAYS: Record<string, number> = {
  identity: 365,
  license: 30,
  hours: 90,
  price: 30,
  availability: 7,
};

export interface IssuerOptions {
  keystore: KeyStore;
  log: MerkleLog;
  /** Server clock. Default: real time. Tests inject a fixed clock. */
  clock?: () => Date;
  /** Transparency-log tree name. Default "veritas-main". */
  treeName?: string;
  /** Owner label of Veritas signing keys. Default "veritas". */
  veritasOwner?: string;
  /** Where to journal authorization records (immutable JSONL). */
  authJournalPath?: string;
}

const b64e = (b: Uint8Array) => Buffer.from(b).toString("base64");
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function validUntil(verifiedAt: Date, claims: Array<Record<string, unknown>>): string {
  let minDays = Infinity;
  for (const c of claims) {
    const days = CLAIM_INTERVAL_DAYS[String(c.type)] ?? 30;
    if (days < minDays) minDays = days;
  }
  return iso(new Date(verifiedAt.getTime() + minDays * 86400_000));
}

export async function issueAttestation(
  rawRequest: unknown,
  opts: IssuerOptions,
): Promise<Attestation> {
  const clock = opts.clock ?? (() => new Date());
  const treeName = opts.treeName ?? "veritas-main";
  const veritasOwner = opts.veritasOwner ?? "veritas";

  // 1. Request shape.
  const reqErrors = validateIssueRequest(rawRequest);
  if (reqErrors.length > 0) {
    throw new IssueError(400, "schema_validation", "request failed schema validation", reqErrors);
  }
  const req = rawRequest as IssueRequest;

  // Path/business consistency is enforced by the HTTP layer; the core takes
  // subject.business_id as authoritative.
  const businessId = String((req.subject as Record<string, unknown>).business_id);

  // 2. Authorization gate — 422, per spec §3.2 / ticket T3 AC.
  const authRaw = req.authorization as Record<string, unknown> | undefined;
  if (!authRaw || typeof authRaw !== "object") {
    throw new IssueError(
      422,
      "authorization_required",
      "countersignature requires an authorization record (auth_id, session_id, sms_confirmation_ref); none was provided",
    );
  }
  const authFields: Array<{ path: string; message: string }> = [];
  for (const f of ["auth_id", "session_id", "sms_confirmation_ref", "authorized_at", "authorized_by"] as const) {
    const v = authRaw[f];
    if (typeof v !== "string" || v.length === 0) {
      authFields.push({ path: `/authorization/${f}`, message: "required non-empty string" });
    }
  }
  if (authRaw.authorized_by !== "owner-on-file") {
    authFields.push({ path: "/authorization/authorized_by", message: 'must be "owner-on-file"' });
  }
  if (authFields.length > 0) {
    throw new IssueError(422, "authorization_invalid", "authorization record is malformed", authFields);
  }
  const auth = authRaw as unknown as AuthRecord;
  const now = clock();
  const authorizedAt = new Date(auth.authorized_at);
  if (Number.isNaN(authorizedAt.getTime())) {
    throw new IssueError(422, "authorization_invalid", "authorization.authorized_at is not a valid timestamp", [
      { path: "/authorization/authorized_at", message: "must be RFC 3339" },
    ]);
  }
  if (authorizedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new IssueError(422, "authorization_invalid", "authorization.authorized_at is in the future", [
      { path: "/authorization/authorized_at", message: "must not be in the future" },
    ]);
  }

  // 3+4. Server-stamped time. device_time (if any) is preserved as metadata.
  const verifiedAt = now;
  const attestationId = req.attestation_id ?? newAttestationId(verifiedAt.getTime());

  // Resolve keys.
  const bizRec = await opts.keystore.getRecord(req.business_key_id);
  if (!bizRec || bizRec.owner !== businessId || bizRec.kind !== "business") {
    throw new IssueError(
      422,
      "business_key_invalid",
      `business_key_id ${req.business_key_id} is not a usable business key for ${businessId}`,
    );
  }
  if (bizRec.status === "retired") {
    throw new IssueError(422, "business_key_invalid", `business key ${req.business_key_id} is retired`);
  }
  const veritasKeyId = req.veritas_key_id ?? (await opts.keystore.activeKey(veritasOwner, "veritas"))?.key_id;
  if (!veritasKeyId) {
    throw new IssueError(503, "no_veritas_key", "no active Veritas signing key configured");
  }

  const unsigned = {
    attestation_id: attestationId,
    protocol_version: "1.1",
    status: "ACTIVE",
    subject: req.subject,
    claims: req.claims,
    verified_at: iso(verifiedAt),
    ...(req.device_time ? { device_time: req.device_time } : {}),
    valid_until: validUntil(verifiedAt, req.claims),
    verification_method: req.verification_method,
    verifier_id: req.verifier_id,
    ...(req.evidence_refs ? { evidence_refs: req.evidence_refs } : {}),
    authorization: auth,
  };

  const shapeErrors = validateUnsignedShape(unsigned);
  if (shapeErrors.length > 0) {
    // Should be unreachable when the request validated — guards assembly bugs.
    throw new IssueError(500, "internal_shape", "assembled attestation failed schema validation", shapeErrors);
  }

  // 5. Sign canonical bytes (everything except signatures/log).
  const toSign = canonicalize(unsigned);
  const toSignBytes = new TextEncoder().encode(toSign);
  const businessSig = await opts.keystore.sign(req.business_key_id, toSignBytes);
  const veritasSig = await opts.keystore.sign(veritasKeyId, toSignBytes);

  const withSigs = {
    ...unsigned,
    signatures: {
      business: { alg: "Ed25519", key_id: req.business_key_id, sig: b64e(businessSig) },
      veritas: { alg: "Ed25519", key_id: veritasKeyId, sig: b64e(veritasSig) },
    },
  };

  // 6. Append to the transparency log; the leaf commits to signatures too.
  const leafBytes = canonicalizeBytes(withSigs);
  const { index: leaf_index, root } = opts.log.append(leafBytes);

  const attestation: Attestation = {
    ...(withSigs as Omit<Attestation, "log">),
    log: { tree: treeName, leaf_index, root },
  };

  // Final belt-and-braces: the returned object validates against the full schema.
  const finalErrors = validateAttestationShape(attestation);
  if (finalErrors.length > 0) {
    throw new IssueError(500, "internal_shape", "issued attestation failed schema validation", finalErrors);
  }

  // 7. Immutable authorization journal.
  if (opts.authJournalPath) {
    mkdirSync(dirname(opts.authJournalPath), { recursive: true });
    appendFileSync(
      opts.authJournalPath,
      JSON.stringify({
        received_at: iso(now),
        attestation_id: attestationId,
        business_id: businessId,
        authorization: auth,
      }) + "\n",
    );
  }

  return attestation;
}
