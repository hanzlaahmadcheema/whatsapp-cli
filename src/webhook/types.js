"use strict";

const {
  WEBHOOK_EVENTS,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
} = require("./constants");

/**
 * Masks a signing secret for safe display and logging.
 * e.g. "whsec_0123456789abcdef0123456789abcdef" -> "whsec_********cdef"
 */
function maskSecret(secret) {
  if (!secret || typeof secret !== "string") return "[REDACTED]";
  const prefix = "whsec_";
  if (secret.startsWith(prefix)) {
    const raw = secret.slice(prefix.length);
    if (raw.length <= 4) return `${prefix}****`;
    const tail = raw.slice(-4);
    return `${prefix}********${tail}`;
  }
  if (secret.length <= 4) return "****";
  return `********${secret.slice(-4)}`;
}

/**
 * Checks if an event name is valid.
 */
function isValidEventType(event) {
  if (typeof event !== "string") return false;
  const trimmed = event.trim();
  if (trimmed === "*") return true;
  return WEBHOOK_EVENTS.includes(trimmed);
}

/**
 * Normalizes and validates an events array.
 */
function normalizeEvents(events) {
  if (!events) return ["*"];
  const list = Array.isArray(events) ? events : [events];
  const cleaned = [];

  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === "*") return ["*"];
    if (isValidEventType(trimmed) && !cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
  }

  if (cleaned.length === 0) {
    throw new Error(
      `Invalid event selection. Supported events: ${WEBHOOK_EVENTS.join(", ")} or "*"`
    );
  }

  return cleaned;
}

/**
 * Normalizes privacy configuration.
 */
function normalizePrivacy(privacy = {}) {
  return {
    includeContent:
      privacy.includeContent !== undefined
        ? Boolean(privacy.includeContent)
        : DEFAULT_PRIVACY_CONFIG.includeContent,
    includeSenderName:
      privacy.includeSenderName !== undefined
        ? Boolean(privacy.includeSenderName)
        : DEFAULT_PRIVACY_CONFIG.includeSenderName,
    includeMediaMetadata:
      privacy.includeMediaMetadata !== undefined
        ? Boolean(privacy.includeMediaMetadata)
        : DEFAULT_PRIVACY_CONFIG.includeMediaMetadata,
  };
}

/**
 * Normalizes security configuration.
 */
function normalizeSecurity(security = {}) {
  return {
    allowLocalhost:
      security.allowLocalhost !== undefined
        ? Boolean(security.allowLocalhost)
        : DEFAULT_SECURITY_CONFIG.allowLocalhost,
    allowLan:
      security.allowLan !== undefined
        ? Boolean(security.allowLan)
        : DEFAULT_SECURITY_CONFIG.allowLan,
    requireHttps:
      security.requireHttps !== undefined
        ? Boolean(security.requireHttps)
        : DEFAULT_SECURITY_CONFIG.requireHttps,
    maxRedirects:
      security.maxRedirects !== undefined
        ? Math.max(0, Math.min(parseInt(security.maxRedirects, 10) || 0, 5))
        : DEFAULT_SECURITY_CONFIG.maxRedirects,
  };
}

/**
 * Strips or masks secrets in an endpoint object before exposure to callers, logs, or APIs.
 */
function sanitizeEndpoint(endpoint, { exposeSecret = false } = {}) {
  if (!endpoint || typeof endpoint !== "object") return null;
  const copy = { ...endpoint };
  if (!exposeSecret) {
    copy.secret = maskSecret(copy.secret);
  }
  return copy;
}

module.exports = {
  maskSecret,
  isValidEventType,
  normalizeEvents,
  normalizePrivacy,
  normalizeSecurity,
  sanitizeEndpoint,
};
