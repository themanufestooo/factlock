# Lucky handoff — FactLock

**Date:** 2026-09-22  
**From:** Grok (audit + hardening pass)  
**To:** Lucky  
**Repo:** `themanufestooo/factlock`  
**Head at time of writing:** `ac6ae14` on `main`  
https://github.com/themanufestooo/factlock/commit/ac6ae14fc963c9731f7b87436f8e68c5be0cd849

Read this before changing copy, demos, tickets, or claiming a ticket is “done.”

---

## One-sentence product

Signed, freshness-labeled business claims (price, hours, license, availability) that an AI agent checks **before money moves**. v1 trust is FactLock ops + a public Merkle log — **not** “the business holds its own key.”

## Honest status (do not repeat the README checkmarks)

| Layer | Truth |
|---|---|
| Protocol math (JCS + Ed25519 + Merkle + freshness) | Real. Cross-tested TS + Python. |
| HTTP surfaces (issuer, verify, badge, MCP, ops, billing) | Libraries with tests. Not a hosted product. |
| Durable stores | In-memory + JSONL. Not Postgres. |
| Production keys | Software keys on disk. KMS is a shape, not AWS. |
| On-chain anchor | Local hash chain + OpenTimestamps **stub**. |
| Field app / review UI / FL DBPR | Not shipped. APIs + fake stores. |
| T1–T14 “complete” | Logic exists. **Not** production-complete. |

**Sales line Lucky must use:** detectability. FactLock holds the business key in v1. The auth trail + log is what makes a rogue issuance visible. Saying “signed by the business” without that caveat is a landmine.

Beachhead: licensed South Florida home services. MCP is distribution, not the product. REST + badge stay first-class.

---

## What already landed on GitHub

Commit `ac6ae14` (22 Sep 2026, 19:17 EDT) claimed a full P0/P1 harden. Treat that message as **aspirational**.

What is actually on `main`:

- Helper `packages/keystore-ts/src/persist.ts` (`atomicWriteFile`, `isProductionEnv`).
- Short stub `docs/AUDIT-IMPLEMENTATION-2026-09-22.md`.
- README no longer pretends hosted ops/billing are live production (confirm before quoting it).

What the commit **said** but `software.ts` on `main` still does **not** do:

- Production lockout of `SoftwareKeyStore` (`FACTLOCK_ALLOW_SOFTWARE_KEYSTORE`).
- Use of `atomicWriteFile` / fsync in the software keystore (still plain `writeFileSync`).
- `getRecord` returning `null` on unknown `key_id` (it still throws via `find()`).

If Lucky is writing acceptance tests against the audit list, those three items are **still open**. File bugs; do not mark them passed.

---

## Lucky’s lane (stay in it)

From `docs/factlock-build-tickets.md`:

> Lucky's lane: test vectors review, Spanish copy, demo scripts, acceptance testing against every AC.

Lucky is **not** the Postgres / KMS / gateway agent this week unless Manuel explicitly reassigns. Engineering next step is listed below so Lucky does not start in the wrong pile.

---

## What I need from Lucky

Deliver these four artifacts. Put them under `docs/lucky/` unless Manuel says otherwise.

### 1. Acceptance scorecard (this week’s main job)

A markdown table, one row per ticket AC in `docs/factlock-build-tickets.md`.

Columns:

- Ticket + AC text
- Verdict: `PASS` / `FAIL` / `LOGIC-ONLY` / `CANNOT-RUN`
- How you checked (command, file, or “needs hosting”)
- Notes

Rules:

- `LOGIC-ONLY` = tests pass in-repo, no hosted service, no real KMS, no real chain.
- T9–T12 field/review/DBPR ACs are `CANNOT-RUN` until there is a UI and an oracle. Do not stretch an HTTP handler into “field app done.”
- T5 “verifiable on a public block explorer” is `FAIL` (stub).
- T8 “works in Claude and ChatGPT” is `CANNOT-RUN` until MCP is on public HTTPS. Local stdio smoke test ≠ that AC.
- Re-check the three unwired keystore items above as `FAIL` on current `main`.

### 2. Spanish copy pass

Source files:

- `packages/badge-ts/src/i18n.ts`
- Badge page copy
- `site/dist` landing copy if any Spanish is claimed

