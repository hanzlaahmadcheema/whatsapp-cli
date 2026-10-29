"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { WhatsAppMcpClient } = require("./client");
const { registerTools } = require("./tools");

function createMcpServer(opts = {}) {
  const pkg = require("../../package.json");
  const server = new McpServer({
    name: "whatsapp-cli",
    version: pkg.version || "1.0.0",
  });

  const client = opts.client || new WhatsAppMcpClient(opts);
  registerTools(server, client);

  return { server, client };
}

async function startMcpServer(opts = {}) {
  // CRITICAL: Ensure process.stdout is strictly reserved for MCP JSON-RPC protocol traffic.
  // Redirect standard console logging to stderr.
  console.log = (...args) => {
    process.stderr.write(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n"
    );
  };
  console.info = (...args) => {
    process.stderr.write(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n"
    );
  };

  const { server, client } = createMcpServer(opts);
  const transport = new StdioServerTransport();

  const cleanup = () => {
    try {
      client.destroy();
    } catch (_) {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await server.connect(transport);
  process.stderr.write("[whatsapp-mcp] WhatsApp MCP server running on stdio.\n");
  return { server, client, transport };
}

module.exports = { createMcpServer, startMcpServer };
