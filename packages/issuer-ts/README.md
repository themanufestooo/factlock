# @veritas/issuer

Attestation issuance service (T3): validate → authorize → stamp → sign →
countersign → log.

## Flow

`POST /v1/businesses/{id}/attest` (authenticated):

1. **Validate** the request against `schemas/issue-request.json` — failures
   return **400** with field-level errors (`{ path: "/claims/0/amount", message }`).
2. **Authorization gate** — a well-formed authorization record
   (`auth_id`, `session_id`, `sms_confirmation_ref`, `authorized_at`,
   `authorized_by: "owner-on-file"`) is required. Missing or malformed →
   **422** (spec §3.2: no countersignature without one). The record is the v1
   custodial approval: the business authorized this issuance via logged-in
   session + SMS confirmation, and it is journaled immutably **and**
   hash-committed inside the attestation the log leaf covers.
3. **Server-stamped time** — `verified_at` comes from the server clock
   (injectable via `IssuerOptions.clock` for tests). `device_time` is accepted
   as metadata only; a skewed client clock cannot move `verified_at`.
4. `valid_until` = `verified_at` + the **shortest** re-verification interval
   across the attestation's claim types (spec §2: identity 365d, license 30d,
   hours 90d, price 30d, availability 7d).
5. **Sign** the JCS-canonical JSON (minus `signatures`/`log`) with the
   custodial business key, then **countersign** with the Veritas key
   (`@veritas/keystore`; explicit `veritas_key_id` or the active Veritas key).
6. **Append** the canonical attestation (with signatures, minus `log`) to the
   transparency log (`@veritas/merkle-log`); the response carries
   `log: { tree: "veritas-main", leaf_index, root }`.

## Use

```ts
import { SoftwareKeyStore } from "@veritas/keystore";
import { MerkleLog } from "@veritas/merkle-log";
import { createIssuerServer } from "@veritas/issuer";

const keystore = new SoftwareKeyStore("./data/keys"); // dev only; prod: KmsKeyStore
const server = createIssuerServer({
  keystore,
  log: new MerkleLog("./data/veritas-main.jsonl"),
  authTokens: [process.env.ISSUER_TOKEN!], // dev stub!
  authJournalPath: "./data/auth.jsonl",
});
server.listen(3000);
```

Or use `issueAttestation(request, opts)` directly (no HTTP).

## Auth

Authentication is a pluggable `authHook(req) => { principal } | null`.
`authTokens` is a **dev/test stub** (static bearer tokens). Fail closed: with
no hook and no tokens, every issuance returns 401. Production must inject a
hook backed by the real identity provider.

`GET /.well-known/veritas-keys.json` (public, CDN-cacheable) and
`GET /healthz` are also served.

## Schemas

- `schemas/attestation-v1.json` — the issued attestation object (spec §2,
  draft 2020-12). Claim types carry per-type required fields
  (e.g. price requires `item`, `amount` (integer minor units), `currency`,
  `disclosed`).
- `schemas/issue-request.json` — the POST body (references the attestation
  schema's `$defs`; validated with ajv, `allErrors: true`).

## Tests

`npm test` — 27 tests: happy path (shape, server time, both signatures verify
via the T1 lib, log leaf commits to the signed bytes, inclusion proof
verifies), clock-skew AC, missing/malformed/future auth → 422, schema
violations → 400 with field paths, wrong-business/retired key → 422, no
Veritas key → 503, shortest-interval `valid_until`, auth journaling, and a
throughput smoke test (asserts ≥ 50 issuances/min; last run ≈ 3,000/min),
plus HTTP status-code coverage (401/400/422/404, fail-closed default).