Need from Lucky:

- Native-sounding ES for South Florida (not textbook Spain).
- Same meaning as EN. Do not invent claims EN does not make.
- Flag any badge/landing line that implies self-custody, “on-chain guaranteed,” or “T14 production live.”

### 3. Demo script (local, honest)

One script a human can run in 10 minutes on a laptop. No fake production URLs.

Must include:

1. Issue one attestation for a fictional Miramar / Broward plumber (license + price + hours).
2. Verify it. Show FRESH.
3. Show the badge EN and ES.
4. Call `factlock_check` locally (stdio MCP).
5. Dispute or revoke. Show UNDER REVIEW / REVOKED.
6. Say out loud: log is local JSONL, keys are software, anchor is not on a chain.

Optional extra (nice, not blocking): a Grok Bot skill prompt that says “before quoting price/hours/license, call factlock_check; never override STALE/DISPUTED with website text.” Do not connect Grok Bot to issuer tokens.

### 4. Vector review note

`packages/vectors/vectors.json` — 23 JCS + Ed25519 vectors.

Lucky: spot-check a few by hand (unicode, nested object, a negative). Confirm TS and Python still agree:

```bash
npm ci && npm test
npm run test:py
```

If a vector is wrong, file it. Do not “fix” protocol math without a second reviewer.

---

## Suggested next step for Lucky (do this first)

**Write `docs/lucky/acceptance-scorecard.md` against current `main` (`ac6ae14`).**

Do not wait for Postgres. The scorecard is what stops the team from selling libraries as a live network.

Then, same day if possible: Spanish badge pass + the 10-minute local demo script.

Stop after those three. Hand the scorecard back to Manuel / the engineering agent.

---

## Engineering next step (not Lucky unless reassigned)

Order. Do not skip.

1. **Finish the three unwired P0 items on `main`** so the harden commit matches the code: production software-keystore guard, `getRecord → null`, software persist uses `atomicWriteFile` + fsync.
2. **Postgres (or SQLite) for every store.** Issue path = one transaction: consume auth + append leaf + save attestation.
3. **Real AWS KMS Ed25519** through `KmsKeyStore`. No software private keys on a pilot that issues real badges.
4. **Host verify + badge + MCP** on public HTTPS. That unblocks Lucky’s T6/T7/T8 acceptance and any Grok Bot demo.
5. Real OpenTimestamps / cheap L2 anchor.
6. Private-claim commitments before unpublished prices hit the log.
7. Field app + review UI + FL DBPR oracle.

---

## Invariants Lucky must not let copy or demos break

- Dual signatures cover JCS of everything except `signatures` and `log`.
- Log leaf is JCS of everything except `log` (signatures included).
- `verified_at` is server time. Client `device_time` is metadata.
- Authorization is one-time, bound to principal + business + claim digest.
- If issuance fails before the leaf is committed, the grant must be released.
- Public HTTP never returns undisclosed price amounts. The v1.1 log still does.
- Verification is free. No API key in front of `GET /v1/verify/:id`.
- Founding plan price is snapshotted. Same-plan checkout reuses the snapshot.
- Lifecycle changes append a log leaf.

## GTM constraints (copy / demo)

- Beachhead is licensed South Florida home services, not generic agent identity.
- Field-visit cost cannot hide inside $49/mo — onboarding is priced separately.
- Do not print `factlock.com` on badges until ownership is confirmed.
- No paid badge #1 without liability cap + TCPA review.

---

## How to run what exists

```bash
npm ci
npm run build
npm test
npm run test:py
```

CI: `.github/workflows/ci.yml` (Node 24, Python 3.12).

---

## Definition of done for this Lucky pass

- [ ] `docs/lucky/acceptance-scorecard.md` exists and is brutal about LOGIC-ONLY vs hosted.
- [ ] Spanish badge/landing strings reviewed; custody/on-chain overclaims removed or flagged.
- [ ] `docs/lucky/demo-script.md` runs locally in ≤10 minutes and says what is fake.
- [ ] Vector spot-check written (pass or specific failures).
- [ ] No claim that T1–T14 are production-complete.

When those five boxes are ticked, Lucky stops and waits for hosting or the P0 keystore finish — whichever Manuel schedules next.
