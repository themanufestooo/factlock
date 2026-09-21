/**
 * T7 tests: hosted badge page + embeddable script (EN/ES).
 * Run compiled: node --test dist/test/*.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { Server } from "node:http";

import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "@factlock/issuer";
import {
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
} from "@factlock/verify-api";

import { badgeScript, createBadgeServer } from "../src/index.js";

const T0 = new Date("2026-09-19T12:00:00Z");
const API_BASE = "https://api.factlock.example";

let server: Server;
let base: string;
let attActive: string;
let attDisputed: string;
let attRevoked: string;
let attXss: string;
let statuses: InMemoryStatusRegistry;

async function issue(
  ctx: { keystore: SoftwareKeyStore; log: MerkleLog; store: InMemoryAttestationStore; bizKeyId: string; authorizations: InMemoryAuthorizationStore; evidence: InMemoryEvidenceStore },
  legalName: string,
): Promise<string> {
  const request = {
      subject: { business_id: "biz_rapido", legal_name: legalName },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        { type: "price", item: "vip_deal", amount: 500, currency: "USD", disclosed: false },
        { type: "license", license_number: "CAT2330154", authority: "FL DBPR", status: "active", checked_at: "2026-09-19T11:00:00Z" },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      evidence_refs: [`evidence_${Math.random().toString(36).slice(2)}`],
      authorization_id: `auth_${Math.random().toString(36).slice(2)}`,
      business_key_id: ctx.bizKeyId,
  };
  ctx.authorizations.put({ authorization_id: request.authorization_id, business_id: "biz_rapido", principal: "owner_rapido", claim_digest: digestClaims(request.claims), method: "authenticated_session", authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file", expires_at: "2026-09-19T12:10:00Z" });
  ctx.evidence.put({ evidence_ref: request.evidence_refs[0], business_id: "biz_rapido", claim_types: ["price", "license"], verified_at: "2026-09-19T11:58:00Z", expires_at: "2026-09-20T12:00:00Z", verification_method: "field_visit", verifier_id: "ver_007" });
  const att = await issueAttestation(request, { keystore: ctx.keystore, log: ctx.log, clock: () => new Date(T0), authorizations: ctx.authorizations, evidence: ctx.evidence }, { principal: "owner_rapido" });
  await ctx.store.put(att);
  return att.attestation_id;
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

before(async () => {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const store = new InMemoryAttestationStore();
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  statuses = new InMemoryStatusRegistry();
  const ctx = { keystore, log, store, bizKeyId: bizRec.key_id, authorizations, evidence };

  attActive = await issue(ctx, "Rapido Plumbing LLC");
  attDisputed = await issue(ctx, "Rapido Plumbing LLC");
  attRevoked = await issue(ctx, "Rapido Plumbing LLC");
  attXss = await issue(ctx, 'Evil <script>alert("xss")</script> LLC');

  await statuses.set(attDisputed, {
    status: "DISPUTED",
    reason: "customer dispute #42",
    at: "2026-09-20T10:00:00Z",
  });
  await statuses.set(attRevoked, {
    status: "REVOKED",
    reason: "3 strikes — permanent revocation",
    at: "2026-09-20T10:00:00Z",
  });

  server = createBadgeServer({
    store,
    keystore,
    log,
    statuses,
    clock: () => new Date(T0),
    apiBaseUrl: API_BASE,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

test("ACTIVE badge page: business, disclosed price, no undisclosed amounts", async () => {
  const { status, text } = await get(`/badge/${attActive}`);
  assert.equal(status, 200);
  assert.match(text, /Rapido Plumbing LLC/);
  assert.match(text, /Verified by FactLock/);
  assert.match(text, /\$89\.00/); // disclosed amount shown
  assert.ok(!text.includes("$5.00"), "undisclosed amount must not appear");
  assert.match(text, /details withheld/);
  assert.match(text, /View full verification/);
  assert.match(text, new RegExp(API_BASE.replace(/\./g, "\\.") + "/v1/verify/"));
});

test("DISPUTED badge shows the UNDER REVIEW banner", async () => {
  const { status, text } = await get(`/badge/${attDisputed}`);
  assert.equal(status, 200);
  assert.match(text, /UNDER REVIEW/);
  assert.match(text, /treated as untrusted|treat these claims as untrusted/i);
});

test("REVOKED badge shows the revoked banner", async () => {
  const { status, text } = await get(`/badge/${attRevoked}`);
  assert.equal(status, 200);
  assert.match(text, /REVOKED/);
  assert.match(text, /permanently revoked/);
});

test("business names are HTML-escaped (XSS probe)", async () => {
  const { status, text } = await get(`/badge/${attXss}`);
  assert.equal(status, 200);
  assert.ok(!text.includes('<script>alert("xss")</script>'), "raw script must not appear");
  assert.match(text, /&lt;script&gt;/);
});

test("?lang=es renders Spanish copy", async () => {
  const { status, text } = await get(`/badge/${attActive}?lang=es`);
  assert.equal(status, 200);
  assert.match(text, /Verificado por FactLock/);
  assert.match(text, /precios verificados/);
  assert.match(text, /Ver verificación completa/);
});

test("Accept-Language: es falls back to Spanish", async () => {
  const { status, text } = await get(`/badge/${attActive}`, { "accept-language": "es-ES,es;q=0.9" });
  assert.equal(status, 200);
  assert.match(text, /Verificado por FactLock/);
});

test("unknown id → localized 404 page", async () => {
  const { status, text } = await get("/badge/fla_nope?lang=es");
  assert.equal(status, 404);
  assert.match(text, /Certificación no encontrada/);
});

test("/badge.js: javascript, < 15KB, embed hooks present", async () => {
  const { status, headers, text } = await get("/badge.js");
  assert.equal(status, 200);
  assert.match(headers.get("content-type") ?? "", /javascript/);
  assert.match(headers.get("access-control-allow-origin") ?? "", /\*/);
  assert.ok(Buffer.byteLength(text, "utf-8") < 15 * 1024, `badge.js too big: ${text.length}`);
  assert.match(text, /data-factlock-badge/);
  assert.match(text, /\/badge\/data\//);
  assert.ok(!text.includes("document.cookie"), "embed script must not touch cookies");
});

