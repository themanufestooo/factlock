# FactLock — Build Tickets (from Protocol v1 + Red-Team)

**For:** contract dev(s) · **Stack suggestion:** TypeScript (API) + Python (reference lib), Postgres, S3-compatible storage, KMS/HSM via cloud provider.
**Conventions:** every ticket lists scope, acceptance criteria (AC), out of scope, and estimate in dev-days. "Done" = AC met + tests + README section.

---

## MILESTONE A — Core protocol library (Weeks 1–2)

### T1 — Canonical JSON + Ed25519 sign/verify (TS + Python)
**Scope:** JCS (RFC 8785) canonicalization; Ed25519 sign and verify; cross-language test vectors.
**AC:**
- `sign(canonical_json, private_key) → sig`; `verify(canonical_json, sig, public_key) → bool` in both languages.
- 20+ shared test vectors pass in both implementations (including unicode, nested objects, float edge cases).
- Tampered payload fails verification; wrong key fails verification.
**Out of scope:** key storage, networking.
**Estimate:** 3 days.

### T2 — Key management service
**Scope:** keypair generation (business + FactLock keys), `key_id` registry, `/.well-known/factlock-keys.json` publication, rotation protocol (new key_id, grace period, old key sunset).
**AC:**
- Keys generated in KMS/HSM; private key material never leaves it.
- Rotation completes without breaking verification of attestations signed by the old key.
- Well-known endpoint returns current + recently-retired keys with `valid_from`/`valid_until`.
**Out of scope:** business self-custody (v2).
**Estimate:** 4 days.

### T3 — Attestation issuance service
**Scope:** `POST /v1/businesses/{id}/attest` (authenticated): validate against JSON schema v1, attach server-stamped `verified_at`, collect business authorization record (login + SMS ref), apply FactLock countersignature, append to transparency log, return attestation.
**AC:**
- Invalid schema rejected with field-level errors.
- `verified_at` = server time, not client time (test: skewed client clock still yields server time).
- No countersignature without a linked authorization record (test: missing auth → 422).
- Issuance throughput ≥ 50/min on modest hardware.
**Out of scope:** verifier app, disputes.
**Estimate:** 5 days.

---

## MILESTONE B — Transparency log + anchoring (Weeks 2–3)

### T4 — Merkle transparency log
**Scope:** append-only log; `GET /v1/log/proof?leaf={index}` inclusion proofs; `GET /v1/log/root` current root; public leaf browsing.
**AC:**
- Inclusion proof verifies against published root using the reference libs (T1).
- Proof generation p99 < 50ms at 1M leaves (benchmark test included).
- Third-party audit script (provided) can replay the full log and recompute the root.
**Out of scope:** anchoring (T5).
**Estimate:** 5 days.

### T5 — Daily on-chain anchoring job
**Scope:** scheduled job: take current Merkle root → publish single on-chain tx → store `{chain, tx_hash, block_height, root}`; `GET /v1/log/anchors` lists them.
**AC:**
- Anchor verifiable on a public block explorer (link in response).
- Missed run alerts (job must be idempotent; backfills on recovery).
- Monthly anchoring cost reported in job logs (target: single-digit dollars).
**Out of scope:** per-attestation chains (rejected by design).
**Estimate:** 3 days.

---

## MILESTONE C — Verification surfaces (Weeks 4–6)

### T6 — Public verification API (free tier)
**Scope:** `GET /v1/businesses/{id}/attestation`, `GET /v1/attestations/{id}`, `GET /v1/revocations`, freshness verdict (FRESH/AGING/STALE per the 70%/100% rule), CDN-friendly cache headers.
**AC:**
- p99 < 200ms globally (CDN in front).
- Freshness verdicts match the spec table exactly (parameterized tests per claim type).
- No API key required; rate limits generous and documented.
**Out of scope:** metered billing (T14).
**Estimate:** 4 days.

### T7 — Hosted badge page + embeddable badge
**Scope:** per-business verification page (claims, freshness, signature status, dispute history, DISPUTED flag state); `<script>` embed for business websites showing live badge.
**AC:**
- Page renders in <1s; shows UNDER REVIEW banner when any claim is DISPUTED.
- Embed works on plain HTML sites with one snippet; degrades gracefully offline.
- Spanish version (i18n from day one).
**Out of scope:** business dashboard (T10 covers ops side).
**Estimate:** 5 days.

