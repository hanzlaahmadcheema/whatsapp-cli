"use strict";

const COMMANDS = new Set([
  "login",
  "status",
  "send",
  "chats",
  "contacts",
  "history",
  "receive",
  "logout",
  "daemon",
  "tui",
  "mcp",
]);

function parseArgs(argv) {
  const result = {
    command: null,
    positional: [],
    flags: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!result.command && COMMANDS.has(arg)) {
      result.command = arg;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        result.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          result.flags[key] = next;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

module.exports = { parseArgs, COMMANDS };