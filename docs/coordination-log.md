# FactLock coordination log

**The repo is the war room.** Grok, ChatGPT, and Lucky coordinate here. Manuel gets briefed in chat; the detail lives here.

## How we work

- **Issues = work items.** File one per task, close only when acceptance criteria are verified on `main`.
- **This log = running record.** Append dated entries at the top of `## Log`. Every entry: who, what changed, what it means for launch.
- **Lanes:**
  - *Lucky:* test vectors review, Spanish copy, demo scripts, acceptance testing against every AC. Not Postgres/KMS/gateway unless Manuel reassigns.
  - *Engineering (Grok's list, in order):* P0 keystore finish → Postgres/SQLite stores → real AWS KMS → public HTTPS for verify+badge+MCP → real anchor → private-claim commitments → field app + review UI + DBPR oracle.
  - *Copy/site (ChatGPT):* landing page, brand application. Must respect the handoff invariants (no self-custody claims, no "on-chain guaranteed", no factlock.com on badges until owned).
- **Honesty rule:** never mark T1–T14 "complete" until the acceptance scorecard says so. `LOGIC-ONLY` is not production. The README's "All 14 build tickets complete" line must not be quoted externally until it is true.

## Launch board

| Item | Status | Owner |
|---|---|---|
| Grok code review | Done 2026-09-22 (`docs/LUCKY-HANDOFF-2026-09-22.md`) | Grok |
| Lucky acceptance pass (scorecard, ES copy, demo, vectors) | Done 2026-09-23 (`docs/lucky/`) | Lucky |
| P0 keystore finish (3 unwired items) | Open — issue #1 | Engineering |
| Landing copy fix ("Signed by business") | Open — issue #2 | Copy/site |
| Hosted pilot track (Postgres, KMS, HTTPS) | Open — issue #3 | Engineering |
| Trademark TESS screen | Done 2026-09-22 — clean, no conflicts; counsel read advised before factlock.com money | Lucky |
| Domain | Open — `getfactlock.com` recommended (~$10.44/yr); availability TBD at registrar | Manuel |
| Social handles | Plan set — `factlock` on X/TikTok/YouTube/LinkedIn, `@getfactlock` on IG; nothing claimed yet | Manuel |
| Repo rename | Done 2026-09-22 — `themanufestooo/factlock` | Lucky |
| Landing page deploy | Blocked on domain + issue #2 | — |
| Content publishing (deck cadence) | Blocked on handles + first teardown | — |

## Scorecard snapshot (2026-09-23, head `387cc50`)

**4 PASS / 11 FAIL / 19 LOGIC-ONLY / 9 CANNOT-RUN** across 43 rows. Full table: `docs/lucky/acceptance-scorecard.md`.

## Log

### 2026-09-23 — Lucky
- Filed issues #1 (P0 keystore), #2 (landing copy landmine), #3 (hosted pilot track). Opened coordination log (this file).
- Lucky's handoff pass complete: scorecard, Spanish copy review, 10-min local demo script, vector spot-check — all under `docs/lucky/`, pushed to `main`.
- Waiting on: engineering for #1/#3, copy/site for #2, Manuel for domain pick + handle claims. Lucky stops here per the handoff's definition of done.

### 2026-09-22 — Grok
- Audit + hardening pass pushed as `ac6ae14`; handoff to Lucky written as `387cc50` (`docs/LUCKY-HANDOFF-2026-09-22.md`).
- Note: `ac6ae14`'s message overclaimed — three keystore items were not actually wired (now issue #1).
