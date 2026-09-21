# @factlock/mcp-server (T8)

Model Context Protocol server exposing **`factlock_check`** — one tool that lets
an AI agent verify a business's attested claims (price, hours, license,
availability) **before quoting a price, booking an appointment, or paying an
invoice** based on those claims.

The handler runs the T6 verifier in-process (Ed25519 signatures → Merkle
inclusion against the current log root → lifecycle status → freshness) and
returns a compact verdict:

```json
{
  "valid": true,
  "status": "ACTIVE",
  "freshness": "FRESH",
  "attestation_id": "fla_01J...",
  "business": { "id": "biz_rapido", "name": "Rapido Plumbing LLC" },
  "summary_line": "VERIFIED — ...",
  "reason": null,
  "claims": [{ "type": "price", "item": "service_call", "verdict": "FRESH" }],
  "details_url": "https://verify.factlock.example/v1/verify/fla_01J..."
}
```

`valid:false` carries a machine-readable `reason`
(`signature_invalid`, `not_in_transparency_log`, `revoked`, `suspended`,
`under_review`, `expired`, `stale`, `aging`, `untrusted`, `no_claim_of_type`,
...). The tool description teaches the agent the freshness legend
(FRESH < 70% of interval, AGING 70–100%, STALE ≥ 100% → do not trust).

## Run

```bash
cd packages/mcp-ts && npm install && npm run build
FACTLOCK_DATA_DIR=/var/lib/factlock \
FACTLOCK_PUBLIC_BASE_URL=https://verify.factlock.example \
npm start
```

Data directory layout (created if missing):

```
<dataDir>/
  log.jsonl            Merkle log journal (T4)
  keystore/            SoftwareKeyStore registry dir (T2)
  attestations.jsonl   one attestation JSON per line
  statuses.jsonl       one {attestation_id, status, reason, at} per line
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "factlock": {
      "command": "node",
      "args": ["/opt/factlock/packages/mcp-ts/dist/src/bin.js"],
      "env": {
        "FACTLOCK_DATA_DIR": "/var/lib/factlock",
        "FACTLOCK_PUBLIC_BASE_URL": "https://verify.factlock.example"
      }
    }
  }
}
```

Generic MCP clients: same command over stdio; the server speaks MCP 2024-11+
(`initialize`, `tools/list`, `tools/call`).

## Tests

`npm test` — 12 tests: handler fixtures (fresh/revoked/stale/unknown id,
business lookup, claim_type filter) plus an MCP protocol smoke test over
`InMemoryTransport` (list + call). Note: build dependencies before dependents
(`tsc` needs their `dist`): core-ts → keystore-ts → log-ts → issuer-ts →
verify-api-ts → mcp-ts.
