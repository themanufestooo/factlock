# FactLock — build the product, in order

This is the working plan. Do not start Step 6 while Step 2 is open.

**Product:** a plumber in South Florida can show a signed, freshness-labeled claim (price / hours / license) that an AI agent checks before money moves.

**Not the product yet:** a protocol monorepo with 14 green tickets.

---

## How we work

One step at a time. Each step has a *done when* you can show a person, not a file.

Lucky stays on acceptance, Spanish, and demo scripts (`docs/LUCKY-HANDOFF-2026-09-22.md`).
Engineering follows the steps below.

---

## Step 0 — Tell the truth (done)

- Protocol math works (JCS + Ed25519 + Merkle + freshness).
- HTTP libraries exist. Nothing is hosted.
- Keys are software-on-disk. Anchor is a stub.
- Lucky handoff is on `main`.

## Step 1 — Close the keystore holes (in progress)

Make the last harden commit match the code:

1. `SoftwareKeyStore` throws in production unless `FACTLOCK_ALLOW_SOFTWARE_KEYSTORE=1`.
2. `getRecord` returns `null` on unknown `key_id`.
3. Registry / secrets / KMS mapping write via temp + fsync + rename.

**Done when:** those three tests pass on `main`.

## Step 2 — One plumber on a laptop (next)

Pick **one** fictional-then-real Broward / Miramar plumber.

Build a single local script that:

1. Creates keys (software, flagged as dev).
2. Records a one-time authorization.
3. Issues license + price + hours.
4. Verifies FRESH.
5. Renders the badge EN/ES.
6. Calls `factlock_check`.
7. Disputes / revokes and shows the badge flip.

**Done when:** Manuel can run one command and walk a contractor through the screen in 10 minutes. Lucky owns the script text; engineering owns the command.

## Step 3 — A real database

SQLite first (one file, one machine). Postgres when two processes exist.

Every store: attestations, status, authorizations, evidence, visits, disputes, billing.

Issuance is **one transaction**: consume auth + append log leaf + save attestation. If any piece fails, nothing sticks and the SMS grant comes back.

**Done when:** kill the process, start it again, the plumber’s badge is still there.

## Step 4 — Host verify + badge + MCP

Public HTTPS:

- `GET /v1/verify/:id` (free, no API key)
- Badge page + embed
- MCP `factlock_check` over Streamable HTTP (for Grok Bot / Claude)

TLS at the edge. Trusted-proxy rate limits. Software keystore still forbidden.

**Done when:** a phone on cellular can open the badge and an agent can add the MCP connector.

## Step 5 — Real keys

Wire `KmsKeyStore` to AWS KMS Ed25519. No `secrets.json` on the box that issues live badges.

**Done when:** `FACTLOCK_ENV=production` cannot boot a software keystore, and a signature comes back from KMS.

## Step 6 — First real badge (manual ops is fine)

- Liability cap + TCPA reviewed.
- Domain on the badge confirmed.
- One real license check (FL DBPR, even if a human pastes the result).
- One field visit with photos + GPS, reviewed by a human.
- Founding $49 checkout works. Onboarding visit is a separate line item.

**Done when:** that one business can show the badge to a customer without us lying about what is behind it.

## Step 7 — Anchor + private prices

- Daily Merkle root to OpenTimestamps or a cheap L2. Explorer link in `/v1/log/anchors`.
- Private-claim commitments before unpublished quotes hit the log.

## Step 8 — Repeatable field ops

Verifier mobile web, review queue, mystery-shopper rotation, 3-strike disputes that actually page someone. Only after Step 6 has one live badge.

---

## What we are not doing yet

- Multi-city expansion
- Business self-custody keys (v2)
- Grok Bot as issuer / ops console
- Calling T9–T14 “production complete”

---

## This week

| Who | Job |
|---|---|
| Engineering | Finish Step 1, then Step 2 command |
| Lucky | Acceptance scorecard + Spanish + demo script text |
| Manuel | Name the first plumber, confirm domain, decide hosting (Fly / Render / a $6 VPS) |
