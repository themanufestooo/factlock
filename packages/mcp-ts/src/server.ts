/**
 * MCP server (T8) — exposes factlock_check over the Model Context Protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  handleFactLockCheck,
  type FactLockEnv,
} from "./tool.js";

const InputSchema = {
  attestation_id: z
    .string()
    .optional()
    .describe("FactLock attestation id (e.g. fla_01J...). Provide this OR business_id."),
  business_id: z
    .string()
    .optional()
    .describe("Business id (e.g. biz_rapido). Uses the business's latest attestation."),
  claim_type: z
    .enum(["price", "hours", "license", "availability"])
    .optional()
    .describe("Require the attestation to cover this claim type."),
};

export function createMcpServer(env: FactLockEnv): McpServer {
  const server = new McpServer(
    { name: "factlock", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    TOOL_NAME,
    {
      title: "FactLock business-truth check",
      description: TOOL_DESCRIPTION,
      inputSchema: InputSchema,
    },
    async (args) => {
      const result = await handleFactLockCheck(args, env);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
  return server;
}
