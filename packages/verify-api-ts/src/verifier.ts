/**
 * Verification algorithm (T6) — spec §5, executed server-side:
 *
 *   1. Resolve the attestation from the store.
 *   2. Verify the business signature against the business public key (key_id).
 *   3. Verify the FactLock countersignature against the FactLock key (key_id).
 *      Keys resolve by key_id, so retired keys still verify old attestations.
 *   4. Verify Merkle inclusion against the log's CURRENT root (not the proof's
 *      self-stated root — binding to the published root is the whole point).
 *   5. Resolve the effective lifecycle status (registry override wins).
 *   6. Reject when now >= valid_until; compute freshness verdicts.
 *
 * All time comes from the injected server clock. Nothing is trusted from the
 * attestation beyond what the signatures and the log prove.
 */
import { canonicalizeBytes, verify } from "@factlock/attestation-core";
import { toHex, verifyInclusionProof } from "@factlock/merkle-log";
import type { Attestation } from "@factlock/issuer";
import type {
  AttestationStore,
  LifecycleStatus,
  VerificationResult,
  VerifyDeps,
} from "./types.js";
import { attestationFreshness, claimFreshness } from "./freshness.js";

const b64d = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** Bytes the business signed: canonical JSON of everything except signatures/log. */
function signedBytes(att: Attestation): Uint8Array {
  const { signatures: _s, log: _l, ...rest } = att as unknown as Record<string, unknown>;
  return canonicalizeBytes(rest);
}

/** Bytes committed to the transparency log: canonical JSON minus the log block. */
function leafBytes(att: Attestation): Uint8Array {
  const { log: _l, ...rest } = att as unknown as Record<string, unknown>;
  return canonicalizeBytes(rest);
}

/**
 * Public endpoints never serve amounts for price claims the business marked
 * undisclosed (spec §2: signed and logged, but not published).
 */
export function redactClaims(
  claims: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return claims.map((c) => {
    if (c.type === "price" && c.disclosed === false) {
      const { amount: _a, currency: _c, ...rest } = c;
      return { ...rest, withheld: true };
    }
    return { ...c };
  });
}

function summarize(r: VerificationResult): string {
  if (!r.signatures_ok) return `INVALID SIGNATURE — ${r.attestation_id} fails cryptographic verification. Do not trust.`;
  if (!r.inclusion_ok) return `NOT IN TRANSPARENCY LOG — ${r.attestation_id} is not anchored. Do not trust.`;
  if (r.status === "REVOKED") return `REVOKED — ${r.attestation_id} was permanently revoked. Do not trust.`;
  if (r.status === "DISPUTED") return `UNDER REVIEW — ${r.attestation_id} is disputed. Treat as untrusted until resolved.`;
  if (r.status === "SUSPENDED") return `SUSPENDED — ${r.attestation_id} is suspended. Do not trust.`;
  if (r.status === "CORRECTED") return `SUPERSEDED — ${r.attestation_id} was replaced by a correction. Verify the replacement before trusting any claim.`;
  if (r.expired) return `EXPIRED — ${r.attestation_id} passed its re-verification date. Do not trust.`;
  if (r.freshness === "STALE") return `STALE — ${r.attestation_id} is past its re-verification interval (${r.age_days}d old). Re-verify before trusting.`;
  if (r.freshness === "AGING") return `AGING — ${r.attestation_id} is ${r.age_days}d old and nearing re-verification. Usable with caution.`;
  return `VERIFIED — ${r.attestation_id}: signatures valid, in transparency log, status ACTIVE, ${r.age_days}d old.`;
}

