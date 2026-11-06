"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  DEFAULT_WEBHOOK_DIR,
  DEFAULT_CHECKPOINTS_FILE,
  PERMISSIONS,
} = require("./constants");
const { ensureWebhookDir } = require("./store");

const MAX_PROCESSED_MESSAGE_IDS = 10000;

class CheckpointStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DEFAULT_WEBHOOK_DIR;
    this.fileName = options.fileName || DEFAULT_CHECKPOINTS_FILE || "recovery_checkpoints.json";
    this.filePath = path.join(this.dataDir, this.fileName);
    this.data = {
      version: 1,
      bootstrapped: false,
      lastReconciledAt: null,
      chats: {},
      processedMessageIds: {},
    };
    this._loaded = false;
  }

  load() {
    ensureWebhookDir(this.dataDir);
    if (fs.existsSync(this.filePath)) {
      try {
        const stat = fs.lstatSync(this.filePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Symbolic link detected for checkpoint file: "${this.filePath}"`);
        }
        const raw = fs.readFileSync(this.filePath, "utf8");
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          this.data = {
            version: 1,
            bootstrapped: Boolean(parsed.bootstrapped),
            lastReconciledAt: parsed.lastReconciledAt || null,
            chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
            processedMessageIds:
              parsed.processedMessageIds && typeof parsed.processedMessageIds === "object"
                ? parsed.processedMessageIds
                : {},
          };
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          // preserve defaults on parse error
        }
      }
    }
    this._loaded = true;
    return this.data;
  }

  save() {
    ensureWebhookDir(this.dataDir);
    const dir = this.dataDir;
    const baseName = path.basename(this.filePath);
    const tmpFile = path.join(
      dir,
      `.${baseName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
    );

    const payload = JSON.stringify(this.data, null, 2);
    const fd = fs.openSync(tmpFile, "w", PERMISSIONS.FILE_MODE || 0o600);
    try {
      fs.writeSync(fd, payload, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.chmodSync(tmpFile, PERMISSIONS.FILE_MODE || 0o600);
    } catch (_) {}

    fs.renameSync(tmpFile, this.filePath);

    try {
      fs.chmodSync(this.filePath, PERMISSIONS.FILE_MODE || 0o600);
    } catch (_) {}
  }

  isBootstrapped() {
    if (!this._loaded) this.load();
    return Boolean(this.data.bootstrapped);
  }

  setBootstrapped(val = true) {
    if (!this._loaded) this.load();
    this.data.bootstrapped = Boolean(val);
    this.save();
  }

  getChatCheckpoint(chatId) {
    if (!this._loaded) this.load();
    return this.data.chats[chatId] || null;
  }

  updateChatCheckpoint(chatId, { lastMessageId = null, lastTimestamp = null, error = null } = {}) {
    if (!this._loaded) this.load();
    const existing = this.data.chats[chatId] || {};
    this.data.chats[chatId] = {
      lastMessageId: lastMessageId !== null ? lastMessageId : (existing.lastMessageId || null),
      lastTimestamp: lastTimestamp !== null ? Number(lastTimestamp) : (existing.lastTimestamp || null),
      reconciledAt: new Date().toISOString(),
      lastError: error !== undefined ? error : (existing.lastError || null),
    };
    this.save();
  }

  recordChatError(chatId, error) {
    if (!this._loaded) this.load();
    const existing = this.data.chats[chatId] || {};
    this.data.chats[chatId] = {
      ...existing,
      lastError: error ? String(error.message || error) : null,
      errorAt: new Date().toISOString(),
    };
    this.save();
  }

  isMessageProcessed(messageId) {
    if (!messageId) return false;
    if (!this._loaded) this.load();
    return Boolean(this.data.processedMessageIds[messageId]);
  }

  markMessageProcessed(messageId, timestamp = Math.floor(Date.now() / 1000)) {
    if (!messageId) return;
    if (!this._loaded) this.load();
    this.data.processedMessageIds[messageId] = timestamp;

    const keys = Object.keys(this.data.processedMessageIds);
    if (keys.length > MAX_PROCESSED_MESSAGE_IDS) {
      const entries = Object.entries(this.data.processedMessageIds);
      entries.sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, Math.floor(MAX_PROCESSED_MESSAGE_IDS * 0.2));
      for (const [k] of toRemove) {
        delete this.data.processedMessageIds[k];
      }
    }
  }

  setLastReconciledAt(ts = new Date().toISOString()) {
    if (!this._loaded) this.load();
    this.data.lastReconciledAt = ts;
    this.save();
  }

  clear() {
    this.data = {
      version: 1,
      bootstrapped: false,
      lastReconciledAt: null,
      chats: {},
      processedMessageIds: {},
    };
    this._loaded = true;
    if (fs.existsSync(this.filePath)) {
      try {
        fs.unlinkSync(this.filePath);
      } catch (_) {}
    }
  }
}

module.exports = {
  CheckpointStore,
  MAX_PROCESSED_MESSAGE_IDS,
};
