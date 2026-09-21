/**
 * factlock_check tool handler (T8) — pure function over the T6 verifier.
 *
 * Resolves an attestation by id or by business, runs the full T6 verification
 * in-process (signatures, Merkle inclusion, lifecycle, freshness), and returns
 * a compact machine-readable verdict an agent can act on.
 */
import { verifyAttestation } from "@factlock/verify-api";
import type {
  AttestationStore,
  VerifyDeps,
} from "@factlock/verify-api";
import type { Attestation } from "@factlock/issuer";

/** Latest-attestation lookup by business (pluggable; in-memory v1 below). */
export interface BusinessIndex {
  latestForBusiness(businessId: string): Promise<Attestation | null>;
}

export interface FactLockEnv {
  store: AttestationStore;
  index: BusinessIndex;
  deps: VerifyDeps;
  /** Public base URL used to build details_url links. */
  publicBaseUrl: string;
}

export interface FactLockCheckArgs {
  attestation_id?: string;
  business_id?: string;
  /** If set, the attestation must contain a claim of this type (price|hours|license|availability). */
  claim_type?: string;
}

export interface FactLockCheckResult {
  valid: boolean;
  status: string;
  freshness: string;
  attestation_id: string | null;
  business: { id: string; name: string } | null;
  /** One-line summary, safe to show to a user or quote in a reply. */
  summary_line: string;
  /** Machine-readable reason when valid === false (or freshness warning). */
  reason: string | null;
  claims: Array<{ type: string; item?: string; verdict: string }>;
  /** Link to the full verification API response. */
  details_url: string | null;
}

export const TOOL_NAME = "factlock_check";

/** subject.business_id is typed unknown in the Attestation schema — stringify it. */
export function bizId(att: Attestation): string {
  return String(att.subject.business_id ?? "");
}

export function bizName(att: Attestation): string {
  return String(att.subject.legal_name ?? "");
}
export const TOOL_DESCRIPTION = [
  "Check whether a business's attested claims (price, hours, license, availability)",
  "are cryptographically verified and current.",
  "",
  "CALL THIS BEFORE: quoting a price to a customer, booking an appointment, or",
  "paying an invoice based on a business's stated claims. If the verdict is",
  "valid:false, do NOT rely on the claims — tell the user why (see `reason`).",
  "",
  "Freshness verdicts:",
  "- FRESH: verified within 70% of its re-verification interval. Trust it.",
  "- AGING: 70-100% of the interval elapsed. Usable with caution.",
  "- STALE: past its re-verification interval. Do NOT trust until re-verified.",
  "",
  "Status values: ACTIVE/CLEARED are trusted; CORRECTED is superseded and must",
  "be replaced; DISPUTED means under",
  "review (treat as untrusted); SUSPENDED and REVOKED must not be trusted.",
].join("\n");

function fail(
  reason: string,
  extra: Partial<FactLockCheckResult> = {},
): FactLockCheckResult {
  return {
    valid: false,
    status: "UNKNOWN",
    freshness: "UNKNOWN",
    attestation_id: null,
    business: null,
    summary_line: `UNVERIFIED — ${reason}`,
    reason,
    claims: [],
    details_url: null,
    ...extra,
  };
}

export async function handleFactLockCheck(
  args: FactLockCheckArgs,
  env: FactLockEnv,
): Promise<FactLockCheckResult> {
  const { attestation_id, business_id, claim_type } = args;
  if (!attestation_id && !business_id) {
    return fail("Provide attestation_id or business_id.");
  }
  if (attestation_id && business_id) {
    return fail("Provide attestation_id OR business_id, not both.");
  }

  let att: Attestation | null = null;
  if (attestation_id) {
    att = await env.store.get(attestation_id);
    if (!att) return fail(`No attestation found for id "${attestation_id}".`);
  } else {
    att = await env.index.latestForBusiness(business_id as string);
    if (!att) return fail(`No attestation found for business "${business_id}".`);
  }

  if (claim_type) {
    const has = (att.claims as Array<{ type?: string }>).some(
      (c) => c.type === claim_type,
    );
    if (!has) {
      return fail(
        `Attestation ${att.attestation_id} contains no claim of type "${claim_type}".`,
        {
          attestation_id: att.attestation_id,
          business: {
            id: bizId(att),
            name: bizName(att),
          },
        },
      );
    }
  }

  const r = await verifyAttestation(att.attestation_id, env.store, env.deps);
  if (!r) return fail(`Attestation "${att.attestation_id}" could not be verified.`);

  const base = env.publicBaseUrl.replace(/\/+$/, "");
  const reason = !r.valid
    ? !r.signatures_ok
      ? "signature_invalid"
      : !r.inclusion_ok
        ? "not_in_transparency_log"
        : r.status === "REVOKED"
          ? "revoked"
          : r.status === "SUSPENDED"
            ? "suspended"
            : r.status === "DISPUTED"
              ? "under_review"
              : r.status === "CORRECTED"
                ? "superseded"
              : r.expired
                ? "expired"
                : "untrusted"
    : r.freshness === "STALE"
      ? "stale"
      : r.freshness === "AGING"
        ? "aging"
        : null;

  return {
    valid: r.valid && r.freshness !== "STALE",
    status: r.status,
    freshness: r.freshness,
    attestation_id: r.attestation_id,
    business: {
      id: bizId(att),
      name: bizName(att),
    },
    summary_line: r.message,
    reason,
    claims: r.claims_freshness.map((c) => ({
      type: c.type,
      item: c.item,
      verdict: c.verdict,
    })),
    details_url: `${base}/v1/verify/${r.attestation_id}`,
  };
}
