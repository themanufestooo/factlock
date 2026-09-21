/**
 * Ops auth tests (audit H-04): bearer tokens, roles, forged-actor override,
 * business scoping, and the tamper-evident audit chain.
 * Run compiled: node --test dist/test/auth.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createOpsServer } from "../src/server.js";
import { HashChainedAuditLog } from "../src/audit.js";
import {
  BIZ,
  BIZ_LAT,
  BIZ_LNG,
  makeStack,
  opsTokens,
  OPS_VERIFIER_TOKEN,
  OPS_REVIEWER_TOKEN,
  OPS_ADMIN_TOKEN,
  OPS_SCOPED_TOKEN,
  OPS_SCOPED_REVIEWER_TOKEN,
} from "./helpers.js";

async function serve() {
  const s = await makeStack();
  const audit = new HashChainedAuditLog(s.clock);
  const server = createOpsServer({
    directory: s.directory,
    visits: s.visits,
    flags: s.flags,
    audit,
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
  return { s, audit, server, base: `http://127.0.0.1:${port}` };
}

async function teardown(server: { close(cb: () => void): void }) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const visitBody = {
  business_id: BIZ,
  gps: { lat: BIZ_LAT + 0.001, lng: BIZ_LNG },
  checklist: [{ claim_type: "price", result: "pass" }],
  evidence_refs: ["photo:1"],
};

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch { /* non-JSON */ }
  return { status: r.status, body: parsed as Record<string, unknown> };
}

test("unauthenticated requests → 401; healthz stays public", async () => {
  const { server, base } = await serve();
  try {
    for (const [method, path, body] of [
      ["POST", "/v1/visits", visitBody],
      ["GET", "/v1/verifiers/x/accuracy", undefined],
      ["POST", "/v1/flags", { attestation_id: "x" }],
      ["GET", "/v1/flags", undefined],
      ["POST", "/v1/disputes", { attestation_id: "x" }],
    ] as const) {
      const r = await req(base, method, path, undefined, body);
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.body.code, "unauthorized");
    }
    // Bad and malformed tokens also 401.
    assert.equal((await req(base, "POST", "/v1/visits", "bogus-token", visitBody)).status, 401);
    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
  } finally {
    await teardown(server);
  }
});

test("wrong role → 403", async () => {
  const { server, base } = await serve();
  try {
    // A reviewer token cannot record visits (verifier role required).
    const v = await req(base, "POST", "/v1/visits", OPS_REVIEWER_TOKEN, visitBody);
    assert.equal(v.status, 403);
    assert.equal(v.body.code, "forbidden");

    // A verifier token cannot open disputes or resolve flags (reviewer role).
    const d = await req(base, "POST", "/v1/disputes", OPS_VERIFIER_TOKEN, { attestation_id: "x", reason: "y" });
    assert.equal(d.status, 403);
    const f = await req(base, "POST", "/v1/flags/flg_x/resolve", OPS_VERIFIER_TOKEN, { decision: "confirm" });
    assert.equal(f.status, 403);

    // Dispute resolution is admin-only.
    const r = await req(base, "POST", "/v1/disputes/dsp_x/resolve", OPS_REVIEWER_TOKEN, { outcome: "cleared" });
    assert.equal(r.status, 403);
  } finally {
    await teardown(server);
  }
});

test("forged actor fields are overridden by the token", async () => {
  const { s, server, base } = await serve();
  try {
    // Visit: forged verifier_id is ignored — the token's actor is stamped.
    const ok = await req(base, "POST", "/v1/visits", OPS_VERIFIER_TOKEN, {
      ...visitBody,
      verifier_id: "attacker_1",
    });
    assert.equal(ok.status, 201);
    const visits = await s.visits.listByVerifier("ver_007");
    assert.equal(visits.length, 1);
    assert.equal(visits[0].verifier_id, "ver_007");
    assert.equal((await s.visits.listByVerifier("attacker_1")).length, 0);

    // Dispute: forged opened_by is ignored.
    const att = await s.issue();
    await s.attestations.put(att);
    const opened = await req(base, "POST", "/v1/disputes", OPS_REVIEWER_TOKEN, {
      attestation_id: att.attestation_id,
      opened_by: "attacker_1",
      reason: "test",
    });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.opened_by, "rev_001");

    // Flag resolve: forged reviewer_id is ignored.
    const flag = await req(base, "POST", "/v1/flags", OPS_VERIFIER_TOKEN, {
      attestation_id: att.attestation_id,
      source: "public-report",
      reason: "test",
    });
    const resolved = await req(base, "POST", `/v1/flags/${flag.body.flag_id}/resolve`, OPS_REVIEWER_TOKEN, {
      decision: "confirm",
      reviewer_id: "attacker_1",
    });
    assert.equal(resolved.status, 200);
    const resolvedFlag = (resolved.body as { flag: { resolution: { reviewer_id: string } } }).flag;
    assert.equal(resolvedFlag.resolution.reviewer_id, "rev_001");
  } finally {
    await teardown(server);
  }
});

