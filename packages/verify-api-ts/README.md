# @veritas/verify-api (T6)

Public verification API: implements spec §5 as a free, keyless HTTP service.
Agents verify an attestation in milliseconds with zero cost and no API key.

## Routes

- `GET /v1/verify/:attestation_id` → `VerificationResult` (200 even when the
  attestation is *invalid* — validity is data, not an HTTP error)
- `GET /v1/attestations/:id` → the attestation (undisclosed price amounts redacted)
- `GET /healthz` → liveness (not rate-limited)

Free tier: 60 requests/minute/IP (in-memory token bucket; 429 + `Retry-After`).

## What verification checks

1. **Business signature** — against the business public key resolved by `key_id`
2. **Veritas countersignature** — against the Veritas key resolved by `key_id`
   (retired keys keep verifying old attestations — verification resolves by `key_id`)
3. **Merkle inclusion** — the leaf's inclusion proof is verified against the
   log's **current** root, not the proof's self-stated root
4. **Lifecycle status** — `ACTIVE`/`CLEARED`/`CORRECTED` are trusted;
   `DISPUTED` is treated as untrusted (equivalent to STALE), `SUSPENDED` and
   `REVOKED` are rejected. A pluggable `StatusRegistry` holds dispute/operator
   overrides so status flips within 60 seconds without re-issuance.
5. **Expiry** — `now > valid_until` is rejected outright, never silently trusted
6. **Freshness** — `AGING` at 70% of the re-verification interval, `STALE` at
   100% (spec §2). The interval comes from the attestation's own
   `verified_at → valid_until` span, so it cannot drift from issuance;
   per-claim verdicts use the §2 table (single source: `CLAIM_INTERVAL_DAYS`
   imported from `@veritas/issuer`).

All time comes from the injected server clock — nothing about freshness is
trusted from client input.

## Response

```json
{
  "attestation_id": "vat_...",
  "valid": true,
  "status": "ACTIVE",
  "freshness": "FRESH",
  "age_days": 3,
  "interval_days": 30,
  "verified_at": "2026-09-19T12:00:00Z",
  "valid_until": "2026-10-19T12:00:00Z",
  "signatures_ok": true,
  "inclusion_ok": true,
  "expired": false,
  "key_ids": { "business": "key_...", "veritas": "key_..." },
  "claims": [ { "type": "price", "item": "service_call", "amount": 8900, "currency": "USD", "disclosed": true } ],
  "claims_freshness": [ { "type": "price", "age_days": 3, "interval_days": 30, "verdict": "FRESH" } ],
  "message": "VERIFIED — vat_...: signatures valid, in transparency log, status ACTIVE, 3d old."
}
```

Undisclosed price claims (`disclosed: false`) are served as
`{type: "price", item, disclosed: false, withheld: true}` — signed and logged,
never published (spec §2).

## Run

```bash
npm install && npm test   # build + node:test suite
```

## Notes / judgment calls

- `AttestationStore` and `StatusRegistry` are interfaces with in-memory v1
  implementations — Postgres slots in later without touching the verifier.
- `LogReader` is the minimal surface the verifier needs; `MerkleLog` (T4)
  satisfies it. A persistent/remote log just implements the interface.
- Rate limiting is per-IP via `X-Forwarded-For` when present (set it at your
  edge) else the socket address.
