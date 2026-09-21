/**
 * T8 tests: MCP protocol smoke test over InMemoryTransport —
 * tools/list advertises factlock_check, tools/call returns a verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SoftwareKeyStore } from "@factlock/keystore";
import { MerkleLog } from "@factlock/merkle-log";
import { issueAttestation, InMemoryAuthorizationStore, InMemoryEvidenceStore, digestClaims } from "@factlock/issuer";
import { InMemoryStatusRegistry } from "@factlock/verify-api";

import { createMcpServer } from "../src/server.js";
import { IndexedAttestationStore } from "../src/indexedStore.js";
import type { FactLockEnv } from "../src/tool.js";

const T0 = new Date("2026-09-19T12:00:00Z");

async function linkedPair(): Promise<{ client: Client; businessId: string }> {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("factlock", "factlock");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  // P0 (H-11): key records carry a real-time valid_from, but this harness
  // freezes issuance in the past — backdate the windows so the keys are
  // valid at the frozen verified_at.
  for (const rec of (keystore as unknown as { records: Array<{ valid_from: string }> }).records) {
    rec.valid_from = "2026-01-01T00:00:00Z";
  }

  const log = new MerkleLog();
  const request = {
      subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      evidence_refs: ["evidence_mcp_server"],
      authorization_id: "auth_1",
      business_key_id: bizRec.key_id,
  };
  const authorizations = new InMemoryAuthorizationStore();
  const evidence = new InMemoryEvidenceStore();
  authorizations.put({ authorization_id: "auth_1", business_id: "biz_rapido", principal: "owner_rapido", claim_digest: digestClaims(request.claims), method: "authenticated_session", authorized_at: "2026-09-19T11:59:00Z", authorized_by: "owner-on-file", expires_at: "2026-09-19T12:10:00Z" });
  evidence.put({ evidence_ref: "evidence_mcp_server", business_id: "biz_rapido", claim_types: ["price"], verified_at: "2026-09-19T11:58:00Z", expires_at: "2026-09-20T12:00:00Z", verification_method: "field_visit", verifier_id: "ver_007" });
  const att = await issueAttestation(request, { keystore, log, clock: () => new Date(T0), authorizations, evidence }, { principal: "owner_rapido" });
  const store = new IndexedAttestationStore();
  await store.put(att);
  const env: FactLockEnv = {
    store,
    index: store,
    deps: {
      keystore,
      log,
      statuses: new InMemoryStatusRegistry(),
      clock: () => new Date(T0),
    },
    publicBaseUrl: "https://verify.factlock.example",
  };

  const server = createMcpServer(env);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, businessId: "biz_rapido" };
}

test("tools/list advertises factlock_check", async () => {
  const { client } = await linkedPair();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("factlock_check"), `expected factlock_check in ${names}`);
  const tool = tools.find((t) => t.name === "factlock_check")!;
  assert.ok(tool.description!.includes("BEFORE"));
  assert.ok(tool.description!.includes("FRESH"));
  await client.close();
});

test("tools/call factlock_check returns a valid verdict", async () => {
  const { client, businessId } = await linkedPair();
  const res = await client.callTool({
    name: "factlock_check",
    arguments: { business_id: businessId },
  });
  const text = (res.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const verdict = JSON.parse(text);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.status, "ACTIVE");
  assert.ok(verdict.details_url.includes("/v1/verify/"));
  await client.close();
});
