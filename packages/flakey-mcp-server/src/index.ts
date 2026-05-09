#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createApi } from "./api.js";
import { registerTools } from "./tools.js";

const API_URL = process.env.FLAKEY_API_URL ?? "http://localhost:3000";
const API_KEY = process.env.FLAKEY_API_KEY ?? "";

/**
 * Mutations (tools that change server state) are gated behind an explicit
 * env opt-in. The convention is "read-only by default"; this flag enforces it.
 * Accepts "1", "true", "yes" (case-insensitive).
 */
const ALLOW_MUTATIONS = /^(1|true|yes)$/i.test(process.env.FLAKEY_MCP_ALLOW_MUTATIONS ?? "");

async function main() {
  if (!API_KEY) {
    console.error("FLAKEY_API_KEY environment variable is required.");
    console.error("Create an API key in Flakey Settings > API Keys.");
    process.exit(1);
  }

  const server = new McpServer({
    name: "flakey",
    version: "0.4.0",
  });

  registerTools(server, {
    api: createApi(API_URL, API_KEY),
    allowMutations: ALLOW_MUTATIONS,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
