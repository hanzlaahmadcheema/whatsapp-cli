"use strict";

const http = require("http");
const { URL } = require("url");
const { ensureDaemon, request } = require("../cli/lib/transport");
const { ROUTES } = require("../ipc/protocol");
const { toJid, shortJid } = require("../ipc/jid");
const daemonStore = require("../store/daemon");
const { MessageRingBuffer } = require("./ring-buffer");

class WhatsAppMcpClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.base = null;
    this.token = null;
    this.ringBuffer = new MessageRingBuffer(opts.maxBufferSize || 100);
    this._sseReq = null;
    this._reconnectTimer = null;
    this._destroyed = false;
  }

  async getConnection() {
    if (this._destroyed) {
      throw new Error("WhatsApp MCP client is destroyed");
    }

    const d = daemonStore.read();
    if (d && d.host && d.port && d.token) {
      const base = `http://${d.host}:${d.port}`;
      try {
        const healthRes = await request(base, d.token, "GET", ROUTES.HEALTH, null, { timeout: 1500 });
        if (healthRes && healthRes.ok) {
          this.base = base;
          this.token = d.token;
          this._ensureSseWatcher();
          return { base: this.base, token: this.token };
        }
      } catch (_) {
        // Fall through to ensureDaemon
      }
    }

    try {
      const spawned = await ensureDaemon({ healthTimeoutMs: 1500 });
      this.base = spawned.base;
      this.token = spawned.token;
      this._ensureSseWatcher();
      return { base: this.base, token: this.token };
    } catch (err) {
      throw new Error(`WhatsApp daemon is not reachable: ${this._sanitizeError(err)}`);
    }
  }

  _sanitizeError(err) {
    if (!err) return "Unknown error";
    let msg = typeof err === "string" ? err : err.message || String(err);
    if (this.token) {
      msg = msg.split(this.token).join("[REDACTED]");
    }
    return msg;
  }

  _ensureSseWatcher() {
    if (this._sseReq || this._destroyed || !this.base || !this.token) return;

    try {
      const url = new URL(ROUTES.RECEIVE, this.base);
      const req = http.get(url, { headers: { "x-wa-token": this.token } }, (res) => {
        if (res.statusCode !== 200) {
          this._scheduleSseReconnect();
          return;
        }

        res.setEncoding("utf8");
        let buf = "";

        res.on("data", (chunk) => {
          buf += chunk;
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data && data.event === "message") {
                this.ringBuffer.push({
                  id: data.id || null,
                  chatId: data.chatId || null,
                  from: data.from || null,
                  to: data.to || null,
                  fromMe: Boolean(data.fromMe),
                  author: data.author || null,
                  body: data.body || "",
                  timestamp: data.timestamp || Math.floor(Date.now() / 1000),
                  hasMedia: Boolean(data.hasMedia),
                  type: data.type || (data.hasMedia ? "media" : "chat"),
                  mimetype: data.mimetype || null,
                  filename: data.filename || null,
                  filesize: data.size || data.filesize || null,
                  caption: data.caption || (data.hasMedia ? data.body : ""),
                });
              }
            } catch (_) {}
          }
        });

        res.on("end", () => this._scheduleSseReconnect());
        res.on("error", () => this._scheduleSseReconnect());
      });

      req.on("error", () => this._scheduleSseReconnect());
      this._sseReq = req;
    } catch (_) {
      this._scheduleSseReconnect();
    }
  }

  _scheduleSseReconnect() {
    if (this._sseReq) {
      try {
        this._sseReq.destroy();
      } catch (_) {}
      this._sseReq = null;
    }
    if (this._destroyed || this._reconnectTimer) return;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._destroyed) {
        this._ensureSseWatcher();
      }
    }, 5000);
    if (this._reconnectTimer && typeof this._reconnectTimer.unref === "function") {
      this._reconnectTimer.unref();
    }
  }

  async getStatus() {
    const { base, token } = await this.getConnection();
    const res = await request(base, token, "GET", ROUTES.STATUS, null, { timeout: 6000 });
    if (!res.ok) {
      throw new Error(`Failed to get status: ${(res.error && res.error.message) || "Unknown error"}`);
    }
    return {
      ok: true,
      state: res.state,
      account: res.account || null,
      lastError: res.lastError || null,
      nodeVersion: res.nodeVersion,
      appVersion: res.appVersion,
    };
  }

  async listChats(limit = 50) {
    const { base, token } = await this.getConnection();
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const res = await request(base, token, "GET", ROUTES.CHATS, null, {
      query: { limit: String(lim) },
      timeout: 10000,
    });
    if (!res.ok) {
      throw new Error(`Failed to list chats: ${(res.error && res.error.message) || "Unknown error"}`);
    }
    return {
      ok: true,
      count: (res.chats && res.chats.length) || 0,
      chats: res.chats || [],
    };
  }

  async listContacts(name = "") {
    const { base, token } = await this.getConnection();
    const query = name ? { name: String(name).trim() } : {};
    const res = await request(base, token, "GET", ROUTES.CONTACTS, null, {
      query,
      timeout: 10000,
    });
    if (!res.ok) {
      throw new Error(`Failed to list contacts: ${(res.error && res.error.message) || "Unknown error"}`);
    }
    return {
      ok: true,
      count: (res.contacts && res.contacts.length) || 0,
      contacts: res.contacts || [],
    };
  }

  async getChatHistory(target, limit = 50) {
    if (!target || typeof target !== "string" || !target.trim()) {
      throw new Error("Recipient target is required.");
    }

    const { base, token } = await this.getConnection();
    const jid = toJid(target.trim());
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));

    const res = await request(base, token, "GET", ROUTES.HISTORY, null, {
      query: { chatId: jid, limit: String(lim) },
      timeout: 12000,
    });
    if (!res.ok) {
      throw new Error(`Failed to get history: ${(res.error && res.error.message) || "Unknown error"}`);
    }
    return {
      ok: true,
      target: jid,
      count: (res.messages && res.messages.length) || 0,
      messages: res.messages || [],
    };
  }

  async sendMessage(target, message) {
    if (!target || typeof target !== "string" || !target.trim()) {
      throw new Error("Recipient target is required.");
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      throw new Error("Message text cannot be empty.");
    }
    if (message.length > 65000) {
      throw new Error("Message exceeds maximum supported length (65,000 characters).");
    }

    const { base, token } = await this.getConnection();

    let jid;
    const cleanTarget = target.trim();
    if (cleanTarget === "me" || cleanTarget === "self") {
      const status = await request(base, token, "GET", ROUTES.STATUS, null, { timeout: 5000 });
      if (!status.ok || status.state !== "ready" || !status.account || !status.account.number) {
        throw new Error("Cannot resolve 'me': WhatsApp session is not ready or account number is unavailable.");
      }
      jid = toJid(status.account.number);
    } else {
      jid = toJid(cleanTarget);
    }

    const res = await request(
      base,
      token,
      "POST",
      ROUTES.SEND,
      { to: jid, message: message.trim() },
      { timeout: 20000 }
    );

    if (!res.ok) {
      const code = res.error && res.error.code;
      const msg = res.error && res.error.message;
      if (code === "NOT_READY") {
        throw new Error("WhatsApp daemon is not ready yet. Please check status or scan QR code if unlinked.");
      }
      throw new Error(`Send failed: ${msg || code || "Unknown error"}`);
    }

    return {
      ok: true,
      messageId: res.messageId,
      to: res.to,
      timestamp: res.timestamp,
    };
  }

  async _resolveTargetJid(base, token, target) {
    if (!target || typeof target !== "string" || !target.trim()) {
      throw new Error("Recipient target is required.");
    }
    const cleanTarget = target.trim();
    if (cleanTarget === "me" || cleanTarget === "self") {
      const status = await request(base, token, "GET", ROUTES.STATUS, null, { timeout: 5000 });
      if (!status.ok || status.state !== "ready" || !status.account || !status.account.number) {
        throw new Error("Cannot resolve 'me': WhatsApp session is not ready or account number is unavailable.");
      }
      return toJid(status.account.number);
    }
    return toJid(cleanTarget);
  }

  async sendImage(target, filePath, caption = "") {
    const { validateFile } = require("../media");
    const valid = validateFile(filePath, { isImage: true });

    const { base, token } = await this.getConnection();
    const jid = await this._resolveTargetJid(base, token, target);

    const res = await request(
      base,
      token,
      "POST",
      ROUTES.SEND_MEDIA,
      {
        to: jid,
        filePath: valid.resolvedPath,
        caption: caption ? String(caption).trim() : undefined,
        isImage: true,
        sendMediaAsDocument: false,
      },
      { timeout: 60000 }
    );

    if (!res.ok) {
      const code = res.error && res.error.code;
      const msg = res.error && res.error.message;
      if (code === "NOT_READY") {
        throw new Error("WhatsApp daemon is not ready yet. Please check status or scan QR code if unlinked.");
      }
      throw new Error(`Send image failed: ${this._sanitizeError(msg || code || "Unknown error")}`);
    }

    return {
      ok: true,
      messageId: res.messageId,
      to: res.to,
      filename: valid.filename,
      mimetype: valid.mimetype,
      timestamp: res.timestamp,
    };
  }

  async sendDocument(target, filePath, { filename, caption } = {}) {
    const { validateFile } = require("../media");
    const valid = validateFile(filePath, { isDocument: true, filename });

    const { base, token } = await this.getConnection();
    const jid = await this._resolveTargetJid(base, token, target);

    const res = await request(
      base,
      token,
      "POST",
      ROUTES.SEND_MEDIA,
      {
        to: jid,
        filePath: valid.resolvedPath,
        filename: valid.filename,
        caption: caption ? String(caption).trim() : undefined,
        isImage: false,
        sendMediaAsDocument: true,
      },
      { timeout: 60000 }
    );

    if (!res.ok) {
      const code = res.error && res.error.code;
      const msg = res.error && res.error.message;
      if (code === "NOT_READY") {
        throw new Error("WhatsApp daemon is not ready yet. Please check status or scan QR code if unlinked.");
      }
      throw new Error(`Send document failed: ${this._sanitizeError(msg || code || "Unknown error")}`);
    }

    return {
      ok: true,
      messageId: res.messageId,
      to: res.to,
      filename: valid.filename,
      mimetype: valid.mimetype,
      timestamp: res.timestamp,
    };
  }

  async markSeen(target) {
    if (!target || typeof target !== "string" || !target.trim()) {
      throw new Error("Recipient target is required.");
    }

    const { base, token } = await this.getConnection();
    const jid = toJid(target.trim());

    const res = await request(base, token, "POST", ROUTES.CHAT_SEEN, { chatId: jid }, { timeout: 6000 });
    if (!res.ok) {
      throw new Error(`Mark seen failed: ${(res.error && res.error.message) || "Unknown error"}`);
    }
    return {
      ok: true,
      chatId: res.chatId,
    };
  }

  getRecentMessages({ limit = 20, sinceTimestamp = null, chatId = null } = {}) {
    const messages = this.ringBuffer.get({ limit, sinceTimestamp, chatId });
    return {
      ok: true,
      bufferedTotal: this.ringBuffer.size,
      count: messages.length,
      messages,
    };
  }

  async getRecentMedia({ chatId, type = "all", limit = 20, sinceTimestamp = null } = {}) {
    const { base, token } = await this.getConnection();

    let resolvedChatId = null;
    if (chatId) {
      if (chatId === "me" || chatId === "self") {
        const status = await this.getStatus();
        resolvedChatId = status.account && status.account.number ? toJid(status.account.number) : null;
      } else {
        resolvedChatId = toJid(chatId.trim());
      }
    }

    const query = {
      type: type || "all",
      limit: Math.max(1, Math.min(limit || 20, 100)),
    };
    if (resolvedChatId) query.chatId = resolvedChatId;
    if (sinceTimestamp) query.sinceTimestamp = sinceTimestamp;

    const res = await request(base, token, "GET", ROUTES.RECENT_MEDIA, null, {
      query,
      timeout: 15000,
    });

    if (!res.ok) {
      throw new Error(`Get recent media failed: ${(res.error && res.error.message) || "Unknown error"}`);
    }

    // Merge with any real-time media messages buffered in ringBuffer
    const bufferedMedia = this.ringBuffer.getMedia({
      type,
      chatId: resolvedChatId,
      sinceTimestamp,
      limit: query.limit,
    });

    const seenIds = new Set();
    const combined = [];

    // Prioritize daemon history results
    for (const item of (res.media || [])) {
      const mid = item.messageId || item.id;
      if (mid && !seenIds.has(mid)) {
        seenIds.add(mid);
        combined.push({
          messageId: mid,
          chatId: item.chatId,
          from: item.from,
          fromMe: item.fromMe,
          author: item.author || null,
          timestamp: item.timestamp,
          type: item.type,
          mimetype: item.mimetype,
          filename: item.filename,
          filesize: item.filesize || item.size || null,
          caption: item.caption || "",
          downloaded: Boolean(item.downloaded),
          filePath: item.filePath || null,
        });
      }
    }

    // Include recent buffer items not already present
    for (const b of bufferedMedia) {
      const mid = b.id;
      if (mid && !seenIds.has(mid)) {
        seenIds.add(mid);
        combined.push({
          messageId: mid,
          chatId: b.chatId,
          from: b.from,
          fromMe: b.fromMe,
          author: b.author || null,
          timestamp: b.timestamp,
          type: b.type,
          mimetype: b.mimetype,
          filename: b.filename,
          filesize: b.filesize || null,
          caption: b.caption || b.body || "",
          downloaded: false,
          filePath: null,
        });
      }
    }

    combined.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const finalMedia = combined.slice(0, query.limit);

    return {
      ok: true,
      count: finalMedia.length,
      media: finalMedia,
    };
  }

  async downloadMedia(messageId, { outputDir, filename } = {}) {
    if (!messageId || typeof messageId !== "string" || !messageId.trim()) {
      throw new Error("Valid message ID is required to download media.");
    }

    const { base, token } = await this.getConnection();
    const payload = {
      messageId: messageId.trim(),
    };
    if (outputDir) payload.outputDir = outputDir;
    if (filename) payload.filename = filename;

    const res = await request(base, token, "POST", ROUTES.MEDIA_DOWNLOAD, payload, { timeout: 60000 });
    if (!res.ok) {
      throw new Error(`Download media failed: ${(res.error && res.error.message) || "Unknown error"}`);
    }

    return {
      ok: true,
      messageId: res.messageId,
      filePath: res.filePath,
      filename: res.filename,
      mimetype: res.mimetype,
      size: res.size,
      caption: res.caption || "",
      cached: Boolean(res.cached),
    };
  }

  async getMediaInfo(messageId) {
    if (!messageId || typeof messageId !== "string" || !messageId.trim()) {
      throw new Error("Valid message ID is required to get media info.");
    }

    const { base, token } = await this.getConnection();
    const res = await request(base, token, "GET", ROUTES.MEDIA_INFO, null, {
      query: { messageId: messageId.trim() },
      timeout: 10000,
    });

    if (!res.ok) {
      throw new Error(`Get media info failed: ${(res.error && res.error.message) || "Unknown error"}`);
    }

    return {
      ok: true,
      media: res.media,
    };
  }

  destroy() {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._sseReq) {
      try {
        this._sseReq.destroy();
      } catch (_) {}
      this._sseReq = null;
    }
    this.ringBuffer.clear();
  }
}

module.exports = { WhatsAppMcpClient };
