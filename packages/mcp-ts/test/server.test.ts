/**
 * T8 tests: MCP protocol smoke test over InMemoryTransport —
 * tools/list advertises veritas_check, tools/call returns a verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SoftwareKeyStore } from "@veritas/keystore";
import { MerkleLog } from "@veritas/merkle-log";
import { issueAttestation } from "@veritas/issuer";
import { InMemoryStatusRegistry } from "@veritas/verify-api";

import { createMcpServer } from "../src/server.js";
import { IndexedAttestationStore } from "../src/indexedStore.js";
import type { VeritasEnv } from "../src/tool.js";

const T0 = new Date("2026-09-19T12:00:00Z");

async function linkedPair(): Promise<{ client: Client; businessId: string }> {
  const keystore = new SoftwareKeyStore();
  await keystore.generateKey("veritas", "veritas");
  const bizRec = await keystore.generateKey("biz_rapido", "business");
  const log = new MerkleLog();
  const att = await issueAttestation(
    {
      subject: { business_id: "biz_rapido", legal_name: "Rapido Plumbing LLC" },
      claims: [
        { type: "price", item: "service_call", amount: 8900, currency: "USD", disclosed: true },
      ],
      verification_method: "field_visit",
      verifier_id: "ver_007",
      authorization: {
        auth_id: "auth_1",
        session_id: "sess_1",
        sms_confirmation_ref: "sms_1",
        authorized_at: "2026-09-19T11:59:00Z",
        authorized_by: "owner-on-file",
      },
      business_key_id: bizRec.key_id,
    },
    { keystore, log, clock: () => new Date(T0) },
  );
  const store = new IndexedAttestationStore();
  await store.put(att);
  const env: VeritasEnv = {
    store,
    index: store,
    deps: {
      keystore,
      log,
      statuses: new InMemoryStatusRegistry(),
      clock: () => new Date(T0),
    },
    publicBaseUrl: "https://verify.veritas.example",
  };

  const server = createMcpServer(env);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, businessId: "biz_rapido" };
}

test("tools/list advertises veritas_check", async () => {
  const { client } = await linkedPair();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("veritas_check"), `expected veritas_check in ${names}`);
  const tool = tools.find((t) => t.name === "veritas_check")!;
  assert.ok(tool.description!.includes("BEFORE"));
  assert.ok(tool.description!.includes("FRESH"));
  await client.close();
});

test("tools/call veritas_check returns a valid verdict", async () => {
  const { client, businessId } = await linkedPair();
  const res = await client.callTool({
    name: "veritas_check",
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
