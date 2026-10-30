"use strict";

/**
 * Cache for WhatsApp contacts and chats to provide synchronous, low-latency
 * name and identity resolution for conversation context enrichment.
 */
class ContactCache {
  constructor() {
    this._contactsByJid = new Map();
    this._contactsByNumber = new Map();
    this._chatsByJid = new Map();
  }

  setContact(contact) {
    if (!contact) return;
    const jid = (contact.id && (contact.id._serialized || contact.id)) || "";
    const name = (contact.name || contact.pushname || contact.formattedName || "").trim();
    const pushname = (contact.pushname || "").trim();
    let number = (contact.number || "").trim();
    if (!number && jid.endsWith("@c.us")) {
      number = jid.replace(/@c\.us$/, "");
    }
    const info = {
      id: jid,
      name,
      pushname,
      number,
    };
    if (jid) this._contactsByJid.set(jid, info);
    if (number) this._contactsByNumber.set(number, info);
  }

  setChat(chat) {
    if (!chat) return;
    const jid = (chat.id && (chat.id._serialized || chat.id)) || "";
    const name = (chat.name || chat.formattedTitle || "").trim();
    const isGroup = Boolean(chat.isGroup || (jid && jid.endsWith("@g.us")));
    if (jid) {
      this._chatsByJid.set(jid, {
        id: jid,
        name,
        isGroup,
      });
    }
  }

  loadContacts(contactsList) {
    if (!Array.isArray(contactsList)) return;
    for (const c of contactsList) {
      this.setContact(c);
    }
  }

  loadChats(chatsList) {
    if (!Array.isArray(chatsList)) return;
    for (const ch of chatsList) {
      this.setChat(ch);
      const jid = (ch.id && (ch.id._serialized || ch.id)) || "";
      const name = (ch.name || ch.formattedTitle || "").trim();
      if (jid && name && !this._contactsByJid.has(jid)) {
        this.setContact({ id: jid, name });
      }
    }
  }

  getContact(jidOrNumber) {
    if (!jidOrNumber) return null;
    const str = String(jidOrNumber).trim();
    return this._contactsByJid.get(str) || this._contactsByNumber.get(str) || null;
  }

  getChat(jid) {
    if (!jid) return null;
    return this._chatsByJid.get(String(jid).trim()) || null;
  }

  resolveSenderName(senderJid, fallbackNotifyName = "") {
    if (!senderJid) return fallbackNotifyName || "";
    if (senderJid === "me") return "You";

    const cleanJid = String(senderJid).trim();

    // 1. Check direct JID cache
    const direct = this._contactsByJid.get(cleanJid);
    if (direct && (direct.name || direct.pushname)) {
      return direct.name || direct.pushname;
    }

    // 2. Check number if it's a contact JID
    const num = cleanJid.endsWith("@c.us") ? cleanJid.replace(/@c\.us$/, "") : "";
    if (num) {
      const byNum = this._contactsByNumber.get(num);
      if (byNum && (byNum.name || byNum.pushname)) {
        return byNum.name || byNum.pushname;
      }
    }

    // 3. Fallback to notify name if provided
    if (fallbackNotifyName && String(fallbackNotifyName).trim()) {
      return String(fallbackNotifyName).trim();
    }

    // 4. Fallback to formatted number or short ID
    return num || cleanJid.split("@")[0] || cleanJid;
  }

  resolveChatName(chatJid, fallbackName = "") {
    if (!chatJid) return fallbackName || "";
    const cleanJid = String(chatJid).trim();

    // 1. Direct chat cache
    const chat = this._chatsByJid.get(cleanJid);
    if (chat && chat.name) return chat.name;

    // 2. Direct contact cache for 1:1 chats
    if (cleanJid.endsWith("@c.us")) {
      const contact = this._contactsByJid.get(cleanJid);
      if (contact && (contact.name || contact.pushname)) {
        return contact.name || contact.pushname;
      }
    }

    // 3. Fallback name from caller
    if (fallbackName && String(fallbackName).trim()) {
      return String(fallbackName).trim();
    }

    // 4. Default group or short JID
    if (cleanJid.endsWith("@g.us")) {
      return "Group Chat";
    }
    return cleanJid.split("@")[0] || cleanJid;
  }
}

/**
 * Extracts and normalizes quoted/replied-to message context.
 */
