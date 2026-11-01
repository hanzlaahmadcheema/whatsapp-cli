"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const {
  validateWebhookUrl,
  resolveAndValidateDestination,
  validateRedirect,
  signPayload,
} = require("./security");
const {
  WEBHOOK_HEADERS,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_QUEUE_CONFIG,
  SIGNING_PROFILES,
} = require("./constants");
const { isRetryableError, normalizeProfile } = require("./types");
const {
  formatPayloadForProfile,
  checkProfileBodyConstraints,
  buildProfileHeaders,
  classifyProfileResponse,
} = require("./profiles");

const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB max response buffer

/**
 * Dispatches an outgoing HTTP POST request to a webhook endpoint destination.
 *
 * Enforces:
 * 1. SSRF and destination IP validation before connection.
 * 2. DNS rebinding prevention via custom lookup pinning connection to validated IP.
 * 3. Disabled redirects by default.
 * 4. HMAC-SHA256 payload signing and idempotency headers.
 * 5. Strict timeout and bounded response buffering.
 * 6. Non-exposure of secrets in error logs or attempt records.
 *
 * @param {object} params
 * @param {string} params.url - Destination URL
 * @param {string|object} params.payload - JSON payload or object
 * @param {string} params.secret - Plaintext HMAC signing secret
 * @param {string} params.eventId - Unique event ID
 * @param {string} params.deliveryId - Unique delivery ID
 * @param {object} [params.options]
 * @param {object} [params.options.security] - Security settings
 * @param {number} [params.options.timeoutMs] - HTTP timeout in milliseconds
 * @param {object} [params.options.headers] - Additional custom headers
 * @param {number} [redirectCount=0] - Current redirect depth
 * @returns {Promise<object>} Structured delivery attempt result
 */
