#!/usr/bin/env node
/**
 * veritas-mcp — stdio MCP server entry point (T8).
 *
 *   VERITAS_DATA_DIR=/var/lib/veritas node dist/src/bin.js
 *   VERITAS_PUBLIC_BASE_URL=https://verify.veritas.example node dist/src/bin.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { loadEnv } from "./env.js";

const dataDir =
  process.env.VERITAS_DATA_DIR ??
  process.argv.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length) ??
  "./veritas-data";

const env = await loadEnv(dataDir, {
  publicBaseUrl: process.env.VERITAS_PUBLIC_BASE_URL,
});
const server = createMcpServer(env);
await server.connect(new StdioServerTransport());