test("business-scoped tokens cannot touch other businesses → 403", async () => {
  const { server, base } = await serve();
  try {
    const r = await req(base, "POST", "/v1/visits", OPS_SCOPED_TOKEN, {
      ...visitBody,
      business_id: "biz_other",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "forbidden");

    // The scoped token works fine within its own business.
    const ok = await req(base, "POST", "/v1/visits", OPS_SCOPED_TOKEN, visitBody);
    assert.equal(ok.status, 201);

    // Dispute listing filtered by another business is rejected.
    const l = await req(base, "GET", "/v1/disputes?business_id=biz_other", OPS_SCOPED_TOKEN);
    assert.equal(l.status, 403);
  } finally {
    await teardown(server);
  }
});

test("high-risk actions write tamper-evident audit entries", async () => {
  const { s, audit, server, base } = await serve();
  try {
    const att = await s.issue();
    await s.attestations.put(att);

    const opened = await req(base, "POST", "/v1/disputes", OPS_REVIEWER_TOKEN, {
      attestation_id: att.attestation_id,
      reason: "audit test",
    });
    assert.equal(opened.status, 201);

    const resolved = await req(base, "POST", `/v1/disputes/${opened.body.dispute_id}/resolve`, OPS_ADMIN_TOKEN, {
      outcome: "cleared",
    });
    assert.equal(resolved.status, 200);

    const entries = await audit.list();
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes("dispute.opened"), `expected dispute.opened, got ${actions}`);
    assert.ok(actions.includes("dispute.resolved"), `expected dispute.resolved, got ${actions}`);
    assert.ok(entries.every((e) => e.actor === "rev_001" || e.actor === "adm_001"));

    // The chain verifies — and detects tampering.
    assert.equal(audit.verifyChain(), true);
    const tampered = await audit.list();
    (tampered[0].subject as Record<string, unknown>).reason = "rewritten";
    // (mutating a returned copy must not corrupt the store)
    assert.equal(audit.verifyChain(), true);
  } finally {
    await teardown(server);
  }
});

