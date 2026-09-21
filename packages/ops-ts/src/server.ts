/**
 * Ops HTTP server (T9–T11) — node:http only.
 *
 *   POST /v1/visits                      record a verification visit (verifier)
 *   GET  /v1/verifiers/:id/accuracy      verifier accuracy (any role)
 *   POST /v1/flags                       open a review flag (verifier)
 *   GET  /v1/flags[?status=open]          list flags (any role)
 *   POST /v1/flags/:id/resolve           resolve a flag (reviewer)
 *   POST /v1/disputes                    open a dispute (reviewer)
 *   GET  /v1/disputes[?status=open]      list disputes (any role)
 *   POST /v1/disputes/:id/resolve        resolve (admin: corrected|suspended|
 *                                        cleared|revoked; 3rd strike→REVOKED)
 *   GET  /healthz                        public
 *
 * 400 = bad shape, 401 = missing/invalid token, 403 = wrong role or
 * cross-business, 404 = unknown id, 422 = business rule. Actor fields
 * (verifier_id, reviewer_id, opened_by) are derived from the authenticated
 * token — forged body values are ignored.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { KeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import type { AttestationStore, StatusRegistry } from "@factlock/verify-api";
import type { Attestation, IssueRequest } from "@factlock/issuer";
import { OpsError } from "./types.js";
import {
  type AuditLog,
  type BusinessDirectory,
  type DisputeStore,
  type FlagStore,
  type VisitStore,
} from "./stores.js";
import type { CdnMirror } from "./types.js";
import { recordVisit, verifierAccuracy } from "./visits.js";
import { openFlag, resolveFlag } from "./flags.js";
import { openDispute, resolveDispute } from "./disputes.js";
import {
  authenticateOps,
  enforceBusinessScope,
  parseOpsTokens,
  requireRole,
  type OpsAuthContext,
  type OpsTokenRecord,
} from "./auth.js";

export interface OpsServerOptions {
  directory: BusinessDirectory;
  visits: VisitStore;
  flags: FlagStore;
  audit: AuditLog;
  disputes: DisputeStore;
  attestations: AttestationStore;
  statuses: StatusRegistry;
  keystore: KeyStore;
  log: MerkleLog;
  cdn: CdnMirror;
  issueCorrection: (request: IssueRequest) => Promise<Attestation>;
  /** Bearer-token map; defaults to FACTLOCK_OPS_TOKENS. */
  tokens?: Map<string, OpsTokenRecord>;
  clock?: () => Date;
  maxBodyBytes?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new OpsError(413, "body_too_large", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
      } catch {
        reject(new OpsError(400, "bad_json", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createOpsServer(opts: OpsServerOptions): Server {
  const maxBody = opts.maxBodyBytes ?? 256_000;
  const clock = opts.clock ?? (() => new Date());
  const tokens = opts.tokens ?? parseOpsTokens(process.env.FACTLOCK_OPS_TOKENS);
  const visitDeps = { directory: opts.directory, visits: opts.visits, disputes: opts.disputes, clock };
  const flagDeps = { flags: opts.flags, audit: opts.audit, attestations: opts.attestations, clock };
  const disputeDeps = {
    attestations: opts.attestations,
    statuses: opts.statuses,
    disputes: opts.disputes,
    keystore: opts.keystore,
    log: opts.log,
    cdn: opts.cdn,
    issueCorrection: opts.issueCorrection,
    clock,
  };

  const auth = (req: IncomingMessage): OpsAuthContext =>
    authenticateOps(req.headers.authorization, tokens);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      // ---- T9 ----
      if (req.method === "POST" && path === "/v1/visits") {
        const a = auth(req);
        requireRole(a, "verifier");
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        enforceBusinessScope(a, String(body.business_id));
        // verifier_id comes from the token; a forged body value is ignored.
        json(res, 201, await recordVisit({ ...(body as Record<string, unknown>), verifier_id: a.actorId } as never, visitDeps));
        return;
      }
      const mAcc = /^\/v1\/verifiers\/([^/]+)\/accuracy$/.exec(path);
      if (req.method === "GET" && mAcc) {
        auth(req);
        json(res, 200, await verifierAccuracy(decodeURIComponent(mAcc[1]), visitDeps));
        return;
      }

      // ---- T10 ----
      if (req.method === "POST" && path === "/v1/flags") {
        const a = auth(req);
        requireRole(a, "verifier");
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        const att = await opts.attestations.get(String(body.attestation_id));
        if (!att) throw new OpsError(404, "attestation_unknown", "no such attestation");
        enforceBusinessScope(a, String((att.subject as Record<string, unknown>).business_id));
        json(res, 201, await openFlag(body as never, flagDeps));
        return;
      }
      if (req.method === "GET" && path === "/v1/flags") {
        const a = auth(req);
        const status = url.searchParams.get("status");
        const flags = await opts.flags.list(
          status === "open" || status === "resolved" ? status : undefined,
        );
        // A business-scoped token sees only flags on its own business's attestations.
        const scoped = a.businessId
          ? (await Promise.all(flags.map(async (f) => {
              const att = await opts.attestations.get(f.attestation_id);
              return att && String((att.subject as Record<string, unknown>).business_id) === a.businessId ? f : null;
            }))).filter((f) => f !== null)
          : flags;
        json(res, 200, { flags: scoped });
        return;
      }
      const mFlag = /^\/v1\/flags\/([^/]+)\/resolve$/.exec(path);
      if (req.method === "POST" && mFlag) {
        const a = auth(req);
        requireRole(a, "reviewer");
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        // Flags resolve in the scope of the flagged attestation's business.
        const flag = await opts.flags.get(decodeURIComponent(mFlag[1]));
        if (flag) {
          const att = await opts.attestations.get(flag.attestation_id);
          if (att) enforceBusinessScope(a, String((att.subject as Record<string, unknown>).business_id));
        }
        // reviewer_id comes from the token; a forged body value is ignored.
        const out = await resolveFlag(
          decodeURIComponent(mFlag[1]),
          { ...(body as Record<string, unknown>), reviewer_id: a.actorId } as never,
          { ...flagDeps, disputes: disputeDeps },
        );
        if (out.dispute_id) {
          // Indirect dispute: the "dispute.opened" audit trail covers escalations too.
          await opts.audit.append({
            actor: a.actorId,
            action: "dispute.opened",
            subject: {
              dispute_id: out.dispute_id,
              attestation_id: out.flag.attestation_id,
              reason: `escalated from flag ${out.flag.flag_id}`,
            },
          });
        }
        json(res, 200, out);
        return;
      }

      // ---- T11 ----
      if (req.method === "POST" && path === "/v1/disputes") {
        const a = auth(req);
        requireRole(a, "reviewer");
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        const att = await opts.attestations.get(String(body.attestation_id));
        if (!att) throw new OpsError(404, "attestation_unknown", "no such attestation");
        enforceBusinessScope(a, String((att.subject as Record<string, unknown>).business_id));
        // opened_by comes from the token; a forged body value is ignored.
        const dispute = await openDispute({ ...(body as Record<string, unknown>), opened_by: a.actorId } as never, disputeDeps);
        await opts.audit.append({
          actor: a.actorId,
          action: "dispute.opened",
          subject: { dispute_id: dispute.dispute_id, attestation_id: dispute.attestation_id, business_id: dispute.business_id, reason: dispute.reason },
        });
        json(res, 201, dispute);
        return;
      }
      if (req.method === "GET" && path === "/v1/disputes") {
        const a = auth(req);
        // A business-scoped token sees only its own disputes: default the
        // filter to the token's scope when no business_id is given.
        const business = url.searchParams.get("business_id") ?? a.businessId ?? null;
        if (business) enforceBusinessScope(a, business);
        const disputes = business
          ? await opts.disputes.listByBusiness(business)
          : await opts.disputes.listOpen();
        json(res, 200, { disputes });
        return;
      }
      const mDsp = /^\/v1\/disputes\/([^/]+)\/resolve$/.exec(path);
      if (req.method === "POST" && mDsp) {
        const a = auth(req);
        requireRole(a, "admin");
        const body = (await readBody(req, maxBody)) as Record<string, unknown>;
        const disputeId = decodeURIComponent(mDsp[1]);
        const existing = await opts.disputes.get(disputeId);
        if (existing) enforceBusinessScope(a, existing.business_id);
        // reviewer_id comes from the token; a forged body value is ignored.
        const out = await resolveDispute(
          disputeId,
          { ...(body as Record<string, unknown>), reviewer_id: a.actorId } as never,
          disputeDeps,
        );
        const resolution = out.dispute.resolution;
        await opts.audit.append({
          actor: a.actorId,
          action: "dispute.resolved",
          subject: {
            dispute_id: disputeId,
            outcome: resolution?.outcome,
            strikes_after: out.strikes_after,
            attestation_status: out.attestation_status,
          },
        });
        if (resolution?.outcome === "corrected" && out.corrected_attestation_id) {
          await opts.audit.append({
            actor: a.actorId,
            action: "correction.issued",
            subject: {
              dispute_id: disputeId,
              corrected_attestation_id: out.corrected_attestation_id,
            },
          });
        }
        if (resolution?.outcome === "suspended") {
          await opts.audit.append({
            actor: a.actorId,
            action: "attestation.suspended",
            subject: {
              dispute_id: disputeId,
              attestation_id: out.dispute.attestation_id,
            },
          });
        }
        if (resolution?.outcome === "revoked") {
          await opts.audit.append({
            actor: a.actorId,
            action: "attestation.revoked",
            subject: {
              dispute_id: disputeId,
              attestation_id: out.dispute.attestation_id,
              revocation_leaf_index: out.revocation_leaf_index,
            },
          });
        }
        json(res, 200, out);
        return;
      }

      json(res, 404, { code: "not_found", message: "unknown route" });
    } catch (err) {
      if (err instanceof OpsError) {
        json(res, err.status, {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
        });
        return;
      }
      json(res, 500, { code: "internal", message: err instanceof Error ? err.message : "internal error" });
    }
  });
}
