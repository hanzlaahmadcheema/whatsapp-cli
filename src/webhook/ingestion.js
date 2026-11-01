"use strict";

const { WEBHOOK_EVENTS } = require("./constants");
const { normalizePrivacy } = require("./types");
const defaultStore = require("./store");

/**
 * Converts numeric WhatsApp message ACK into standard human-readable name.
 * 0: pending, 1: sent, 2: delivered, 3: read, 4: played, -1: error
 */
function ackToName(ackCode) {
  switch (Number(ackCode)) {
    case 1:
      return "sent";
    case 2:
      return "delivered";
    case 3:
      return "read";
    case 4:
      return "played";
    case 0:
      return "pending";
    case -1:
      return "error";
    default:
      return "unknown";
  }
}

/**
 * Applies endpoint-specific privacy filtering to an outgoing event payload.
 * Returns a cloned and redacted payload preserving original structures.
 *
 * @param {object} payload - The canonical webhook payload
 * @param {object} [privacySettings] - Endpoint privacy configuration
 * @returns {object} Filtered payload
 */
function applyPrivacyFilter(payload, privacySettings = {}) {
  const privacy = normalizePrivacy(privacySettings);
  // Deep clone to prevent cross-endpoint data mutation
  const cloned = JSON.parse(JSON.stringify(payload));
  const data = cloned.data;
  if (!data || typeof data !== "object") return cloned;

  // 1. includeContent: false -> Redact text content (body, caption)
  if (!privacy.includeContent) {
    if ("body" in data) data.body = null;
    if ("caption" in data) data.caption = null;
    if (data.quotedMsg && typeof data.quotedMsg === "object") {
      if ("body" in data.quotedMsg) data.quotedMsg.body = null;
      if ("caption" in data.quotedMsg) data.quotedMsg.caption = null;
    }
  }

  // 2. includeSenderName: false -> Redact senderName
  if (!privacy.includeSenderName) {
    if ("senderName" in data) data.senderName = null;
    if (data.quotedMsg && typeof data.quotedMsg === "object") {
      if ("senderName" in data.quotedMsg) data.quotedMsg.senderName = null;
    }
  }

  // 3. includeMediaMetadata: false -> Redact media metadata (filename, mimetype, filesize, media object)
  if (!privacy.includeMediaMetadata) {
    if ("media" in data) data.media = null;
    if ("mimetype" in data) data.mimetype = null;
    if ("filename" in data) data.filename = null;
    if ("filesize" in data) data.filesize = null;
    if (data.quotedMsg && typeof data.quotedMsg === "object") {
      if ("media" in data.quotedMsg) data.quotedMsg.media = null;
      if ("mimetype" in data.quotedMsg) data.quotedMsg.mimetype = null;
      if ("filename" in data.quotedMsg) data.quotedMsg.filename = null;
      if ("filesize" in data.quotedMsg) data.quotedMsg.filesize = null;
    }
  }

  return cloned;
}

/**
 * Creates canonical webhook event payload format.
 */
function createEventPayload({
  event,
  data,
  account = null,
  eventId = null,
  timestamp = Math.floor(Date.now() / 1000),
}) {
  return {
    id: eventId || `evt_${event.replace(/\./g, "_")}_${Date.now()}`,
    event,
    timestamp,
    account: account
      ? {
          number: account.number || null,
          name: account.name || null,
          jid: account.jid || null,
        }
      : null,
    data,
  };
}

/**
 * Webhook Event Bridge connecting Daemon/WhatsApp events to the Webhook Engine.
 */
class WebhookBridge {
  constructor(options = {}) {
    this.service = options.service || null;
    this.queue = options.queue || null;
    this.dataDir = options.dataDir || undefined;
    this.store = options.store || defaultStore;
    this.account = options.account || null;

    // Deduplication cache
    this.seenEvents = new Map(); // key -> timestamp
    this.maxSeen = options.maxSeen || 5000;
    this.lastState = null;

    // Subscriptions
    this._unsubService = null;
    this._clientListeners = [];
    this._started = false;
  }