function extractQuotedMessage(m, contactCache = null) {
  if (!m) return null;

  // Locate quoted message data across whatsapp-web.js model representations
  const raw =
    (m._data && m._data.quotedMsg) ||
    m.quotedMsg ||
    m._quotedMsg ||
    null;

  const hasQuoted = Boolean(m.hasQuotedMsg || raw);
  if (!hasQuoted && !raw) return null;

  if (raw) {
    const rawId =
      (raw.id && (raw.id._serialized || raw.id)) ||
      (m._data && m._data.quotedStanzaID) ||
      null;

    const isFromMe = Boolean(
      raw.fromMe ||
      (raw.id && raw.id.fromMe) ||
      (raw.from === "me")
    );

    const senderJid = isFromMe
      ? "me"
      : raw.participant ||
        raw.author ||
        raw.from ||
        (m._data && m._data.quotedParticipant) ||
        null;

    const notifyName = raw.notifyName || raw.pushname || "";
    const senderName = isFromMe
      ? "You"
      : contactCache && senderJid
      ? contactCache.resolveSenderName(senderJid, notifyName)
      : notifyName || (senderJid ? senderJid.split("@")[0] : null);

    const hasMedia = Boolean(
      raw.hasMedia ||
      (raw.type && raw.type !== "chat") ||
      raw.mimetype
    );

    return {
      id: rawId,
      from: isFromMe ? "me" : senderJid,
      fromMe: isFromMe,
      senderName: senderName || null,
      body: raw.body || raw.caption || "",
      type: raw.type || (hasMedia ? "media" : "chat"),
      hasMedia,
      mimetype: raw.mimetype || null,
      filename: raw.filename || null,
    };
  }

  // Fallback when hasQuotedMsg is true but raw data object is not hydrated
  if (m.hasQuotedMsg) {
    const stanzaId = m._data && m._data.quotedStanzaID;
    const participant = m._data && m._data.quotedParticipant;
    const isFromMe = Boolean(participant && participant.startsWith("me"));
    const senderJid = isFromMe ? "me" : participant || null;
    const senderName = isFromMe
      ? "You"
      : contactCache && senderJid
      ? contactCache.resolveSenderName(senderJid)
      : senderJid ? senderJid.split("@")[0] : null;

    return {
      id: stanzaId || null,
      from: senderJid,
      fromMe: isFromMe,
      senderName,
      body: "",
      type: "chat",
      hasMedia: false,
      mimetype: null,
      filename: null,
    };
  }

  return null;
}

/**
 * Enriches a WhatsApp message with comprehensive conversational context:
 * - Sender identity & name attribution
 * - Quoted / replied-to message hydration
 * - Group context (isGroup, chatName, participant author)
 * - Media references
 *
 * Maintains 100% backward compatibility with all legacy messageSummary fields.
 */
function enrichMessageSummary(m, options = {}) {
  if (!m) return null;

  const contactCache = options.contactCache || null;
  const chat = options.chat || null;
  const myNumber = options.myNumber || null;

  // 1. Message ID
  const id = (m.id && (m.id._serialized || m.id)) || null;

  // 2. Sender origin (fromMe)
  const isFromMe = Boolean(
    m.fromMe ||
    (m.id && m.id.fromMe) ||
    m.from === "me" ||
    (myNumber && m.from && typeof m.from === "string" && m.from.includes(myNumber))
  );

  // 3. Remote Chat & Group detection
  const remoteJid =
    (m.id && m.id.remote) ||
    (chat && (chat.id?._serialized || chat.id)) ||
    (isFromMe ? m.to : m.from) ||
    m.from ||
    null;

  const isGroup = Boolean(
    (chat && chat.isGroup) ||
    (remoteJid && remoteJid.endsWith("@g.us")) ||
    (m.author && !isFromMe)
  );

  // 4. Author & Sender attribution
  const authorJid = isFromMe
    ? "me"
    : (m.author || (m._data && m._data.author) || (isGroup ? m.from : null) || null);

  const senderJid = isFromMe
    ? "me"
    : (isGroup ? (authorJid || m.from) : m.from);

  const fallbackNotifyName =
    (m._data && (m._data.notifyName || m._data.pushname)) ||
    m._notifyName ||
    m.notifyName ||
    "";

  const senderName = isFromMe
    ? "You"
    : contactCache
    ? contactCache.resolveSenderName(senderJid, fallbackNotifyName)
    : fallbackNotifyName || (senderJid ? senderJid.split("@")[0] : null);

  // 5. Chat name resolution
  const fallbackChatName = (chat && (chat.name || chat.formattedTitle)) || "";
  const chatName = contactCache
    ? contactCache.resolveChatName(remoteJid, fallbackChatName)
    : fallbackChatName || (isGroup ? "Group Chat" : (senderName || (remoteJid ? remoteJid.split("@")[0] : null)));

  // 6. Quoted / replied-to message resolution
  const quotedMsg = extractQuotedMessage(m, contactCache);

  // 7. Media & Content resolution
  const hasMedia = Boolean(
    m.hasMedia ||
    (m.type && m.type !== "chat" && m.type !== "call_log")
  );
  const type = m.type || (hasMedia ? "media" : "chat");
  const mimetype = m.mimetype || (m._data && m._data.mimetype) || null;
  const filename = m.filename || (m._data && m._data.filename) || null;
  const filesize =
    m.size ||
    m.filesize ||
    (m._data && (m._data.size || m._data.filesize)) ||
    null;
  const caption = hasMedia ? (m.body || (m._data && m._data.caption) || "") : "";

  return {
    // Legacy fields preserved for backward compatibility
    id,
    from: isFromMe ? "me" : m.from,
    to: m.to || null,
    author: authorJid,
    body: m.body || "",
    timestamp: m.timestamp || Math.floor(Date.now() / 1000),
    ack: typeof m.ack === "number" ? m.ack : null,
    hasMedia,
    type,
    isForwarded: Boolean(m.isForwarded || (m._data && m._data.isForwarded)),
    mimetype,
    filename,
    filesize,
    caption,

    // Enriched Conversation Context fields
    chatId: remoteJid,
    chatName: chatName || null,
    isGroup,
    fromMe: isFromMe,
    senderName: senderName || null,
    hasQuotedMsg: Boolean(quotedMsg),
    quotedMsg: quotedMsg || null,
  };
}

/**
 * Backward-compatible message summary function.
 */
function messageSummary(m, options = {}) {
  return enrichMessageSummary(m, options);
}

module.exports = {
  ContactCache,
  extractQuotedMessage,
  enrichMessageSummary,
  messageSummary,
};