async function dispatchWebhookRequest(params, redirectCount = 0) {
  const { url, payload, rawBody, secret, eventId, deliveryId, options = {} } = params;
  const profile = normalizeProfile(params.profile || options.profile);

  if (!url || typeof url !== "string") {
    throw new Error("Webhook destination URL must be a non-empty string.");
  }
  if (!secret || typeof secret !== "string") {
    throw new Error("Endpoint signing secret is required.");
  }

  const security = {
    ...DEFAULT_SECURITY_CONFIG,
    ...(options.security || {}),
  };
  const timeoutMs =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : DEFAULT_QUEUE_CONFIG.timeoutMs;

  const startTime = Date.now();

  // Determine exact serialized rawBody bytes for transmission and signing
  let payloadStr;
  if (rawBody !== undefined && rawBody !== null) {
    payloadStr = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  } else {
    const formatted = formatPayloadForProfile(profile, payload);
    payloadStr = typeof formatted === "string" ? formatted : JSON.stringify(formatted);
  }

  // Pre-flight check body constraints (e.g. OpenBot 64 KiB limit)
  const constraint = checkProfileBodyConstraints(profile, payloadStr);
  if (!constraint.ok) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      statusCode: 413,
      statusMessage: "Payload Too Large",
      durationMs,
      error: constraint.error,
      retryable: false, // Non-retryable permanent error
      responseBody: null,
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // 1. SSRF validation & DNS resolution with IP pinning
  let destination;
  try {
    destination = await resolveAndValidateDestination(url, security);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      statusCode: null,
      statusMessage: null,
      durationMs,
      error: err.message || "SSRF destination validation failed",
      retryable: isRetryableError(err, null, profile),
      responseBody: null,
    };
  }

  const { pinnedIp, hostname, port, protocol } = destination;
  const isHttps = protocol === "https:";
  const clientLib = isHttps ? https : http;
  const parsedUrl = new URL(url);
  const reqPath = (parsedUrl.pathname || "/") + (parsedUrl.search || "");

  // 2. Profile-specific cryptographic signatures & headers
  let reqHeaders;
  try {
    reqHeaders = buildProfileHeaders(profile, {
      secret,
      rawBody: payloadStr,
      timestamp,
      deliveryId: deliveryId || eventId || "",
      eventId,
      customHeaders: {
        host: port === (isHttps ? 443 : 80) ? hostname : `${hostname}:${port}`,
        ...(options.headers || {}),
      },
    });
  } catch (signErr) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      statusCode: null,
      statusMessage: null,
      durationMs,
      error: signErr.message || "Failed to generate headers or signatures",
      retryable: false,
      responseBody: null,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (req && !req.destroyed) {
        req.destroy();
      }
      resolve(result);
    };

    const reqOptions = {
      protocol,
      host: hostname,
      port: Number(port),
      path: reqPath,
      method: "POST",
      headers: reqHeaders,
      // Pin socket connection directly to validated IP (prevents DNS rebinding)
      lookup: (_host, opts, callback) => {
        if (typeof opts === "function") {
          callback = opts;
          opts = {};
        }
        const family = pinnedIp.includes(":") ? 6 : 4;
        if (opts && opts.all) {
          return callback(null, [{ address: pinnedIp, family }]);
        }
        return callback(null, pinnedIp, family);
      },
    };

    // For HTTPS, configure SNI to match the hostname for valid cert checks
    if (isHttps) {
      reqOptions.servername = hostname;
    }

    try {
      req = clientLib.request(reqOptions, async (res) => {
        const statusCode = res.statusCode || 0;
        const statusMessage = res.statusMessage || "";
        const durationMs = Date.now() - startTime;

        // Check for 3xx redirect
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          res.headers.location
        ) {
          res.resume(); // Discard body
          const maxRedirects = security.maxRedirects || 0;
          if (redirectCount >= maxRedirects) {
            return finish({
              success: false,
              statusCode,
              statusMessage,
              durationMs,
              error: `Redirect rejected: maxRedirects (${maxRedirects}) exceeded.`,
              retryable: false,
              responseBody: null,
            });
          }

          // Follow redirect with security validation
          try {
            const redirectUrl = new URL(res.headers.location, url).href;
            validateRedirect(redirectUrl, security, redirectCount);
            const redirectResult = await dispatchWebhookRequest(
              {
                ...params,
                url: redirectUrl,
                rawBody: payloadStr,
                profile,
              },
              redirectCount + 1
            );
            return finish(redirectResult);
          } catch (redErr) {
            return finish({
              success: false,
              statusCode,
              statusMessage,
              durationMs,
              error: redErr.message || "Redirect security violation",
              retryable: false,
              responseBody: null,
            });
          }
        }

        // Buffer response body safely with size limit
        const chunks = [];
        let totalBytes = 0;
        let truncated = false;

        res.on("data", (chunk) => {
          if (totalBytes + chunk.length > MAX_RESPONSE_BYTES) {
            const allowed = MAX_RESPONSE_BYTES - totalBytes;
            if (allowed > 0) {
              chunks.push(chunk.slice(0, allowed));
              totalBytes += allowed;
            }
            truncated = true;
            res.destroy();
          } else {
            chunks.push(chunk);
            totalBytes += chunk.length;
          }
        });

        res.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          const responseBody = bodyBuffer.toString("utf8");
          const { isSuccess, retryable } = classifyProfileResponse(
            profile,
            statusCode,
            null
          );

          finish({
            success: isSuccess,
            statusCode,
            statusMessage,
            durationMs,
            error: isSuccess ? null : `HTTP ${statusCode} ${statusMessage}`.trim(),
            retryable,
            responseBody: truncated
              ? `${responseBody} [TRUNCATED]`
              : responseBody,
          });
        });

        res.on("error", (err) => {
          const { retryable } = classifyProfileResponse(
            profile,
            statusCode,
            err
          );
          finish({
            success: false,
            statusCode,
            statusMessage,
            durationMs: Date.now() - startTime,
            error: err.message || "Response stream error",
            retryable,
            responseBody: null,
          });
        });
      });

      // Timeout handling
      req.setTimeout(timeoutMs, () => {
        const timeoutErr = new Error(`Delivery request timed out after ${timeoutMs}ms`);
        timeoutErr.code = "ETIMEDOUT";
        const { retryable } = classifyProfileResponse(profile, null, timeoutErr);
        finish({
          success: false,
          statusCode: null,
          statusMessage: null,
          durationMs: Date.now() - startTime,
          error: timeoutErr.message,
          retryable,
          responseBody: null,
        });
      });

      req.on("error", (err) => {
        const { retryable } = classifyProfileResponse(profile, null, err);
        finish({
          success: false,
          statusCode: null,
          statusMessage: null,
          durationMs: Date.now() - startTime,
          error: err.message || "Network request failed",
          retryable,
          responseBody: null,
        });
      });

      // Write payload body and send
      req.write(payloadStr, "utf8");
      req.end();
    } catch (err) {
      const { retryable } = classifyProfileResponse(profile, null, err);
      finish({
        success: false,
        statusCode: null,
        statusMessage: null,
        durationMs: Date.now() - startTime,
        error: err.message || "Failed to initiate request",
        retryable,
        responseBody: null,
      });
    }
  });
}

module.exports = {
  dispatchWebhookRequest,
};
