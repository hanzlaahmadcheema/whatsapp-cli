"use strict";

const crypto = require("crypto");
const dns = require("dns");
const net = require("net");
const { URL } = require("url");

/**
 * Converts an IPv4 dotted-decimal string to a 32-bit unsigned integer.
 */
function ipv4ToInt(ip) {
  const parts = ip.split(".").map((part) => parseInt(part, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Checks if an IPv4 integer falls within a CIDR subnet.
 */
function isInIpv4Subnet(ipInt, subnetStr, prefixLength) {
  const subnetInt = ipv4ToInt(subnetStr);
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (subnetInt & mask);
}

/**
 * Normalizes IPv6 addresses and extracts wrapped IPv4 (e.g. ::ffff:192.168.1.1).
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return null;
  let clean = ip.trim().toLowerCase();

  // Strip brackets if provided e.g. [::1]
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }

  // IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  const v4MappedMatch = clean.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    return { ip: v4MappedMatch[1], version: 4 };
  }

  // IPv4-compatible IPv6 e.g. ::192.168.1.1
  const v4CompatMatch = clean.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4CompatMatch && v4CompatMatch[1] !== "0.0.0.1") {
    return { ip: v4CompatMatch[1], version: 4 };
  }

  const ver = net.isIP(clean);
  if (ver === 0) return null;
  return { ip: clean, version: ver };
}

/**
 * Checks if an IP address is a loopback address.
 */
function isLoopback(rawIp) {
  const parsed = normalizeIp(rawIp);
  if (!parsed) return false;

  if (parsed.version === 4) {
    const ipInt = ipv4ToInt(parsed.ip);
    return isInIpv4Subnet(ipInt, "127.0.0.0", 8);
  }

  if (parsed.version === 6) {
    return parsed.ip === "::1";
  }

  return false;
}

/**
 * Checks if an IP address is in private LAN space (RFC 1918 / RFC 4193).
 */
function isPrivateLan(rawIp) {
  const parsed = normalizeIp(rawIp);
  if (!parsed) return false;

  if (parsed.version === 4) {
    const ipInt = ipv4ToInt(parsed.ip);
    return (
      isInIpv4Subnet(ipInt, "10.0.0.0", 8) ||
      isInIpv4Subnet(ipInt, "172.16.0.0", 12) ||
      isInIpv4Subnet(ipInt, "192.168.0.0", 16)
    );
  }

  if (parsed.version === 6) {
    // Unique Local Address: fc00::/7 (starts with fc or fd)
    return parsed.ip.startsWith("fc") || parsed.ip.startsWith("fd");
  }

  return false;
}

/**
 * Checks if an IP is link-local or cloud metadata service.
 */
function isLinkLocal(rawIp) {
  const parsed = normalizeIp(rawIp);
  if (!parsed) return false;

  if (parsed.version === 4) {
    const ipInt = ipv4ToInt(parsed.ip);
    return isInIpv4Subnet(ipInt, "169.254.0.0", 16);
  }

  if (parsed.version === 6) {
    // fe80::/10
    const prefix = parsed.ip.slice(0, 4);
    return ["fe80", "fe90", "fea0", "feb0"].some((p) => prefix.startsWith(p.slice(0, 3)));
  }

  return false;
}

/**
 * Determines whether an IP is blocked according to SSRF rules.
 */
function isBlockedIp(rawIp, options = {}) {
  const parsed = normalizeIp(rawIp);
  if (!parsed) return { blocked: true, reason: "Invalid IP address format" };

  const { allowLocalhost = false, allowLan = false } = options;

  // 1. Loopback
  if (isLoopback(parsed.ip)) {
    if (allowLocalhost) {
      return { blocked: false, classification: "localhost" };
    }
    return { blocked: true, reason: "Loopback destination prohibited" };
  }

  // 2. Private LAN
  if (isPrivateLan(parsed.ip)) {
    if (allowLan) {
      return { blocked: false, classification: "lan" };
    }
    return { blocked: true, reason: "Private network destination prohibited" };
  }

  // 3. Link-local & cloud metadata (169.254.169.254) — ALWAYS blocked
  if (isLinkLocal(parsed.ip)) {
    return { blocked: true, reason: "Link-local / cloud metadata destination prohibited" };
  }

  // 4. Special, multicast, and reserved IPv4
  if (parsed.version === 4) {
    const ipInt = ipv4ToInt(parsed.ip);
    // 0.0.0.0/8 (Current network)
    if (isInIpv4Subnet(ipInt, "0.0.0.0", 8)) {
      return { blocked: true, reason: "Current network (0.0.0.0/8) prohibited" };
    }
    // 100.64.0.0/10 (Carrier-Grade NAT)
    if (isInIpv4Subnet(ipInt, "100.64.0.0", 10)) {
      return { blocked: true, reason: "Carrier-Grade NAT (100.64.0.0/10) prohibited" };
    }
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (isInIpv4Subnet(ipInt, "192.0.0.0", 24)) {
      return { blocked: true, reason: "IETF protocol assignments prohibited" };
    }
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation RFC 5737)
    if (
      isInIpv4Subnet(ipInt, "192.0.2.0", 24) ||
      isInIpv4Subnet(ipInt, "198.51.100.0", 24) ||
      isInIpv4Subnet(ipInt, "203.0.113.0", 24)
    ) {
      return { blocked: true, reason: "Documentation IP address prohibited" };
    }
    // 224.0.0.0/4 (Multicast) & 255.255.255.255 (Broadcast)
    if (isInIpv4Subnet(ipInt, "224.0.0.0", 4) || parsed.ip === "255.255.255.255") {
      return { blocked: true, reason: "Multicast or broadcast destination prohibited" };
    }
  }

  // 5. Special IPv6
  if (parsed.version === 6) {
    if (parsed.ip === "::") {
      return { blocked: true, reason: "Unspecified IPv6 destination prohibited" };
    }
    // Multicast ff00::/8
    if (parsed.ip.startsWith("ff")) {
      return { blocked: true, reason: "Multicast IPv6 destination prohibited" };
    }
    // Documentation 2001:db8::/32
    if (parsed.ip.startsWith("2001:db8:") || parsed.ip.startsWith("2001:0db8:")) {
      return { blocked: true, reason: "Documentation IPv6 destination prohibited" };
    }
  }

  return { blocked: false, classification: "public" };
}

/**
 * Validates a webhook destination URL structure and security constraints.
 */
function validateWebhookUrl(urlStr, options = {}) {
  if (!urlStr || typeof urlStr !== "string") {
    throw new Error("Webhook URL must be a non-empty string.");
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    // If URL failed to parse due to an out-of-range port, provide a descriptive error
    const portMatch = urlStr.match(/:(\d+)(?:\/|\?|#|$)/);
    if (portMatch) {
      const p = parseInt(portMatch[1], 10);
      if (p < 1 || p > 65535) {
        throw new Error(`Invalid port specified: ${portMatch[1]}`);
      }
    }
    throw new Error(`Invalid URL format: "${urlStr}"`);
  }

  // Protocol check
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: "${parsed.protocol}". Only HTTPS and HTTP are supported.`);
  }

  // Disallow user:pass authentication credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error("Credentials (username:password) in webhook URLs are prohibited.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("Webhook URL missing valid hostname.");
  }

  // Check port
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port specified: ${parsed.port}`);
  }

  const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const { allowLocalhost = false, allowLan = false, requireHttps = true } = options;

  // Enforce HTTPS for remote public internet endpoints
  if (parsed.protocol === "http:") {
    if (isLocalHost) {
      if (!allowLocalhost) {
        throw new Error(
          "HTTP localhost endpoints are blocked by default. Set allowLocalhost: true to permit local testing."
        );
      }
    } else {
      // Check if hostname is an explicit private IP
      const ipCheck = normalizeIp(hostname);
      if (ipCheck && isPrivateLan(ipCheck.ip)) {
        if (!allowLan) {
          throw new Error(
            "HTTP private LAN endpoints are blocked by default. Set allowLan: true to permit LAN integrations."
          );
        }
      } else if (requireHttps) {
        throw new Error(
          "HTTPS is strictly required for remote public webhook endpoints. HTTP is not permitted."
        );
      }
    }
  }

  return {
    url: parsed.href,
    protocol: parsed.protocol,
    hostname,
    port,
    pathname: parsed.pathname,
    isLocalhost: isLocalHost,
  };
}

/**
 * Resolves destination hostname and validates ALL resulting IP addresses against SSRF rules.
 * Returns the validated resolved IPs to prevent DNS rebinding attacks.
 */
async function resolveAndValidateDestination(urlStr, options = {}, dnsLookup = dns.promises.lookup) {
  const validated = validateWebhookUrl(urlStr, options);
  const hostname = validated.hostname;

  // If already an IP address
  const directIp = normalizeIp(hostname);
  if (directIp) {
    const check = isBlockedIp(directIp.ip, options);
    if (check.blocked) {
      throw new Error(`Security violation (SSRF): ${check.reason} (${directIp.ip})`);
    }
    return {
      ...validated,
      resolvedIps: [directIp.ip],
      pinnedIp: directIp.ip,
      ipVersion: directIp.version,
    };
  }

  // Resolve DNS
  let records;
  try {
    records = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for hostname "${hostname}": ${err.message}`);
  }

  if (!records || records.length === 0) {
    throw new Error(`No DNS records found for hostname "${hostname}".`);
  }

  const resolvedIps = [];
  for (const record of records) {
    const address = record.address;
    const check = isBlockedIp(address, options);
    if (check.blocked) {
      throw new Error(
        `Security violation (SSRF): Hostname "${hostname}" resolved to blocked IP ${address}. ${check.reason}`
      );
    }
    resolvedIps.push(address);
  }

  // Return the first validated IP for connection pinning (preventing DNS rebinding)
  return {
    ...validated,
    resolvedIps,
    pinnedIp: resolvedIps[0],
    ipVersion: net.isIP(resolvedIps[0]),
  };
}

/**
 * Validates a redirect destination according to security policy.
 */
function validateRedirect(targetUrlStr, originalOptions = {}, redirectCount = 0) {
  const maxRedirects = originalOptions.maxRedirects || 0;
  if (redirectCount >= maxRedirects) {
    throw new Error(`Redirect rejected: maxRedirects (${maxRedirects}) exceeded.`);
  }
  return validateWebhookUrl(targetUrlStr, originalOptions);
}

// -------------------------------------------------------------
// Cryptographic HMAC-SHA256 Signing & Verification
// -------------------------------------------------------------

/**
 * Signs an outgoing payload using HMAC-SHA256.
 *
 * @param {string} secret - Endpoint signing secret (e.g. whsec_...)
 * @param {string|object} payload - The JSON payload string or object
 * @param {number} timestamp - Unix epoch timestamp in seconds
 * @returns {object} { signature: string, timestamp: number, headerValue: string, hubHeaderValue: string }
 */
function signPayload(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof secret !== "string") {
    throw new Error("Signing secret must be a non-empty string.");
  }

  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signaturePayload = `${timestamp}.${payloadStr}`;

  const hmacHex = crypto
    .createHmac("sha256", secret)
    .update(signaturePayload, "utf8")
    .digest("hex");

  return {
    signature: hmacHex,
    timestamp,
    headerValue: `t=${timestamp},v1=${hmacHex}`,
    hubHeaderValue: `sha256=${hmacHex}`,
  };
}

/**
 * Verifies the HMAC-SHA256 signature of a received payload.
 *
 * @param {object} params
 * @param {string} params.secret - Expected endpoint signing secret
 * @param {string|object} params.payload - Received payload string or object
 * @param {string} params.signatureHeader - Received signature header (e.g. "sha256=..." or "t=...,v1=...")
 * @param {string|number} [params.timestampHeader] - Received timestamp header if not in signatureHeader
 * @param {number} [params.toleranceSeconds=300] - Replay prevention tolerance (default: 5 minutes)
 * @param {number} [params.nowSeconds] - Current time override for testing
 * @returns {object} { ok: boolean, reason?: string }
 */
function verifySignature({
  secret,
  payload,
  signatureHeader,
  timestampHeader,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (!secret || typeof secret !== "string") {
    return { ok: false, reason: "Missing or invalid secret" };
  }
  if (!payload) {
    return { ok: false, reason: "Missing payload" };
  }
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return { ok: false, reason: "Missing or invalid signature header" };
  }

  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);

  // Parse signature and timestamp
  let receivedTimestamp = null;
  let receivedSignatureHex = null;

  if (signatureHeader.includes("t=") && signatureHeader.includes("v1=")) {
    // Format: "t=1700000000,v1=abcdef..."
    const parts = signatureHeader.split(",");
    for (const part of parts) {
      const [key, val] = part.split("=").map((s) => s.trim());
      if (key === "t") receivedTimestamp = parseInt(val, 10);
      if (key === "v1") receivedSignatureHex = val;
    }
  } else if (signatureHeader.startsWith("sha256=")) {
    // Format: "sha256=abcdef..."
    receivedSignatureHex = signatureHeader.slice(7).trim();
  } else {
    // Raw hex
    receivedSignatureHex = signatureHeader.trim();
  }

  if (timestampHeader !== undefined && timestampHeader !== null) {
    const parsedTs = parseInt(timestampHeader, 10);
    if (!isNaN(parsedTs)) {
      receivedTimestamp = parsedTs;
    }
  }

  if (!receivedSignatureHex) {
    return { ok: false, reason: "No valid signature found in header" };
  }

  // Validate timestamp if provided or required
  if (receivedTimestamp !== null) {
    if (isNaN(receivedTimestamp)) {
      return { ok: false, reason: "Invalid timestamp format" };
    }
    const age = Math.abs(nowSeconds - receivedTimestamp);
    if (age > toleranceSeconds) {
      return { ok: false, reason: `Timestamp outside tolerance window (${age}s > ${toleranceSeconds}s)` };
    }
  }

  // Compute expected HMAC
  const expectedData =
    receivedTimestamp !== null ? `${receivedTimestamp}.${payloadStr}` : payloadStr;

  const expectedHmacHex = crypto
    .createHmac("sha256", secret)
    .update(expectedData, "utf8")
    .digest("hex");

  // Constant-time comparison
  const expectedBuf = Buffer.from(expectedHmacHex, "utf8");
  const receivedBuf = Buffer.from(receivedSignatureHex, "utf8");

  if (expectedBuf.length !== receivedBuf.length) {
    return { ok: false, reason: "Signature length mismatch" };
  }

  const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);
  if (!isValid) {
    return { ok: false, reason: "Signature mismatch" };
  }

  return { ok: true };
}

/**
 * Validates delivery ID matches OpenBot / standard requirements:
 * 1–256 ASCII characters matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$
 */
function validateDeliveryId(deliveryId) {
  if (!deliveryId || typeof deliveryId !== "string") {
    throw new Error("Invalid OpenBot delivery ID: delivery ID must be a non-empty string.");
  }
  const regex = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
  if (!regex.test(deliveryId)) {
    throw new Error(
      `Invalid OpenBot delivery ID format: "${deliveryId}". Must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`
    );
  }
  return deliveryId;
}

/**
 * Signs an outgoing OpenBot payload using HMAC-SHA256:
 * HMAC-SHA256(secret, timestamp + "." + deliveryId + "." + rawBody)
 * Format: sha256=<lowercase hexadecimal digest>
 */
function signOpenBotPayload(secret, rawBody, timestamp, deliveryId) {
  if (!secret || typeof secret !== "string") {
    throw new Error("Signing secret must be a non-empty string.");
  }
  if (rawBody === undefined || rawBody === null) {
    throw new Error("Payload rawBody is required for signing.");
  }
  const rawBodyStr = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  const ts = Number(timestamp) || Math.floor(Date.now() / 1000);
  const delId = validateDeliveryId(deliveryId);

  const signaturePayload = `${ts}.${delId}.${rawBodyStr}`;

  const hmacHex = crypto
    .createHmac("sha256", secret)
    .update(signaturePayload, "utf8")
    .digest("hex");

  return {
    signature: hmacHex,
    timestamp: ts,
    deliveryId: delId,
    headerValue: `sha256=${hmacHex}`,
  };
}

/**
 * Verifies an incoming OpenBot HMAC-SHA256 signature:
 * Verifies timestamp is within tolerance window (default: 5 minutes = 300s)
 * and signature matches HMAC-SHA256(secret, timestamp + "." + deliveryId + "." + rawBody)
 */
function verifyOpenBotSignature({
  secret,
  rawBody,
  timestampHeader,
  deliveryIdHeader,
  signatureHeader,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (!secret || typeof secret !== "string") {
    return { ok: false, reason: "Missing or invalid secret" };
  }
  if (rawBody === undefined || rawBody === null) {
    return { ok: false, reason: "Missing payload rawBody" };
  }
  if (!timestampHeader) {
    return { ok: false, reason: "Missing X-OpenBot-Timestamp header" };
  }
  if (!deliveryIdHeader) {
    return { ok: false, reason: "Missing X-OpenBot-Delivery-Id header" };
  }
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return { ok: false, reason: "Missing or invalid X-OpenBot-Signature header" };
  }

  const rawBodyStr = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);

  // Parse timestamp
  const ts = parseInt(timestampHeader, 10);
  if (isNaN(ts)) {
    return { ok: false, reason: "Invalid timestamp header format" };
  }

  const age = Math.abs(nowSeconds - ts);
  if (age > toleranceSeconds) {
    return {
      ok: false,
      reason: `Timestamp outside tolerance window (${age}s > ${toleranceSeconds}s)`,
    };
  }

  // Parse signature header: expects "sha256=<hex>"
  let receivedSignatureHex = signatureHeader.trim();
  if (receivedSignatureHex.startsWith("sha256=")) {
    receivedSignatureHex = receivedSignatureHex.slice(7).trim();
  } else {
    return { ok: false, reason: 'Invalid signature format (must start with "sha256=")' };
  }

  // Validate delivery ID
  try {
    validateDeliveryId(deliveryIdHeader);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const expectedData = `${ts}.${deliveryIdHeader}.${rawBodyStr}`;
  const expectedHmacHex = crypto
    .createHmac("sha256", secret)
    .update(expectedData, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expectedHmacHex, "utf8");
  const receivedBuf = Buffer.from(receivedSignatureHex, "utf8");

  if (expectedBuf.length !== receivedBuf.length) {
    return { ok: false, reason: "Signature length mismatch" };
  }

  const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);
  if (!isValid) {
    return { ok: false, reason: "Signature mismatch" };
  }

  return { ok: true };
}

module.exports = {
  ipv4ToInt,
  isInIpv4Subnet,
  normalizeIp,
  isLoopback,
  isPrivateLan,
  isLinkLocal,
  isBlockedIp,
  validateWebhookUrl,
  resolveAndValidateDestination,
  validateRedirect,
  signPayload,
  verifySignature,
  validateDeliveryId,
  signOpenBotPayload,
  verifyOpenBotSignature,
};
