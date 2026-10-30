"use strict";

const { EventEmitter } = require("events");
const { Controller } = require("./controller");
const { fetchAccountInfo, withTimeout } = require("../whatsapp/probe");
const { STATE } = require("../ipc/protocol");
const { ok, fail } = require("../ipc/protocol");
const stateStore = require("../store/state");
const { ContactCache, enrichMessageSummary, messageSummary } = require("../conversation");

class WhatsAppService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.controller = new Controller(opts);
    this.state = STATE.UNLINKED;
    this.lastError = null;
    this.account = null;
    this._contactCache = new ContactCache();
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
    this.controller.on("recovery_success", ({ attempt }) => {
      this.lastError = null;
      this.broadcast({ event: "recovery_success", attempt });
    });
    this.controller.on("recovery_failed", ({ attempts, error }) => {
      this.state = STATE.ERROR;
      this.lastError = `Recovery failed after ${attempts} attempts: ${error}`;
      this.broadcast({ event: "recovery_failed", attempts, error: this.lastError });
    });
    this.controller.on("recovering", () => {
      this.state = STATE.CONNECTING;
      this.lastError = "WhatsApp page reloaded — reconnecting…";
      this.broadcast({ event: "state", state: STATE.CONNECTING, reason: "reconnecting" });
    });

    const { SleepNotifier } = require("./sleep");
    this.sleepNotifier = opts.sleepNotifier || new SleepNotifier(opts.sleepOpts || {});
    this.sleepNotifier.on("suspend", () => this.handleSuspend());
    this.sleepNotifier.on("resume", () => this.handleResume());
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
    if (this.sleepNotifier && typeof this.sleepNotifier.start === "function") {
      this.sleepNotifier.start();
    }
    this.controller.start().catch((err) => {
      this.lastError = String(err && err.message ? err.message : err);
      this.state = STATE.ERROR;
      this.broadcast({ event: "error", message: this.lastError });
    });
  }

  handleSuspend() {
    this.state = STATE.CONNECTING;
    this.lastError = "System suspended — waiting for resume…";
    this.broadcast({ event: "sleep", timestamp: Date.now() });
    if (this.controller && typeof this.controller.suspend === "function") {
      this.controller.suspend();
    }
  }

  async handleResume() {
    this.broadcast({ event: "resume", timestamp: Date.now() });
    this.lastError = "System resumed — checking network & recovering…";
    this.broadcast({ event: "state", state: STATE.CONNECTING, reason: "resuming" });
    try {
      if (this.controller && typeof this.controller.resume === "function") {
        await this.controller.resume({
          autoReconnect: this.opts.autoReconnectOnResume !== false,
          networkTimeoutMs: this.opts.networkTimeoutMs ?? 30000,
          dnsLookupFn: this.opts.dnsLookupFn,
        });
      }
      await this.refreshAccountInfo();
    } catch (err) {
      this.state = STATE.ERROR;
      this.lastError = "Resume recovery failed: " + String((err && err.message) || err);
      this.broadcast({ event: "state", state: STATE.ERROR, error: this.lastError });
    }
  }

  async recover() {
    this.state = STATE.CONNECTING;
    this.lastError = "Manual reconnect requested — reconnecting…";
    this.broadcast({ event: "state", state: STATE.CONNECTING, reason: "reconnecting" });
    try {
      if (this.controller && typeof this.controller.recover === "function") {
        await this.controller.recover();
      }
      await this.refreshAccountInfo();
      return { ok: true, state: this.state };
    } catch (err) {
      this.state = STATE.ERROR;
      this.lastError = "Reconnect failed: " + String((err && err.message) || err);
      this.broadcast({ event: "state", state: STATE.ERROR, error: this.lastError });
      throw err;
    }
  }

  async refreshAccountInfo() {
    try {
      const info = await fetchAccountInfo(this.client);
      if (info) {
        this.account = info;
        stateStore.update({ account: info, linkedAt: Date.now() });
        this.refreshContactsCache().catch(() => {});
      }
    } catch (err) {
      this.lastError = "Account info fetch failed: " + String((err && err.message) || err);
    }
    return this.account;
  }

  async refreshContactsCache() {
    if (this.state === STATE.READY && this.client?.getContacts) {
      try {
        const contacts = await this.withClient("getContacts", () => this.client.getContacts(), 10000);
        if (contacts && this._contactCache) {
          this._contactCache.loadContacts(contacts);
        }
      } catch (_) {}
    }
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

  async withClient(action, fn, timeoutMs = 25000) {
    try {
      return await withTimeout(fn(), timeoutMs);
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
      const msg = await this.withClient("send", () => client.sendMessage(to, body), ttl);
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
      const msg = await this.withClient("sendMedia", () => client.sendMessage(to, media, options), 60000);
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
        if (this._contactCache) this._contactCache.loadChats(chatsRaw);
        return chatsRaw.slice(0, limit).map((c) => ({
          id: c.id?._serialized || c.id || "",
          name: c.name || c.formattedTitle || "",
          isGroup: !!c.isGroup,
          timestamp: c.timestamp || null,
          unreadCount: c.unreadCount || 0,
          archived: !!c.archived,
          pinned: !!c.pinned,
          isMuted: !!c.isMuted,
          lastMessage: c.lastMessage
            ? messageSummary(c.lastMessage, {
                contactCache: this._contactCache,
                chat: c,
                myNumber: this.account?.number,
              })
            : null,
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
        if (this._contactCache) this._contactCache.loadContacts(contacts);
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
      if (this._contactCache) this._contactCache.setChat(chat);
      const messages = await chat.fetchMessages({ limit });
      return messages.map((m) =>
        messageSummary(m, {
          contactCache: this._contactCache,
          chat,
          myNumber: this.account?.number,
        })
      );
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

  async getMediaInfo({ messageId }) {
    if (!messageId) return fail("BAD_REQUEST", "`messageId` is required.");
    if (this.state !== STATE.READY) return fail("NOT_READY", "WhatsApp daemon is not ready yet.");

    const { findCachedMedia, extractMediaInfo } = require("../media/store");
    const cached = findCachedMedia(messageId);
    if (cached) {
      return ok({
        media: {
          messageId,
          chatId: cached.chatId || null,
          from: cached.sender || null,
          type: cached.mimetype && cached.mimetype.startsWith("image/") ? "image" : "document",
          mimetype: cached.mimetype,
          filename: cached.filename,
          filesize: cached.size,
          caption: cached.caption || "",
          timestamp: cached.timestamp || null,
          downloaded: true,
          filePath: cached.filePath,
        },
      });
    }

    try {
      const msg = await this.withClient("getMessageById", () => this.client.getMessageById(messageId));
      if (!msg) {
        return fail("NOT_FOUND", `Message with ID "${messageId}" was not found.`);
      }
      if (!msg.hasMedia) {
        return fail("NO_MEDIA", `Message "${messageId}" does not contain media.`);
      }
      return ok({ media: extractMediaInfo(msg) });
    } catch (err) {
      return fail("MEDIA_INFO_FAILED", err.message || String(err));
    }
  }

  async downloadMedia({ messageId, outputDir, filename }) {
    if (!messageId) return fail("BAD_REQUEST", "`messageId` is required.");
    if (this.state !== STATE.READY) return fail("NOT_READY", "WhatsApp daemon is not ready yet.");

    const { findCachedMedia, saveIncomingMedia } = require("../media/store");
    const existing = findCachedMedia(messageId, outputDir);
    if (existing && (!filename || existing.filename === filename)) {
      return ok({
        messageId,
        filePath: existing.filePath,
        filename: existing.filename,
        mimetype: existing.mimetype,
        size: existing.size,
        caption: existing.caption || "",
        cached: true,
      });
    }

    try {
      const msg = await this.withClient("getMessageById", () => this.client.getMessageById(messageId));
      if (!msg) {
        return fail("NOT_FOUND", `Message with ID "${messageId}" was not found.`);
      }
      if (!msg.hasMedia) {
        return fail("NO_MEDIA", `Message "${messageId}" does not contain media.`);
      }

      if (typeof msg.downloadMedia !== "function") {
        return fail("NOT_SUPPORTED", "Client message does not support downloadMedia.");
      }

      const media = await this.withClient("downloadMedia", () => msg.downloadMedia(), 60000);
      if (!media || !media.data) {
        return fail("MEDIA_EXPIRED", "Media is expired, unavailable, or failed to download from WhatsApp.");
      }

      const saved = saveIncomingMedia(messageId, media, {
        outputDir,
        overrideFilename: filename,
        caption: msg.body || "",
        sender: msg.from,
        timestamp: msg.timestamp,
        chatId: (msg.id && msg.id.remote) || msg.from,
      });

      return ok(saved);
    } catch (err) {
      return fail("DOWNLOAD_FAILED", err.message || String(err));
    }
  }

  async getRecentMedia({ chatId, type = "all", limit = 20, sinceTimestamp } = {}) {
    if (this.state !== STATE.READY || !this.client) return [];

    const { extractMediaInfo } = require("../media/store");
    const targetLimit = Math.max(1, Math.min(limit || 20, 100));

    const matchesType = (itemType, mimeType) => {
      if (!type || type === "all") return true;
      if (type === "image") {
        return itemType === "image" || (mimeType && mimeType.startsWith("image/"));
      }
      if (type === "document") {
        return itemType === "document" || (mimeType && !mimeType.startsWith("image/"));
      }
      return itemType === type;
    };

    const matchesTimestamp = (ts) => {
      if (!sinceTimestamp) return true;
      const t = ts > 1e11 ? Math.floor(ts / 1000) : ts;
      const s = sinceTimestamp > 1e11 ? Math.floor(sinceTimestamp / 1000) : sinceTimestamp;
      return t >= s;
    };

    const mediaList = [];
    const seenIds = new Set();

    if (chatId) {
      try {
        const { toJid } = require("../ipc/jid");
        const resolvedJid = toJid(chatId);
        const chat = await this.withClient("getChatById", () => this.client.getChatById(resolvedJid));
        if (chat && typeof chat.fetchMessages === "function") {
          const messages = await chat.fetchMessages({ limit: Math.max(50, targetLimit * 2) });
          for (const m of messages) {
            if (!m.hasMedia) continue;
            const mid = m.id && (m.id._serialized || m.id);
            if (!mid || seenIds.has(mid)) continue;
            if (!matchesType(m.type, m.mimetype)) continue;
            if (!matchesTimestamp(m.timestamp)) continue;
            seenIds.add(mid);
            mediaList.push(extractMediaInfo(m));
          }
        }
      } catch (_) {}
    } else {
      try {
        const chats = await this.withClient("getChats", () => this.client.getChats());
        const recentChats = (chats || []).slice(0, 15);
        for (const chat of recentChats) {
          if (mediaList.length >= targetLimit * 2) break;
          if (chat && typeof chat.fetchMessages === "function") {
            try {
              const msgs = await chat.fetchMessages({ limit: 25 });
              for (const m of msgs) {
                if (!m.hasMedia) continue;
                const mid = m.id && (m.id._serialized || m.id);
                if (!mid || seenIds.has(mid)) continue;
                if (!matchesType(m.type, m.mimetype)) continue;
                if (!matchesTimestamp(m.timestamp)) continue;
                seenIds.add(mid);
                mediaList.push(extractMediaInfo(m));
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    mediaList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return mediaList.slice(0, targetLimit);
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
    if (this.sleepNotifier && typeof this.sleepNotifier.stop === "function") {
      this.sleepNotifier.stop();
    }
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