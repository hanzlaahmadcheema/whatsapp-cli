"use strict";

const path = require("path");
const { paths } = require("../config/paths");

const DEFAULT_WEBHOOK_DIR = path.join(paths.dataDir, "webhooks");
const DEFAULT_ENDPOINTS_FILE = "endpoints.json";
const DEFAULT_QUEUE_FILE = "queue.json";
const DEFAULT_HISTORY_FILE = "history.json";

const WEBHOOK_EVENTS = Object.freeze([
  "message.received",
  "message.sent",
  "message.updated",
  "message.ack",
  "media.received",
  "session.state",
  "session.qr",
  "webhook.test",
]);

const WEBHOOK_HEADERS = Object.freeze({
  SIGNATURE_256: "x-hub-signature-256",
  SIGNATURE_WA: "x-wa-signature",
  TIMESTAMP: "x-wa-timestamp",
  EVENT_ID: "x-wa-event-id",
  IDEMPOTENCY_KEY: "idempotency-key",
  USER_AGENT: "user-agent",
});

const DELIVERY_STATUS = Object.freeze({
  PENDING: "pending",
  DELIVERING: "delivering",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
});

const DEFAULT_QUEUE_CONFIG = Object.freeze({
  maxAttempts: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 60000,
  backoffFactor: 2,
  timeoutMs: 10000,
  concurrency: 5,
  perEndpointConcurrency: 1,
  maxHistoryEntries: 500,
  historyRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
});

const DEFAULT_SECURITY_CONFIG = Object.freeze({
  allowLocalhost: false,
  allowLan: false,
  requireHttps: true,
  maxRedirects: 0,
});

const DEFAULT_PRIVACY_CONFIG = Object.freeze({
  includeContent: true,
  includeSenderName: true,
  includeMediaMetadata: true,
});

const PERMISSIONS = Object.freeze({
  DIR_MODE: 0o700,
  FILE_MODE: 0o600,
});

module.exports = {
  DEFAULT_WEBHOOK_DIR,
  DEFAULT_ENDPOINTS_FILE,
  DEFAULT_QUEUE_FILE,
  DEFAULT_HISTORY_FILE,
  WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
  DELIVERY_STATUS,
  DEFAULT_QUEUE_CONFIG,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  PERMISSIONS,
};
