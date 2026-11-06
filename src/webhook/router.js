"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  DEFAULT_WEBHOOK_DIR,
  DEFAULT_ROUTES_FILE,
  PERMISSIONS,
} = require("./constants");
const { loadEndpoints } = require("./store");

/**
 * Strips non-digit characters from a string.
 */
function stripDigits(input) {
  if (input === null || input === undefined) return "";
  return String(input).replace(/[^\d]/g, "");
}

/**
 * Validates whether a digit string looks like a valid international phone number (7-15 digits, non-zero leading).
 */
function isValidPhoneNumber(digits) {
  return /^[1-9]\d{6,14}$/.test(digits);
}

/**
 * Normalizes a contact string (phone number, JID, LID, or raw identifier).
 *
 * @param {string} input - Raw contact identifier
 * @returns {object|null} { raw, canonicalJid, phone, type }
 */
function normalizeContact(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();

  // 1. Group JID (@g.us)
  if (lower.endsWith("@g.us")) {
    return {
      raw,
      canonicalJid: lower,
      phone: null,
      type: "group",
    };
  }

  // 2. Newsletter/Channel JID (@newsletter)
  if (lower.endsWith("@newsletter")) {
    return {
      raw,
      canonicalJid: lower,
      phone: null,
      type: "channel",
    };
  }

  // 3. WhatsApp LID (@lid)
  if (lower.endsWith("@lid")) {
    const userPart = lower.split("@")[0];
    const digits = stripDigits(userPart);
    return {
      raw,
      canonicalJid: lower,
      phone: digits || null,
      type: "lid",
    };
  }

  // 4. Contact JID (@c.us or @s.whatsapp.net)
  if (lower.endsWith("@c.us") || lower.endsWith("@s.whatsapp.net")) {
    const userPart = lower.split("@")[0];
    const digits = stripDigits(userPart);
    const canonicalJid = digits ? `${digits}@c.us` : lower;
    return {
      raw,
      canonicalJid,
      phone: digits || null,
      type: "jid",
    };
  }

  // 5. Phone number format (digits, with or without leading '+', hyphens, spaces, parentheses)
  const digits = stripDigits(raw);
  if (digits && isValidPhoneNumber(digits)) {
    return {
      raw,
      canonicalJid: `${digits}@c.us`,
      phone: digits,
      type: "phone",
    };
  }

  // 6. Non-standard identifier or raw token
  return {
    raw,
    canonicalJid: lower,
    phone: digits || null,
    type: "unknown",
  };
}

/**
 * Extracts all candidate sender identifiers from an incoming message payload.
 * Collects normalized JIDs, phone digits, and lowercased tokens.
 *
 * @param {object} payload - Canonical webhook event payload
 * @returns {Set<string>} Set of candidate match strings
 */
function extractSenderIdentifiers(payload) {
  const identifiers = new Set();
  if (!payload || typeof payload !== "object") return identifiers;

  const data = payload.data || {};
  const candidates = [
    data.from,
    data.author,
    data.chatId,
    data.sender,
  ];

  for (const item of candidates) {
    if (!item) continue;
    const norm = normalizeContact(item);
    if (!norm) continue;

    if (norm.canonicalJid) identifiers.add(norm.canonicalJid.toLowerCase());
    if (norm.phone) identifiers.add(norm.phone);
    if (norm.raw) identifiers.add(norm.raw.toLowerCase().trim());

    // Also strip non-digits if phone digits present
    const digits = stripDigits(norm.raw);
    if (digits) identifiers.add(digits);
  }

  return identifiers;
}

/**
 * Checks whether a rule's target contact matches any candidate sender identifier.
 *
 * @param {string} ruleContact - The contact specified in the routing rule
 * @param {Set<string>} candidateIdentifiers - Set of sender identifiers from message
 * @returns {boolean} True if matched
 */
function matchesContact(ruleContact, candidateIdentifiers) {
  if (!ruleContact || !candidateIdentifiers || candidateIdentifiers.size === 0) {
    return false;
  }

  const norm = normalizeContact(ruleContact);
  if (!norm) return false;

  if (norm.canonicalJid && candidateIdentifiers.has(norm.canonicalJid.toLowerCase())) {
    return true;
  }
  if (norm.phone && candidateIdentifiers.has(norm.phone)) {
    return true;
  }
  if (norm.raw && candidateIdentifiers.has(norm.raw.toLowerCase().trim())) {
    return true;
  }
  const digits = stripDigits(norm.raw);
  if (digits && candidateIdentifiers.has(digits)) {
    return true;
  }

  return false;
}

/**
 * Creates an empty default routing configuration.
 */
function createEmptyRoutingConfig() {
  return {
    version: 1,
    fallback: {
      endpointId: null,
      enabled: false,
    },
    rules: [],
    endpointRules: {},
    multiDestination: false,
  };
}

/**
 * Returns absolute path to routes.json with directory creation and symlink protection.
 */
function getRoutesFilePath(customDir) {
  const dir = customDir || DEFAULT_WEBHOOK_DIR;
  const resolvedDir = path.resolve(dir);

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true, mode: PERMISSIONS.DIR_MODE });
  }

  const filePath = path.join(resolvedDir, DEFAULT_ROUTES_FILE);
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Security violation: routes file is a symbolic link: ${filePath}`);
    }
  }

  return filePath;
}

/**
 * Loads routing configuration from disk.
 *
 * @param {string} [customDir]
 * @returns {object} Routing configuration object
 */
function loadRoutingConfig(customDir) {
  const filePath = getRoutesFilePath(customDir);
  if (!fs.existsSync(filePath)) {
    return createEmptyRoutingConfig();
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return createEmptyRoutingConfig();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return createEmptyRoutingConfig();

    return {
      version: parsed.version || 1,
      fallback: parsed.fallback || { endpointId: null, enabled: false },
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      endpointRules:
        parsed.endpointRules && typeof parsed.endpointRules === "object"
          ? parsed.endpointRules
          : {},
      multiDestination: Boolean(parsed.multiDestination),
    };
  } catch (err) {
    throw new Error(`Failed to read webhook routes: ${err.message}`);
  }
}

/**
 * Atomically saves routing configuration to disk with 0600 permissions and fsync.
 *
 * @param {object} config
 * @param {string} [customDir]
 */
function saveRoutingConfig(config, customDir) {
  const dir = path.resolve(customDir || DEFAULT_WEBHOOK_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: PERMISSIONS.DIR_MODE });
  }

  const targetFile = getRoutesFilePath(customDir);
  const tmpFile = path.join(
    dir,
    `.${DEFAULT_ROUTES_FILE}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );

  const payload = JSON.stringify(config, null, 2);

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

  fs.renameSync(tmpFile, targetFile);

  try {
    fs.chmodSync(targetFile, PERMISSIONS.FILE_MODE);
  } catch (_) {}
}

/**
 * Generates a unique route rule identifier.
 */
