/**
 * Minimal HTTP server for the public verification API (T6) — node:http only.
 *
 * Routes (all free, no auth, rate-limited per IP):
 *   GET /v1/verify/:attestation_id   → VerificationResult (200 even when invalid;
 *                                     validity is data, not an HTTP error)
 *   GET /v1/attestations/:id         → raw attestation (free). Undisclosed price
 *                                     amounts are redacted here too (spec §2:
 *                                     signed and logged, never served publicly).
 *                                     The log commits to the full signed bytes.
 *   GET /healthz                     → liveness (not rate-limited)
 *
 * 429 responses carry Retry-After. Unknown IDs → 404.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { verifyAttestation, redactClaims } from "./verifier.js";
import { TokenBucket } from "./ratelimit.js";
import type { VerifyServerOptions } from "./types.js";

function json(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

export function createVerifyServer(opts: VerifyServerOptions): Server {
  const cap = opts.rateLimit?.capacity ?? 60;
  const windowMs = opts.rateLimit?.windowMs ?? 60_000;
  const bucket = new TokenBucket(cap, windowMs);
  const deps = {
    keystore: opts.keystore,
    log: opts.log,
    statuses: opts.statuses,
    clock: opts.clock,
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      const m =
        /^\/v1\/verify\/([^/]+)$/.exec(path) ??
        null;
      const mRaw = /^\/v1\/attestations\/([^/]+)$/.exec(path);

      if (req.method === "GET" && (m || mRaw)) {
        // Free tier: fixed rate limit per IP.
        const gate = bucket.take(clientIp(req));
        if (!gate.allowed) {
          json(
            res,
            429,
            { code: "rate_limited", message: "free-tier rate limit exceeded" },
            { "retry-after": String(gate.retryAfterSec) },
          );
          return;
        }
        const id = decodeURIComponent((m ?? mRaw)![1]);
        if (mRaw) {
          const att = await opts.store.get(id);
          if (!att) {
            json(res, 404, { code: "not_found", message: `no attestation ${id}` });
            return;
          }
          // Spec §2: undisclosed amounts are signed+logged but never served.
          json(res, 200, {
            ...att,
            claims: redactClaims(att.claims as Array<Record<string, unknown>>),
          });
          return;
        }
        const result = await verifyAttestation(id, opts.store, deps);
        if (!result) {
          json(res, 404, { code: "not_found", message: `no attestation ${id}` });
          return;
        }
        json(res, 200, result);
        return;
      }

      json(res, 404, { code: "not_found", message: "unknown route" });
    } catch (err) {
      json(res, 500, {
        code: "internal",
        message: err instanceof Error ? err.message : "internal error",
      });
    }
  });
}
