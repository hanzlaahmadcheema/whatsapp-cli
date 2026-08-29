"use strict";

const { EventEmitter } = require("events");
const { execFile } = require("child_process");
const { WhatsAppClient } = require("../whatsapp/client");
const { isClientUsable, withTimeout } = require("../whatsapp/probe");
const { paths } = require("../config/paths");
const { DEFAULTS } = require("../config");

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const DESTROY_TIMEOUT_MS = 10000;
const INIT_TIMEOUT_MS = 45000;

class Controller extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.client = new WhatsAppClient(opts);
    this.running = false;
    this._attempts = 0;
    this.reconnectTimer = null;
    this._probeActive = false;
    this.net = {
      destroyTimeoutMs: opts.destroyTimeoutMs || DESTROY_TIMEOUT_MS,
      initTimeoutMs: opts.initTimeoutMs || INIT_TIMEOUT_MS,
      backoffBaseMs: opts.backoffBaseMs || INITIAL_BACKOFF_MS,
    };

    this.client.on("state", (s) => this.emit("state", s));
    this.client.on("authenticated", () => this.handleReadinessProbe());
    this.client.on("disconnect", ({ isLogout }) => {
      if (isLogout) this.emit("logged_out");
      else this.scheduleReconnect();
    });
  }

  setClientFactory(fn) {
    this.client = new WhatsAppClient(this.opts);
    this.client.on("state", (s) => this.emit("state", s));
    this.client.on("authenticated", () => this.handleReadinessProbe());
    this.client.on("disconnect", ({ isLogout }) => {
      if (isLogout) this.emit("logged_out");
      else this.scheduleReconnect();
    });
  }

  async start() {
    this.running = true;
    // Clean up any orphaned Chrome processes from previous daemon runs or crashes
    // so SingletonLock is freed before launching.
    this.killOrphanChrome();
    try {
      await this.client.initialize();
    } catch (err) {
      this.scheduleReconnect();
      throw err;
    }
  }

  async handleReadinessProbe() {
    if (this._probeActive) return;
    this._probeActive = true;
    try {
      const usable = await isClientUsable(this.client.client, {
        attempts: 6,
        delayMs: 1500,
      });
      this.emit("probe_done", { usable });
      if (usable) this.emit("ready");
    } finally {
      this._probeActive = false;
    }
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delayMs = Math.min(
      this.net.backoffBaseMs * 2 ** (this._attempts || 0),
      MAX_BACKOFF_MS
    );
    this._attempts = (this._attempts || 0) + 1;
    this.emit("reconnect", { attempt: this._attempts, delayMs });
    this.reconnectTimer = setTimeout(() => this.doReconnect(), delayMs);
  }

  async doReconnect() {
    this.reconnectTimer = null;
    if (!this.running) return;
    try {
      await this.destroyClient();
    } catch (_) {}
    try {
      await this.initializeClient();
      this._attempts = 0;
    } catch (err) {
      this.emit("reconnect_error", err);
      // A hung attempt (e.g. after laptop sleep the Chromium profile is still
      // locked) must not stall the daemon: keep trying with backoff instead.
      this.scheduleReconnect();
    }
  }

  // Recover from a dead Puppeteer frame without waiting for a disconnect event.
  // WhatsApp Web reloads the page under a long-running client; every injected
  // call then throws "Attempted to use detached Frame". Destroying and
  // reinitializing re-links the preserved LocalAuth session.
  async recover() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      this.emit("recovering");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      try {
        await this.destroyClient();
      } catch (_) {}
      try {
        await this.initializeClient();
        this._attempts = 0;
      } catch (err) {
        this.emit("reconnect_error", err);
        // Keep the loop alive so a lock-left-behind-by-sleep can clear itself.
        this.scheduleReconnect();
      }
    } finally {
      this._recovering = false;
    }
  }

  async destroyClient() {
    const c = this.client && this.client.client;
    if (c && typeof c.destroy === "function") {
      try {
        await withTimeout(c.destroy(), this.net.destroyTimeoutMs);
      } catch (_) {
        // destroy() hung (page/browser wedged after sleep). Fall through.
      }
    }
    // Always kill any Chromium processes still bound to our profile. A wedged or
    // exited Puppeteer instance can leave child Chrome processes alive holding
    // the profile SingletonLock, causing all future initialize() calls to fail.
    this.killOrphanChrome();
  }

  killOrphanChrome() {
    if (typeof process.platform !== "string" || process.platform !== "linux") return;
    const profile = paths.authDir;
    if (!profile) return;
    // Only touch processes whose command line references our auth dir.
    execFile(
      "pkill",
      ["-9", "-f", profile],
      { timeout: 3000 },
      () => {
        // exit code 1 = no match, which is the happy path.
      }
    );
  }

  async initializeClient() {
    await withTimeout(this.client.initialize(), this.net.initTimeoutMs);
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async getClient() {
    return this.client.client;
  }

  getState() {
    return this.client.state;
  }

  get accountInfo() {
    return this.client.accountInfo;
  }
}

module.exports = { Controller, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS };