"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  DEFAULT_WEBHOOK_DIR,
  DEFAULT_QUEUE_FILE,
  DEFAULT_HISTORY_FILE,
  DELIVERY_STATUS,
  DEFAULT_QUEUE_CONFIG,
  PERMISSIONS,
} = require("./constants");
const {
  generateDeliveryId,
  generateEventId,
  calculateBackoff,
  sanitizeDelivery,
  normalizeProfile,
} = require("./types");
const { dispatchWebhookRequest } = require("./http");
const { ensureWebhookDir, getEndpoint } = require("./store");
const {
  formatPayloadForProfile,
  checkProfileBodyConstraints,
} = require("./profiles");

/**
 * Resolves safe queue file path preventing symlinks and path traversal.
 */
function getQueueFilePath(customDir) {
  const dir = ensureWebhookDir(customDir);
  const target = path.resolve(dir, DEFAULT_QUEUE_FILE);
  if (!target.startsWith(path.resolve(dir))) {
    throw new Error("Path traversal detected in queue file path.");
  }
  return target;
}

/**
 * Resolves safe history file path preventing symlinks and path traversal.
 */
function getHistoryFilePath(customDir) {
  const dir = ensureWebhookDir(customDir);
  const target = path.resolve(dir, DEFAULT_HISTORY_FILE);
  if (!target.startsWith(path.resolve(dir))) {
    throw new Error("Path traversal detected in history file path.");
  }
  return target;
}

/**
 * Atomically writes data to disk with fsync and 0600 permissions.
 */
function atomicWriteJson(targetFile, data, customDir) {
  const dir = ensureWebhookDir(customDir);
  const baseName = path.basename(targetFile);
  const tmpFile = path.join(
    dir,
    `.${baseName}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  );

  const payload = JSON.stringify(data, null, 2);
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
 * Safely loads JSON file from disk.
 */
function loadJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic link detected for storage file: "${filePath}"`);
    }
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Durable Delivery Queue with Bounded Concurrency, Isolation,
 * Backoff with Jitter, and Crash Recovery.
 */
class DeliveryQueue {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DEFAULT_WEBHOOK_DIR;
    this.concurrency = options.concurrency || DEFAULT_QUEUE_CONFIG.concurrency;
    this.perEndpointConcurrency =
      options.perEndpointConcurrency ||
      DEFAULT_QUEUE_CONFIG.perEndpointConcurrency;
    this.maxAttempts =
      options.maxAttempts || DEFAULT_QUEUE_CONFIG.maxAttempts;
    this.timeoutMs = options.timeoutMs || DEFAULT_QUEUE_CONFIG.timeoutMs;
    this.maxHistoryEntries =
      options.maxHistoryEntries || DEFAULT_QUEUE_CONFIG.maxHistoryEntries;
    this.historyRetentionMs =
      options.historyRetentionMs || DEFAULT_QUEUE_CONFIG.historyRetentionMs;

    this.backoffOptions = {
      initialBackoffMs:
        options.initialBackoffMs || DEFAULT_QUEUE_CONFIG.initialBackoffMs,
      maxBackoffMs:
        options.maxBackoffMs || DEFAULT_QUEUE_CONFIG.maxBackoffMs,
      backoffFactor:
        options.backoffFactor || DEFAULT_QUEUE_CONFIG.backoffFactor,
      jitter: options.jitter !== undefined ? options.jitter : true,
    };

    // Store custom dependency injection (optional, e.g. for testing)
    this._getEndpointFn = options.getEndpointFn || getEndpoint;
    this._dispatchFn = options.dispatchFn || dispatchWebhookRequest;

    // In-memory queue state (synced to queue.json)
    this._deliveries = new Map(); // deliveryId -> delivery
    // In-memory history state (synced to history.json)
    this._history = []; // array of completed delivery records

    // Concurrency tracking
    this._activeTotal = 0;
    this._activePerEndpoint = new Map(); // endpointId -> count
    this._inFlightPromises = new Set();

