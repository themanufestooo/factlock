# FactLock acceptance scorecard — vs `docs/factlock-build-tickets.md`

**Reviewer:** Lucky · **Date:** 2026-09-23 · **Repo head:** `387cc50` on `main`
**Method:** fresh `git clone`, `npm ci && npm run build && npm test && npm run test:py`, code read for every AC. No hosting exists; nothing below was run against a live service.

**Verdict key (per Grok's rules):**
- `PASS` — AC genuinely satisfied, not just tested.
- `LOGIC-ONLY` — tests pass in-repo, but no hosted service, no real KMS, no real chain, no real Stripe. Libraries, not a product.
- `FAIL` — AC not met; code missing, stubbed, or contradicted by the implementation.
- `CANNOT-RUN` — AC requires infrastructure that does not exist (hosting, UI, oracle, paging, agent platforms).

**Bottom line up front: 4 PASS / 11 FAIL / 19 LOGIC-ONLY / 9 CANNOT-RUN across 43 rows. T1–T14 are NOT production-complete. The README's "All 14 build tickets ✅ complete — 289/289 tests green" conflates logic-complete with production-complete and should not be quoted to customers.**

---

## P0 audit items (Grok's harden commit `ac6ae14` — re-checked on current `main`)

| # | Item | Verdict | How checked | Notes |
|---|---|---|---|---|
| P0-1 | Production lockout of `SoftwareKeyStore` via `FACTLOCK_ALLOW_SOFTWARE_KEYSTORE` | FAIL | `grep -rn FACTLOCK_ALLOW_SOFTWARE packages/` → zero hits | The commit message claimed this; the code has no env guard at all. `new SoftwareKeyStore()` works in any environment. |
| P0-2 | Software keystore uses `atomicWriteFile` + fsync | FAIL | `packages/keystore-ts/src/software.ts` lines 99, 107 | `persist()` still uses plain `writeFileSync` for both `registry.jsonl` and `secrets.json`. `persist.ts` exports `atomicWriteFile` but nothing in `software.ts` imports it. |
| P0-3 | `getRecord` returns `null` on unknown `key_id` | FAIL | `packages/keystore-ts/src/software.ts:168-170` | Signature says `Promise<KeyRecord \| null>` but the body is `return { ...(this.find(keyId)) }` — `find()` **throws** `KeystoreError(ERR_KEY_NOT_FOUND)`. It never returns `null`. Same pattern in `kms.ts:193-195`. The type lies. |

---

## T1 — Canonical JSON + Ed25519 (TS + Python)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| `sign`/`verify` in both languages | PASS | `npm test` (core-ts 39/39), `npm run test:py` | Real implementations, cross-tested. |
| 20+ shared vectors pass in both (unicode, nested, float edges) | PASS | `packages/vectors/vectors.json`: 22 canonical + 3 sig vectors; spot-checked `unicode-bmp` (`{"café":1}` raw UTF-8), `astral-key-order` (UTF-16 code-unit sort: z < é < € < 𝄞) — hand-verified correct per RFC 8785 | See `docs/lucky/vector-review.md`. |
| Tampered payload fails; wrong key fails | PASS | `negative` vector + tamper tests in both suites | Genuine negatives, not tautologies. |

## T2 — Key management service

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Keys generated in KMS/HSM; private material never leaves it | FAIL | `packages/keystore-ts/src/kms.ts` — `KmsClientLike` is an injected interface; tests run against a stub | The shape is right, the AWS is not. The only keystore that actually works end-to-end is `SoftwareKeyStore` (dev-only by its own docstring). |
| Rotation completes without breaking verification of old-key attestations | LOGIC-ONLY | `keystore.test.ts` rotation tests 22/22 pass | In-memory/JSONL only. Grace/sunset bookkeeping tested, but against no real KMS and no hosted well-known endpoint. |
| Well-known endpoint returns current + retired keys with `valid_from`/`valid_until` | LOGIC-ONLY | `wellknown.ts` exists; unit-tested | No public HTTPS serving it. |

## T3 — Attestation issuance service

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Invalid schema rejected with field-level errors | LOGIC-ONLY | `issuer.test.ts` — validation tests pass | Library-level. No hosted endpoint to reject against. |
| `verified_at` = server time, not client time (skewed-clock test) | LOGIC-ONLY | `issuer.test.ts` — skewed-clock test passes | `nowIso()` is process time; "server time" is true only when the process is the server. |
| No countersignature without linked authorization record (missing auth → 422) | LOGIC-ONLY | `issuer.test.ts` + `hardening.test.ts` pass; one-time grant bound to principal + claim digest | The one-time-grant logic is genuinely good. Still library-only. |
| Throughput ≥ 50/min on modest hardware | LOGIC-ONLY | `issuer.test.ts:359` — 120 issuances measured, passes | In-process against in-memory stores. Says nothing about HTTP + Postgres throughput. |

## T4 — Merkle transparency log

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Inclusion proof verifies against published root using T1 libs | LOGIC-ONLY | `merkle.test.ts` 71/71; byte-identical + verify + tamper-reject vectors | "Published root" = a local JSONL file. There is no public log operator. |
| Proof generation p99 < 50ms at 1M leaves (benchmark test included) | FAIL | `packages/log-ts/test/merkle.test.ts` — no benchmark, no 1M-leaf test exists | The AC explicitly requires a benchmark test; it was never written. Tree is RFC 6962-shaped, but the performance claim is untested. |
| Third-party audit script replays full log and recomputes root | LOGIC-ONLY | `merkle.test.ts:244` — journal replay test passes | The replay harness exists in-repo; no independent third party has run it against a live log. |

## T5 — Daily on-chain anchoring job

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Anchor verifiable on a public block explorer | FAIL | `packages/anchor-ts/src/providers/opentimestamps.ts` — documented stub, **disabled by default, throws unless explicitly enabled** | Default provider is `LocalAnchorProvider` → local JSONL. Nothing has ever touched a chain. |
| Missed run alerts; idempotent; backfills on recovery | FAIL | `anchor.test.ts` — no alert test, no backfill test; no alerting code in `anchor.ts` | The hash chain itself is tamper-evident (genesis/links/recomputed-hashes all tested), but the *job* semantics in this AC do not exist. |
| Monthly anchoring cost reported in job logs (single-digit $) | FAIL | No chain submission happens, so there is no cost to report | Cannot report the cost of a transaction that never occurs. |

## T6 — Public verification API (free tier)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| p99 < 200ms globally (CDN in front) | CANNOT-RUN | No hosting, no CDN | Untestable until deployed. |
| Freshness verdicts match spec table exactly (parameterized per claim type) | LOGIC-ONLY | `freshness.ts` implements 70%/100% rule; `verifier.test.ts` passes | The math is right in-repo. "Per claim type" parameterization is thin — one global ratio. |
| No API key required; rate limits generous and documented | LOGIC-ONLY | `ratelimit.ts` tested; trusted-proxy handling added in `ac6ae14` | Limits exist in code; "documented" is generous — check README/docs before quoting numbers. |

## T7 — Hosted badge page + embeddable badge

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Page renders <1s; UNDER REVIEW banner on DISPUTED | LOGIC-ONLY | `badge.test.ts` 10/10 incl. disputed fixture → banner asserted | Server-rendered HTML; "<1s" unmeasured without hosting. |
| Embed works on plain HTML with one snippet; degrades gracefully offline | LOGIC-ONLY | `render.ts` embed path exists | Offline-degradation path not covered by a test I could find. |
| Spanish version (i18n from day one) | PASS | `packages/badge-ts/src/i18n.ts` — full ES dict reviewed | Native South Florida Spanish. One nit: `status_CLEARED` = "Desestimada" (see `spanish-copy.md`). |

## T8 — MCP server (`factlock_check`)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Works end-to-end in Claude and ChatGPT agent environments (recorded demo) | CANNOT-RUN | MCP is stdio-local only; no public HTTPS | A local smoke test is not this AC. |
| Machine-readable verdicts; never throws on STALE | LOGIC-ONLY | `factlockCheck.test.ts` 12/12 — revoked/expired/unknown all return verdicts, no throws | Genuinely good behavior. Local only. |
| Published with install instructions a non-engineer can follow | FAIL | `packages/mcp-ts/README.md` has dev build steps; nothing is published anywhere | Not on npm, no hosted endpoint, no non-engineer installer. |

## T9 — Verifier field app (mobile web)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Full verification completable in <15 min in field test | CANNOT-RUN | No mobile web app exists | `ops-ts/visits.ts` is checklist *validation logic*, not an app. |
| Spoofed GPS (mock location) detected and flagged | CANNOT-RUN | `geo.ts` has distance math; no device GPS pipeline | No app, no OS location APIs, no mock-location detection. |
| Evidence bundle hashed client-side; hashes match server | CANNOT-RUN | No client | Server-side hashing exists; the client side of this AC does not. |

## T10 — Review dashboard (countersignature console)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| License check runs automatically (FL DBPR); mismatch blocks countersignature | CANNOT-RUN | `grep -ri dbpr packages/ops-ts/src` → zero hits | No DBPR integration of any kind. No oracle, no check, no block. |
| Every countersignature links its authorization record | CANNOT-RUN | Auth linkage exists in *issuer* tests, but there is no review console UI | The invariant holds in the library; the console this AC describes does not exist. |
| Audit trail: who approved what, when, immutable | CANNOT-RUN | No console, no operator identities | The log is append-only, but "who approved" requires the missing UI + auth. |

## T11 — Dispute system

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Filing a dispute flips the public badge to UNDER REVIEW within 60s | LOGIC-ONLY | `disputes.test.ts` — full lifecycle ACTIVE→DISPUTED→…→REVOKED tested; badge disputed-fixture tested | Lifecycle logic is real. The 60-second timing bound is untestable without a hosted badge. |
| SLA breach auto-escalates and pages (clock injection) | CANNOT-RUN | No SLA timer, escalation, or paging code in `disputes.ts` | The feature does not exist yet — not even as logic. Needs infra *and* code. |
| Strike enforcement automatic; full 3-strike path | LOGIC-ONLY | `disputes.test.ts:12` — 3rd strike forces REVOKED; tested | Automatic *in the library*. No cron/worker runs it in production. |

## T12 — Re-verification scheduler

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Cadence matches spec table; nudges sent on schedule (time injection) | LOGIC-ONLY (cadence) | `scheduler.test.ts` — 70% boundary, urgency ordering tested | Cadence math only. |
| Expired attestations flip to STALE without human action | LOGIC-ONLY | Freshness math tested; no scheduler worker exists to *perform* the flip | The verdict computes STALE on read; nothing proactively transitions state. |
| Mystery-shopper picks unpredictable (not round-robin) | FAIL | `scheduler.ts` exports only `dueForReverification` — no shopper selection code at all | AC has zero implementation. |
| Nudge sending (part of AC 1) | FAIL | No nudge/notification code anywhere in `ops-ts` | "Nudges sent on schedule" cannot pass with no sender. |

## T13 — Subscriptions (Stripe)

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Failed payment → 7-day grace → badge shows "verification lapsed" | LOGIC-ONLY | `webhook.test.ts` — `invoice.payment_failed → past_due + 7-day grace; invoice.paid recovers`, offline via real `stripe` package HMAC verify with `sk_test_123` | Webhook state machine is genuinely tested. No live Stripe, no hosted checkout/portal. |
| Founding-price lock honored permanently | LOGIC-ONLY | `billing.test.ts` — snapshot tests pass | Price snapshot logic tested; no production plan changes to honor it against. |

## T14 — Metered API billing

| AC | Verdict | How checked | Notes |
|---|---|---|---|
| Metering accurate to ±0.1% vs log replay (reconciliation test) | LOGIC-ONLY | `metering.test.ts` passes | In-memory metering vs in-repo log. No production traffic. |
| Integrator can see live usage and projected bill | LOGIC-ONLY | Usage/projection functions tested | No hosted dashboard; "live" is doing heavy lifting. |

---

## Tally

| Verdict | Count |
|---|---|
| PASS | 4 |
| FAIL | 11 |
| LOGIC-ONLY | 19 |
| CANNOT-RUN | 9 |
| **Total rows** | **43** |

**What PASS actually means here:** T1 is genuinely done as a library (3 rows), and the badge Spanish strings exist and are correct (1 row). Everything else is libraries-with-tests at best.

**Do not quote the README's "All 14 build tickets ✅ complete" to anyone outside the team.** The honest statement is: *protocol math and lifecycle logic are implemented and tested in-repo; no ticket is production-complete; nothing is hosted.*
