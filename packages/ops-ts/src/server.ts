/**
 * Ops HTTP server (T9–T11) — node:http only.
 *
 *   POST /v1/visits                      record a verification visit
 *   GET  /v1/verifiers/:id/accuracy      verifier accuracy (comp input)
 *   POST /v1/flags                       open a review flag
 *   GET  /v1/flags[?status=open]          list flags
 *   POST /v1/flags/:id/resolve           resolve a flag (audit-trailed;
 *                                        decision=dispute escalates to T11)
 *   POST /v1/disputes                    open a dispute (→ DISPUTED)
 *   GET  /v1/disputes[?status=open]      list disputes
 *   POST /v1/disputes/:id/resolve        resolve (corrected|suspended|
 *                                        cleared|revoked; 3rd strike→REVOKED)
 *   GET  /healthz
 *
 * 400 = bad shape, 404 = unknown id, 422 = business rule (GPS, evidence,
 * already-open dispute, missing corrected_request). No auth in v1 — this
 * sits behind the operator VPN / verifier-app auth in production.
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
        const body = await readBody(req, maxBody);
        json(res, 201, await recordVisit(body as never, visitDeps));
        return;
      }
      const mAcc = /^\/v1\/verifiers\/([^/]+)\/accuracy$/.exec(path);
      if (req.method === "GET" && mAcc) {
        json(res, 200, await verifierAccuracy(decodeURIComponent(mAcc[1]), visitDeps));
        return;
      }

      // ---- T10 ----
      if (req.method === "POST" && path === "/v1/flags") {
        const body = (await readBody(req, maxBody)) as Record<string, never>;
        json(res, 201, await openFlag(body as never, flagDeps));
        return;
      }
      if (req.method === "GET" && path === "/v1/flags") {
        const status = url.searchParams.get("status");
        const flags = await opts.flags.list(
          status === "open" || status === "resolved" ? status : undefined,
        );
        json(res, 200, { flags });
        return;
      }
      const mFlag = /^\/v1\/flags\/([^/]+)\/resolve$/.exec(path);
      if (req.method === "POST" && mFlag) {
        const body = (await readBody(req, maxBody)) as Record<string, never>;
        const out = await resolveFlag(decodeURIComponent(mFlag[1]), body as never, {
          ...flagDeps,
          disputes: disputeDeps,
        });
        json(res, 200, out);
        return;
      }

      // ---- T11 ----
      if (req.method === "POST" && path === "/v1/disputes") {
        const body = (await readBody(req, maxBody)) as Record<string, never>;
        json(res, 201, await openDispute(body as never, disputeDeps));
        return;
      }
      if (req.method === "GET" && path === "/v1/disputes") {
        const business = url.searchParams.get("business_id");
        const disputes = business
          ? await opts.disputes.listByBusiness(business)
          : await opts.disputes.listOpen();
        json(res, 200, { disputes });
        return;
      }
      const mDsp = /^\/v1\/disputes\/([^/]+)\/resolve$/.exec(path);
      if (req.method === "POST" && mDsp) {
        const body = (await readBody(req, maxBody)) as Record<string, never>;
        json(res, 200, await resolveDispute(decodeURIComponent(mDsp[1]), body as never, disputeDeps));
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
