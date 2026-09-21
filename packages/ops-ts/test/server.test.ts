/**
 * T9–T11 HTTP tests. Run compiled: node --test dist/test/server.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createOpsServer } from "../src/server.js";
import {
  BIZ,
  BIZ_LAT,
  BIZ_LNG,
  makeStack,
  opsTokens,
  OPS_VERIFIER_TOKEN,
  OPS_REVIEWER_TOKEN,
  OPS_ADMIN_TOKEN,
} from "./helpers.js";

async function serve() {
  const s = await makeStack();
  const server = createOpsServer({
    directory: s.directory,
    visits: s.visits,
    flags: s.flags,
    audit: s.audit,
    disputes: s.disputes,
    attestations: s.attestations,
    statuses: s.statuses,
    keystore: s.keystore,
    log: s.log,
    cdn: s.cdn,
    issueCorrection: s.issue,
    tokens: opsTokens(),
    clock: s.clock,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { s, server, base };
}

async function teardown(server: { close(cb: () => void): void }) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const authHeaders = (token: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

const post = (base: string, token: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

const get = (base: string, token: string, path: string) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

test("visits: 201 happy, 422 on out-of-range GPS", async () => {
  const { s, server, base } = await serve();
  try {
    const ok = await post(base, OPS_VERIFIER_TOKEN, "/v1/visits", {
      business_id: BIZ,
      verifier_id: "ver_007",
      gps: { lat: BIZ_LAT + 0.001, lng: BIZ_LNG },
      evidence_refs: ["photo:1"],
      checklist: [{ claim_type: "price", result: "pass" }],
    });
    assert.equal(ok.status, 201);
    assert.ok((ok.body.visit_id as string).startsWith("vst_"));

    const bad = await post(base, OPS_VERIFIER_TOKEN, "/v1/visits", {
      business_id: BIZ,
      verifier_id: "ver_007",
      gps: { lat: BIZ_LAT + 0.006, lng: BIZ_LNG },
      checklist: [{ claim_type: "hours", result: "pass" }],
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, "gps_out_of_range");

    const acc = (await get(base, OPS_VERIFIER_TOKEN, "/v1/verifiers/ver_007/accuracy").then((r) => r.json())) as Record<string, unknown>;
    assert.equal(acc.verifier_id, "ver_007");
    assert.equal(acc.visits_total, 1);
    assert.equal(s.directory !== undefined, true);
  } finally {
    await teardown(server);
  }
});

test("flags: open → list → resolve(dispute) opens a dispute", async () => {
  const { s, server, base } = await serve();
  try {
    const att = await s.issue();
    await s.attestations.put(att);
    const opened = await post(base, OPS_VERIFIER_TOKEN, "/v1/flags", {
      attestation_id: att.attestation_id,
      source: "mystery-shopper",
      reason: "closed at posted hours",
    });
    assert.equal(opened.status, 201);
    const flagId = opened.body.flag_id as string;

    const listed = (await get(base, OPS_VERIFIER_TOKEN, "/v1/flags?status=open").then((r) => r.json())) as {
      flags: Array<{ flag_id: string }>;
    };
    assert.equal(listed.flags.length, 1);

    const resolved = await post(base, OPS_REVIEWER_TOKEN, `/v1/flags/${flagId}/resolve`, {
      decision: "dispute",
      reviewer_id: "rev_9", // forged: must be overridden by the token's actor
    });
    assert.equal(resolved.status, 200);
    assert.ok(resolved.body.dispute_id, "dispute should be opened");

    const open = (await get(base, OPS_REVIEWER_TOKEN, "/v1/disputes").then((r) => r.json())) as {
      disputes: Array<{ dispute_id: string }>;
    };
    assert.equal(open.disputes.length, 1);
  } finally {
    await teardown(server);
  }
});

test("disputes: open → resolve(cleared); healthz; 404", async () => {
  const { s, server, base } = await serve();
  try {
    const att = await s.issue();
    await s.attestations.put(att);
    const opened = await post(base, OPS_REVIEWER_TOKEN, "/v1/disputes", {
      attestation_id: att.attestation_id,
      opened_by: "rev_1",
      reason: "test",
    });
    assert.equal(opened.status, 201);
    const resolved = await post(base, OPS_ADMIN_TOKEN, `/v1/disputes/${opened.body.dispute_id}/resolve`, {
      outcome: "cleared",
      reviewer_id: "rev_1",
    });
    assert.equal(resolved.status, 200);
    assert.equal((resolved.body as { attestation_status: string }).attestation_status, "CLEARED");

    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    const nf = await get(base, OPS_ADMIN_TOKEN, "/v1/nope");
    assert.equal(nf.status, 404);
  } finally {
    await teardown(server);
  }
});
