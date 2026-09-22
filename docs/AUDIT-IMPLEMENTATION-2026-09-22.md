# FactLock audit + hardening pass

**Date:** 2026-09-22  
**Repo:** `themanufestooo/factlock`  
**Audience:** other agents continuing this work. Read this before changing protocol, auth, billing, or persistence.

## Product in one sentence

Signed, freshness-labeled business claims (price, hours, license, availability) that an AI agent can check before money moves. v1 trust is FactLock operations + detectability via a Merkle log — not business self-custody.

## Honest status

| Layer | Status |
|---|---|
| Protocol math (JCS + Ed25519 + Merkle + freshness) | Implemented and cross-tested |
| Issuance / verify / badge / MCP HTTP surfaces | Implemented as `node:http` libraries |
| Durable production stores (Postgres, KMS, OTS, CDN revocations) | **Not shipped** — interfaces + in-memory / JSONL |
| Field verifier app, review UI, DBPR oracle | **Not shipped** — HTTP APIs + in-memory stores |
| On-chain anchoring | Local hash-chain + OpenTimestamps *stub* |

Do not tell integrators “T1–T14 production complete.”

See this file plus `README.md` for the 2026-09-22 hardening list, remaining work, auth env vars, and invariants.
