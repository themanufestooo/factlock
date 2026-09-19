/**
 * T3 tests: HTTP server — auth, routing, status codes.
 * Run compiled: node --test dist/test/*.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { SoftwareKeyStore } from "@veritas/keystore";
import { MerkleLog } from "@veritas/merkle-log";
import { createIssuerServer } from "../src/server.js";

const FIXED_NOW = new Date("2026-09-19T12:00:05Z");
const TOKEN = "test-token-123";

let server: Server;
let base: string;
let bizKeyId: string;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
    claims: [
      { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
    ],
    verification_method: "field_visit",
    verifier_id: "ver_007",
    authorization: {
      auth_id: "auth_1",
      session_id: "sess_1",
      sms_confirmation_ref: "sms_1",
      authorized_at: "2026-09-19T11:59:58Z",
      authorized_by: "owner-on-file",
    },
    business_key_id: bizKeyId,
    ...overrides,
  };
}

async function post(path: string, payload: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("veritas", "veritas");
  bizKeyId = (await keystore.generateKey("biz_rapido", "business")).key_id;
  server = createIssuerServer({
    keystore,
    log: new MerkleLog(),
    clock: () => new Date(FIXED_NOW),
    authTokens: [TOKEN], // dev stub
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

test("POST /v1/businesses/{id}/attest -> 201 with attestation", async () => {
  const { status, json } = await post("/v1/businesses/biz_rapido/attest", body(), TOKEN);
  assert.equal(status, 201);
  assert.equal(json.status, "ACTIVE");
  assert.equal(json.verified_at, "2026-09-19T12:00:05Z");
  assert.ok((json as { attestation_id: string }).attestation_id.startsWith("vat_"));
  const log = json.log as { tree: string; leaf_index: number; root: string };
  assert.equal(log.tree, "veritas-main");
  assert.match(log.root, /^[0-9a-f]{64}$/);
});

test("no bearer token -> 401", async () => {
  const { status, json } = await post("/v1/businesses/biz_rapido/attest", body());
  assert.equal(status, 401);
  assert.equal(json.error, "unauthorized");
});

test("wrong bearer token -> 401", async () => {
  const { status } = await post("/v1/businesses/biz_rapido/attest", body(), "wrong");
  assert.equal(status, 401);
});

test("invalid JSON -> 400", async () => {
  const { status, json } = await post(
    "/v1/businesses/biz_rapido/attest",
    "{not json",
    TOKEN,
  );
  assert.equal(status, 400);
  assert.equal(json.error, "invalid_json");
});

test("missing authorization in body -> 422", async () => {
  const b = body();
  delete b.authorization;
  const { status, json } = await post("/v1/businesses/biz_rapido/attest", b, TOKEN);
  assert.equal(status, 422);
  assert.equal(json.error, "authorization_required");
});

test("schema violation -> 400 with field errors", async () => {
  const b = body({ claims: [{ type: "price", item: "x" }] });
  const { status, json } = await post("/v1/businesses/biz_rapido/attest", b, TOKEN);
  assert.equal(status, 400);
  assert.equal(json.error, "schema_validation");
  const fields = json.fields as Array<{ path: string; message: string }>;
  assert.ok(fields.some((f) => f.path === "/claims/0/amount"));
});

test("path business id vs subject mismatch -> 400", async () => {
  const { status, json } = await post("/v1/businesses/biz_other/attest", body(), TOKEN);
  assert.equal(status, 400);
  assert.equal(json.error, "business_mismatch");
});

test("GET /.well-known/veritas-keys.json -> key directory", async () => {
  const res = await fetch(`${base}/.well-known/veritas-keys.json`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as {
    generated_at: string;
    keys: Array<{ key_id: string; status: string; valid_until: string | null }>;
  };
  assert.ok(doc.generated_at);
  assert.ok(doc.keys.length >= 2);
  assert.ok(doc.keys.every((k) => k.key_id && k.status));
});

test("GET /healthz -> 200", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
});

test("unknown route -> 404", async () => {
  const res = await fetch(`${base}/v1/nope`);
  assert.equal(res.status, 404);
});

test("fail closed: no auth hook configured -> 401", async () => {
  const keystore = new SoftwareKeyStore();
  const locked = createIssuerServer({ keystore, log: new MerkleLog() });
  await new Promise<void>((resolve) => locked.listen(0, "127.0.0.1", resolve));
  const addr = locked.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/businesses/b/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      locked.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
