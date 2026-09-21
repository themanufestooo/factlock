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
 *      business key, then countersign with the FactLock key (keystore T2).
 *   6. Append the canonical attestation (minus the log block) to the
 *      transparency log (T4); record leaf_index + root.
 *   7. Journal the authorization record immutably (it is also hash-committed
 *      inside the attestation's authorization block, which the log leaf covers).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, canonicalizeBytes } from "@factlock/attestation-core";
import type { KeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { IssueError, type Attestation, type IssueContext, type IssueRequest } from "./types.js";
import { digestClaims, type AuthorizationStore, type EvidenceStore } from "./guards.js";
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
  /** Transparency-log tree name. Default "factlock-main". */
  treeName?: string;
  /** Owner label of FactLock signing keys. Default "factlock". */
  factlockOwner?: string;
  /** Where to journal authorization records (immutable JSONL). */
  authJournalPath?: string;
  /** Server-side, single-use authorization registry. Required; omission fails closed. */
  authorizations?: AuthorizationStore;
  /** Server-side evidence registry. Required; omission fails closed. */
  evidence?: EvidenceStore;
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
  context?: IssueContext,
): Promise<Attestation> {
  const clock = opts.clock ?? (() => new Date());
  const treeName = opts.treeName ?? "factlock-main";
  const factlockOwner = opts.factlockOwner ?? "factlock";

  // 1. Request shape.
  const reqErrors = validateIssueRequest(rawRequest);
  if (reqErrors.length > 0) {
    throw new IssueError(400, "schema_validation", "request failed schema validation", reqErrors);
  }
  const req = rawRequest as IssueRequest;

  // Path/business consistency is enforced by the HTTP layer; the core takes
  // subject.business_id as authoritative.
  const businessId = String((req.subject as Record<string, unknown>).business_id);

  const now = clock();
  if (!context?.principal) {
    throw new IssueError(401, "principal_required", "an authenticated principal is required");
  }
  if (!opts.authorizations || !opts.evidence) {
    throw new IssueError(503, "verification_unavailable", "authorization and evidence verification are not configured");
  }
  const auth = await opts.authorizations.consume({
    authorizationId: req.authorization_id,
    businessId,
    principal: context.principal,
    claimDigest: digestClaims(req.claims),
    now,
  });
  if (!auth) {
    throw new IssueError(422, "authorization_invalid", "authorization is missing, expired, replayed, or not bound to this principal, business, and claim set");
  }
  const evidenceOk = await opts.evidence.verify({
    evidenceRefs: req.evidence_refs,
    businessId,
    claimTypes: req.claims.map((claim) => String(claim.type)),
    verificationMethod: req.verification_method,
    verifierId: req.verifier_id,
    now,
  });
  if (!evidenceOk) {
    throw new IssueError(422, "evidence_invalid", "evidence is missing, expired, unverified, or does not cover every claim");
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
  const factlockKeyId = req.factlock_key_id ?? (await opts.keystore.activeKey(factlockOwner, "factlock"))?.key_id;
  if (!factlockKeyId) {
    throw new IssueError(503, "no_factlock_key", "no active FactLock signing key configured");
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
  const factlockSig = await opts.keystore.sign(factlockKeyId, toSignBytes);

  const withSigs = {
    ...unsigned,
    signatures: {
      business: { alg: "Ed25519", key_id: req.business_key_id, sig: b64e(businessSig) },
      factlock: { alg: "Ed25519", key_id: factlockKeyId, sig: b64e(factlockSig) },
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