  /**
   * Starts listening to daemon broadcaster and WhatsApp client events.
   */
  start() {
    if (this._started) return;
    this._started = true;

    // 1. Subscribe to WhatsAppService event broadcaster
    if (this.service && typeof this.service.subscribe === "function") {
      this._unsubService = this.service.subscribe((rawEvent) => {
        try {
          this.handleBroadcastEvent(rawEvent);
        } catch (_) {}
      });
    }

    // 2. Attach to client-level ack and update events if client is available
    this._attachClientEvents();
  }

  /**
   * Attaches listeners directly to client emitter for ack, edit, and revoke.
   */
  _attachClientEvents() {
    const client =
      this.service?.controller?.client?.client ||
      this.service?.controller?.client ||
      this.service?.client;

    if (client && typeof client.on === "function") {
      const onAck = (msg, ack) => {
        try {
          const msgId = msg?.id?._serialized || msg?.id || null;
          const chatId = msg?.to || msg?.chatId || msg?.from || null;
          if (msgId) {
            this.ingestAck({
              messageId: msgId,
              chatId,
              ack,
              timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
            });
          }
        } catch (_) {}
      };

      const onEdit = (msg, newBody) => {
        try {
          const msgId = msg?.id?._serialized || msg?.id || null;
          const chatId = msg?.chatId || msg?.to || msg?.from || null;
          if (msgId) {
            this.ingestUpdate({
              messageId: msgId,
              chatId,
              updateType: "edit",
              body: newBody || msg.body || "",
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        } catch (_) {}
      };

      const onRevoke = (after, before) => {
        try {
          const msg = before || after;
          const msgId = msg?.id?._serialized || msg?.id || null;
          const chatId = msg?.chatId || msg?.to || msg?.from || null;
          if (msgId) {
            this.ingestUpdate({
              messageId: msgId,
              chatId,
              updateType: "revoke",
              body: null,
              timestamp: Math.floor(Date.now() / 1000),
            });
          }
        } catch (_) {}
      };

      client.on("message_ack", onAck);
      client.on("message_edit", onEdit);
      client.on("message_revoke_everyone", onRevoke);

      // Multi-device & LID change listener bridge:
      // In WhatsApp Web 2.3000+, incoming messages from Linked Identity (@lid) chats or
      // delayed decrypted payloads often trigger Backbone 'change' or 'change:type' rather
      // than 'add'. Injecting a safety hook ensures onAddMessageEvent is reliably dispatched.
      const installPageHooks = async () => {
        try {
          if (client.pupPage && !client.pupPage.isClosed()) {
            await client.pupPage.evaluate(() => {
              if (window._wwebjsLidPatchInstalled) return;
              window._wwebjsLidPatchInstalled = true;

              try {
                const { Msg } = window.require("WAWebCollections");
                window._wwebjsSeenIds = window._wwebjsSeenIds || new Set();

                if (Msg && Msg._models) {
                  for (const m of Msg._models) {
                    const id = m.id?._serialized || m.id;
                    if (id) window._wwebjsSeenIds.add(id);
                  }
                }

                const handleMsg = (m) => {
                  if (!m) return;
                  const id = m.id?._serialized || m.id;
                  if (!id || window._wwebjsSeenIds.has(id)) return;
                  if (m.type === "ciphertext") return;
                  if (!m.isNewMsg) return;

                  window._wwebjsSeenIds.add(id);
                  if (window._wwebjsSeenIds.size > 2000) {
                    const oldest = window._wwebjsSeenIds.values().next().value;
                    window._wwebjsSeenIds.delete(oldest);
                  }

                  if (typeof window.onAddMessageEvent === "function") {
                    try {
                      window.onAddMessageEvent(window.WWebJS.getMessageModel(m));
                    } catch (_) {}
                  }
                };

                Msg.on("add", handleMsg);
                Msg.on("change", handleMsg);
                Msg.on("change:type", handleMsg);
              } catch (_) {}
            });
          }
        } catch (_) {}
      };

      if (client.pupPage) {
        installPageHooks().catch(() => {});
      }
      client.on("ready", installPageHooks);

      this._clientListeners.push(
        { emitter: client, event: "message_ack", fn: onAck },
        { emitter: client, event: "message_edit", fn: onEdit },
        { emitter: client, event: "message_revoke_everyone", fn: onRevoke },
        { emitter: client, event: "ready", fn: installPageHooks }
      );
    }
  }

  /**
   * Stops listening and cleans up event handlers.
   */
  stop() {
    if (!this._started) return;
    this._started = false;

    if (this._unsubService) {
      this._unsubService();
      this._unsubService = null;
    }

    for (const { emitter, event, fn } of this._clientListeners) {
      try {
        if (typeof emitter.removeListener === "function") {
          emitter.removeListener(event, fn);
        }
      } catch (_) {}
    }
    this._clientListeners = [];
  }

  /**
   * Handles incoming broadcast events from WhatsAppService.
   */
  handleBroadcastEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== "object") return;
    const type = rawEvent.event;

    // 1. Message event (incoming or outgoing)
    if (type === "message") {
      this.ingestMessage(rawEvent);
      return;
    }

    // 2. Session state events
    if (type === "state" || type === "logged_out") {
      const state = type === "logged_out" ? "logged_out" : rawEvent.state;
      this.ingestState(state, this.lastState, rawEvent.reason || null);
      return;
    }

    // 3. Explicit message.ack event
    if (type === "message_ack" || type === "message.ack") {
      this.ingestAck(rawEvent);
      return;
    }

    // 4. Explicit message.updated event
    if (type === "message_updated" || type === "message.updated") {
      this.ingestUpdate(rawEvent);
      return;
    }
  }

  /**
   * Ingests and maps an enriched message into message.received, message.sent, and media.received.
   */
  ingestMessage(summary, options = {}) {
    if (!summary || !summary.id) return;
    const messageId = summary.id;
    const isFromMe = Boolean(summary.fromMe || summary.from === "me");
    const eventType = isFromMe ? "message.sent" : "message.received";
    const dedupKey = `${eventType}:${messageId}`;

    if (this.isDuplicate(dedupKey)) {
      return;
    }
    this.markSeen(dedupKey);

    const timestamp = summary.timestamp || Math.floor(Date.now() / 1000);
    const accountInfo = options.account || this.service?.account || this.account;

    // Build common message data structure
    const messageData = {
      messageId,
      chatId: summary.chatId || (isFromMe ? summary.to : summary.from) || null,
      chatName: summary.chatName || null,
      from: summary.from || (isFromMe ? "me" : null),
      to: summary.to || null,
      author: summary.author || null,
      senderName: summary.senderName || null,
      body: summary.body || "",
      timestamp,
      isGroup: Boolean(summary.isGroup),
      fromMe: isFromMe,
      hasMedia: Boolean(summary.hasMedia),
      type: summary.type || (summary.hasMedia ? "media" : "chat"),
      media: summary.hasMedia
        ? {
            mimetype: summary.mimetype || null,
            filename: summary.filename || null,
            filesize: summary.filesize || null,
            caption: summary.caption || "",
          }
        : null,
      hasQuotedMsg: Boolean(summary.hasQuotedMsg),
      quotedMsg: summary.quotedMsg || null,
    };

    // 1. Dispatch message.received or message.sent
    const eventId = isFromMe ? `evt_snt_${messageId}` : `evt_rcv_${messageId}`;
    const payload = createEventPayload({
      event: eventType,
      data: messageData,
      account: accountInfo,
      eventId,
      timestamp,
    });

    this.dispatchToSubscribers(eventType, payload);

    // 2. If message contains media, also trigger media.received
    if (summary.hasMedia && !isFromMe) {
      const mediaDedupKey = `media.received:${messageId}`;
      if (!this.isDuplicate(mediaDedupKey)) {
        this.markSeen(mediaDedupKey);

        const mediaData = {
          messageId,
          chatId: messageData.chatId,
          chatName: messageData.chatName,
          from: messageData.from,
          senderName: messageData.senderName,
          timestamp,
          isGroup: messageData.isGroup,
          type: summary.type || "media",
          caption: summary.caption || "",
          media: {
            mimetype: summary.mimetype || null,
            filename: summary.filename || null,
            filesize: summary.filesize || null,
            hasMedia: true,
          },
        };

        const mediaPayload = createEventPayload({
          event: "media.received",
          data: mediaData,
          account: accountInfo,
          eventId: `evt_med_${messageId}`,
          timestamp,
        });

        this.dispatchToSubscribers("media.received", mediaPayload);
      }
    }
  }

  /**
   * Ingests session state changes (ready, connecting, syncing, logged_out, error).
   */
  ingestState(state, previousState = null, details = null) {
    if (!state) return;
    // Suppress duplicate state emissions (especially across transient polling or reconnect loops)
    if (this.lastState === state) {
      return;
    }
    const oldState = previousState || this.lastState;
    this.lastState = state;

    const timestamp = Math.floor(Date.now() / 1000);
    const eventId = `evt_sta_${state}_${timestamp}`;

    const payload = createEventPayload({
      event: "session.state",
      data: {
        state,
        previousState: oldState || null,
        timestamp,
        details: details || null,
      },
      account: this.service?.account || this.account,
      eventId,
      timestamp,
    });

    this.dispatchToSubscribers("session.state", payload);
  }

  /**
   * Ingests message ACK (sent, delivered, read, played).
   */
  ingestAck(params = {}) {
    const { messageId, chatId, ack, timestamp } = params;
    if (!messageId || ack === undefined || ack === null) return;

    const dedupKey = `message.ack:${messageId}:${ack}`;
    if (this.isDuplicate(dedupKey)) {
      return;
    }
    this.markSeen(dedupKey);

    const ts = timestamp || Math.floor(Date.now() / 1000);
    const eventId = `evt_ack_${messageId}_${ack}`;

    const payload = createEventPayload({
      event: "message.ack",
      data: {
        messageId,
        chatId: chatId || null,
        ack: Number(ack),
        ackName: ackToName(ack),
        timestamp: ts,
      },
      account: this.service?.account || this.account,
      eventId,
      timestamp: ts,
    });

    this.dispatchToSubscribers("message.ack", payload);
  }

  /**
   * Ingests message edits and revokes.
   */
  ingestUpdate(params = {}) {
    const { messageId, chatId, updateType = "update", body = null, timestamp } = params;
    if (!messageId) return;

    const ts = timestamp || Math.floor(Date.now() / 1000);
    const eventId = `evt_upd_${messageId}_${ts}`;

    const payload = createEventPayload({
      event: "message.updated",
      data: {
        messageId,
        chatId: chatId || null,
        updateType,
        body,
        timestamp: ts,
      },
      account: this.service?.account || this.account,
      eventId,
      timestamp: ts,
    });

    this.dispatchToSubscribers("message.updated", payload);
  }

  /**
   * Dispatches an event payload to all matching, enabled endpoints.
   * Applies endpoint-specific privacy settings and enqueues asynchronously.
   */
  dispatchToSubscribers(eventType, payload) {
    if (!this.queue) return;

    let endpoints = [];
    try {
      endpoints = this.store.findEndpointsForEvent(eventType, this.dataDir);
    } catch (_) {
      return;
    }

    if (!endpoints || endpoints.length === 0) return;

    for (const ep of endpoints) {
      // 1. Strict boundary: Disabled endpoints receive nothing
      if (!ep.enabled) continue;

      // 2. Strict boundary: Unsubscribed event types receive nothing
      const subscribed =
        ep.events.includes("*") || ep.events.includes(eventType);
      if (!subscribed) continue;

      try {
        // 3. Apply endpoint-specific privacy settings
        const filteredPayload = applyPrivacyFilter(payload, ep.privacy);

        // 4. Asynchronously enqueue to persistent delivery queue
        this.queue.enqueue({
          endpointId: ep.id,
          url: ep.url,
          eventType,
          payload: filteredPayload,
          eventId: payload.id,
        });
      } catch (_) {}
    }
  }

  isDuplicate(key) {
    return this.seenEvents.has(key);
  }

  markSeen(key) {
    this.seenEvents.set(key, Date.now());
    if (this.seenEvents.size > this.maxSeen) {
      // Prune oldest 20%
      const entries = Array.from(this.seenEvents.entries());
      entries.sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, Math.floor(this.maxSeen * 0.2));
      for (const [k] of toRemove) {
        this.seenEvents.delete(k);
      }
    }
  }

  clearSeen() {
    this.seenEvents.clear();
    this.lastState = null;
  }
}

module.exports = {
  ackToName,
  applyPrivacyFilter,
  createEventPayload,
  WebhookBridge,
};
