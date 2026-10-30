"use strict";

const { EventEmitter } = require("events");
const { execFile, execFileSync } = require("child_process");
const { WhatsAppClient } = require("../whatsapp/client");
const { isClientUsable, withTimeout } = require("../whatsapp/probe");
const { paths } = require("../config/paths");
const { DEFAULTS } = require("../config");
const { STATE } = require("../ipc/protocol");

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
    this._probePromise = null;
    this._recoveringPromise = null;
    this._suspended = false;
    this.maxRecoveryAttempts = opts.maxRecoveryAttempts || 5;
    this.state = STATE.CONNECTING;
    this.net = {
      destroyTimeoutMs: opts.destroyTimeoutMs || DESTROY_TIMEOUT_MS,
      initTimeoutMs: opts.initTimeoutMs || INIT_TIMEOUT_MS,
      backoffBaseMs: opts.backoffBaseMs || INITIAL_BACKOFF_MS,
    };

    this._wireClient(this.client);
  }

  _wireClient(client) {
    client.on("state", (s) => {
      if (s === STATE.READY) {
        // WhatsApp Web reported ready, but probe first to verify operability
        // before advertising READY to the daemon and clients.
        this.handleReadinessProbe();
        return;
      }
      this.state = s;
      this.emit("state", s);
    });
    client.on("authenticated", () => this.handleReadinessProbe());
    client.on("disconnect", ({ isLogout }) => {
      if (isLogout) this.emit("logged_out");
      else this.scheduleReconnect();
    });
  }

  setClientFactory(fn) {
    this.client = new WhatsAppClient(this.opts);
    this._wireClient(this.client);
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
    if (this._probePromise) return this._probePromise;
    this._probePromise = (async () => {
      try {
        const usable = await isClientUsable(this.client.client, {
          attempts: this.opts.probeAttempts || 6,
          delayMs: this.opts.probeDelayMs !== undefined ? this.opts.probeDelayMs : 1500,
        });
        this.emit("probe_done", { usable });
        if (usable) {
          this.state = STATE.READY;
          this.emit("state", STATE.READY);
          this.emit("ready");
        } else {
          if (this.state === STATE.READY) {
            this.state = STATE.CONNECTING;
            this.emit("state", STATE.CONNECTING);
          }
        }
        return usable;
      } finally {
        this._probePromise = null;
      }
    })();
    return this._probePromise;
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer || this._suspended) return;
    if (this._attempts >= this.maxRecoveryAttempts) {
      this.state = STATE.ERROR;
      this.emit("state", STATE.ERROR);
      this.emit("recovery_failed", {
        attempts: this._attempts,
        error: "Maximum reconnect attempts reached",
      });
      return;
    }
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
    if (!this.running || this._suspended) return;
    try {
      await this.destroyClient();
    } catch (_) {}
    try {
      await this.initializeClient();
      const usable = await this.handleReadinessProbe();
      if (usable) {
        this._attempts = 0;
      } else {
        this.scheduleReconnect();
      }
    } catch (err) {
      this.emit("reconnect_error", err);
      // A hung attempt (e.g. after laptop sleep the Chromium profile is still
      // locked) must not stall the daemon: keep trying with backoff instead.
      this.scheduleReconnect();
    }
  }

  suspend() {
    this._suspended = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = STATE.CONNECTING;
    this.emit("state", STATE.CONNECTING);
    this.emit("suspended");
  }

  async resume(opts = {}) {
    this._suspended = false;
    this.emit("resumed");
    const autoReconnect = opts.autoReconnect !== false;
    if (!autoReconnect) return;

    const { checkNetworkReady } = require("./sleep");
    const networkReady = await checkNetworkReady({
      timeoutMs: opts.networkTimeoutMs ?? 30000,
      intervalMs: 1500,
      dnsLookupFn: opts.dnsLookupFn,
    });

    if (!networkReady) {
      this.state = STATE.ERROR;
      this.emit("state", STATE.ERROR);
      const err = new Error("Network not available after system resume");
      this.emit("reconnect_error", err);
      this.emit("recovery_failed", { attempts: 0, error: err.message });
      throw err;
    }

    return await this.recover();
  }

  // Recover from a dead Puppeteer frame without waiting for a disconnect event.
  // WhatsApp Web reloads the page under a long-running client; every injected
  // call then throws "Attempted to use detached Frame". Destroying and
  // reinitializing re-links the preserved LocalAuth session.
  async recover() {
    if (this._recoveringPromise) return this._recoveringPromise;
    this._recoveringPromise = (async () => {
      this.emit("recovering");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.state = STATE.CONNECTING;
      this.emit("state", STATE.CONNECTING);

      let lastErr = null;
      const maxAttempts = this.maxRecoveryAttempts;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this._suspended) {
          throw new Error("Recovery interrupted: system suspended");
        }
        try {
          try {
            await this.destroyClient();
          } catch (_) {}

          await this.initializeClient();

          // After initialization, probe operability before considering recovery successful
          const usable = await this.handleReadinessProbe();
          if (usable) {
            this._attempts = 0;
            this.emit("recovery_success", { attempt });
            return true;
          }
          throw new Error("Readiness probe failed after client initialization");
        } catch (err) {
          lastErr = err;
          this.emit("reconnect_error", err);
          if (attempt < maxAttempts && !this._suspended) {
            const delayMs = Math.min(
              this.net.backoffBaseMs * 2 ** (attempt - 1),
              MAX_BACKOFF_MS
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      this.state = STATE.ERROR;
      this.emit("state", STATE.ERROR);
      this.emit("recovery_failed", {
        attempts: maxAttempts,
        error: lastErr ? lastErr.message : "Recovery attempts exhausted",
      });
      throw lastErr || new Error("Recovery failed after max attempts");
    })();

    try {
      return await this._recoveringPromise;
    } finally {
      this._recoveringPromise = null;
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
    // Synchronously terminate any orphaned Chrome processes bound to our profile
    // before initializing so they cannot race with launching a fresh browser.
    try {
      execFileSync("pkill", ["-9", "-f", profile], { timeout: 3000, stdio: "ignore" });
    } catch (_) {
      // Exit code 1 means no matching processes found, which is the happy path.
    }
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
    return this.state || this.client.state;
  }

  get accountInfo() {
    return this.client.accountInfo;
  }
}

module.exports = { Controller, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS };