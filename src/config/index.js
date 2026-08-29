"use strict";

const fs = require("fs");
const path = require("path");
const { paths } = require("./paths");

const DEFAULTS = Object.freeze({
  sessionName: "session",
  host: "127.0.0.1",
  port: 0,
  healthTimeoutMs: 1000,
  readyTimeoutMs: 120000,
  reconnectBaseMs: 2000,
  reconnectMaxMs: 30000,
  chatsLimit: 50,
  historyLimit: 50,
  sendAckTimeoutMs: 60000,
});

const PINNED_WHATSWEBJS_VERSION = "1.34.7";

const WEB_VERSION_PIN = Object.freeze({
  version: "2.3000.1037753511-alpha",
  source: "https://github.com/wppconnect-team/wa-version/raw/main/html/:version.html",
  versionsApi: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json",
});

function buildPuppeteerConfig() {
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
}

// Resolve which web build to serve. Preference:
//   1. An explicitly requested version that exists in the local cache.
//   2. The newest *.html build already sitting in .wwebjs_cache (the machine's
//      proven-working build; survives pruned pin versions upstream).
//   3. The pinned version (fetch script populates it).
function resolveWebVersion(cacheDir = paths.cacheDir, requested) {
  if (requested && fs.existsSync(path.join(cacheDir, `${requested}.html`))) {
    return requested;
  }
  const builds = listCachedBuilds(cacheDir);
  if (builds.length > 0) return builds[builds.length - 1];
  return requested || WEB_VERSION_PIN.version;
}

function listCachedBuilds(cacheDir = paths.cacheDir) {
  let names = [];
  try {
    names = fs.readdirSync(cacheDir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".html"))
    .map((n) => n.slice(0, -".html".length))
    .sort();
}

function buildClientOptions(overrides = {}) {
  const cacheDir = overrides.cacheDir || paths.cacheDir;
  const sessionName = overrides.sessionName || DEFAULTS.sessionName;
  const webVersion = resolveWebVersion(cacheDir, overrides.webVersion);

  return {
    authStrategy: buildAuthStrategy(overrides.authDir || paths.authDir, sessionName),
    puppeteer: buildPuppeteerConfig(),
    webVersion,
    webVersionCache: { type: "local", path: cacheDir },
    authTimeoutMs: overrides.authTimeoutMs || 90000,
  };
}

function buildAuthStrategy(authDir, sessionName) {
  const { LocalAuth } = require("whatsapp-web.js");
  // Breaking default: the original script used `new LocalAuth()` which stores
  // under .wwebjs_auth/session. Passing clientId would create session-<id> and
  // lose the preserved profile. Only set clientId when a custom name is asked.
  const opts = { dataPath: authDir, rmMaxRetries: 2 };
  if (sessionName && sessionName !== DEFAULTS.sessionName) {
    opts.clientId = sessionName;
  }
  return new LocalAuth(opts);
}

function resolveClientVersion() {
  let installed = null;
  try {
    installed = require(path.join("whatsapp-web.js", "package.json")).version;
  } catch (_) {}
  return {
    pinned: PINNED_WHATSWEBJS_VERSION,
    installed,
    match: installed === PINNED_WHATSWEBJS_VERSION,
  };
}

module.exports = {
  DEFAULTS,
  WEB_VERSION_PIN,
  PINNED_WHATSWEBJS_VERSION,
  buildClientOptions,
  buildAuthStrategy,
  resolveClientVersion,
  resolveWebVersion,
  listCachedBuilds,
};