test("dispute outcomes write distinct high-risk audit events", async () => {
  const { s, audit, server, base } = await serve();
  try {
    const openDispute = async () => {
      const att = await s.issue();
      await s.attestations.put(att);
      const opened = await req(base, "POST", "/v1/disputes", OPS_REVIEWER_TOKEN, {
        attestation_id: att.attestation_id,
        reason: "outcome test",
      });
      assert.equal(opened.status, 201);
      return opened.body.dispute_id as string;
    };
    const actions = async () => (await audit.list()).map((e) => e.action);

    // corrected → correction.issued with the new attestation id
    // (resolve this one first: every strike outcome accumulates per business,
    // and the third strike forces revocation regardless of outcome)
    const d3 = await openDispute();
    const corrected = await req(base, "POST", `/v1/disputes/${d3}/resolve`, OPS_ADMIN_TOKEN, {
      outcome: "corrected",
      corrected_request: {
        subject: { business_id: BIZ, legal_name: "Rapido Plumbing LLC" },
        claims: [
          { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        ],
        verification_method: "field_visit",
        verifier_id: "ver_007",
        evidence_refs: ["evidence_ops"],
        authorization_id: "auth_1",
        business_key_id: "",
      },
    });
    assert.equal(corrected.status, 200);
    assert.equal(typeof (corrected.body as Record<string, unknown>).corrected_attestation_id, "string");
    const issuedEntries = (await audit.list()).filter((e) => e.action === "correction.issued");
    assert.equal(issuedEntries.length, 1);
    assert.equal(
      (issuedEntries[0].subject as Record<string, unknown>).corrected_attestation_id,
      (corrected.body as Record<string, unknown>).corrected_attestation_id,
    );

    // suspended → attestation.suspended
    const d1 = await openDispute();
    assert.equal((await req(base, "POST", `/v1/disputes/${d1}/resolve`, OPS_ADMIN_TOKEN, { outcome: "suspended" })).status, 200);
    assert.ok((await actions()).includes("attestation.suspended"), "expected attestation.suspended");

    // revoked → attestation.revoked with the merkle leaf index
    const d2 = await openDispute();
    assert.equal((await req(base, "POST", `/v1/disputes/${d2}/resolve`, OPS_ADMIN_TOKEN, { outcome: "revoked" })).status, 200);
    const revokedEntries = (await audit.list()).filter((e) => e.action === "attestation.revoked");
    assert.equal(revokedEntries.length, 1);
    assert.equal(typeof (revokedEntries[0].subject as Record<string, unknown>).revocation_leaf_index, "number");
  } finally {
    await teardown(server);
  }
});

test("flag escalation to dispute writes dispute.opened", async () => {
  const { s, audit, server, base } = await serve();
  try {
    const att = await s.issue();
    await s.attestations.put(att);
    const flag = await req(base, "POST", "/v1/flags", OPS_VERIFIER_TOKEN, {
      attestation_id: att.attestation_id,
      source: "public-report",
      reason: "escalation test",
    });
    assert.equal(flag.status, 201);
    const resolved = await req(base, "POST", `/v1/flags/${flag.body.flag_id}/resolve`, OPS_REVIEWER_TOKEN, {
      decision: "dispute",
    });
    assert.equal(resolved.status, 200);
    assert.ok((resolved.body as Record<string, unknown>).dispute_id, "expected a dispute_id from escalation");

    const actions = (await audit.list()).map((e) => e.action);
    assert.ok(actions.includes("flag.dispute"), `expected flag.dispute, got ${actions}`);
    assert.ok(actions.includes("dispute.opened"), `expected dispute.opened, got ${actions}`);
  } finally {
    await teardown(server);
  }
});

test("business-scoped tokens are isolated from other businesses", async () => {
  const { s, server, base } = await serve();
  try {
    const other = "biz_other";
    const otherAtt = await s.issue({
      subject: { business_id: other, legal_name: "Other Co" },
    });
    await s.attestations.put(otherAtt);
    const ownAtt = await s.issue();
    await s.attestations.put(ownAtt);

    // A dispute on the other business, opened with an unscoped reviewer token.
    const opened = await req(base, "POST", "/v1/disputes", OPS_REVIEWER_TOKEN, {
      attestation_id: otherAtt.attestation_id,
      reason: "other business",
    });
    assert.equal(opened.status, 201);
    const otherDisputeId = opened.body.dispute_id as string;

    // The scoped verifier sees only its own business's disputes.
    const listed = await req(base, "GET", "/v1/disputes", OPS_SCOPED_TOKEN);
    assert.equal(listed.status, 200);
    const ids = ((listed.body as { disputes: Array<{ dispute_id: string }> }).disputes).map((d) => d.dispute_id);
    assert.ok(!ids.includes(otherDisputeId), "scoped listing must not leak other businesses");

    // Explicitly requesting another business is rejected.
    assert.equal((await req(base, "GET", "/v1/disputes?business_id=biz_other", OPS_SCOPED_TOKEN)).status, 403);

    // Flag listing is isolated too.
    const otherFlag = await req(base, "POST", "/v1/flags", OPS_VERIFIER_TOKEN, {
      attestation_id: otherAtt.attestation_id,
      source: "public-report",
      reason: "other business flag",
    });
    assert.equal(otherFlag.status, 201);
    const flagsListed = await req(base, "GET", "/v1/flags", OPS_SCOPED_TOKEN);
    assert.equal(flagsListed.status, 200);
    const flagIds = ((flagsListed.body as { flags: Array<{ flag_id: string }> }).flags).map((f) => f.flag_id);
    assert.ok(!flagIds.includes(otherFlag.body.flag_id as string), "scoped flag listing must not leak other businesses");

    // A scoped reviewer cannot resolve flags on another business's attestation.
    const denied = await req(base, "POST", `/v1/flags/${otherFlag.body.flag_id}/resolve`, OPS_SCOPED_REVIEWER_TOKEN, {
      decision: "confirm",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "forbidden");

    // Resolving a flag on the reviewer's own business still works.
    const ownFlag = await req(base, "POST", "/v1/flags", OPS_VERIFIER_TOKEN, {
      attestation_id: ownAtt.attestation_id,
      source: "public-report",
      reason: "own business flag",
    });
    assert.equal(ownFlag.status, 201);
    assert.equal(
      (await req(base, "POST", `/v1/flags/${ownFlag.body.flag_id}/resolve`, OPS_SCOPED_REVIEWER_TOKEN, { decision: "confirm" })).status,
      200,
    );
  } finally {
    await teardown(server);
  }
});

test("audit chain detects a forged entry", async () => {
  const log = new HashChainedAuditLog();
  await log.append({ actor: "a", action: "x", subject: {} });
  await log.append({ actor: "b", action: "y", subject: {} });
  assert.equal(log.verifyChain(), true);
  // Reach into the internals the way a compromised host could and rewrite.
  const internal = log as unknown as { entries: Array<{ subject: unknown; hash: string }> };
  internal.entries[0].subject = { forged: true };
  assert.equal(log.verifyChain(), false);
});