### T8 — MCP server (`factlock_check`)
**Scope:** MCP server exposing `factlock_check(business_id, claim_types[])` → claims + freshness verdict + proof bundle.
**AC:**
- Works end-to-end in Claude and ChatGPT agent environments (recorded demo).
- Returns machine-readable verdicts; never throws on STALE (returns verdict + age).
- Published with install instructions a non-engineer can follow.
**Out of scope:** other agent frameworks (direct API covers them).
**Estimate:** 3 days.

---

## MILESTONE D — Ops tooling (Weeks 5–8)

### T9 — Verifier field app (mobile web)
**Scope:** checklist per verification playbook; in-app photo capture (no uploads, EXIF preserved); GPS capture with address cross-check (>500m mismatch → human review flag); evidence hashing; submission queue (offline-tolerant).
**AC:**
- Full verification completable in <15 minutes in field test.
- Spoofed GPS (mock location) detected and flagged.
- Evidence bundle hashed client-side; hashes match server recomputation.
**Out of scope:** native apps (mobile web is fine for v1).
**Estimate:** 8 days.

### T10 — Review dashboard (countersignature console)
**Scope:** queue of submitted verifications; evidence viewer; server-side license check integration (FL DBPR); approve → countersign / reject with reason; verifier accuracy stats.
**AC:**
- License check runs automatically; mismatch blocks countersignature.
- Every countersignature links its authorization record (Finding 1).
- Audit trail: who approved what, when, immutable.
**Out of scope:** disputes (T11).
**Estimate:** 6 days.

### T11 — Dispute system
**Scope:** `POST /v1/disputes` (refundable deposit, rate-limited); claim lifecycle `ACTIVE → DISPUTED → CORRECTED | SUSPENDED | CLEARED`; 48h SLA timer with auto-escalation; public dispute log; strike counting (2 = 30-day suspension, 3 = permanent); frivolous-filer forfeiture.
**AC:**
- Filing a dispute flips the public badge to UNDER REVIEW within 60 seconds.
- SLA breach auto-escalates and pages (test with clock injection).
- Strike enforcement is automatic, not manual — test the full 3-strike path.
**Out of scope:** legal correspondence tooling.
**Estimate:** 7 days.

### T12 — Re-verification scheduler
**Scope:** per-claim-type cadence engine; automated business nudges ("one-tap confirm"); expiry → STALE transitions; rotating field re-check assignments; mystery-shopper selection (5%/mo).
**AC:**
- Cadence matches spec table; nudges sent on schedule (test with time injection).
- Expired attestations flip to STALE without human action.
- Mystery-shopper picks are unpredictable (not round-robin guessable).
**Out of scope:** verifier payroll.
**Estimate:** 4 days.

---

## MILESTONE E — Billing (Weeks 8–10)

### T13 — Subscriptions (Stripe)
**Scope:** $49 founding / $79 standard plans; checkout; customer portal; webhooks → provisioning (badge active/inactive).
**AC:**
- Failed payment → 7-day grace → badge shows "verification lapsed" (not silent).
- Founding-price lock honored permanently (test: price change doesn't touch founders).
**Out of scope:** metered billing (T14).
**Estimate:** 3 days.

### T14 — Metered API billing for integrators
**Scope:** API key issuance; per-query metering; tiered pricing; usage dashboard; invoicing.
**AC:**
- Metering accurate to ±0.1% against log replay (reconciliation test).
- Integrator can see live usage and projected bill.
**Out of scope:** free-tier abuse tooling beyond rate limits.
**Estimate:** 4 days.

---

## Build order & resourcing

- **Critical path:** T1 → T2 → T3 → T4 → T6 → T7 (first badge page live ≈ week 4–5).
- **Parallelizable:** T5, T8, T9/T10/T11/T12, T13/T14.
- **Total:** ~64 dev-days ≈ 1 solid contractor over ~10–12 weeks, or 2 contractors in ~6 weeks. Budget $4k–$8k holds if scoped tightly; the risk is scope creep on T9/T11 — hold the line on AC.
- **Lucky's lane:** test vectors review, Spanish copy, demo scripts, acceptance testing against every AC above.
