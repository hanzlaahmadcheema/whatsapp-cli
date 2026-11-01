"use strict";

const path = require("path");
const { paths } = require("../config/paths");

const DEFAULT_WEBHOOK_DIR = path.join(paths.dataDir, "webhooks");
const DEFAULT_ENDPOINTS_FILE = "endpoints.json";

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
  WEBHOOK_EVENTS,
  WEBHOOK_HEADERS,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  PERMISSIONS,
};
