/**
 * P0 hardening tests (audit H-10, H-06, M-02): server-generated IDs, safe
 * integer caps, corrected hours pattern, bounded strings, semantic
 * timestamps. Run compiled: node --test dist/test/hardening.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation as issueAttestationCore, type IssuerOptions } from "../src/issuer.js";
import { InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "../src/guards.js";
import { IssueError } from "../src/types.js";

const FIXED_NOW = new Date("2026-09-19T12:00:05Z");

async function makeHarness() {
  const keystore = new SoftwareKeyStore();
  const factlockRec = await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  const opts: IssuerOptions = { keystore, log, clock: () => new Date(FIXED_NOW), authorizations, evidence };
  return { opts, bizKeyId: bizRec.key_id, authorizations, evidence };
}

function baseRequest(h: Awaited<ReturnType<typeof makeHarness>>, overrides: Record<string, unknown> = {}) {
  return {
    subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
    claims: [
      { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
    ],
    verification_method: "field_visit",
    verifier_id: "ver_007",
    evidence_refs: ["photo:1"],
    authorization_id: "auth_hardening_1",
    business_key_id: h.bizKeyId,
    ...overrides,
  };
}

async function issue(raw: unknown, h: Awaited<ReturnType<typeof makeHarness>>) {
  const req = raw as Record<string, unknown>;
  const claims = (req.claims ?? []) as Array<Record<string, unknown>>;
  const businessId = String((req.subject as Record<string, unknown>).business_id);
  let claimDigest: string;
  try {
    claimDigest = digestClaims(claims);
  } catch {
    // Unsafe integers are rejected by canonicalize here; issue() must still
    // be reached so its schema validation produces the expected IssueError.
    claimDigest = "digest:rejected-by-canonicalize";
  }
  h.authorizations.put({
    authorization_id: String(req.authorization_id),
    business_id: businessId,
    principal: "owner_rapido",
    claim_digest: claimDigest,
    method: "authenticated_session",
    authorized_at: "2026-09-19T11:59:58Z",
    authorized_by: "owner-on-file",
    expires_at: "2026-09-19T12:10:00Z",
  });
  for (const ref of (req.evidence_refs ?? []) as string[]) {
    h.evidence.put({
      evidence_ref: ref,
      business_id: businessId,
      claim_types: claims.map((c) => String(c.type)),
      verified_at: "2026-09-19T11:58:00Z",
      expires_at: "2026-09-20T12:00:00Z",
      verification_method: String(req.verification_method ?? ""),
      verifier_id: String(req.verifier_id ?? ""),
    });
  }
  return issueAttestationCore(raw, h.opts, { principal: "owner_rapido" });
}

function hoursClaim(open: string, close: string) {
  return {
    type: "hours",
    timezone: "America/New_York",
    schedule: [{ day: "mon", open, close }],
  };
}

test("client-supplied attestation_id is ignored; server always generates fla_<ulid>", async () => {
  const h = await makeHarness();
  const a = await issue(baseRequest(h, { attestation_id: "fla_FORGED123" }), h);
  assert.match(a.attestation_id, /^fla_[A-Z0-9]{26}$/);
  assert.notEqual(a.attestation_id, "fla_FORGED123");
});

test("two issuances never collide on attestation_id", async () => {
  const h = await makeHarness();
  const a1 = await issue(baseRequest(h, { authorization_id: "auth_h1" }), h);
  const a2 = await issue(baseRequest(h, { authorization_id: "auth_h2" }), h);
  assert.notEqual(a1.attestation_id, a2.attestation_id);
});

test("hours 29:59 rejected; 23:59 accepted (pattern fix)", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(baseRequest(h, { claims: [hoursClaim("09:00", "29:59")], authorization_id: "auth_h3" }), h),
    (e: unknown) => e instanceof IssueError && e.code === "schema_validation",
  );
  const h2 = await makeHarness();
  const ok = await issue(baseRequest(h2, { claims: [hoursClaim("09:00", "23:59")], authorization_id: "auth_h4" }), h2);
  assert.ok(ok.attestation_id.startsWith("fla_"));
});

test("unsafe-integer price amount rejected (H-06)", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(
      baseRequest(h, {
        claims: [{ type: "price", item: "x", amount: 9007199254740993, currency: "USD", disclosed: true }],
        authorization_id: "auth_h5",
      }),
      h,
    ),
    (e: unknown) => e instanceof IssueError && e.code === "schema_validation",
  );
});

test("overlong strings rejected (M-02 bounds)", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(
      baseRequest(h, {
        subject: { business_id: "biz_rapido", legal_name: "x".repeat(201) },
        authorization_id: "auth_h6",
      }),
      h,
    ),
    (e: unknown) => e instanceof IssueError && e.code === "schema_validation",
  );
});

test("non-date checked_at rejected (semantic timestamp, M-02)", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(
      baseRequest(h, {
        claims: [
          {
            type: "license",
            authority: "FL DBPR",
            license_number: "CFC1",
            status: "active",
            checked_at: "2026-13-40T99:99:99Z",
          },
        ],
        authorization_id: "auth_h7",
      }),
      h,
    ),
    (e: unknown) =>
      e instanceof IssueError &&
      ((e as IssueError).code === "invalid_timestamp" || (e as IssueError).code === "schema_validation"),
  );
});

test("validateTimestamps flags unparsable dates the format check could miss", async () => {
  const { validateTimestamps } = await import("../src/validate.js");
  const errs = validateTimestamps({
    device_time: "not-a-date",
    claims: [{ type: "license", checked_at: "2026-13-40" }, { type: "price" }],
  });
  assert.equal(errs.length, 2);
  assert.ok(errs.every((e) => e.message.includes("real calendar date")));

  const ok = validateTimestamps({
    device_time: "2026-09-19T12:00:00Z",
    claims: [{ type: "license", checked_at: "2026-09-19T12:00:00Z" }],
  });
  assert.equal(ok.length, 0);
});

test("claim objects reject unknown fields (strict per-type schemas)", async () => {
  const h = await makeHarness();
  const evil: Array<Record<string, unknown>> = [
    { type: "price", item: "x", amount: 100, currency: "USD", disclosed: true, evil: 1 },
    { type: "hours", timezone: "America/New_York", schedule: [{ day: "mon", open: "09:00", close: "18:00" }], evil: 1 },
    { type: "license", authority: "FL DBPR", license_number: "CFC1", status: "active", checked_at: "2026-09-19T11:00:00Z", evil: 1 },
    { type: "availability", service: "catering", available: true, evil: 1 },
    { type: "identity", legal_name: "Rapido Plumbing LLC", evil: 1 },
  ];
  let n = 0;
  for (const claim of evil) {
    n += 1;
    await assert.rejects(
      issue(baseRequest(h, { claims: [claim], authorization_id: `auth_evil_${n}` }), h),
      (e: unknown) => e instanceof IssueError && e.code === "schema_validation",
      `claim type ${claim.type} must reject unknown fields`,
    );
  }
});

test("all five claim types issue successfully", async () => {
  const h = await makeHarness();
  const a = await issue(
    baseRequest(h, {
      claims: [
        { type: "identity", legal_name: "Rapido Plumbing LLC", phone: "+13055550100" },
        { type: "license", authority: "FL DBPR", license_number: "CFC1", status: "active", checked_at: "2026-09-19T11:00:00Z" },
        hoursClaim("09:00", "18:00"),
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
        { type: "availability", service: "catering", available: true },
      ],
      authorization_id: "auth_all5",
    }),
    h,
  );
  assert.ok(a.attestation_id.startsWith("fla_"));
  assert.equal(a.claims.length, 5);
});

test("unknown claim type rejected", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(baseRequest(h, { claims: [{ type: "mystery" }], authorization_id: "auth_unknown_type" }), h),
    (e: unknown) => e instanceof IssueError && e.code === "schema_validation",
  );
});

test("future checked_at rejected (timestamp ordering)", async () => {
  const h = await makeHarness();
  await assert.rejects(
    issue(
      baseRequest(h, {
        claims: [
          { type: "license", authority: "FL DBPR", license_number: "CFC1", status: "active", checked_at: "2026-09-20T12:00:00Z" },
        ],
        authorization_id: "auth_future_check",
      }),
      h,
    ),
    (e: unknown) => e instanceof IssueError && e.code === "invalid_timestamp",
  );
});

test("skewed device_time is preserved as metadata and never moves verified_at", async () => {
  const h = await makeHarness();
  // A client clock ahead of the server is accepted (explicit AC) — only the
  // server clock stamps verified_at.
  const a = await issue(
    baseRequest(h, { device_time: "2026-09-20T12:00:00Z", authorization_id: "auth_skewed_device" }),
    h,
  );
  assert.equal(a.verified_at, "2026-09-19T12:00:05Z");
  assert.equal(a.device_time, "2026-09-20T12:00:00Z");
});

test("authorization dated after issuance rejected (timestamp ordering)", async () => {
  const h = await makeHarness();
  const req = baseRequest(h, { authorization_id: "auth_time_travel" });
  h.authorizations.put({
    authorization_id: "auth_time_travel",
    business_id: "biz_rapido",
    principal: "owner_rapido",
    claim_digest: digestClaims(req.claims as Array<Record<string, unknown>>),
    method: "authenticated_session",
    authorized_at: "2026-09-19T12:01:00Z", // after FIXED_NOW 12:00:05Z
    authorized_by: "owner-on-file",
    expires_at: "2026-09-19T12:10:00Z",
  });
  h.evidence.put({
    evidence_ref: "photo:1",
    business_id: "biz_rapido",
    claim_types: ["price"],
    verified_at: "2026-09-19T11:58:00Z",
    expires_at: "2026-09-20T12:00:00Z",
    verification_method: "field_visit",
    verifier_id: "ver_007",
  });
  await assert.rejects(
    issueAttestationCore(req, h.opts, { principal: "owner_rapido" }),
    (e: unknown) => e instanceof IssueError && e.code === "authorization_invalid",
  );
});

test("array bounds enforced (claims, evidence_refs, schedule)", async () => {
  const { validateIssueRequest } = await import("../src/validate.js");
  const h = await makeHarness();
  const price = { type: "price", item: "x", amount: 100, currency: "USD", disclosed: true };

  const tooManyClaims = baseRequest(h, { claims: Array.from({ length: 65 }, () => ({ ...price })) });
  assert.ok(validateIssueRequest(tooManyClaims).length > 0, "65 claims must exceed maxItems");

  const tooManyRefs = baseRequest(h, { evidence_refs: Array.from({ length: 33 }, (_, i) => `photo:${i}`) });
  assert.ok(validateIssueRequest(tooManyRefs).length > 0, "33 evidence_refs must exceed maxItems");

  const tooManyDays = baseRequest(h, {
    claims: [{
      type: "hours",
      timezone: "America/New_York",
      schedule: Array.from({ length: 8 }, (_, i) => ({ day: "mon", open: "09:00", close: "18:00", _i: i })).map(({ _i, ...r }) => r),
    }],
  });
  assert.ok(validateIssueRequest(tooManyDays).length > 0, "8 schedule entries must exceed maxItems");

  // Boundary values still pass.
  const boundary = baseRequest(h, { claims: Array.from({ length: 64 }, () => ({ ...price })) });
  assert.equal(validateIssueRequest(boundary).length, 0, "64 claims must be accepted");
});
