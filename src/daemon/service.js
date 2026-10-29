"use strict";

const { EventEmitter } = require("events");
const { Controller } = require("./controller");
const { fetchAccountInfo, withTimeout } = require("../whatsapp/probe");
const { STATE } = require("../ipc/protocol");
const { ok, fail } = require("../ipc/protocol");
const stateStore = require("../store/state");

function messageSummary(m) {
  return {
    id: m.id && m.id._serialized,
    from: m.from,
    to: m.to,
    author: m.author || null,
    body: m.body || "",
    timestamp: m.timestamp,
    ack: typeof m.ack === "number" ? m.ack : null,
    hasMedia: !!m.hasMedia,
    type: m.type || null,
    isForwarded: !!m.isForwarded,
  };
}

class WhatsAppService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.controller = new Controller(opts);
    this.state = STATE.UNLINKED;
    this.lastError = null;
    this.account = null;
    this._subscribers = new Set();
    this._heartbeatTimer = setInterval(() => this._checkHeartbeat(), 30000);

    this.controller.on("state", (s) => {
      this.state = s;
      this.broadcast({ event: "state", state: s });
    });
    this.controller.on("logged_out", () => {
      this.state = STATE.LOGGED_OUT;
      this.lastError = "Session logged out. Run `wa login` to re-link.";
      this.broadcast({ event: "logged_out" });
      stateStore.update({ state: STATE.LOGGED_OUT });
    });
    this.controller.on("probe_done", ({ usable }) => {
      if (!usable && this.state !== STATE.READY) {
        this.state = STATE.CONNECTING;
        this.lastError = "Authenticated but not ready yet";
        this.broadcast({ event: "probe_done", usable });
      }
    });
    this.controller.on("ready", () => {
      this.lastError = null;
      this.refreshAccountInfo();
    });
    this.controller.on("recovering", () => {
      this.state = STATE.CONNECTING;
      this.lastError = "WhatsApp page reloaded — reconnecting…";
      this.broadcast({ event: "state", state: STATE.CONNECTING, reason: "reconnecting" });
    });
    // Forward raw client-level events the CLI cares about (QR, auth, message)
    // over SSE. The sub-controller also emits "state" so only wire one path.
    const client = this.controller.client;
    client.on("qr", (qr) => {
      this.broadcast({ event: "qr", qr });
    });
    client.on("ready", () => {
      this.lastError = null;
      this.refreshAccountInfo();
    });
    client.on("auth_failure", (err) => {
      this.lastError = String((err && err.message) || err);
      this.broadcast({ event: "auth_failure", message: this.lastError });
    });
    client.on("message", (msg) => {
      this.broadcast({
        event: "message",
        from: msg.from,
        body: msg.body,
        timestamp: msg.timestamp,
      });
    });
  }

  async start() {
    this.controller.start().catch((err) => {
      this.lastError = String(err && err.message ? err.message : err);
      this.state = STATE.ERROR;
      this.broadcast({ event: "error", message: this.lastError });
    });
  }

  async refreshAccountInfo() {
    try {
      const info = await fetchAccountInfo(this.client);
      if (info) {
        this.account = info;
        stateStore.update({ account: info, linkedAt: Date.now() });
      }
    } catch (err) {
      this.lastError = "Account info fetch failed: " + String((err && err.message) || err);
    }
    return this.account;
  }

  get client() {
    return this.controller.client.client;
  }

  // ---- frame-liveness ----

  // The Puppeteer page frame can silently detach (WhatsApp reloads the page
  // under a long-running client). Every injected call then throws
  // "Attempted to use detached Frame". Detect it, restart the client, and
  // surface a friendly reason instead of a raw "r: r".
  isFrameError(err) {
    const msg = String((err && err.message) || err);
    return /detached\s+frame|already\s+disposed|execut.*?destroyed|target.*?closed|node\s+is\s+no\s+longer\s+attached/i.test(
      msg,
    );
  }

  async _checkHeartbeat() {
    if (this.state === STATE.ERROR) {
      await this.recoverFromFrameFailure("heartbeat_error_recovery");
      return;
    }
    if (this.state !== STATE.READY || !this.client || typeof this.client.getState !== "function") return;
    try {
      await this.withClient("heartbeat", () => this.client.getState());
    } catch (err) {
      // withClient intercepts timeouts and triggers recoverFromFrameFailure automatically.
    }
  }

  async recoverFromFrameFailure(action) {
    this.state = STATE.CONNECTING;
    this.broadcast({ event: "state", state: STATE.CONNECTING, reason: "reconnecting" });
    this.lastError = `${action} failed because the WhatsApp page reloaded. Reconnecting own session…`;
    this.recoverPromise =
      this.recoverPromise ||
      this.controller.recover().then(
        () => {
          this.recoverPromise = null;
          this.refreshAccountInfo();
        },
        (err) => {
          this.recoverPromise = null;
          this.lastError = "Reconnect failed: " + String((err && err.message) || err);
        },
      );
    return this.recoverPromise;
  }

  async withClient(action, fn) {
    try {
      return await withTimeout(fn(), 25000);
    } catch (err) {
      if (this.isFrameError(err)) {
        await this.recoverFromFrameFailure(action);
        return null;
      }
      throw err;
    }
  }

  // ---- actions ----

  async send({ to, body, ttl = 60000 }) {
    if (this.state !== STATE.READY) return fail("NOT_READY", "wa daemon is not ready yet. Wait for sync or run `wa status`.");
    const client = this.client;
    if (!client || typeof client.sendMessage !== "function") {
      return fail("NO_CLIENT", "Daemon has no active client (" + this.state + ").");
    }
    try {
      const msg = await this.withClient("send", () => client.sendMessage(to, body));
      if (!msg) return fail("NOT_READY", "WhatsApp page reloaded — reconnecting. Run `wa status` to monitor.");
      return ok({ to, body, messageId: msg.id._serialized, timestamp: Date.now() });
    } catch (err) {
      return fail("SEND_FAILED", String(err && err.message ? err.message : err));
    }
  }

  async sendMedia({ to, media, options = {} }) {
    if (this.state !== STATE.READY) return fail("NOT_READY", "wa daemon is not ready yet. Wait for sync or run `wa status`.");
    const client = this.client;
    if (!client || typeof client.sendMessage !== "function") {
      return fail("NO_CLIENT", "Daemon has no active client (" + this.state + ").");
    }
    try {
      const msg = await this.withClient("sendMedia", () => client.sendMessage(to, media, options));
      if (!msg) return fail("NOT_READY", "WhatsApp page reloaded — reconnecting. Run `wa status` to monitor.");
      const messageId = (msg.id && (msg.id._serialized || msg.id)) || "(unknown)";
      return ok({
        to,
        messageId,
        timestamp: Date.now(),
        filename: media && media.filename ? media.filename : null,
        mimetype: media && media.mimetype ? media.mimetype : null,
      });
    } catch (err) {
      return fail("SEND_MEDIA_FAILED", String(err && err.message ? err.message : err));
    }
  }

  async getChats({ limit = 50 } = {}) {
    if (this.state === STATE.READY && this.client?.getChats) {
      try {
        const chatsRaw = await this.withClient("getChats", () => this.client.getChats());
        if (!Array.isArray(chatsRaw)) return [];
        return chatsRaw.slice(0, limit).map((c) => ({
          id: c.id?._serialized || c.id || "",
          name: c.name || c.formattedTitle || "",
          isGroup: !!c.isGroup,
          timestamp: c.timestamp || null,
          unreadCount: c.unreadCount || 0,
          archived: !!c.archived,
          pinned: !!c.pinned,
          isMuted: !!c.isMuted,
          lastMessage: c.lastMessage ? messageSummary(c.lastMessage) : null,
        }));
      } catch (err) {
        if (this.isFrameError(err)) {
          this.lastError = "getChats failed: WhatsApp page reloaded — reconnecting";
          await this.recoverFromFrameFailure("getChats");
          return [];
        }
        this.lastError = "getChats failed: " + String(err);
      }
    }
    return [];
  }

  async getContacts({ name } = {}) {
    if (this.state === STATE.READY && this.client?.getContacts) {
      try {
        const contacts = await this.withClient("getContacts", () => this.client.getContacts());
        if (!contacts) return [];
        const all = contacts.map((c) => ({
          id: c.id._serialized,
          name: c.name || c.pushname || "",
          number: c.number || "",
        }));
        if (!name) return all;
        const q = name.toLowerCase();
        return all.filter((c) => (c.name.toLowerCase().includes(q)));
      } catch (err) {
        if (this.isFrameError(err)) {
          this.lastError = "getContacts failed: WhatsApp page reloaded — reconnecting";
          await this.recoverFromFrameFailure("getContacts");
        }
        return [];
      }
    }
    return [];
  }

  async getHistory({ chatId, limit = 50 }) {
    if (this.state !== STATE.READY || !this.client) return [];
    try {
      const chat = await this.withClient("getHistory", () => this.client.getChatById(chatId));
      if (!chat || typeof chat.fetchMessages !== "function") return [];
      const messages = await chat.fetchMessages({ limit });
      return messages.map((m) => messageSummary(m));
    } catch (err) {
      if (this.isFrameError(err)) {
        this.lastError = "getHistory failed: WhatsApp page reloaded — reconnecting";
        await this.recoverFromFrameFailure("getHistory");
      }
      return [];
    }
  }

  async markSeen({ chatId }) {
    if (this.state !== STATE.READY) return fail("NOT_READY", "wa daemon is not ready yet.");
    const client = this.client;
    if (!client || typeof client.sendSeen !== "function") {
      return fail("NO_CLIENT", "Daemon has no active client (" + this.state + ").");
    }
    try {
      await this.withClient("markSeen", () => client.sendSeen(chatId));
      return ok({ chatId });
    } catch (err) {
      return fail("MARK_SEEN_FAILED", String(err && err.message ? err.message : err));
    }
  }

  async setArchived({ chatId, archived }) {
    if (this.state !== STATE.READY) return fail("NOT_READY", "wa daemon is not ready yet.");
    const client = this.client;
    const fn = archived ? client?.archiveChat : client?.unarchiveChat;
    if (!client || typeof fn !== "function") {
      return fail("NO_CLIENT", "Daemon has no active client (" + this.state + ").");
    }
    try {
      await this.withClient("archive", () => fn.call(client, chatId));
      return ok({ chatId, archived });
    } catch (err) {
      return fail("ARCHIVE_FAILED", String(err && err.message ? err.message : err));
    }
  }

  subscribe(cb) {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  broadcast(event) {
    for (const cb of this._subscribers.values()) {
      try {
        cb(event);
      } catch (_) {}
    }
  }

  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this.controller && typeof this.controller.stop === "function") {
      this.controller.stop();
    }
  }
}

module.exports = { WhatsAppService };