function generateRuleId() {
  return `route_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Extracts exclusion list for an endpoint from both endpointRules and endpoint object.
 */
function getEndpointExclusions(endpoint, config) {
  const exclusions = [];
  if (!endpoint) return exclusions;

  // 1. From routes.json endpointRules
  const er = config?.endpointRules?.[endpoint.id];
  if (er && Array.isArray(er.exclusion)) {
    exclusions.push(...er.exclusion);
  }

  // 2. From endpoint definition
  if (Array.isArray(endpoint.exclusion)) {
    exclusions.push(...endpoint.exclusion);
  }
  if (endpoint.routing && Array.isArray(endpoint.routing.exclusion)) {
    exclusions.push(...endpoint.routing.exclusion);
  }

  return exclusions;
}

/**
 * Extracts allowlist for an endpoint from both endpointRules and endpoint object.
 */
function getEndpointAllowlist(endpoint, config) {
  const allowlist = [];
  if (!endpoint) return allowlist;

  // 1. From routes.json endpointRules
  const er = config?.endpointRules?.[endpoint.id];
  if (er && Array.isArray(er.allowlist)) {
    allowlist.push(...er.allowlist);
  }

  // 2. From endpoint definition
  if (Array.isArray(endpoint.allowlist)) {
    allowlist.push(...endpoint.allowlist);
  }
  if (endpoint.routing && Array.isArray(endpoint.routing.allowlist)) {
    allowlist.push(...endpoint.routing.allowlist);
  }

  return allowlist;
}

/**
 * Resolves destination endpoints for a webhook event payload based on the 5-step precedence policy:
 *
 * 1. Explicit contact-to-endpoint mapping.
 * 2. Endpoint exclusion rules.
 * 3. Endpoint allowlist matching.
 * 4. Configured fallback endpoint.
 * 5. No delivery when no eligible destination exists and fallback is disabled.
 *
 * Preserves backward compatibility when routing is not configured.
 *
 * @param {object} payload - Webhook event payload
 * @param {Array<object>} availableEndpoints - Active endpoints subscribed to event
 * @param {string} [customDir] - Custom storage directory
 * @param {object} [options] - Optional overrides (e.g. injected routingConfig)
 * @returns {Array<object>} Resolved destination endpoints (single endpoint by default to prevent fan-out)
 */
function resolveDestinations(payload, availableEndpoints, customDir, options = {}) {
  if (!Array.isArray(availableEndpoints) || availableEndpoints.length === 0) {
    return [];
  }

  const config = options.routingConfig || loadRoutingConfig(customDir);

  // Check if routing is configured
  const hasExplicitRules =
    Array.isArray(config.rules) && config.rules.some((r) => r.enabled !== false);
  const hasEndpointRules = Object.keys(config.endpointRules || {}).some((k) => {
    const er = config.endpointRules[k];
    return (
      (Array.isArray(er.allowlist) && er.allowlist.length > 0) ||
      (Array.isArray(er.exclusion) && er.exclusion.length > 0)
    );
  });
  const hasEndpointInlineRules = availableEndpoints.some((ep) => {
    const r = ep.routing || {};
    return (
      (Array.isArray(r.allowlist) && r.allowlist.length > 0) ||
      (Array.isArray(r.exclusion) && r.exclusion.length > 0) ||
      (Array.isArray(ep.allowlist) && ep.allowlist.length > 0) ||
      (Array.isArray(ep.exclusion) && ep.exclusion.length > 0)
    );
  });
  const hasFallback = Boolean(
    config.fallback &&
      config.fallback.endpointId &&
      typeof config.fallback.endpointId === "string"
  );

  // Backward compatibility: If no routing configuration exists, preserve existing broadcast
  if (!hasExplicitRules && !hasEndpointRules && !hasEndpointInlineRules && !hasFallback) {
    return availableEndpoints;
  }

  // Extract candidate sender identifiers from payload
  const candidateIdentifiers = extractSenderIdentifiers(payload);

  // If sender identifiers cannot be determined (malformed/unknown identity)
  if (candidateIdentifiers.size === 0) {
    if (config.fallback && config.fallback.enabled && config.fallback.endpointId) {
      const fallbackEp = availableEndpoints.find(
        (ep) => ep.id === config.fallback.endpointId
      );
      return fallbackEp ? [fallbackEp] : [];
    }
    return [];
  }

  // Precedence 1: Explicit contact-to-endpoint mapping
  if (hasExplicitRules) {
    const matchingRules = config.rules.filter((rule) => {
      if (rule.enabled === false) return false;
      return matchesContact(rule.contact, candidateIdentifiers);
    });

    if (matchingRules.length > 0) {
      // Deterministic sort: priority desc, createdAt asc, id asc
      matchingRules.sort((a, b) => {
        const pDiff = (b.priority || 0) - (a.priority || 0);
        if (pDiff !== 0) return pDiff;
        const aDate = a.createdAt || "";
        const bDate = b.createdAt || "";
        const dDiff = aDate.localeCompare(bDate);
        if (dDiff !== 0) return dDiff;
        return (a.id || "").localeCompare(b.id || "");
      });

      const matchedEndpoints = [];
      for (const rule of matchingRules) {
        const ep = availableEndpoints.find((e) => e.id === rule.endpointId);
        if (ep) {
          if (config.multiDestination) {
            if (!matchedEndpoints.some((e) => e.id === ep.id)) {
              matchedEndpoints.push(ep);
            }
          } else {
            return [ep];
          }
        }
      }

      if (matchedEndpoints.length > 0) {
        return matchedEndpoints;
      }
    }
  }

  // Precedence 2 & 3: Endpoint exclusion and allowlist matching
  const nonExcludedEndpoints = [];

  for (const ep of availableEndpoints) {
    const exclusions = getEndpointExclusions(ep, config);
    let isExcluded = false;

    for (const excl of exclusions) {
      if (matchesContact(excl, candidateIdentifiers)) {
        isExcluded = true;
        break;
      }
    }

    if (!isExcluded) {
      nonExcludedEndpoints.push(ep);
    }
  }

  // Check allowlist matches among non-excluded endpoints
  const allowlistMatches = [];
  for (const ep of nonExcludedEndpoints) {
    const allowlist = getEndpointAllowlist(ep, config);
    if (allowlist.length > 0) {
      for (const allowed of allowlist) {
        if (matchesContact(allowed, candidateIdentifiers)) {
          allowlistMatches.push(ep);
          break;
        }
      }
    }
  }

  if (allowlistMatches.length > 0) {
    if (config.multiDestination) {
      return allowlistMatches;
    }
    // Deterministic tie-breaking: priority desc, createdAt asc, id asc
    allowlistMatches.sort((a, b) => {
      const pDiff = (b.priority || 0) - (a.priority || 0);
      if (pDiff !== 0) return pDiff;
      const aDate = a.createdAt || "";
      const bDate = b.createdAt || "";
      const dDiff = aDate.localeCompare(bDate);
      if (dDiff !== 0) return dDiff;
      return (a.id || "").localeCompare(b.id || "");
    });
    return [allowlistMatches[0]];
  }

  // Precedence 4: Configured fallback endpoint
  if (
    config.fallback &&
    config.fallback.enabled &&
    config.fallback.endpointId
  ) {
    const fallbackEp = availableEndpoints.find(
      (ep) => ep.id === config.fallback.endpointId
    );
    if (fallbackEp) {
      // Check if fallback endpoint explicitly excludes this sender
      const fallbackExclusions = getEndpointExclusions(fallbackEp, config);
      const isFallbackExcluded = fallbackExclusions.some((excl) =>
        matchesContact(excl, candidateIdentifiers)
      );
      if (!isFallbackExcluded) {
        return [fallbackEp];
      }
    }
  }

  // Precedence 5: No delivery when no eligible destination exists and fallback is disabled
  return [];
}

/**
 * Validates endpoint existence against registered endpoints.
 */
function validateEndpointReference(endpointId, customDir) {
  if (!endpointId || typeof endpointId !== "string") {
    throw new Error("endpointId is required.");
  }
  const endpoints = loadEndpoints(customDir);
  if (!endpoints[endpointId]) {
    throw new Error(`Referenced webhook endpoint does not exist: "${endpointId}"`);
  }
  return endpoints[endpointId];
}

/**
 * Adds an explicit contact-to-endpoint routing rule.
 *
 * @param {object} ruleData
 * @param {string} ruleData.contact - Target contact phone or JID
 * @param {string} ruleData.endpointId - ID of destination endpoint
 * @param {number} [ruleData.priority=0] - Priority integer
 * @param {string} [ruleData.name] - Friendly name
 * @param {boolean} [ruleData.enabled=true] - Status
 * @param {string} [customDir]
 * @returns {object} Created rule
 */
function addRule(ruleData = {}, customDir) {
  if (!ruleData.contact || typeof ruleData.contact !== "string" || !ruleData.contact.trim()) {
    throw new Error("A valid contact (phone number or JID) is required.");
  }
  const endpoint = validateEndpointReference(ruleData.endpointId, customDir);

  const norm = normalizeContact(ruleData.contact);
  if (!norm) {
    throw new Error(`Invalid contact identifier: "${ruleData.contact}"`);
  }

  const config = loadRoutingConfig(customDir);
  const id = generateRuleId();
  const now = new Date().toISOString();

  const rule = {
    id,
    contact: norm.canonicalJid || norm.raw,
    rawContact: ruleData.contact.trim(),
    endpointId: endpoint.id,
    priority: Number.isInteger(ruleData.priority) ? ruleData.priority : 0,
    name: typeof ruleData.name === "string" ? ruleData.name.trim() : null,
    enabled: ruleData.enabled !== undefined ? Boolean(ruleData.enabled) : true,
    createdAt: now,
    updatedAt: now,
  };

  config.rules.push(rule);
  saveRoutingConfig(config, customDir);

  return rule;
}

/**
 * Updates an existing routing rule.
 *
 * @param {string} id
 * @param {object} updates
 * @param {string} [customDir]
 * @returns {object} Updated rule
 */
function updateRule(id, updates = {}, customDir) {
  if (!id) throw new Error("Rule ID is required.");
  const config = loadRoutingConfig(customDir);
  const rule = config.rules.find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Routing rule not found: "${id}"`);
  }

  if (updates.contact !== undefined) {
    if (!updates.contact || typeof updates.contact !== "string" || !updates.contact.trim()) {
      throw new Error("Contact must be a non-empty string.");
    }
    const norm = normalizeContact(updates.contact);
    rule.contact = norm.canonicalJid || norm.raw;
    rule.rawContact = updates.contact.trim();
  }

  if (updates.endpointId !== undefined) {
    const endpoint = validateEndpointReference(updates.endpointId, customDir);
    rule.endpointId = endpoint.id;
  }

  if (updates.priority !== undefined) {
    rule.priority = Number.isInteger(updates.priority) ? updates.priority : rule.priority;
  }

  if (updates.name !== undefined) {
    rule.name = typeof updates.name === "string" ? updates.name.trim() : null;
  }

  if (updates.enabled !== undefined) {
    rule.enabled = Boolean(updates.enabled);
  }

  rule.updatedAt = new Date().toISOString();
  saveRoutingConfig(config, customDir);

  return rule;
}