export async function verifyAttestation(
  id: string,
  store: AttestationStore,
  deps: VerifyDeps,
): Promise<VerificationResult | null> {
  const att = await store.get(id);
  if (!att) return null;
  const clock = deps.clock ?? (() => new Date());
  const nowMs = clock().getTime();

  const signed = signedBytes(att);
  const leaf = leafBytes(att);

  // Key authorization (audit H-11): keys resolve to SIGNED registry records
  // carrying owner, role, and validity window — not bare public keys. The
  // business key must belong to the attestation's subject business, the
  // countersigning key must be a FactLock key (kind AND owner), and each must have been
  // valid at issuance time. Unknown, out-of-role, or out-of-window keys
  // fail closed.
  const issuedAtMs = new Date(att.verified_at).getTime();
  let signaturesOk = false;
  try {
    if (!Number.isFinite(issuedAtMs)) throw new Error("bad verified_at");
    const bizRec = await deps.keystore.getRecord(att.signatures.business.key_id);
    const verRec = await deps.keystore.getRecord(att.signatures.factlock.key_id);
    if (!bizRec || !verRec) throw new Error("unknown key_id");
    const businessId = String((att.subject as Record<string, unknown>).business_id);
    if (bizRec.kind !== "business" || bizRec.owner !== businessId) {
      throw new Error("business key is not owned by the subject business");
    }
    // The countersigner must be a FactLock key: BOTH kind and owner are
    // checked, because generateKey() does not restrict the kind a business
    // can register under its own owner.
    const factlockOwner = deps.factlockOwner ?? "factlock";
    if (verRec.kind !== "factlock" || verRec.owner !== factlockOwner) {
      throw new Error("countersigning key is not a FactLock key");
    }
    for (const rec of [bizRec, verRec]) {
      if (new Date(rec.valid_from).getTime() > issuedAtMs) {
        throw new Error(`key ${rec.key_id} was not yet valid at issuance`);
      }
      if (rec.valid_until && new Date(rec.valid_until).getTime() <= issuedAtMs) {
        throw new Error(`key ${rec.key_id} was past its validity window at issuance`);
      }
    }
    const bizPub = new Uint8Array(Buffer.from(bizRec.public_key, "base64"));
    const verPub = new Uint8Array(Buffer.from(verRec.public_key, "base64"));
    const bizOk = verify(bizPub, signed, b64d(att.signatures.business.sig));
    const verOk = verify(verPub, signed, b64d(att.signatures.factlock.sig));
    signaturesOk = bizOk && verOk;
  } catch {
    signaturesOk = false; // unknown key_id, wrong role/owner, out-of-window, malformed sig, etc.
  }

  // Merkle inclusion against the CURRENT published root.
  let inclusionOk = false;
  try {
    const proof = deps.log.getProof(att.log.leaf_index);
    inclusionOk =
      proof.leaf === toHex(leaf) &&
      verifyInclusionProof(proof) &&
      proof.root.toLowerCase() === deps.log.getRoot().toLowerCase();
  } catch {
    inclusionOk = false;
  }

  // Effective lifecycle status.
  const override = await deps.statuses?.get(id);
  const status = (override?.status ?? att.status) as LifecycleStatus;

  // Freshness from the attestation's own verified_at → valid_until span.
  const verifiedAtMs = new Date(att.verified_at).getTime();
  const validUntilMs = new Date(att.valid_until).getTime();
  const f = attestationFreshness(verifiedAtMs, validUntilMs, nowMs);

  const trustedStatus = status === "ACTIVE" || status === "CLEARED";
  const expired = !Number.isFinite(validUntilMs) || nowMs >= validUntilMs;
  const valid =
    signaturesOk && inclusionOk && trustedStatus && !expired && f.verdict !== "STALE";

  const result: VerificationResult = {
    attestation_id: id,
    valid,
    status,
    freshness: f.verdict,
    age_days: f.age_days,
    interval_days: f.interval_days,
    verified_at: att.verified_at,
    valid_until: att.valid_until,
    signatures_ok: signaturesOk,
    inclusion_ok: inclusionOk,
    expired,
    key_ids: {
      business: att.signatures.business.key_id,
      factlock: att.signatures.factlock.key_id,
    },
    claims: valid ? redactClaims(att.claims as Array<Record<string, unknown>>) : [],
    claims_freshness: valid ? claimFreshness(
      att.claims as Array<Record<string, unknown>>,
      verifiedAtMs,
      nowMs,
    ) : [],
    message: "",
  };
  result.message = summarize(result);
  return result;
}
