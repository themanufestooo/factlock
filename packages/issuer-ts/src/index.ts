/** FactLock attestation issuance — TypeScript (T3). */
export { issueAttestation, CLAIM_INTERVAL_DAYS } from "./issuer.js";
export type { IssuerOptions } from "./issuer.js";
export { createIssuerServer } from "./server.js";
export type { ServerOptions, AuthContext } from "./server.js";
export { validateIssueRequest, validateUnsignedShape, validateAttestationShape, validateTimestamps } from "./validate.js";
export { newAttestationId } from "./ulid.js";
export { InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "./guards.js";
export type { AuthorizationStore, AuthorizationRecord, EvidenceStore, EvidenceRecord } from "./guards.js";
export { IssueError } from "./types.js";
export type {
  IssueRequest,
  AuthRecord,
  Attestation,
  AttestationSignature,
  FieldError,
  IssueContext,
} from "./types.js";
