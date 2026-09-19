/** Veritas MCP server — TypeScript (T8). */
export { createMcpServer } from "./server.js";
export { loadEnv } from "./env.js";
export { IndexedAttestationStore } from "./indexedStore.js";
export { handleVeritasCheck, TOOL_NAME, TOOL_DESCRIPTION } from "./tool.js";
export type {
  BusinessIndex,
  VeritasEnv,
  VeritasCheckArgs,
  VeritasCheckResult,
} from "./tool.js";
