/**
 * MCP server (T8) — exposes veritas_check over the Model Context Protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  handleVeritasCheck,
  type VeritasEnv,
} from "./tool.js";

const InputSchema = {
  attestation_id: z
    .string()
    .optional()
    .describe("Veritas attestation id (e.g. vat_01J...). Provide this OR business_id."),
  business_id: z
    .string()
    .optional()
    .describe("Business id (e.g. biz_rapido). Uses the business's latest attestation."),
  claim_type: z
    .enum(["price", "hours", "license", "availability"])
    .optional()
    .describe("Require the attestation to cover this claim type."),
};

export function createMcpServer(env: VeritasEnv): McpServer {
  const server = new McpServer(
    { name: "veritas", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    TOOL_NAME,
    {
      title: "Veritas business-truth check",
      description: TOOL_DESCRIPTION,
      inputSchema: InputSchema,
    },
    async (args) => {
      const result = await handleVeritasCheck(args, env);
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
