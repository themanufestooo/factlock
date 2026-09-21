# @factlock/issuer

Attestation issuance service (T3): validate → authorize → stamp → sign →
countersign → log.

## Flow

`POST /v1/businesses/{id}/attest` (authenticated):

1. **Validate** the request against `schemas/issue-request.json` — failures
   return **400** with field-level errors (`{ path: "/claims/0/amount", message }`).
2. **Authorization gate** — the client supplies only an opaque
   `authorization_id`. The issuer atomically consumes a server-held record
   bound to the authenticated principal, business, and exact claim digest.
   Missing, expired, replayed, or mismatched authorization → **422**.
3. **Evidence gate** — current server-held evidence must belong to the business
   and collectively cover every claim. Missing verification services fail closed.
4. **Server-stamped time** — `verified_at` comes from the server clock
   (injectable via `IssuerOptions.clock` for tests). `device_time` is accepted
   as metadata only; a skewed client clock cannot move `verified_at`.
5. `valid_until` = `verified_at` + the **shortest** re-verification interval
   across the attestation's claim types (spec §2: identity 365d, license 30d,
   hours 90d, price 30d, availability 7d).
6. **Sign** the JCS-canonical JSON (minus `signatures`/`log`) with the
   custodial business key, then **countersign** with the FactLock key
   (`@factlock/keystore`; explicit `factlock_key_id` or the active FactLock key).
7. **Append** the canonical attestation (with signatures, minus `log`) to the
   transparency log (`@factlock/merkle-log`); the response carries
   `log: { tree: "factlock-main", leaf_index, root }`.

## Use

```ts
import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { createIssuerServer, InMemoryAuthorizationStore, InMemoryEvidenceStore } from "@factlock/issuer";

const keystore = new SoftwareKeyStore("./data/keys"); // dev only; prod: KmsKeyStore
const authorizations = new InMemoryAuthorizationStore(); // use a durable adapter in production
const evidence = new InMemoryEvidenceStore(); // use a durable adapter in production
const server = createIssuerServer({
  keystore,
  log: new MerkleLog("./data/factlock-main.jsonl"),
  authTokens: [process.env.ISSUER_TOKEN!], // dev stub!
  authJournalPath: "./data/auth.jsonl",
  authorizations,
  evidence,
});
server.listen(3000);
```

Or use `issueAttestation(request, opts, { principal })` directly (no HTTP).

## Auth

Authentication is a pluggable `authHook(req) => { principal } | null`.
`authTokens` is a **dev/test stub** (static bearer tokens). Fail closed: with
no hook and no tokens, every issuance returns 401. Production must inject a
hook backed by the real identity provider.

`GET /.well-known/factlock-keys.json` (public, CDN-cacheable) and
`GET /healthz` are also served.

## Schemas

- `schemas/attestation-v1.json` — the issued attestation object (spec §2,
  draft 2020-12). Claim types carry per-type required fields
  (e.g. price requires `item`, `amount` (integer minor units), `currency`,
  `disclosed`).
- `schemas/issue-request.json` — the POST body (references the attestation
  schema's `$defs`; validated with ajv, `allErrors: true`).

## Tests

`npm test` — 30 tests: happy path (shape, server time, both signatures verify
via the T1 lib, log leaf commits to the signed bytes, inclusion proof
verifies), clock-skew AC, principal binding, one-time authorization replay,
evidence coverage, unavailable verification services, schema
violations → 400 with field paths, wrong-business/retired key → 422, no
FactLock key → 503, shortest-interval `valid_until`, auth journaling, and a
throughput smoke test (asserts ≥ 50 issuances/min; last run ≈ 3,000/min),
plus HTTP status-code coverage (401/400/422/404, fail-closed default).
