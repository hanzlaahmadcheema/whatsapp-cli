"use strict";

const crypto = require("crypto");
const {
  WEBHOOK_EVENTS,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  DEFAULT_QUEUE_CONFIG,
  DELIVERY_STATUS,
  SIGNING_PROFILES,
  OPENBOT_STATUS_CODES,
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
 * Normalizes and validates an endpoint signing profile.
 * Defaults to "generic". Supported: "generic", "openbot".
 */
function normalizeProfile(profile) {
  if (!profile || typeof profile !== "string") {
    return SIGNING_PROFILES.GENERIC;
  }
  const clean = profile.trim().toLowerCase();
  if (clean === SIGNING_PROFILES.OPENBOT) return SIGNING_PROFILES.OPENBOT;
  if (clean === SIGNING_PROFILES.GENERIC) return SIGNING_PROFILES.GENERIC;
  throw new Error(
    `Invalid signing profile: "${profile}". Supported profiles: "${SIGNING_PROFILES.GENERIC}", "${SIGNING_PROFILES.OPENBOT}".`
  );
}

/**
 * Strips or masks secrets in an endpoint object before exposure to callers, logs, or APIs.
 */
function sanitizeEndpoint(endpoint, { exposeSecret = false } = {}) {
  if (!endpoint || typeof endpoint !== "object") return null;
  const copy = { ...endpoint };
  copy.profile = normalizeProfile(copy.profile);
  if (!exposeSecret) {
    copy.secret = maskSecret(copy.secret);
  }
  return copy;
}

/**
 * Generates a unique delivery ID.
 */
function generateDeliveryId() {
  return `del_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Generates a unique event ID.
 */
function generateEventId() {
  return `evt_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Calculates exponential backoff with full jitter.
 *
 * @param {number} attempt - Current attempt number (1-based)
 * @param {object} [options] - Configuration overrides
 * @param {number} [options.initialBackoffMs=1000]
 * @param {number} [options.maxBackoffMs=60000]
 * @param {number} [options.backoffFactor=2]
 * @param {boolean} [options.jitter=true] - If false, returns deterministic max backoff
 * @returns {number} Backoff delay in milliseconds
 */
function calculateBackoff(attempt, options = {}) {
  const initial = options.initialBackoffMs || DEFAULT_QUEUE_CONFIG.initialBackoffMs;
  const max = options.maxBackoffMs || DEFAULT_QUEUE_CONFIG.maxBackoffMs;
  const factor = options.backoffFactor || DEFAULT_QUEUE_CONFIG.backoffFactor;

  const exponent = Math.max(0, (attempt || 1) - 1);
  const calculated = Math.min(max, initial * Math.pow(factor, exponent));

  if (options.jitter === false) {
    return Math.round(calculated);
  }

  // Full jitter: uniformly random between 50ms and calculated delay
  const delay = Math.floor(Math.random() * calculated);
  return Math.max(50, delay);
}

/**
 * Determines whether an HTTP response status code is eligible for retry.
 */
function isRetryableHttpStatus(statusCode, profile = SIGNING_PROFILES.GENERIC) {
  if (typeof statusCode !== "number") return false;

  if (profile === SIGNING_PROFILES.OPENBOT) {
    // 200, 202 accepted (success, not retryable)
    if (OPENBOT_STATUS_CODES.ACCEPTED.includes(statusCode)) return false;
    // 400, 401, 404, 413, 415 permanent errors
    if (OPENBOT_STATUS_CODES.PERMANENT.includes(statusCode)) return false;
    // 429, 503 retryable
    if (OPENBOT_STATUS_CODES.RETRYABLE.includes(statusCode)) return true;
    // Any other 5xx is server error -> retry
    if (statusCode >= 500 && statusCode < 600) return true;
    // Any other 4xx is client error -> do not retry
    return false;
  }

  // Generic profile:
  // 408 Request Timeout, 429 Too Many Requests
  if (statusCode === 408 || statusCode === 429) return true;
  // 5xx Server Errors (500, 502, 503, 504, etc.)
  if (statusCode >= 500 && statusCode < 600) return true;
  return false;
}

/**
 * Determines whether an error (network, execution, or HTTP status) is eligible for retry.
 */
function isRetryableError(err, statusCode = null, profile = SIGNING_PROFILES.GENERIC) {
  if (statusCode !== null && statusCode !== undefined) {
    return isRetryableHttpStatus(statusCode, profile);
  }

  if (!err) return false;
  const message = typeof err === "string" ? err : err.message || "";
  const code = err.code || "";

  // SSRF violations, URL formatting, credentials, and redirect errors are permanent/non-retryable
  if (
    message.includes("Security violation (SSRF)") ||
    message.includes("Unsupported URL protocol") ||
    message.includes("Invalid URL format") ||
    message.includes("Credentials (username:password)") ||
    message.includes("Redirect rejected") ||
    message.includes("exceeds OpenBot limit") ||
    message.includes("OpenBot body limit") ||
    message.includes("Invalid OpenBot delivery ID")
  ) {
    return false;
  }

  // Network drop, timeout, or connection reset errors are retryable
  const retryableCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "UND_ERR_SOCKET",
    "EAI_AGAIN",
  ];
  if (retryableCodes.includes(code)) return true;

  if (
    message.includes("timeout") ||
    message.includes("ECONNRESET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("socket hang up")
  ) {
    return true;
  }

  return false;
}

/**
 * Sanitizes a delivery record for logging, inspection, or API response.
 * Guarantees no secret or sensitive auth material is present.
 */
function sanitizeDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  const copy = { ...delivery };
  if (copy.secret) delete copy.secret;
  if (copy.history && Array.isArray(copy.history)) {
    copy.history = copy.history.map((h) => {
      const hCopy = { ...h };
      if (hCopy.secret) delete hCopy.secret;
      return hCopy;
    });
  }
  return copy;
}

module.exports = {
  maskSecret,
  isValidEventType,
  normalizeEvents,
  normalizePrivacy,
  normalizeSecurity,
  normalizeProfile,
  sanitizeEndpoint,
  generateDeliveryId,
  generateEventId,
  calculateBackoff,
  isRetryableHttpStatus,
  isRetryableError,
  sanitizeDelivery,
};
