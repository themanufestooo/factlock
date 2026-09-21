/** FactLock MCP server — TypeScript (T8). */
export { createMcpServer } from "./server.js";
export { loadEnv } from "./env.js";
export { IndexedAttestationStore } from "./indexedStore.js";
export { handleFactLockCheck, TOOL_NAME, TOOL_DESCRIPTION } from "./tool.js";
export type {
  BusinessIndex,
  FactLockEnv,
  FactLockCheckArgs,
  FactLockCheckResult,
} from "./tool.js";
