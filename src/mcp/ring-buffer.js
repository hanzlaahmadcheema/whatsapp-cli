"use strict";

/**
 * Bounded in-memory ring buffer for caching recent WhatsApp messages
 * received via daemon SSE stream. No persistent disk storage.
 */
class MessageRingBuffer {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.buffer = [];
    this._seenIds = new Set();
  }

  push(message) {
    if (!message) return;
    const id = message.id || `${message.timestamp}_${message.from}_${(message.body || "").slice(0, 20)}`;
    if (this._seenIds.has(id)) return;
    this._seenIds.add(id);

    this.buffer.push(message);
    if (this.buffer.length > this.maxSize) {
      const removed = this.buffer.shift();
      if (removed) {
        const remId = removed.id || `${removed.timestamp}_${removed.from}_${(removed.body || "").slice(0, 20)}`;
        this._seenIds.delete(remId);
      }
    }
  }

  get({ limit = 20, sinceTimestamp = null, chatId = null } = {}) {
    let result = [...this.buffer];

    if (chatId) {
      const targetDigits = String(chatId).replace(/[^\d]/g, "");
      const targetShort = String(chatId).split("@")[0];
      result = result.filter((m) => {
        const mChatId = m.chatId || "";
        const mFrom = m.from || "";
        const mTo = m.to || "";
        const mChatDigits = mChatId.replace(/[^\d]/g, "");
        const mFromDigits = mFrom.replace(/[^\d]/g, "");
        return (
          mChatId === chatId ||
          mFrom === chatId ||
          mTo === chatId ||
          (targetShort && (mChatId.startsWith(targetShort) || mFrom.startsWith(targetShort))) ||
          (targetDigits && (mChatDigits === targetDigits || mFromDigits === targetDigits))
        );
      });
    }

    if (typeof sinceTimestamp === "number" && !isNaN(sinceTimestamp)) {
      result = result.filter((m) => {
        const ts = m.timestamp ? (m.timestamp > 1e11 ? Math.floor(m.timestamp / 1000) : m.timestamp) : 0;
        const sinceSec = sinceTimestamp > 1e11 ? Math.floor(sinceTimestamp / 1000) : sinceTimestamp;
        return ts >= sinceSec;
      });
    }

    const lim = Math.max(1, Math.min(limit || 20, this.maxSize));
    return result.slice(-lim).reverse();
  }

  getMedia({ type = "all", chatId = null, sinceTimestamp = null, limit = 20 } = {}) {
    let result = this.buffer.filter((m) => m && m.hasMedia);

    if (type && type !== "all") {
      result = result.filter((m) => {
        if (type === "image") return m.type === "image" || (m.mimetype && m.mimetype.startsWith("image/"));
        if (type === "document") return m.type === "document" || (m.mimetype && !m.mimetype.startsWith("image/"));
        return m.type === type;
      });
    }

    if (chatId) {
      const targetDigits = String(chatId).replace(/[^\d]/g, "");
      const targetShort = String(chatId).split("@")[0];
      result = result.filter((m) => {
        const mChatId = m.chatId || "";
        const mFrom = m.from || "";
        const mTo = m.to || "";
        const mChatDigits = mChatId.replace(/[^\d]/g, "");
        const mFromDigits = mFrom.replace(/[^\d]/g, "");
        return (
          mChatId === chatId ||
          mFrom === chatId ||
          mTo === chatId ||
          (targetShort && (mChatId.startsWith(targetShort) || mFrom.startsWith(targetShort))) ||
          (targetDigits && (mChatDigits === targetDigits || mFromDigits === targetDigits))
        );
      });
    }

    if (typeof sinceTimestamp === "number" && !isNaN(sinceTimestamp)) {
      result = result.filter((m) => {
        const ts = m.timestamp ? (m.timestamp > 1e11 ? Math.floor(m.timestamp / 1000) : m.timestamp) : 0;
        const sinceSec = sinceTimestamp > 1e11 ? Math.floor(sinceTimestamp / 1000) : sinceTimestamp;
        return ts >= sinceSec;
      });
    }

    const lim = Math.max(1, Math.min(limit || 20, this.maxSize));
    return result.slice(-lim).reverse();
  }

  clear() {
    this.buffer = [];
    this._seenIds.clear();
  }

  get size() {
    return this.buffer.length;
  }
}

module.exports = { MessageRingBuffer };