/**
 * Deletes a routing rule by ID.
 *
 * @param {string} id
 * @param {string} [customDir]
 * @returns {{ ok: boolean, id: string }}
 */
function deleteRule(id, customDir) {
  if (!id) throw new Error("Rule ID is required.");
  const config = loadRoutingConfig(customDir);
  const idx = config.rules.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new Error(`Routing rule not found: "${id}"`);
  }

  config.rules.splice(idx, 1);
  saveRoutingConfig(config, customDir);

  return { ok: true, id };
}

/**
 * Retrieves a rule by ID.
 */
function getRule(id, customDir) {
  if (!id) return null;
  const config = loadRoutingConfig(customDir);
  return config.rules.find((r) => r.id === id) || null;
}

/**
 * Lists all explicit routing rules.
 */
function listRules(customDir) {
  const config = loadRoutingConfig(customDir);
  return [...config.rules];
}

/**
 * Configures the fallback endpoint for unmatched contacts.
 *
 * @param {object} params
 * @param {string|null} params.endpointId - Endpoint ID or null to clear
 * @param {boolean} [params.enabled=true] - Whether fallback is active
 * @param {string} [customDir]
 * @returns {object} Fallback configuration
 */
function setFallback({ endpointId, enabled = true } = {}, customDir) {
  const config = loadRoutingConfig(customDir);

  if (endpointId) {
    const endpoint = validateEndpointReference(endpointId, customDir);
    config.fallback = {
      endpointId: endpoint.id,
      enabled: Boolean(enabled),
    };
  } else {
    config.fallback = {
      endpointId: null,
      enabled: false,
    };
  }

  saveRoutingConfig(config, customDir);
  return { ...config.fallback };
}

