"use strict";

const {
  SIGNING_PROFILES,
  OPENBOT_HEADERS,
  OPENBOT_MAX_BODY_BYTES,
  WEBHOOK_HEADERS,
} = require("./constants");
const { normalizeProfile, isRetryableError } = require("./types");
const {
  signPayload,
  signOpenBotPayload,
  validateDeliveryId,
} = require("./security");

/**
 * Formats a canonical WhatsApp event payload into the destination profile's envelope.
 *
 * Generic: returns canonical payload unmodified ({ id, event, timestamp, account, data }).
 * OpenBot: wraps into { type, occurredAt, data: { ...data, eventId, account } }.
 *
 * @param {string} profile - Signing profile ("generic" | "openbot")
 * @param {object} canonicalPayload - Canonical WhatsApp event object
 * @returns {object} Formatted envelope object
 */
function formatPayloadForProfile(profile, canonicalPayload) {
  const norm = normalizeProfile(profile);

  if (norm === SIGNING_PROFILES.OPENBOT) {
    if (!canonicalPayload || typeof canonicalPayload !== "object") {
      return canonicalPayload;
    }

    const type = canonicalPayload.event || "unknown";
    const occurredAt = canonicalPayload.timestamp
      ? new Date(Number(canonicalPayload.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    const dataObj =
      canonicalPayload.data && typeof canonicalPayload.data === "object"
        ? { ...canonicalPayload.data }
        : {};

    // Embed event ID and account in data sub-object to preserve full context
    dataObj.eventId = canonicalPayload.id || null;
    dataObj.account = canonicalPayload.account || null;

    return {
      type,
      occurredAt,
      data: dataObj,
    };
  }

  // Generic profile: return as-is
  return canonicalPayload;
}

/**
 * Verifies profile-specific payload constraints before transmission.
 *
 * For OpenBot: enforces maximum body size limit of 64 KiB (65,536 bytes).
 *
 * @param {string} profile - Signing profile
 * @param {string} rawBodyStr - Serialized UTF-8 payload body
 * @returns {{ ok: boolean, error?: string }}
 */
function checkProfileBodyConstraints(profile, rawBodyStr) {
  const norm = normalizeProfile(profile);

  if (norm === SIGNING_PROFILES.OPENBOT) {
    const bytes = Buffer.byteLength(rawBodyStr, "utf8");
    if (bytes > OPENBOT_MAX_BODY_BYTES) {
      return {
        ok: false,
        error: `Payload body (${bytes} bytes) exceeds OpenBot limit of ${OPENBOT_MAX_BODY_BYTES} bytes (64 KiB).`,
      };
    }
  }

  return { ok: true };
}

/**
 * Builds HTTP headers and cryptographic signatures according to the endpoint profile.
 *
 * @param {string} profile - Endpoint profile ("generic" | "openbot")
 * @param {object} params
 * @param {string} params.secret - Plaintext HMAC signing secret
 * @param {string} params.rawBody - Exact serialized UTF-8 payload string
 * @param {number} params.timestamp - Unix epoch timestamp in seconds
 * @param {string} params.deliveryId - Unique delivery ID
 * @param {string} [params.eventId] - Unique event ID
 * @param {object} [params.customHeaders] - Additional headers to merge
 * @returns {Record<string, string>} HTTP request headers
 */
function buildProfileHeaders(profile, params) {
  const norm = normalizeProfile(profile);
  const {
    secret,
    rawBody,
    timestamp,
    deliveryId,
    eventId,
    customHeaders = {},
  } = params;

  const bodyLength = Buffer.byteLength(rawBody, "utf8");

  if (norm === SIGNING_PROFILES.OPENBOT) {
    validateDeliveryId(deliveryId);
    const signed = signOpenBotPayload(secret, rawBody, timestamp, deliveryId);

    return {
      "content-type": "application/json; charset=utf-8",
      "user-agent": "whatsapp-cli-webhook/1.0",
      "content-length": bodyLength,
      [OPENBOT_HEADERS.TIMESTAMP]: String(timestamp),
      [OPENBOT_HEADERS.DELIVERY_ID]: deliveryId,
      [OPENBOT_HEADERS.SIGNATURE]: signed.headerValue,
      ...customHeaders,
    };
  }

  // Generic profile
  const signed = signPayload(secret, rawBody, timestamp);

  return {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "whatsapp-cli-webhook/1.0",
    "content-length": bodyLength,
    [WEBHOOK_HEADERS.SIGNATURE_WA]: signed.headerValue,
    [WEBHOOK_HEADERS.SIGNATURE_256]: signed.hubHeaderValue,
    [WEBHOOK_HEADERS.TIMESTAMP]: String(timestamp),
    [WEBHOOK_HEADERS.EVENT_ID]: eventId || "",
    [WEBHOOK_HEADERS.IDEMPOTENCY_KEY]: deliveryId || eventId || "",
    ...customHeaders,
  };
}

/**
 * Classifies HTTP response status code and errors based on endpoint profile semantics.
 *
 * @param {string} profile - Signing profile
 * @param {number|null} statusCode - HTTP status code
 * @param {Error|null} err - Network or execution error
 * @returns {{ isSuccess: boolean, retryable: boolean }}
 */
function classifyProfileResponse(profile, statusCode, err) {
  const norm = normalizeProfile(profile);

  if (norm === SIGNING_PROFILES.OPENBOT) {
    const isSuccess = statusCode === 200 || statusCode === 202;
    const retryable = isRetryableError(err, statusCode, SIGNING_PROFILES.OPENBOT);
    return { isSuccess, retryable };
  }

  const isSuccess = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const retryable = isRetryableError(err, statusCode, SIGNING_PROFILES.GENERIC);
  return { isSuccess, retryable };
}

module.exports = {
  formatPayloadForProfile,
  checkProfileBodyConstraints,
  buildProfileHeaders,
  classifyProfileResponse,
};
