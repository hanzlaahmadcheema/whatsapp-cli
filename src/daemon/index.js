"use strict";

const path = require("path");
const { paths } = require("../config/paths");
const { WhatsAppService } = require("./service");
const { DaemonServer } = require("./server");
const daemonStore = require("../store/daemon");
const { DEFAULTS } = require("../config");

function parseArgs(argv) {
  const idx = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    detach: argv.includes("--detach"),
    foreground: argv.includes("--foreground"),
    host: idx("--host") || DEFAULTS.host,
    port: parseInt(idx("--port") || "0", 10),
    readyTimeout: parseInt(idx("--ready-timeout") || String(DEFAULTS.readyTimeoutMs), 10),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.detach) {
    spawnDetached();
    return;
  }

  const existing = daemonStore.read();
  if (existing && existing.pid && existing.pid !== process.pid) {
    let alive = false;
    try {
      process.kill(existing.pid, 0);
      alive = true;
    } catch (_) {}
    if (alive) {
      console.log(`wa daemon is already running on http://${existing.host || "127.0.0.1"}:${existing.port} (pid ${existing.pid})`);
      return;
    }
  }

  const { loadSettings } = require("../config/settings");
  const settings = loadSettings();

  const service = new WhatsAppService({
    autoReconnectOnResume: settings.autoReconnectOnResume,
    maxRecoveryAttempts: settings.maxRecoveryAttempts,
    networkTimeoutMs: settings.networkTimeoutMs,
    backoffBaseMs: settings.retryBackoffBaseMs,
  });
  const server = new DaemonServer({ service, host: args.host, port: args.port });

  service.on("ready", () => {
    console.log("✓ WhatsApp daemon ready.");
  });
  service.on("state", (s) => {
    if (args.foreground) console.log(`[daemon] state -> ${s}`);
  });

  await server.start();
  daemonStore.write({
    pid: process.pid,
    host: args.host,
    port: server.port,
    token: server.token,
    startedAt: new Date().toISOString(),
  });

  console.log(`wa daemon listening on http://${args.host}:${server.port} (pid ${process.pid})`);

  service.start();

  const shutdown = () => {
    service.stop();
    server.stop();
    daemonStore.remove();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function spawnDetached() {
  const { spawn } = require("child_process");
  const daemonIndex = path.join(paths.root, "src", "daemon", "index.js");
  const child = spawn(process.execPath, [daemonIndex], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  console.log("spawned wa daemon (detached) pid=" + child.pid);
}

module.exports = { main, parseArgs, spawnDetached };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}