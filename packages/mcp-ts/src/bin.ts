#!/usr/bin/env node
/**
 * factlock-mcp — stdio MCP server entry point (T8).
 *
 *   FACTLOCK_DATA_DIR=/var/lib/factlock node dist/src/bin.js
 *   FACTLOCK_PUBLIC_BASE_URL=https://verify.factlock.example node dist/src/bin.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { loadEnv } from "./env.js";

const dataDir =
  process.env.FACTLOCK_DATA_DIR ??
  process.argv.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length) ??
  "./factlock-data";

const env = await loadEnv(dataDir, {
  publicBaseUrl: process.env.FACTLOCK_PUBLIC_BASE_URL,
});
const server = createMcpServer(env);
await server.connect(new StdioServerTransport());
