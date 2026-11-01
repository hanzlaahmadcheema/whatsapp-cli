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
          lid: account.lid || null,
        }
      : null,
    data,
  };
}

/**
 * Set of webhook event types that are strictly excluded from queue delivery.
 * Per specification: delivery receipts, read receipts, session/connection state,
 * edits/revocations, and outgoing messages must never reach the persistent queue.
 */
const EXCLUDED_WEBHOOK_EVENTS = new Set([
  "message.sent",
  "message.ack",
  "message.updated",
  "session.state",
  "session.qr",
]);

/**
 * Checks whether an incoming message or broadcast event originated from or targets
 * a WhatsApp Channel (Newsletter), broadcast channel, or status broadcast.
 *
 * @param {object} summary - Message summary or raw event
 * @returns {boolean} True if identified as Channel or Broadcast
 */
function isChannelOrBroadcast(summary) {
  if (!summary || typeof summary !== "object") return false;

  // 1. Explicit boolean or type flags
  if (Boolean(summary.isNewsletter || summary._data?.isNewsletter)) return true;
  if (Boolean(summary.broadcast || summary._data?.broadcast)) return true;
  if (Boolean(summary.isStatus || summary.isStatusV3 || summary._data?.isStatusV3)) return true;
  if (summary.server === "newsletter" || summary._data?.server === "newsletter") return true;
  if (summary.type === "newsletter_notification") return true;

  // 2. Check JID fields for @newsletter or @broadcast
  const fieldsToCheck = [
    summary.chatId,
    summary.from,
    summary.to,
    summary.author,
    typeof summary.id === "object" ? summary.id?.remote : summary.id,
    summary._data?.id?.remote,
    summary.reaction?.parentMsgKey?.remote,
  ];

  for (const field of fieldsToCheck) {
    if (typeof field === "string") {
      const lower = field.toLowerCase();
      if (lower.includes("@newsletter") || lower.endsWith("@newsletter")) return true;
      if (lower.includes("@broadcast") || lower.endsWith("@broadcast") || lower === "status@broadcast") return true;
    }
  }

  // 3. Channel reactions: reaction where parent or target chat is newsletter
  if (summary.type === "reaction" && summary.reaction && typeof summary.reaction === "object") {
    const targetChat =
      summary.reaction.chatId ||
      summary.reaction.msgKey?.remote ||
      summary.reaction.parentMsgKey?.remote;
    if (typeof targetChat === "string" && targetChat.toLowerCase().includes("@newsletter")) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves all identifier forms for the authenticated WhatsApp account.
 *
 * @param {object} accountInfo - Account object
 * @returns {{ ids: Set<string>, numbers: Set<string> }} Sets of normalized IDs and numbers
 */
function getAccountIdentifiers(accountInfo) {
  const ids = new Set();
  const numbers = new Set();

  if (!accountInfo) return { ids, numbers };

  const addVal = (val) => {
    if (!val || typeof val !== "string") return;
    const trimmed = val.trim();
    if (!trimmed) return;
    ids.add(trimmed.toLowerCase());

    // Extract user/phone number if present
    const userPart = trimmed.split("@")[0].split(":")[0];
    if (userPart && /^\d+$/.test(userPart)) {
      numbers.add(userPart);
      ids.add(`${userPart}@c.us`);
      ids.add(`${userPart}@s.whatsapp.net`);
    } else if (/^\d+$/.test(trimmed)) {
      numbers.add(trimmed);
      ids.add(`${trimmed}@c.us`);
      ids.add(`${trimmed}@s.whatsapp.net`);
    }
  };

  addVal(accountInfo.number);
  addVal(accountInfo.phone);
  addVal(accountInfo.jid);
  addVal(accountInfo.me);
  addVal(accountInfo.lid);

  if (accountInfo.wid) {
    if (typeof accountInfo.wid === "object") {
      addVal(accountInfo.wid.user);
      addVal(accountInfo.wid._serialized);
      addVal(accountInfo.wid.lid);
    } else if (typeof accountInfo.wid === "string") {
      addVal(accountInfo.wid);
    }
  }

  return { ids, numbers };
}

/**
 * Checks whether the authenticated account is explicitly mentioned in structured mentions.
 *
 * @param {Array<string|object>} mentions - Structured mention list from WhatsApp metadata
 * @param {object} accountInfo - Authenticated account info
 * @returns {boolean} True if authenticated account is explicitly mentioned
 */
function isAccountMentioned(mentions, accountInfo) {
  if (!Array.isArray(mentions) || mentions.length === 0) return false;
  const { ids, numbers } = getAccountIdentifiers(accountInfo);
  if (ids.size === 0 && numbers.size === 0) return false;

  for (const m of mentions) {
    if (!m) continue;
    const raw = typeof m === "object" ? (m._serialized || m.user || m.id || String(m)) : String(m);
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned) continue;

    // 1. Direct ID / JID / LID match
    if (ids.has(cleaned)) return true;

    // 2. Base JID match (without device suffix, e.g. 923124706501:1@c.us -> 923124706501@c.us)
    const baseJid = cleaned.replace(/:[0-9]+@/, "@");
    if (ids.has(baseJid)) return true;

    // 3. User / phone number match
    const userPart = cleaned.split("@")[0].split(":")[0];
    if (userPart && numbers.has(userPart)) return true;
  }

  return false;
}

/**
 * Centralized eligibility filter for incoming WhatsApp messages.
 * Evaluates whether a message qualifies to reach the persistent webhook queue.
 *
 * Requirements:
 * 1. Personal Chats: Dispatch every new incoming message in 1:1 conversations.
 *    Supports all message types (text, images, documents, audio/ptt, video, stickers).
 *    Never dispatch outgoing messages.
 * 2. Group Chats: Dispatch ONLY when the authenticated account is explicitly mentioned
 *    using structured WhatsApp mention metadata.
 * 3. Channels / Broadcasts: Never dispatch.
 *
 * @param {object} summary - Message summary or raw event
 * @param {object} [accountInfo] - Authenticated account info
 * @returns {boolean} True if message qualifies for delivery
 */
function isIncomingMessageEligible(summary, accountInfo) {
  if (!summary || typeof summary !== "object") return false;

  // 1. Never dispatch outgoing messages
  const isFromMe = Boolean(
    summary.fromMe ||
    summary.from === "me" ||
    (summary.id && typeof summary.id === "object" && summary.id.fromMe)
  );
  if (isFromMe) return false;

  // 2. Never dispatch WhatsApp Channels, channel posts, channel reactions, or broadcasts
  if (isChannelOrBroadcast(summary)) return false;

  // 3. Determine if group message
  const remoteId = summary.chatId || summary.from || (typeof summary.id === "object" ? summary.id?.remote : null);
  const isGroup = Boolean(
    summary.isGroup ||
    (typeof remoteId === "string" && remoteId.endsWith("@g.us")) ||
    (summary.author && !isFromMe)
  );

  // 4. Group Chat filtering: Must explicitly mention the bot account
  if (isGroup) {
    const rawMentions =
      summary.mentionedJidList ||
      summary.mentionedIds ||
      summary.mentions ||
      (summary._data && summary._data.mentionedJidList) ||
      [];
    const mentions = Array.isArray(rawMentions)
      ? rawMentions.map((item) =>
          typeof item === "object" && item !== null
            ? (item._serialized || item.user || String(item))
            : String(item)
        )
      : [];

    return isAccountMentioned(mentions, accountInfo);
  }

  // 5. Personal Chat (1:1): Allow all incoming message types
  return true;
}

/**
 * Centralized event eligibility filter before queue insertion.
 * Ensures excluded events never reach the webhook queue, even if subscribed to '*'.
 *
 * @param {string} eventType - The webhook event type
 * @param {object} payload - The event payload
 * @param {object} [accountInfo] - Authenticated account info
 * @returns {boolean} True if event is eligible to be enqueued
 */
function isEventEligible(eventType, payload, accountInfo) {
  // 1. Manual test/ping events are explicitly preserved
  if (eventType === "webhook.test") {
    return true;
  }

  // 2. Excluded events are strictly rejected
  if (EXCLUDED_WEBHOOK_EVENTS.has(eventType)) {
    return false;
  }

  // 3. Message and media received events must pass message eligibility
  if (eventType === "message.received" || eventType === "media.received") {
    const data = payload?.data;
    if (!data) return false;
    return isIncomingMessageEligible(data, accountInfo);
  }

  // 4. Default: reject unknown / unapproved event types
  return false;
}

/**
 * Resolves account info dynamically from bridge options, active service, or state store.
 *
 * @param {object} bridge - WebhookBridge instance
 * @param {object} [options] - Ingestion options
 * @returns {object|null} Resolved account info
 */
function resolveAccountInfo(bridge, options = {}) {
  const merged = Object.assign(
    {},
    bridge?.account || {},
    bridge?.service?.account || {},
    options && options.account ? options.account : {}
  );
  if (merged.number || merged.jid || merged.me || merged.lid) {
    return merged;
  }
  const clientInfo =
    bridge?.service?.client?.info ||
    bridge?.service?.controller?.client?.client?.info ||
    bridge?.service?.controller?.client?.info;
  if (clientInfo) {
    const widUser = clientInfo.wid?.user || clientInfo.me?.user;
    const widSerialized = clientInfo.wid?._serialized || clientInfo.me?._serialized;
    const lidSerialized = clientInfo.lid?._serialized;
    if (widUser || widSerialized || lidSerialized) {
      return {
        number: widUser || (widSerialized ? widSerialized.split("@")[0].split(":")[0] : null),
        jid: widSerialized || (widUser ? `${widUser}@c.us` : null),
        me: widSerialized || (widUser ? `${widUser}@c.us` : null),
        lid: lidSerialized || null,
        name: clientInfo.pushname || clientInfo.name || null,
      };
    }
  }
  try {
    const state = require("../store/state").get();
    if (state?.account) {
      return state.account;
    }
  } catch (_) {}
  return null;
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

    // 2. Session state events: update internal bridge state but never enqueue
    if (type === "state" || type === "logged_out") {
      const state = type === "logged_out" ? "logged_out" : rawEvent.state;
      this.ingestState(state, this.lastState, rawEvent.reason || null);
      return;
    }

    // 3. Message ACK: ignored per strict filtering specification
    if (type === "message_ack" || type === "message.ack") {
      this.ingestAck(rawEvent);
      return;
    }

    // 4. Message Updated: ignored per strict filtering specification
    if (type === "message_updated" || type === "message.updated") {
      this.ingestUpdate(rawEvent);
      return;
    }
  }

  /**
   * Ingests and maps a qualifying incoming WhatsApp message into message.received and media.received.
   * Strictly filters out outgoing messages, channels, broadcasts, and unmentioned group messages.
   */
  ingestMessage(summary, options = {}) {
    if (!summary || typeof summary !== "object") return;
    const messageId =
      typeof summary.id === "object" && summary.id !== null
        ? summary.id._serialized || summary.id.id
        : summary.id;
    if (!messageId) return;

    const accountInfo = resolveAccountInfo(this, options);

    // Centralized eligibility filter before queue insertion
    if (!isIncomingMessageEligible(summary, accountInfo)) {
      return;
    }

    const eventType = "message.received";
    const dedupKey = `${eventType}:${messageId}`;

    if (this.isDuplicate(dedupKey)) {
      return;
    }
    this.markSeen(dedupKey);

    const timestamp = summary.timestamp || Math.floor(Date.now() / 1000);

    // Extract structured mentions
    const rawMentions =
      summary.mentionedJidList ||
      summary.mentionedIds ||
      summary.mentions ||
      (summary._data && summary._data.mentionedJidList) ||
      [];
    const mentionedJidList = Array.isArray(rawMentions)
      ? rawMentions.map((item) =>
          typeof item === "object" && item !== null
            ? (item._serialized || item.user || item.id || String(item))
            : String(item)
        )
      : [];

    // Build common message data structure preserving full metadata
    const messageData = {
      messageId,
      chatId: summary.chatId || summary.from || null,
      chatName: summary.chatName || null,
      from: summary.from || null,
      to: summary.to || null,
      author: summary.author || null,
      senderName: summary.senderName || null,
      body: summary.body || "",
      timestamp,
      isGroup: Boolean(summary.isGroup),
      fromMe: false,
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
      hasQuotedMsg: Boolean(summary.hasQuotedMsg || summary.quotedMsg),
      quotedMsg: summary.quotedMsg || null,
      mentionedJidList,
    };

    // 1. Dispatch message.received
    const eventId = `evt_rcv_${messageId}`;
    const payload = createEventPayload({
      event: eventType,
      data: messageData,
      account: accountInfo,
      eventId,
      timestamp,
    });

    this.dispatchToSubscribers(eventType, payload);

    // 2. If qualifying incoming message contains media, also trigger media.received
    if (summary.hasMedia) {
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
          hasQuotedMsg: messageData.hasQuotedMsg,
          quotedMsg: messageData.quotedMsg,
          mentionedJidList,
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
   * Ingests session state changes. Updates bridge state; excluded from webhook queue.
   */
  ingestState(state, previousState = null, details = null) {
    if (!state) return;
    if (this.lastState === state) {
      return;
    }
    this.lastState = state;
    // Excluded from webhook delivery queue per strict filtering specification
  }

  /**
   * Ingests message ACK (sent, delivered, read, played). Excluded from webhook queue.
   */
  ingestAck(params = {}) {
    // Excluded from webhook delivery queue per strict filtering specification
  }

  /**
   * Ingests message edits and revokes. Excluded from webhook queue.
   */
  ingestUpdate(params = {}) {
    // Excluded from webhook delivery queue per strict filtering specification
  }

  /**
   * Dispatches an event payload to all matching, enabled endpoints.
   * Strictly enforces event eligibility before queue insertion.
   * Applies endpoint-specific privacy settings and enqueues asynchronously.
   */
  dispatchToSubscribers(eventType, payload) {
    if (!this.queue) return;

    // Centralized eligibility check before queue insertion:
    // Excluded events (session.state, message.ack, message.updated, message.sent, etc.)
    // are rejected even when an endpoint subscribes to "*"
    const accountInfo = resolveAccountInfo(this, { account: payload?.account });
    if (!isEventEligible(eventType, payload, accountInfo)) {
      return;
    }

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
  isChannelOrBroadcast,
  getAccountIdentifiers,
  isAccountMentioned,
  isIncomingMessageEligible,
  isEventEligible,
  resolveAccountInfo,
  WebhookBridge,
};
