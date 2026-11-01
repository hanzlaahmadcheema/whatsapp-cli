"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  DEFAULT_WEBHOOK_DIR,
  DEFAULT_ENDPOINTS_FILE,
  PERMISSIONS,
} = require("./constants");
const {
  normalizeEvents,
  normalizePrivacy,
  normalizeSecurity,
  normalizeProfile,
  sanitizeEndpoint,
} = require("./types");
const { validateWebhookUrl } = require("./security");

/**
 * Ensures the managed webhook directory exists with restrictive permissions (0700).
 */
function ensureWebhookDir(customDir) {
  const dir = customDir || DEFAULT_WEBHOOK_DIR;

  // Protect against path traversal
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true, mode: PERMISSIONS.DIR_MODE });
  }

  try {
    fs.chmodSync(resolved, PERMISSIONS.DIR_MODE);
  } catch (_) {
    // Some filesystems (FAT, NTFS) do not support posix chmod; ignore gracefully
  }

  return resolved;
}

/**
 * Returns the verified absolute path to endpoints.json with symlink protection.
 */
function getEndpointsFilePath(customDir) {
  const dir = ensureWebhookDir(customDir);
  const filePath = path.join(dir, DEFAULT_ENDPOINTS_FILE);

  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Security violation: endpoints file is a symbolic link: ${filePath}`);
    }
  }

  return filePath;
}

/**
 * Generates a cryptographically strong, URL-safe endpoint signing secret.
 */
function generateEndpointSecret() {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Generates a unique endpoint identifier.
 */
function generateEndpointId() {
  return `wh_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Loads all endpoints from persistent storage.
 * @returns {Record<string, object>}
 */
function loadEndpoints(customDir) {
  const filePath = getEndpointsFilePath(customDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new Error(`Failed to read webhook endpoints: ${err.message}`);
  }
}

/**
 * Atomically saves all endpoints to disk with fsync and 0600 file permissions.
 */
function saveEndpoints(endpointsMap, customDir) {
  const dir = ensureWebhookDir(customDir);
  const targetFile = getEndpointsFilePath(customDir);
  const tmpFile = path.join(
    dir,
    `.${DEFAULT_ENDPOINTS_FILE}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );

  const payload = JSON.stringify(endpointsMap, null, 2);

  // Write with 0600 permissions
  const fd = fs.openSync(tmpFile, "w", PERMISSIONS.FILE_MODE);
  try {
    fs.writeSync(fd, payload, 0, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.chmodSync(tmpFile, PERMISSIONS.FILE_MODE);
  } catch (_) {}

  // Atomic rename over target file
  fs.renameSync(tmpFile, targetFile);

  try {
    fs.chmodSync(targetFile, PERMISSIONS.FILE_MODE);
  } catch (_) {}
}

/**
 * Registers a new webhook endpoint.
 *
 * @param {object} data
 * @param {string} data.url - Target webhook URL
 * @param {string[]} [data.events] - Subscribed events (defaults to ["*"])
 * @param {string} [data.name] - Optional human-friendly name
 * @param {boolean} [data.enabled=true] - Initial status
 * @param {object} [data.privacy] - Privacy options
 * @param {object} [data.security] - Security options (allowLocalhost, allowLan, requireHttps)
 * @param {string} [customDir] - Storage directory override
 * @returns {object} The created endpoint including the plaintext secret (only returned on creation)
 */
function createEndpoint(data = {}, customDir) {
  if (!data.url) {
    throw new Error("Endpoint URL is required.");
  }

  const security = normalizeSecurity(data.security);
  const validatedUrl = validateWebhookUrl(data.url, security);
  const events = normalizeEvents(data.events);
  const privacy = normalizePrivacy(data.privacy);
  const profile = normalizeProfile(data.profile);

  const endpoints = loadEndpoints(customDir);

  // Safeguard: Check if an endpoint with the identical destination URL already exists
  const existingId = Object.keys(endpoints).find(
    (k) =>
      endpoints[k].url.trim().toLowerCase() ===
      validatedUrl.url.trim().toLowerCase()
  );

  if (existingId) {
    const existing = endpoints[existingId];
    existing.name =
      typeof data.name === "string" ? data.name.trim() : existing.name;
    existing.events = events;
    existing.privacy = privacy;
    existing.security = security;
    existing.profile = profile;
    if (data.enabled !== undefined) {
      existing.enabled = Boolean(data.enabled);
    }
    if (data.secret && typeof data.secret === "string" && data.secret.trim()) {
      existing.secret = data.secret.trim();
    }
    existing.updatedAt = new Date().toISOString();

    endpoints[existingId] = existing;
    saveEndpoints(endpoints, customDir);

    // Return with secret visible once on creation/configuration
    return { ...existing };
  }

  const id = generateEndpointId();
  const secret =
    data.secret && typeof data.secret === "string" && data.secret.trim()
      ? data.secret.trim()
      : generateEndpointSecret();
  const now = new Date().toISOString();

  const endpoint = {
    id,
    url: validatedUrl.url,
    name: typeof data.name === "string" ? data.name.trim() : null,
    profile,
    secret,
    events,
    enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
    privacy,
    security,
    createdAt: now,
    updatedAt: now,
  };

  endpoints[id] = endpoint;
  saveEndpoints(endpoints, customDir);

  // Return unmasked secret on creation only
  return { ...endpoint };
}

/**
 * Retrieves a single endpoint by ID.
 */
function getEndpoint(id, customDir, { exposeSecret = false } = {}) {
  if (!id) return null;
  const endpoints = loadEndpoints(customDir);
  const endpoint = endpoints[id];
  if (!endpoint) return null;
  return sanitizeEndpoint(endpoint, { exposeSecret });
}

/**
 * Lists all registered endpoints with secrets masked.
 */
function listEndpoints(customDir, { exposeSecret = false } = {}) {
  const endpoints = loadEndpoints(customDir);
  return Object.values(endpoints).map((ep) =>
    sanitizeEndpoint(ep, { exposeSecret })
  );
}

/**
 * Updates an existing webhook endpoint configuration.
 */
function updateEndpoint(id, updates = {}, customDir) {
  if (!id) throw new Error("Endpoint ID is required.");
  const endpoints = loadEndpoints(customDir);
  const current = endpoints[id];
  if (!current) {
    throw new Error(`Webhook endpoint not found: "${id}"`);
  }

  let updatedUrl = current.url;
  const updatedSecurity = updates.security
    ? normalizeSecurity({ ...current.security, ...updates.security })
    : current.security;

  if (updates.url) {
    const validated = validateWebhookUrl(updates.url, updatedSecurity);
    updatedUrl = validated.url;
  }

  const updatedEvents = updates.events
    ? normalizeEvents(updates.events)
    : current.events;

  const updatedPrivacy = updates.privacy
    ? normalizePrivacy({ ...current.privacy, ...updates.privacy })
    : current.privacy;

  const updatedEnabled =
    updates.enabled !== undefined ? Boolean(updates.enabled) : current.enabled;

  const updatedName =
    updates.name !== undefined
      ? (typeof updates.name === "string" ? updates.name.trim() : null)
      : current.name;

  const updatedProfile =
    updates.profile !== undefined
      ? normalizeProfile(updates.profile)
      : normalizeProfile(current.profile);

  const updated = {
    ...current,
    url: updatedUrl,
    name: updatedName,
    profile: updatedProfile,
    events: updatedEvents,
    enabled: updatedEnabled,
    privacy: updatedPrivacy,
    security: updatedSecurity,
    updatedAt: new Date().toISOString(),
  };

  endpoints[id] = updated;
  saveEndpoints(endpoints, customDir);

  return sanitizeEndpoint(updated, { exposeSecret: false });
}

/**
 * Deletes an endpoint from persistent storage.
 */
function deleteEndpoint(id, customDir) {
  if (!id) throw new Error("Endpoint ID is required.");
  const endpoints = loadEndpoints(customDir);
  if (!endpoints[id]) {
    throw new Error(`Webhook endpoint not found: "${id}"`);
  }

  delete endpoints[id];
  saveEndpoints(endpoints, customDir);

  return { ok: true, id };
}

/**
 * Rotates the signing secret for an endpoint.
 * Returns the unmasked new secret once.
 */
function rotateEndpointSecret(id, customDir) {
  if (!id) throw new Error("Endpoint ID is required.");
  const endpoints = loadEndpoints(customDir);
  const current = endpoints[id];
  if (!current) {
    throw new Error(`Webhook endpoint not found: "${id}"`);
  }

  const newSecret = generateEndpointSecret();
  const updated = {
    ...current,
    secret: newSecret,
    updatedAt: new Date().toISOString(),
  };

  endpoints[id] = updated;
  saveEndpoints(endpoints, customDir);

  return {
    endpoint: sanitizeEndpoint(updated, { exposeSecret: false }),
    newSecret,
  };
}

/**
 * Explicitly sets or imports an existing signing secret for an endpoint.
 * Protects against generating a replacement secret for external integrations.
 */
function setEndpointSecret(id, newSecret, customDir) {
  if (!id) throw new Error("Endpoint ID is required.");
  if (!newSecret || typeof newSecret !== "string" || !newSecret.trim()) {
    throw new Error("Secret must be a non-empty string.");
  }
  const endpoints = loadEndpoints(customDir);
  const current = endpoints[id];
  if (!current) {
    throw new Error(`Webhook endpoint not found: "${id}"`);
  }

  const updated = {
    ...current,
    secret: newSecret.trim(),
    updatedAt: new Date().toISOString(),
  };

  endpoints[id] = updated;
  saveEndpoints(endpoints, customDir);

  return sanitizeEndpoint(updated, { exposeSecret: false });
}

/**
 * Returns all active endpoints subscribed to an event type (with unmasked secret for dispatcher).
 */
function findEndpointsForEvent(eventType, customDir) {
  if (!eventType) return [];
  const endpoints = loadEndpoints(customDir);
  const matched = [];

  for (const ep of Object.values(endpoints)) {
    if (!ep.enabled) continue;
    if (ep.events.includes("*") || ep.events.includes(eventType)) {
      matched.push({ ...ep });
    }
  }

  return matched;
}

module.exports = {
  ensureWebhookDir,
  getEndpointsFilePath,
  generateEndpointSecret,
  generateEndpointId,
  loadEndpoints,
  saveEndpoints,
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  rotateEndpointSecret,
  setEndpointSecret,
  findEndpointsForEvent,
};
