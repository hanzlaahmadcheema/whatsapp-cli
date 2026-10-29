"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { paths } = require("../../config/paths");
const { readJson } = require("../../store/json");
const { TOKEN_HEADER } = require("../../ipc/token");

const DEFAULTS = {
  healthTimeoutMs: 1500,
  requestTimeoutMs: 60000,
  spawnWaitMs: 15000,
  pollIntervalMs: 500,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDaemonFile() {
  return readJson(paths.daemonFile, null);
}

function daemonUrl() {
  const d = readDaemonFile();
  if (!d || !d.host || !d.port) return null;
  return `http://${d.host}:${d.port}`;
}

function request(baseUrl, token, method, pathname, body, opts = {}) {
  return new Promise((resolve, reject) => {
    let targetPath = pathname;
    if (opts.query && Object.keys(opts.query).length) {
      targetPath += (pathname.includes("?") ? "&" : "?") + new URLSearchParams(opts.query).toString();
    }
    const target = new URL(targetPath, baseUrl);
    const req = http.request(
      target,
      {
        method,
        headers: {
          [TOKEN_HEADER]: token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        timeout: opts.timeout || DEFAULTS.requestTimeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data || "{}");
          } catch (_) {
            parsed = { ok: false, error: { code: "BAD_RESPONSE", message: data } };
          }
          resolve(parsed);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function health(baseUrl, token, timeoutMs = DEFAULTS.healthTimeoutMs) {
  return request(baseUrl, token, "GET", "/health", null, { timeout: timeoutMs }).then(
    (r) => ({ ok: true, payload: r }),
    (err) => ({ ok: false, error: err })
  );
}

function findByPort() {
  return null;
}

async function ensureDaemon(opts = {}) {
  const d = readDaemonFile();
  if (d && d.host && d.port && d.token) {
    const base = `http://${d.host}:${d.port}`;
    let pidAlive = false;
    if (d.pid) {
      try {
        process.kill(d.pid, 0);
        pidAlive = true;
      } catch (_) {
        pidAlive = false;
      }
    }
    if (pidAlive) {
      const h = await health(base, d.token, opts.healthTimeoutMs || 3000);
      if (h.ok) return { base, token: d.token, started: false };
      // Process is alive but first health check timed out. Give it another chance with a longer timeout
      // in case Node is temporarily busy with heavy serialization.
      const h2 = await health(base, d.token, 4000);
      if (h2.ok) return { base, token: d.token, started: false };
      // Daemon process is alive but unresponsive after multiple attempts.
      // Terminate the unresponsive process before spawning a replacement to prevent duplicate daemons.
      try {
        process.kill(d.pid, "SIGTERM");
        await sleep(1000);
        try { process.kill(d.pid, "SIGKILL"); } catch (_) {}
      } catch (_) {}
      removeDaemonFile();
    } else {
      removeDaemonFile();
    }
  }
  return spawnDaemon(opts);
}

function removeDaemonFile() {
  try {
    const fs = require("fs");
    fs.unlinkSync(paths.daemonFile);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      // not fatal; spawnDaemon will still try
    }
  }
}

async function spawnDaemon(_opts = {}) {
  const { execFile } = require("child_process");
  const daemonIndex = path.join(paths.root, "src", "daemon", "index.js");
  const child = spawn(process.execPath, [daemonIndex], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + DEFAULTS.spawnWaitMs;
  while (Date.now() < deadline) {
    const d = readDaemonFile();
    if (d && d.host && d.port && d.token) {
      return { base: `http://${d.host}:${d.port}`, token: d.token, started: true };
    }
    await sleep(250);
  }
  throw new Error("timed out waiting for wa daemon");
}

function commandSend(base, token, body) {
  return request(base, token, "POST", "/send", body);
}

function commandGet(base, token, route, params) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(base, token, "GET", route + (qs ? "?" + qs : ""), null);
}

module.exports = { daemonUrl, ensureDaemon, request, commandGet, commandSend };