/**
 * Retrieves current fallback configuration.
 */
function getFallback(customDir) {
  const config = loadRoutingConfig(customDir);
  return { ...config.fallback };
}

/**
 * Sets per-endpoint allowlist and exclusion rules.
 *
 * @param {string} endpointId
 * @param {object} rules
 * @param {string[]} [rules.allowlist]
 * @param {string[]} [rules.exclusion]
 * @param {string} [customDir]
 * @returns {object} Endpoint rules
 */
function setEndpointRules(endpointId, { allowlist, exclusion } = {}, customDir) {
  const endpoint = validateEndpointReference(endpointId, customDir);
  const config = loadRoutingConfig(customDir);

  const cleanList = (list) => {
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        if (!item || typeof item !== "string") return null;
        const norm = normalizeContact(item);
        return norm ? norm.canonicalJid || norm.raw : null;
      })
      .filter(Boolean);
  };

  const current = config.endpointRules[endpoint.id] || { allowlist: [], exclusion: [] };
  const updated = {
    allowlist: allowlist !== undefined ? cleanList(allowlist) : current.allowlist || [],
    exclusion: exclusion !== undefined ? cleanList(exclusion) : current.exclusion || [],
  };

  config.endpointRules[endpoint.id] = updated;
  saveRoutingConfig(config, customDir);

  return { endpointId: endpoint.id, ...updated };
}

