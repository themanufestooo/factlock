# FactLock — signed business-truth layer for AI agents

FactLock lets an AI agent verify a business claim **before money moves**: signed,
timestamped, publicly-auditable attestations (price, hours, license, availability),
countersigned by FactLock after verification and logged in a Merkle transparency
log. The repository includes a hash-chained anchoring interface; production chain
submission remains a deployment integration, not a shipped guarantee.

- **Spec:** `docs/factlock-attestation-protocol-v1.1.md` (build-ready)
- **Adversarial review:** `docs/factlock-redteam-v1.md`
- **Build plan:** `docs/factlock-build-tickets.md` (T1–T14)
- **Private-claim proposal:** `docs/factlock-private-claims-proposal.md`
- **Landing page:** `site/dist/index.html` (static, dependency-free)

Built by EYFE Services LLC (interim entity).

## Repo layout

```
docs/                  protocol spec, red-team report, build tickets
packages/
  core-ts/             T1 — TypeScript core: JCS (RFC 8785) + Ed25519  ✅ done
  core-py/             T1 — Python reference implementation            ✅ done
  vectors/             shared cross-language test vectors (hand-computed ground truth)
  keystore-ts/         T2 — key management: KMS-shaped KeyStore, rotation, well-known keys ✅ done
  issuer-ts/           T3 — attestation issuance: schema validation, server-stamped time,
                       one-time authorization + evidence gates, countersignature,
                       log append                                               ✅ done
  log-ts/              T4 — RFC 6962 Merkle transparency log + proofs + audit ✅ done
  verify-api-ts/       T6 — public verification API: signatures, inclusion,
                       lifecycle, freshness verdicts, rate-limited free tier  ✅ done
  badge-ts/            T7 — hosted badge page + embeddable JS badge (EN/ES)   ✅ done
  mcp-ts/              T8 — MCP server: factlock_check tool for AI agents       ✅ done
  anchor-ts/           T5 — daily anchoring: hash-chained anchor log of roots ✅ done
```

## T1 status — done, tested

Both implementations share `packages/vectors/vectors.json` (23 canonicalization
vectors with hand-computed RFC 8785 expectations, 3 deterministic Ed25519 vectors
plus tamper/wrong-key negatives). **33/33 tests pass in each language.**

```bash
# TypeScript
cd packages/core-ts && npm install && npm test

# Python
cd packages/core-py && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
PYTHONPATH=src .venv/bin/python -m pytest tests/ -q
```

## Roadmap (from build tickets)

- **T1** ✅ Canonical JSON + Ed25519 sign/verify (TS + Python)
- **T2** ✅ Key management service (KMS/HSM-shaped, rotation, well-known keys)
- **T3** ✅ Attestation issuance service (schema validation, server-stamped time, auth trail)
- **T4** ✅ Merkle transparency log + inclusion proofs
- **T5** ✅ Daily anchoring job (hash-chained anchor log; local + OTS-shaped providers)
- **T6** ✅ Public verification API (free tier, freshness verdicts)
- **T7** ✅ Hosted badge page + embeddable badge (EN/ES)
- **T8** ✅ MCP server (`factlock_check`)
- **T9–T12** ✅ Verifier app, review console, disputes (3rd-strike revocation), re-verification scheduler
- **T13–T14** ✅ Stripe subscriptions + metered API billing

Critical path: T1 → T2 → T3 → T4 → T6 → T7 ✅ complete. T8 + T5 ✅ complete.
All 14 build tickets ✅ complete — 289/289 tests green.
