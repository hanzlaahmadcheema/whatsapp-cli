"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const dns = require("dns").promises;

/**
 * Check if the network and DNS are reachable before attempting reconnection.
 *
 * @param {object} [opts]
 * @param {string} [opts.host] - Hostname to resolve (default: web.whatsapp.com)
 * @param {number} [opts.timeoutMs] - Maximum total wait time (default: 30000ms)
 * @param {number} [opts.intervalMs] - Initial retry delay (default: 1500ms)
 * @param {Function} [opts.dnsLookupFn] - Injectable dns lookup function
 * @returns {Promise<boolean>}
 */
async function checkNetworkReady(opts = {}) {
  const host = opts.host || "web.whatsapp.com";
  const timeoutMs = opts.timeoutMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 1500;
  const lookup = opts.dnsLookupFn || ((h) => dns.lookup(h));

  const deadline = Date.now() + timeoutMs;
  let delay = intervalMs;

  while (Date.now() < deadline) {
    try {
      const res = await lookup(host);
      if (res && (res.address || typeof res === "string")) {
        return true;
      }
    } catch (_) {
      // Network/DNS not yet available; wait and retry
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 1.5, 5000);
  }
  return false;
}

class SleepNotifier extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.child = null;
    this.running = false;
    this._respawnTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;

    if (this.opts.disabled || process.platform !== "linux") {
      return;
    }

    this._spawnMonitor();
  }

  _spawnMonitor() {
    if (!this.running) return;

    try {
      // Monitor login1 PrepareForSleep signal on system bus
      const monitor = spawn(
        "gdbus",
        ["monitor", "--system", "-d", "org.freedesktop.login1", "-o", "/org/freedesktop/login1"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      if (typeof monitor.unref === "function") {
        monitor.unref();
      }

      this.child = monitor;

      let buffer = "";
      monitor.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          this._handleLine(line);
        }
      });

      monitor.on("error", () => {
        this._scheduleRespawn();
      });

      monitor.on("exit", () => {
        this.child = null;
        this._scheduleRespawn();
      });
    } catch (_) {
      this._scheduleRespawn();
    }
  }

  _handleLine(line) {
    if (!line.includes("PrepareForSleep")) return;

    // Pattern: PrepareForSleep (true,) or PrepareForSleep (false,)
    if (/PrepareForSleep\s*\(\s*true\b/i.test(line)) {
      this.emit("suspend", { timestamp: Date.now() });
    } else if (/PrepareForSleep\s*\(\s*false\b/i.test(line)) {
      this.emit("resume", { timestamp: Date.now() });
    }
  }

  _scheduleRespawn() {
    if (!this.running || this._respawnTimer) return;
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (this.running) {
        this._spawnMonitor();
      }
    }, 5000);
  }

  stop() {
    this.running = false;
    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer);
      this._respawnTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch (_) {}
      this.child = null;
    }
  }

  simulateSuspend() {
    this.emit("suspend", { timestamp: Date.now(), simulated: true });
  }

  simulateResume() {
    this.emit("resume", { timestamp: Date.now(), simulated: true });
  }
}

module.exports = { SleepNotifier, checkNetworkReady };
