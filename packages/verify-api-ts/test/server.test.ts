/**
 * T6 tests: HTTP server — routing, 404s, rate limiting.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "@factlock/issuer";

import {
  createVerifyServer,
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
} from "../src/index.js";

const T0 = new Date("2026-09-19T12:00:00Z");

let server: Server;
let base: string;
let attId: string;
let store: InMemoryAttestationStore;

async function get(path: string): Promise<{ status: number; headers: Headers; json: unknown }> {
  const res = await fetch(`${base}${path}`);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, json: body };
}

before(async () => {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const request = {
      subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        { type: "price", item: "vip_deal", amount: 500, currency: "USD", disclosed: false },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      evidence_refs: ["evidence_verify_server"],
      authorization_id: "auth_1",
      business_key_id: bizRec.key_id,
  };
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  authorizations.put({ authorization_id: "auth_1", business_id: "biz_rapido", principal: "owner_rapido", claim_digest: digestClaims(request.claims), method: "authenticated_session", authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file", expires_at: "2026-09-19T12:10:00Z" });
  evidence.put({ evidence_ref: "evidence_verify_server", business_id: "biz_rapido", claim_types: ["price"], verified_at: "2026-09-19T11:58:00Z", expires_at: "2026-09-20T12:00:00Z", verification_method: "field_visit", verifier_id: "ver_007" });
  const att = await issueAttestation(request, { keystore, log, clock: () => new Date(T0), authorizations, evidence }, { principal: "owner_rapido" });
  store = new InMemoryAttestationStore();
  await store.put(att);
  attId = att.attestation_id;

  server = createVerifyServer({
    store,
    keystore,
    log,
    statuses: new InMemoryStatusRegistry(),
    clock: () => new Date(T0),
    rateLimit: { capacity: 50, windowMs: 60_000 }, // generous; the limit test exhausts it
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

test("GET /v1/verify/:id returns the verification result", async () => {
  const { status, json } = await get(`/v1/verify/${attId}`);
  assert.equal(status, 200);
  const r = json as Record<string, unknown>;
  assert.equal(r.attestation_id, attId);
  assert.equal(r.valid, true);
  assert.equal(r.status, "ACTIVE");
  assert.equal(r.freshness, "FRESH");
});

test("GET /v1/attestations/:id serves the attestation with redacted amounts", async () => {
  const { status, json } = await get(`/v1/attestations/${attId}`);
  assert.equal(status, 200);
  const att = json as { claims: Array<Record<string, unknown>> };
  const vip = att.claims.find((c) => c.item === "vip_deal")!;
  assert.ok(!("amount" in vip), "undisclosed amount must not be served");
  assert.equal(vip.withheld, true);
});

test("unknown id → 404 on both routes", async () => {
  const v = await get("/v1/verify/fla_nope");
  assert.equal(v.status, 404);
  const a = await get("/v1/attestations/fla_nope");
  assert.equal(a.status, 404);
});

test("free-tier rate limit trips with 429 + Retry-After", async () => {
  // Exhaust the bucket (capacity 50); earlier tests consumed only a few.
  let last = { status: 0, headers: new Headers(), json: null as unknown };
  for (let i = 0; i < 60; i++) {
    last = await get(`/v1/verify/${attId}`);
    if (last.status === 429) break;
    assert.equal(last.status, 200);
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"), "Retry-After header required");
  assert.equal((last.json as Record<string, unknown>).code, "rate_limited");
});

test("GET /healthz is not rate-limited", async () => {
  const { status } = await get("/healthz");
  assert.equal(status, 200);
});
