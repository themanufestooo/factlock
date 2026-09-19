/** Issuer types (T3). */

export interface AuthRecord {
  auth_id: string;
  session_id: string;
  sms_confirmation_ref: string;
  authorized_at: string; // RFC 3339 UTC, server-stamped by the auth service
  authorized_by: "owner-on-file";
}

export interface IssueRequest {
  subject: Record<string, unknown>;
  claims: Array<Record<string, unknown>>;
  device_time?: string;
  verification_method: string;
  verifier_id: string;
  evidence_refs?: string[];
  /** Validated explicitly by the issuer (422 on any problem). */
  authorization?: unknown;
  business_key_id: string;
  veritas_key_id?: string;
  attestation_id?: string;
}

export interface AttestationSignature {
  alg: "Ed25519";
  key_id: string;
  sig: string; // base64, 64 bytes
}

export interface Attestation {
  attestation_id: string;
  protocol_version: "1.1";
  status: "ACTIVE";
  subject: Record<string, unknown>;
  claims: Array<Record<string, unknown>>;
  verified_at: string;
  device_time?: string;
  valid_until: string;
  verification_method: string;
  verifier_id: string;
  evidence_refs?: string[];
  authorization: AuthRecord;
  signatures: {
    business: AttestationSignature;
    veritas: AttestationSignature;
  };
  log: {
    tree: string;
    leaf_index: number;
    root: string;
  };
}

export interface FieldError {
  /** JSON-pointer-ish path, e.g. "/claims/0/amount". */
  path: string;
  message: string;
}

export class IssueError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: FieldError[];
  constructor(status: number, code: string, message: string, fields?: FieldError[]) {
    super(message);
    this.name = "IssueError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
