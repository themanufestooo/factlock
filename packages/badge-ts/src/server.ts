/**
 * Badge HTTP server (T7) — node:http only, no framework.
 *
 *   GET /badge/:attestation_id   → hosted badge page (HTML, EN/ES)
 *   GET /badge/data/:id          → JSON payload for the embed script (CORS *)
 *   GET /badge.js                → the embeddable script (CORS *)
 *   GET /healthz                 → liveness
 *
 * Language: ?lang=es wins, then Accept-Language, else en.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { verifyAttestation } from "@veritas/verify-api";
import type {
  AttestationStore,
  StatusRegistry,
  VerifyDeps,
} from "@veritas/verify-api";
import type { KeyStore } from "@veritas/keystore";
import type { LogReader } from "@veritas/verify-api";
import { badgeData, badgePage, badgeScript, notFoundPage, pickLang } from "./render.js";
import type { Lang } from "./i18n.js";

export interface BadgeServerOptions {
  store: AttestationStore;
  keystore: KeyStore;
  log: LogReader;
  statuses?: StatusRegistry;
  clock?: () => Date;
  /** Public base URL of the verification API, used for "view full" links. */
  apiBaseUrl: string;
}

const CORS = { "access-control-allow-origin": "*" };

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function langOf(req: IncomingMessage, url: URL): Lang {
  return pickLang(url.searchParams.get("lang"), req.headers["accept-language"] ?? null);
}

export function createBadgeServer(opts: BadgeServerOptions): Server {
  const deps: VerifyDeps = {
    keystore: opts.keystore,
    log: opts.log,
    statuses: opts.statuses,
    clock: opts.clock,
  };
  const script = badgeScript();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        send(res, 200, "application/json", JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && path === "/badge.js") {
        send(res, 200, "application/javascript; charset=utf-8", script, {
          ...CORS,
          "cache-control": "public, max-age=300",
        });
        return;
      }

      const mData = /^\/badge\/data\/([^/]+)$/.exec(path);
      if (req.method === "GET" && mData) {
        const id = decodeURIComponent(mData[1]);
        const lang = langOf(req, url);
        const att = await opts.store.get(id);
        if (!att) {
          send(res, 404, "application/json", JSON.stringify({ code: "not_found" }), CORS);
          return;
        }
        const result = await verifyAttestation(id, opts.store, deps);
        if (!result) {
          send(res, 404, "application/json", JSON.stringify({ code: "not_found" }), CORS);
          return;
        }
        send(
          res,
          200,
          "application/json",
          JSON.stringify(badgeData({ attestation: att, result, lang, apiBaseUrl: opts.apiBaseUrl })),
          CORS,
        );
        return;
      }

      const mPage = /^\/badge\/([^/]+)$/.exec(path);
      if (req.method === "GET" && mPage) {
        const id = decodeURIComponent(mPage[1]);
        const lang = langOf(req, url);
        const att = await opts.store.get(id);
        if (!att) {
          send(res, 404, "text/html; charset=utf-8", notFoundPage(lang));
          return;
        }
        const result = await verifyAttestation(id, opts.store, deps);
        if (!result) {
          send(res, 404, "text/html; charset=utf-8", notFoundPage(lang));
          return;
        }
        send(
          res,
          200,
          "text/html; charset=utf-8",
          badgePage({ attestation: att, result, lang, apiBaseUrl: opts.apiBaseUrl }),
        );
        return;
      }

      send(res, 404, "application/json", JSON.stringify({ code: "not_found", message: "unknown route" }));
    } catch (err) {
      send(
        res,
        500,
        "application/json",
        JSON.stringify({ code: "internal", message: err instanceof Error ? err.message : "internal error" }),
      );
    }
  });
}
