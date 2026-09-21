/**
 * Shared fixtures for ops-ts tests: full T2/T3/T4/T6 stack in-process.
 */
import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims, type Attestation, type IssueRequest } from "@factlock/issuer";
import {
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
  verifyAttestation,
} from "@factlock/verify-api";
import {
  InMemoryAuditLog,
  InMemoryBusinessDirectory,
  InMemoryCdnMirror,
  InMemoryDisputeStore,
  InMemoryFlagStore,
  InMemoryVisitStore,
} from "../src/stores.js";
import type { DisputeDeps } from "../src/disputes.js";

export const T0 = new Date("2026-09-19T12:00:00Z");
export const DAY = 86_400_000;
export const BIZ = "biz_rapido";
export const BIZ_LAT = 25.987;
export const BIZ_LNG = -80.357;

export function authRecord(id: string) {
  return `auth_${id}`;
}

export function baseIssueRequest(): IssueRequest {
  return {
    subject: { business_id: BIZ, legal_name: "Rapido Plumbing LLC" },
    claims: [
      { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
      { type: "hours", timezone: "America/New_York", schedule: [{ day: "mon", open: "08:00", close: "18:00" }] },
    ],
    verification_method: "field_visit",
    verifier_id: "ver_007",
    evidence_refs: ["evidence_ops"],
    authorization_id: authRecord("1"),
    business_key_id: "",
  };
}

export async function makeStack(now: Date = T0) {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey(BIZ, "business");
  const log = new MerkleLog();
  const clock = () => new Date(now);
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();

  const issue = async (overrides: Partial<IssueRequest> = {}): Promise<Attestation> => {
    const req = { ...baseIssueRequest(), business_key_id: bizRec.key_id, ...overrides };
    authorizations.put({ authorization_id: req.authorization_id, business_id: BIZ, principal: "owner_rapido", claim_digest: digestClaims(req.claims), method: "authenticated_session", authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file", expires_at: new Date(now.getTime() + 600_000).toISOString() });
    for (const ref of req.evidence_refs) evidence.put({ evidence_ref: ref, business_id: BIZ, claim_types: req.claims.map((claim) => String(claim.type)), verified_at: "2026-09-19T11:58:00Z", expires_at: new Date(now.getTime() + DAY).toISOString(), verification_method: req.verification_method, verifier_id: req.verifier_id });
    return issueAttestation(req, { keystore, log, clock, authorizations, evidence }, { principal: "owner_rapido" });
  };

  const attestations = new InMemoryAttestationStore();
  const statuses = new InMemoryStatusRegistry();
  const directory = new InMemoryBusinessDirectory();
  await directory.put({ business_id: BIZ, name: "Rapido Plumbing LLC", lat: BIZ_LAT, lng: BIZ_LNG });
  const visits = new InMemoryVisitStore();
  const flags = new InMemoryFlagStore();
  const audit = new InMemoryAuditLog();
  const disputes = new InMemoryDisputeStore();
  const cdn = new InMemoryCdnMirror();

  const disputeDeps: DisputeDeps = { attestations, statuses, disputes, keystore, log, cdn, clock, issueCorrection: issue };
  const verifyDeps = { keystore, log, statuses, clock };

  return {
    keystore, bizRec, log, clock, issue,
    attestations, statuses, directory, visits, flags, audit, disputes, cdn,
    disputeDeps, verifyDeps,
    verify: (id: string) => verifyAttestation(id, attestations, verifyDeps),
  };
}
