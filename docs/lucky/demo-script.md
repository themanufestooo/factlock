# FactLock local demo script — 10 minutes, laptop only

**Reviewer:** Lucky · **Date:** 2026-09-23 · **Repo head:** `387cc50`
**Audience:** Manuel, or anyone evaluating FactLock. No fake production URLs anywhere in this demo.

**The business is fictional.** "Coco Plumbing LLC", Miramar/Broward. The license number `CFC-0000000-DEMO` is invented. No field visit happened. Say that out loud at the start.

## 0. One-time setup (2 min, before the audience arrives)

```bash
git clone https://github.com/themanufestooo/factlock.git && cd factlock
npm ci && npm run build
```

Save the three scripts below as `demo-seed.mjs`, `demo-serve.mjs`, `demo-dispute.mjs` in the repo root. They are **demo scaffolding, not product code** — delete or `.gitignore` them after. They use only the built `dist/` packages and the same call patterns as the test suites.

### `demo-seed.mjs` — issue one attestation into `./demo-data/`

```js
// Fictional business. Fictional license. No field visit happened.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SoftwareKeyStore } from "./packages/keystore-ts/dist/src/index.js";
import { MerkleLog } from "./packages/log-ts/dist/src/index.js";
import {
  issueAttestation, InMemoryAuthorizationStore,
  InMemoryEvidenceStore, digestClaims,
} from "./packages/issuer-ts/dist/src/index.js";

const DIR = "./demo-data";
mkdirSync(join(DIR, "keystore"), { recursive: true });

const keystore = new SoftwareKeyStore(join(DIR, "keystore"));
await keystore.generateKey("factlock", "factlock");
const biz = await keystore.generateKey("coco_plumbing", "business");
const log = new MerkleLog(join(DIR, "log.jsonl"));
const authorizations = new InMemoryAuthorizationStore();
const evidence = new InMemoryEvidenceStore();

const claims = [
  { type: "price", item: "service_call_diagnostic", amount: 8900, currency: "USD", unit: "per_visit", disclosed: true },
  { type: "hours", item: "weekday_hours", opens: "08:00", closes: "18:00", timezone: "America/New_York", disclosed: true },
  { type: "license", authority: "FL DBPR (FICTIONAL - no lookup performed)", license_number: "CFC-0000000-DEMO", status: "active", checked_at: new Date().toISOString() },
];
const authId = "auth_demo_001";
authorizations.put({
  authorization_id: authId, business_id: "biz_coco", principal: "owner_coco",
  claim_digest: digestClaims(claims), method: "authenticated_session",
  authorized_at: new Date().toISOString(), authorized_by: "owner-on-file",
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
});
evidence.put({
  evidence_ref: "demo:owner_assertion", business_id: "biz_coco",
  claim_types: ["price", "hours", "license"], verified_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 90 * 86400_000).toISOString(),
  verification_method: "owner_assertion", verifier_id: "demo",
});

const att = await issueAttestation({
  subject: { business_id: "biz_coco", legal_name: "Coco Plumbing LLC", dba: "Coco Plumbing", phone: "+1-954-555-0100" },
  claims, verification_method: "owner_assertion", verifier_id: "demo",
  evidence_refs: ["demo:owner_assertion"], authorization_id: authId,
  business_key_id: biz.key_id,
}, { keystore, log, authorizations, evidence }, { principal: "owner_coco" });

writeFileSync(join(DIR, "attestations.jsonl"), JSON.stringify(att) + "\n");
writeFileSync(join(DIR, "statuses.jsonl"), JSON.stringify({
  attestation_id: att.attestation_id, status: "ACTIVE", reason: "demo seed", at: new Date().toISOString(),
}) + "\n");
console.log("ATTESTATION_ID=" + att.attestation_id);
console.log("leaf_index=" + att.log.leaf_index + " root=" + att.log.root.slice(0, 16) + "…");
```

### `demo-serve.mjs` — badge server on the data dir (restart to pick up status changes)

```js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SoftwareKeyStore } from "./packages/keystore-ts/dist/src/index.js";
import { MerkleLog } from "./packages/log-ts/dist/src/index.js";
import { InMemoryAttestationStore, InMemoryStatusRegistry } from "./packages/verify-api-ts/dist/src/index.js";
import { createBadgeServer } from "./packages/badge-ts/dist/src/index.js";

const DIR = "./demo-data";
const readJsonl = (p) => existsSync(p) ? readFileSync(p, "utf-8").split("\n").map(l => l.trim()).filter(Boolean).map(JSON.parse) : [];
const keystore = new SoftwareKeyStore(join(DIR, "keystore"));
const log = MerkleLog.load(join(DIR, "log.jsonl"));
const store = new InMemoryAttestationStore();
for (const a of readJsonl(join(DIR, "attestations.jsonl"))) await store.put(a);
const statuses = new InMemoryStatusRegistry();
for (const s of readJsonl(join(DIR, "statuses.jsonl"))) await statuses.set(s.attestation_id, s);
const server = createBadgeServer({ store, keystore, log, statuses, apiBaseUrl: "http://127.0.0.1:8471" });
server.listen(8471, "127.0.0.1", () => console.log("badge: http://127.0.0.1:8471/badge/<ATTESTATION_ID>"));
```