    // Scheduling and shutdown
    this._timer = null;
    this._shuttingDown = false;
    this._initialized = false;
  }

  /**
   * Initializes queue, loads state from disk, and runs crash recovery.
   */
  async init({ autoProcess = true } = {}) {
    if (this._initialized) return;
    ensureWebhookDir(this.dataDir);

    const queuePath = getQueueFilePath(this.dataDir);
    const historyPath = getHistoryFilePath(this.dataDir);

    // 1. Load active queue
    const rawQueue = loadJsonFile(queuePath) || {};
    this._deliveries.clear();
    for (const [id, item] of Object.entries(rawQueue)) {
      this._deliveries.set(id, item);
    }

    // 2. Load history
    const rawHistory = loadJsonFile(historyPath) || [];
    this._history = Array.isArray(rawHistory) ? rawHistory : [];

    // 3. Crash recovery: recover items stuck in "delivering"
    this.recover();

    this._initialized = true;
    if (autoProcess) {
      this.processQueue();
    }
  }

  /**
   * Recovers deliveries that were in-flight when the process previously exited or crashed.
   * Resets status to "pending" with immediate eligibility.
   *
   * @returns {number} Number of recovered deliveries
   */
  recover() {
    let recoveredCount = 0;
    const now = Date.now();

    for (const delivery of this._deliveries.values()) {
      if (delivery.status === DELIVERY_STATUS.DELIVERING) {
        delivery.status = DELIVERY_STATUS.PENDING;
        delivery.nextAttemptAt = now;
        delivery.updatedAt = new Date(now).toISOString();
        if (!delivery.history) delivery.history = [];
        delivery.history.push({
          attempt: delivery.attempts,
          timestamp: now,
          recovered: true,
          note: "Recovered from ungraceful shutdown/crash",
        });
        recoveredCount++;
      }
    }

    if (recoveredCount > 0) {
      this._saveQueue();
    }

    return recoveredCount;
  }

  /**
   * Persists active queue to disk atomically.
   */
  _saveQueue() {
    const queuePath = getQueueFilePath(this.dataDir);
    const plainObj = {};
    for (const [id, item] of this._deliveries.entries()) {
      plainObj[id] = item;
    }
    atomicWriteJson(queuePath, plainObj, this.dataDir);
  }

  /**
   * Persists history to disk atomically.
   */
  _saveHistory() {
    const historyPath = getHistoryFilePath(this.dataDir);
    atomicWriteJson(historyPath, this._history, this.dataDir);
  }

  /**
   * Enqueues an event for a target endpoint.
   *
   * @param {object} params
   * @param {string} params.endpointId - ID of target endpoint
   * @param {string} [params.url] - Target URL (auto-fetched from store if omitted)
   * @param {string} params.eventType - Event type (e.g. "message.received")
   * @param {object|string} params.payload - Event payload
   * @param {string} [params.eventId] - Event ID (auto-generated if omitted)
   * @param {number} [params.maxAttempts] - Custom max attempts
   * @returns {object} Sanitized delivery record
   */
  enqueue(params) {
    if (!params.endpointId) {
      throw new Error("endpointId is required to enqueue a delivery.");
    }
    if (!params.eventType) {
      throw new Error("eventType is required to enqueue a delivery.");
    }

    const deliveryId = generateDeliveryId();
    const eventId = params.eventId || generateEventId();
    const now = Date.now();
    const isoNow = new Date(now).toISOString();

    // Determine target profile and persist exact serialized body
    let profile = params.profile;
    if (!profile) {
      try {
        const ep = this._getEndpointFn(params.endpointId, this.dataDir);
        if (ep && ep.profile) profile = ep.profile;
      } catch (_) {}
    }
    const normalizedProfile = normalizeProfile(profile);

    // If params.rawBody is provided, use it; otherwise format payload for profile and serialize
    let rawBody = params.rawBody;
    let payload = params.payload;
    if (rawBody === undefined || rawBody === null) {
      const formatted = formatPayloadForProfile(normalizedProfile, payload);
      rawBody = typeof formatted === "string" ? formatted : JSON.stringify(formatted);
      payload = formatted;
    } else if (typeof rawBody !== "string") {
      rawBody = JSON.stringify(rawBody);
    }

    const delivery = {
      id: deliveryId,
      eventId,
      endpointId: params.endpointId,
      url: params.url || null,
      eventType: params.eventType,
      profile: normalizedProfile,
      rawBody, // Persist exact serialized body across retries!
      payload,
      status: DELIVERY_STATUS.PENDING,
      attempts: 0,
      maxAttempts: params.maxAttempts || this.maxAttempts,
      createdAt: isoNow,
      updatedAt: isoNow,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      manualRetries: 0,
      history: [],
    };

    this._deliveries.set(deliveryId, delivery);
    this._saveQueue();

    if (!this._shuttingDown) {
      this.processQueue();
    }

    return sanitizeDelivery(delivery);
  }

  /**
   * Dispatches next ready items adhering to global concurrency bounds
   * and per-endpoint isolation limits.
   */
  processQueue() {
    if (this._shuttingDown) return;

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const now = Date.now();
    let nextWakeupDelay = null;

    // 1. Check if global concurrency limit is reached
    if (this._activeTotal >= this.concurrency) {
      return;
    }

    // 2. Identify candidates eligible for delivery
    const eligible = [];

    for (const delivery of this._deliveries.values()) {
      if (
        delivery.status === DELIVERY_STATUS.PENDING ||
        delivery.status === DELIVERY_STATUS.FAILED
      ) {
        if (delivery.nextAttemptAt <= now) {
          // Check per-endpoint active limit
          const activeForEndpoint =
            this._activePerEndpoint.get(delivery.endpointId) || 0;
          if (activeForEndpoint < this.perEndpointConcurrency) {
            eligible.push(delivery);
          }
        } else {
          // Calculate delay until this item is eligible
          const delay = delivery.nextAttemptAt - now;
          if (nextWakeupDelay === null || delay < nextWakeupDelay) {
            nextWakeupDelay = delay;
          }
        }
      }
    }

    // 3. Sort eligible by creation time (FIFO ordering per endpoint)
    eligible.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // 4. Dispatch candidates up to global capacity
    for (const delivery of eligible) {
      if (this._activeTotal >= this.concurrency) break;

      const activeForEndpoint =
        this._activePerEndpoint.get(delivery.endpointId) || 0;
      if (activeForEndpoint >= this.perEndpointConcurrency) continue;

      this._dispatchDelivery(delivery);
    }

    // 5. Schedule wakeup for next backoff interval if any items are waiting
    if (nextWakeupDelay !== null && !this._shuttingDown) {
      this._timer = setTimeout(() => {
        this.processQueue();
      }, Math.max(25, nextWakeupDelay));
      if (this._timer.unref) {
        this._timer.unref();
      }
    }
  }

  /**
   * Dispatches a single delivery item asynchronously.
   */
  async _dispatchDelivery(delivery) {
    const endpointId = delivery.endpointId;

    // Update active counters and item status
    this._activeTotal++;
    const currentActive = this._activePerEndpoint.get(endpointId) || 0;
    this._activePerEndpoint.set(endpointId, currentActive + 1);

    delivery.status = DELIVERY_STATUS.DELIVERING;
    delivery.updatedAt = new Date().toISOString();
    this._saveQueue();

    const dispatchPromise = (async () => {
      let endpoint = null;
      try {
        endpoint = this._getEndpointFn(endpointId, this.dataDir, {
          exposeSecret: true,
        });
      } catch (_) {}

      // If endpoint is not found or disabled, dead-letter immediately
      if (!endpoint || !endpoint.enabled) {
        return {
          success: false,
          statusCode: null,
          statusMessage: null,
          durationMs: 0,
          error: !endpoint
            ? `Endpoint "${endpointId}" not found`
            : `Endpoint "${endpointId}" is disabled`,
          retryable: false,
          responseBody: null,
        };
      }

      const targetUrl = delivery.url || endpoint.url;
      const secret = endpoint.secret;
      const profile = delivery.profile || endpoint.profile || "generic";

      // Ensure stable rawBody is present and reused
      const rawBody =
        delivery.rawBody !== undefined && delivery.rawBody !== null
          ? delivery.rawBody
          : typeof delivery.payload === "string"
          ? delivery.payload
          : JSON.stringify(delivery.payload);

      return await this._dispatchFn({
        url: targetUrl,
        rawBody,
        payload: delivery.payload,
        secret,
        eventId: delivery.eventId,
        deliveryId: delivery.id, // Stable delivery ID across retries
        profile,
        options: {
          security: endpoint.security,
          timeoutMs: this.timeoutMs,
          profile,
        },
      });
    })();

    this._inFlightPromises.add(dispatchPromise);

    try {
      const result = await dispatchPromise;
      this._handleDeliveryResult(delivery, result);
    } catch (unexpectedErr) {
      this._handleDeliveryResult(delivery, {
        success: false,
        statusCode: null,
        statusMessage: null,
        durationMs: 0,
        error: unexpectedErr.message || "Unexpected dispatcher error",
        retryable: false,
        responseBody: null,
      });
    } finally {
      this._inFlightPromises.delete(dispatchPromise);

      // Decrement active counters
      this._activeTotal = Math.max(0, this._activeTotal - 1);
      const remainingForEndpoint =
        (this._activePerEndpoint.get(endpointId) || 1) - 1;
      if (remainingForEndpoint <= 0) {
        this._activePerEndpoint.delete(endpointId);
      } else {
        this._activePerEndpoint.set(endpointId, remainingForEndpoint);
      }

      // Continue queue loop
      if (!this._shuttingDown) {
        this.processQueue();
      }
    }
  }

  /**
   * Processes the result of a delivery attempt (success, retry, or dead-letter).
   */
  _handleDeliveryResult(delivery, result) {
    const now = Date.now();
    const isoNow = new Date(now).toISOString();

    delivery.attempts++;
    delivery.lastAttemptAt = isoNow;
    delivery.updatedAt = isoNow;
    delivery.lastStatusCode = result.statusCode;
    delivery.lastError = result.error;

    if (!delivery.history) delivery.history = [];
    delivery.history.push({
      attempt: delivery.attempts,
      timestamp: now,
      durationMs: result.durationMs,
      statusCode: result.statusCode,
      error: result.error,
      success: result.success,
    });

    if (result.success) {
      // 1. Success -> Complete delivery
      delivery.status = DELIVERY_STATUS.SUCCEEDED;
      delivery.completedAt = isoNow;
      this._moveToHistory(delivery);
    } else if (!result.retryable || delivery.attempts >= delivery.maxAttempts) {
      // 2. Dead-letter -> Exhausted attempts or non-retryable error
      delivery.status = DELIVERY_STATUS.DEAD_LETTER;
      delivery.completedAt = isoNow;
      this._moveToHistory(delivery);
    } else {
      // 3. Transient failure -> Schedule exponential backoff with jitter
      delivery.status = DELIVERY_STATUS.FAILED;
      const delayMs = calculateBackoff(delivery.attempts, this.backoffOptions);
      delivery.nextAttemptAt = now + delayMs;
      this._saveQueue();
    }
  }

  /**
   * Moves a completed delivery from active queue to history and enforces retention.
   */
  _moveToHistory(delivery) {
    this._deliveries.delete(delivery.id);
    this._history.unshift(sanitizeDelivery(delivery));
    this.pruneHistory();
    this._saveQueue();
    this._saveHistory();
  }

  /**
   * Enforces bounded retention on delivery history:
   * Prunes records exceeding max entries or older than retention period.
   */
  pruneHistory(options = {}) {
    const maxEntries =
      typeof options.maxEntries === "number"
        ? options.maxEntries
        : this.maxHistoryEntries;
    const retentionMs =
      typeof options.retentionMs === "number"
        ? options.retentionMs
        : this.historyRetentionMs;
    const now = Date.now();
    const cutoffTime = now - retentionMs;

    // Filter out entries older than retention period
    let pruned = this._history.filter((entry) => {
      const completedTime = entry.completedAt
        ? new Date(entry.completedAt).getTime()
        : new Date(entry.updatedAt).getTime();
      return completedTime >= cutoffTime;
    });

    // If still exceeding max capacity, keep newest
    if (pruned.length > maxEntries) {
      pruned = pruned.slice(0, maxEntries);
    }

    this._history = pruned;
    this._saveHistory();
    return this._history.length;
  }

  /**
   * Manually retries a delivery.
   * Prevents duplicate active deliveries and transitions failed/dead-letter to pending.
   *
   * @param {string} deliveryId
   * @returns {object} Updated sanitized delivery record
   */
  retryDelivery(deliveryId) {
    if (!deliveryId) {
      throw new Error("deliveryId is required for manual retry.");
    }

    // 1. Check in active queue
    let delivery = this._deliveries.get(deliveryId);

    if (delivery) {
      if (delivery.status === DELIVERY_STATUS.DELIVERING) {
        throw new Error(
          `Cannot retry delivery "${deliveryId}": delivery is currently in progress.`
        );
      }
      if (delivery.status === DELIVERY_STATUS.PENDING) {
        delivery.nextAttemptAt = Date.now();
        this._saveQueue();
        this.processQueue();
        return sanitizeDelivery(delivery);
      }

      // Status is failed or dead_letter
      delivery.status = DELIVERY_STATUS.PENDING;
      delivery.nextAttemptAt = Date.now();
      delivery.manualRetries = (delivery.manualRetries || 0) + 1;
      delivery.updatedAt = new Date().toISOString();
      this._saveQueue();
      const snapshot = sanitizeDelivery(delivery);
      this.processQueue();
      return snapshot;
    }

    // 2. Check in history
    const historyIndex = this._history.findIndex((d) => d.id === deliveryId);
    if (historyIndex !== -1) {
      const [historyItem] = this._history.splice(historyIndex, 1);
      historyItem.status = DELIVERY_STATUS.PENDING;
      historyItem.nextAttemptAt = Date.now();
      historyItem.manualRetries = (historyItem.manualRetries || 0) + 1;
      historyItem.updatedAt = new Date().toISOString();
      delete historyItem.completedAt;

      this._deliveries.set(deliveryId, historyItem);
      this._saveQueue();
      this._saveHistory();

      const snapshot = sanitizeDelivery(historyItem);
      this.processQueue();
      return snapshot;
    }

    throw new Error(`Delivery record not found: "${deliveryId}"`);
  }

  /**
   * Returns a single delivery by ID from active queue or history.
   */
  getDelivery(deliveryId) {
    if (!deliveryId) return null;
    const active = this._deliveries.get(deliveryId);
    if (active) return sanitizeDelivery(active);

    const historical = this._history.find((d) => d.id === deliveryId);
    if (historical) return sanitizeDelivery(historical);

    return null;
  }

  /**
   * Lists deliveries with optional filtering and pagination.
   */
  listDeliveries(filter = {}) {
    let items = [];

    // Active
    for (const d of this._deliveries.values()) {
      items.push(sanitizeDelivery(d));
    }
    // Completed
    items.push(...this._history.map((d) => sanitizeDelivery(d)));

    if (filter.endpointId) {
      items = items.filter((d) => d.endpointId === filter.endpointId);
    }
    if (filter.status) {
      items = items.filter((d) => d.status === filter.status);
    }
    if (filter.eventType) {
      items = items.filter((d) => d.eventType === filter.eventType);
    }

    // Sort newest first
    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const offset = Math.max(0, parseInt(filter.offset, 10) || 0);
    const limit = Math.min(
      Math.max(1, parseInt(filter.limit, 10) || 50),
      500
    );

    return {
      total: items.length,
      offset,
      limit,
      deliveries: items.slice(offset, offset + limit),
    };
  }

  /**
   * Returns queue operational statistics.
   */
  getStats() {
    let pending = 0;
    let delivering = 0;
    let failed = 0;
    let succeeded = 0;
    let deadLetter = 0;

    for (const d of this._deliveries.values()) {
      if (d.status === DELIVERY_STATUS.PENDING) pending++;
      else if (d.status === DELIVERY_STATUS.DELIVERING) delivering++;
      else if (d.status === DELIVERY_STATUS.FAILED) failed++;
    }

    for (const d of this._history) {
      if (d.status === DELIVERY_STATUS.SUCCEEDED) succeeded++;
      else if (d.status === DELIVERY_STATUS.DEAD_LETTER) deadLetter++;
    }

    return {
      activeDeliveries: this._activeTotal,
      pending,
      delivering,
      failed,
      succeeded,
      deadLetter,
      historyCount: this._history.length,
    };
  }

  /**
   * Gracefully shuts down the delivery queue:
   * Stops accepting deliveries, clears timers, drains in-flight requests up to timeoutMs.
   */
  async shutdown({ timeoutMs = 5000 } = {}) {
    this._shuttingDown = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (this._inFlightPromises.size > 0) {
      const drainPromise = Promise.all(Array.from(this._inFlightPromises));
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(resolve, timeoutMs)
      );
      await Promise.race([drainPromise, timeoutPromise]);
    }

    this._saveQueue();
    this._saveHistory();
    return true;
  }
}

module.exports = {
  getQueueFilePath,
  getHistoryFilePath,
  DeliveryQueue,
};