test("/badge/data/:id: CORS-open JSON with precomputed display fields", async () => {
  const { status, headers, text } = await get(`/badge/data/${attActive}?lang=es`);
  assert.equal(status, 200);
  assert.match(headers.get("access-control-allow-origin") ?? "", /\*/);
  const d = JSON.parse(text) as Record<string, unknown>;
  assert.equal(d.attestation_id, attActive);
  assert.equal(d.status, "ACTIVE");
  assert.equal(d.verified_by, "Verificado por FactLock");
  assert.ok(String(d.verify_url).startsWith(API_BASE + "/v1/verify/"));
  const prices = d.prices as { disclosed: unknown[]; attested_count: number; withheld_count: number };
  assert.equal(prices.attested_count, 2);
  assert.equal(prices.withheld_count, 1);
  assert.equal(prices.disclosed.length, 1);
  assert.ok(
    !text.includes("$5.00") && !text.includes('"amount":500'),
    "undisclosed amount must not leak into the payload",
  );
});

test("badge.js renders into a container (DOM-stub smoke test)", async () => {
  const src = badgeScript();
  let rendered = "";
  const container = {
    tagName: "DIV",
    getAttribute: (n: string) =>
      ({ "data-attestation-id": attActive, "data-lang": "en", "data-api-base": base })[n] ?? null,
    set innerHTML(v: string) {
      rendered = v;
    },
    get innerHTML() {
      return rendered;
    },
  };
  const payload = {
    attestation_id: attActive,
    business_name: "Rapido Plumbing LLC",
    status: "ACTIVE",
    freshness: "FRESH",
    freshness_word: "Fresh",
    verify_url: `${API_BASE}/v1/verify/${attActive}`,
    verified_by: "Verified by FactLock",
    dot: "#16a34a",
  };
  const context = {
    document: {
      readyState: "complete",
      querySelectorAll: () => [container],
      createElement: () => ({ setAttribute() { /* noop */ } }),
    },
    fetch: async () => ({ ok: true, json: async () => payload }),
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  for (let i = 0; i < 10 && !rendered; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.match(rendered, /Verified by FactLock/);
  assert.match(rendered, /Fresh/);
  assert.ok(rendered.includes(API_BASE), "badge links to the verification API");
});