### `demo-dispute.mjs` — flip lifecycle state

```js
// usage: node demo-dispute.mjs <ATTESTATION_ID> DISPUTED|REVOKED
import { appendFileSync } from "node:fs";
const [id, status] = process.argv.slice(2);
appendFileSync("./demo-data/statuses.jsonl", JSON.stringify({
  attestation_id: id, status, reason: "demo dispute filed by presenter", at: new Date().toISOString(),
}) + "\n");
console.log(`status → ${status} (restart demo-serve.mjs to show it)`);
```

---

## The 10 minutes

**Say first:** "Everything you're about to see runs on this laptop. The business is fictional, the license is invented, no inspector visited anyone."

### 1. Issue (1 min)

```bash
node demo-seed.mjs
# → ATTESTATION_ID=fla_...  leaf_index=0  root=9f2c…
```

**Say:** "That ran schema validation, server-stamped the time, required a one-time authorization bound to the owner and the exact claim digest, countersigned with the FactLock key, and appended a leaf to the Merkle log. The same code path the tests cover."

### 2. Verify — FRESH (1 min)

```bash
node -e "
import('./packages/verify-api-ts/dist/src/index.js').then(async ({ verifyAttestation, InMemoryAttestationStore, InMemoryStatusRegistry }) => {
  const { readFileSync } = await import('node:fs');
  const { SoftwareKeyStore } = await import('./packages/keystore-ts/dist/src/index.js');
  const { MerkleLog } = await import('./packages/log-ts/dist/src/index.js');
  const id = process.argv[1];
  const store = new InMemoryAttestationStore();
  for (const l of readFileSync('./demo-data/attestations.jsonl','utf-8').trim().split('\n')) await store.put(JSON.parse(l));
  const r = await verifyAttestation(id, { store, keystore: new SoftwareKeyStore('./demo-data/keystore'), log: MerkleLog.load('./demo-data/log.jsonl'), statuses: new InMemoryStatusRegistry() });
  console.log(JSON.stringify({ valid: r.valid, freshness: r.freshness, signatures: r.signatures }, null, 2));
}, 'fla_REPLACE_ME')"
```

Simpler alternative if that one-liner feels fragile live: skip it — the badge page in step 3 shows the same verdict. The MCP call in step 4 also returns it. Don't let plumbing eat the 10 minutes.

**Say:** "FRESH — issued minutes ago against a 90-day license window. The verdict is recomputed from signatures + log inclusion + lifecycle, every time."

### 3. Badge EN + ES (2 min)

```bash
node demo-serve.mjs
# open: http://127.0.0.1:8471/badge/fla_REPLACE_ME
# then: http://127.0.0.1:8471/badge/fla_REPLACE_ME?lang=es
```

**Say:** "Same attestation, English and Spanish — 'Vigente', 'En revisión', the point-in-time disclaimer in both languages. The badge never shows the business's private anything; undisclosed prices render as 'verified, details withheld'."

### 4. `factlock_check` over stdio MCP (2 min)

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"factlock_check","arguments":{"business_id":"biz_coco"}}}' \
| FACTLOCK_DATA_DIR=./demo-data node packages/mcp-ts/dist/src/bin.js
```

**Say:** "That's the agent path — a JSON-RPC call over stdio, machine-readable verdict. An agent deciding whether to quote this plumber's $89 service call would call this *before* repeating the price. Note: this is local stdio. The ticket requires it working inside Claude and ChatGPT's agent environments over public HTTPS — that is not this demo."

### 5. Dispute → UNDER REVIEW → REVOKED (2 min)

```bash
node demo-dispute.mjs fla_REPLACE_ME DISPUTED
# restart demo-serve.mjs, refresh the badge → UNDER REVIEW banner
node demo-dispute.mjs fla_REPLACE_ME REVOKED
# restart demo-serve.mjs, refresh → REVOKED
```

**Say:** "Dispute filed, badge flips to UNDER REVIEW. Third strike — or an explicit revoke — and it's permanent. Every transition appended a leaf to the log, so the history is auditable. What's *not* shown: the 48-hour SLA auto-escalation and paging — that code doesn't exist yet."

### 6. Say what's fake (1 min — do not skip)

Read these out loud, verbatim:

1. "The transparency log is a JSONL file on this laptop — not a public log anyone can audit."
2. "The keys are software keys on disk — not a KMS or HSM. There is no production key custody here."
3. "The anchor is a local hash chain — nothing has touched a blockchain."
4. "The license was never checked against FL DBPR. That integration does not exist."
5. "No field visit happened. The 'evidence' is a string I typed."
6. "Nothing you saw is hosted. There is no API, no badge CDN, no MCP endpoint on the public internet."

---

## Optional extra: Grok Bot skill prompt (not wired to anything)

> Before you quote a business's price, hours, or license number, call `factlock_check` for that business. If the verdict is STALE or DISPUTED — or if there is no attestation — say so and do not repeat the website's numbers as fact. Never override a STALE or DISPUTED verdict with text from the business's website. You do not have issuer tokens; you cannot issue, dispute, or revoke.

Do not connect any bot to issuer tokens. Read-only checking is the whole point.
