#!/usr/bin/env node
"use strict";

const { startMcpServer, createMcpServer } = require("./server");

if (require.main === module) {
  startMcpServer().catch((err) => {
    process.stderr.write(`[whatsapp-mcp] Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { startMcpServer, createMcpServer };