/**
 * Retrieves per-endpoint routing rules.
 */
function getEndpointRules(endpointId, customDir) {
  if (!endpointId) return { allowlist: [], exclusion: [] };
  const config = loadRoutingConfig(customDir);
  return config.endpointRules[endpointId] || { allowlist: [], exclusion: [] };
}

/**
 * Clears all routing configuration (rules, endpointRules, fallback).
 */
function clearRoutingConfig(customDir) {
  const empty = createEmptyRoutingConfig();
  saveRoutingConfig(empty, customDir);
  return empty;
}

/**
 * Object-oriented coordinator for webhook routing.
 */
class WebhookRouter {
  constructor(options = {}) {
    this.dataDir = options.dataDir || null;
    this.store = options.store || null;
  }

  resolveDestinations(payload, availableEndpoints, customDir = null, options = {}) {
    return resolveDestinations(
      payload,
      availableEndpoints,
      customDir || this.dataDir,
      options
    );
  }

  addRule(ruleData, customDir = null) {
    return addRule(ruleData, customDir || this.dataDir);
  }

  updateRule(id, updates, customDir = null) {
    return updateRule(id, updates, customDir || this.dataDir);
  }

  deleteRule(id, customDir = null) {
    return deleteRule(id, customDir || this.dataDir);
  }

  getRule(id, customDir = null) {
    return getRule(id, customDir || this.dataDir);
  }

  listRules(customDir = null) {
    return listRules(customDir || this.dataDir);
  }

  setFallback(params, customDir = null) {
    return setFallback(params, customDir || this.dataDir);
  }

  getFallback(customDir = null) {
    return getFallback(customDir || this.dataDir);
  }

  setEndpointRules(endpointId, rules, customDir = null) {
    return setEndpointRules(endpointId, rules, customDir || this.dataDir);
  }

  getEndpointRules(endpointId, customDir = null) {
    return getEndpointRules(endpointId, customDir || this.dataDir);
  }

  clear(customDir = null) {
    return clearRoutingConfig(customDir || this.dataDir);
  }

  getConfig(customDir = null) {
    return loadRoutingConfig(customDir || this.dataDir);
  }
}

module.exports = {
  stripDigits,
  isValidPhoneNumber,
  normalizeContact,
  extractSenderIdentifiers,
  matchesContact,
  createEmptyRoutingConfig,
  getRoutesFilePath,
  loadRoutingConfig,
  saveRoutingConfig,
  resolveDestinations,
  validateEndpointReference,
  addRule,
  updateRule,
  deleteRule,
  getRule,
  listRules,
  setFallback,
  getFallback,
  setEndpointRules,
  getEndpointRules,
  clearRoutingConfig,
  WebhookRouter,
};
