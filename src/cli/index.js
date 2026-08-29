"use strict";

const pc = require("picocolors");
const { parseArgs, COMMANDS } = require("./args");
const handlers = require("./commands");

const USAGE = `${pc.bold(pc.cyan("wa"))} ${pc.dim("— WhatsApp CLI")}

${pc.bold("Commands:")}
  ${pc.cyan("login")}                Link this device / show QR for first-time setup
  ${pc.cyan("status")}               Show current daemon and session state
  ${pc.cyan("send")} <to> <message>  Send a message to a contact or group
  ${pc.cyan("chats")}                List recent chats
  ${pc.cyan("contacts")}             List contacts
  ${pc.cyan("history")} <to>         Show message history for a chat
${pc.cyan("receive")}               Stream incoming messages (Ctrl-C to stop)
  ${pc.cyan("logout")}               Force logout / unlink the device
  ${pc.cyan("daemon")}               Show daemon state
  ${pc.cyan("tui")}                  Launch interactive TUI

${pc.dim("Options:")}
  ${pc.dim("--help / -h")}           Show this help
`;

async function run(argv) {
  const parsed = parseArgs(argv);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (!parsed.command || !COMMANDS.has(parsed.command)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const handler = handlers[parsed.command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${parsed.command}\n`);
    process.exit(2);
  }

  await handler(parsed);
}

module.exports = { run, USAGE };