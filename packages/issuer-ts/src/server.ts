/**
 * Minimal HTTP server for issuance (T3) — node:http only, no framework.
 *
 * Routes:
 *   POST /v1/businesses/{id}/attest   issuance (authenticated)
 *   GET  /.well-known/veritas-keys.json  key directory (public)
 *   GET  /healthz                       liveness
 *
 * Authentication is a pluggable hook. The default STUB accepts a configured
 * bearer-token set — dev/test only. Production MUST inject a hook backed by
 * the real identity provider (fail closed: no hook => 401 everything).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildWellKnown } from "@veritas/keystore";
import { issueAttestation, type IssuerOptions } from "./issuer.js";
import { IssueError } from "./types.js";

export interface AuthContext {
  principal: string;
}

export interface ServerOptions extends IssuerOptions {
  /** Return null to reject. Default: reject everything (fail closed). */
  authHook?: (req: IncomingMessage) => Promise<AuthContext | null>;
  /** Convenience stub: accept these bearer tokens. Documented as dev-only. */
  authTokens?: string[];
  maxBodyBytes?: number;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new IssueError(413, "body_too_large", `body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function stubHook(tokens: Set<string>) {
  return async (req: IncomingMessage): Promise<AuthContext | null> => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (m && tokens.has(m[1])) return { principal: "api-client" };
    return null;
  };
}

export function createIssuerServer(opts: ServerOptions): Server {
  const maxBody = opts.maxBodyBytes ?? 1_048_576;
  const authHook =
    opts.authHook ?? (opts.authTokens ? stubHook(new Set(opts.authTokens)) : async () => null);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === "/.well-known/veritas-keys.json") {
        const doc = buildWellKnown(await opts.keystore.listRecords());
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
        });
        res.end(JSON.stringify(doc));
        return;
      }

      const attestMatch = /^\/v1\/businesses\/([^/]+)\/attest$/.exec(path);
      if (req.method === "POST" && attestMatch) {
        const authed = await authHook(req);
        if (!authed) {
          json(res, 401, { error: "unauthorized", message: "valid bearer credentials required" });
          return;
        }
        const businessId = decodeURIComponent(attestMatch[1]);
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, maxBody));
        } catch (e) {
          if (e instanceof IssueError && e.status === 413) throw e;
          throw new IssueError(400, "invalid_json", "request body is not valid JSON");
        }
        if (typeof body !== "object" || body === null) {
          throw new IssueError(400, "invalid_json", "request body must be a JSON object");
        }
        const subject = (body as Record<string, unknown>).subject as
          | Record<string, unknown>
          | undefined;
        if (subject && subject.business_id && subject.business_id !== businessId) {
          throw new IssueError(400, "business_mismatch", "path business id does not match subject.business_id", [
            { path: "/subject/business_id", message: `expected ${businessId}` },
          ]);
        }
        const attestation = await issueAttestation(body, opts);
        json(res, 201, attestation);
        return;
      }

      json(res, 404, { error: "not_found", message: `no route ${req.method} ${path}` });
    } catch (e) {
      if (e instanceof IssueError) {
        json(res, e.status, {
          error: e.code,
          message: e.message,
          ...(e.fields ? { fields: e.fields } : {}),
        });
        return;
      }
      // Never leak internals; the keystore/HSM errors stay server-side.
      json(res, 500, { error: "internal", message: "internal error" });
    }
  });
}
