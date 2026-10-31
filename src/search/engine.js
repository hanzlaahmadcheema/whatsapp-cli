"use strict";

const { parseDateToTimestamp } = require("./date-parser");
const { calculateRelevance, deduplicateResults } = require("./scorer");
const { loadMediaIndex } = require("../media/store");
const { toJid } = require("../ipc/jid");

/**
 * Executes unified search across messages, media, contacts, and chats.
 * Strictly read-only: never modifies state or performs external network writes.
 */
async function searchWhatsApp(options = {}, context = {}) {
  const query = (options.query || options.q || "").trim();
  const scope = (options.scope || "all").toLowerCase();
  const rawChatId = options.chatId || options.chat || null;
  const rawSender = options.sender || null;
  const typeFilter = (options.type || "all").toLowerCase();
  const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 20, 100));
  const offset = Math.max(0, parseInt(options.offset, 10) || 0);

  const now = context.now instanceof Date ? context.now : new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  // 1. Strict date parsing
  let sinceTs = null;
  let untilTs = null;

  if (options.since) {
    const parsed = parseDateToTimestamp(options.since, { endOfDay: false, now });
    if (parsed && typeof parsed === "object" && parsed.since !== undefined) {
      sinceTs = parsed.since;
      untilTs = parsed.until;
    } else {
      sinceTs = parsed;
    }
  }

  if (options.until && !untilTs) {
    const parsed = parseDateToTimestamp(options.until, { endOfDay: true, now });
    untilTs = parsed;
  }

  // 2. Chat ID normalization
  let targetChatId = null;
  if (rawChatId) {
    try {
      targetChatId = toJid(rawChatId);
    } catch (_) {
      targetChatId = String(rawChatId).trim();
    }
  }

  // Sender filter normalization
  const senderQuery = rawSender ? String(rawSender).toLowerCase().trim() : null;

  // Filter predicates
  const matchesTimestamp = (ts) => {
    if (!ts) return !sinceTs; // If no timestamp, passes only if no since filter
    const t = ts > 1e11 ? Math.floor(ts / 1000) : ts;
    if (sinceTs && t < sinceTs) return false;
    if (untilTs && t > untilTs) return false;
    return true;
  };

  const matchesChat = (chatId) => {
    if (!targetChatId) return true;
    if (!chatId) return false;
    const cleanTarget = targetChatId.replace(/[^\d]/g, "");
    const cleanChat = String(chatId).replace(/[^\d]/g, "");
    return (
      chatId === targetChatId ||
      String(chatId).toLowerCase() === targetChatId.toLowerCase() ||
      (cleanTarget && cleanChat && (cleanChat === cleanTarget || cleanChat.endsWith(cleanTarget)))
    );
  };

  const matchesSender = (senderId, senderName) => {
    if (!senderQuery) return true;
    const idStr = String(senderId || "").toLowerCase();
    const nameStr = String(senderName || "").toLowerCase();
    const cleanQuery = senderQuery.replace(/[^\d]/g, "");
    const cleanId = idStr.replace(/[^\d]/g, "");

    return (
      idStr.includes(senderQuery) ||
      nameStr.includes(senderQuery) ||
      (cleanQuery && cleanId && (cleanId === cleanQuery || cleanId.endsWith(cleanQuery)))
    );
  };

  const matchesType = (itemType, mimetype) => {
    if (!typeFilter || typeFilter === "all") return true;
    const t = String(itemType || "").toLowerCase();
    const mimeStr = String(mimetype || "").toLowerCase();

    if (typeFilter === "chat" || typeFilter === "text") {
      return t === "chat" || (!t && !mimeStr);
    }
    if (typeFilter === "image") {
      return t === "image" || mimeStr.startsWith("image/");
    }
    if (typeFilter === "document" || typeFilter === "doc") {
      if (mimeStr) {
        return !mimeStr.startsWith("image/") && !mimeStr.startsWith("audio/") && !mimeStr.startsWith("video/");
      }
      return t === "document" || t === "doc";
    }
    if (typeFilter === "video") {
      return t === "video" || mimeStr.startsWith("video/");
    }
    if (typeFilter === "audio") {
      return t === "audio" || mimeStr.startsWith("audio/");
    }
    return t === typeFilter;
  };

  const candidates = [];
  const service = context.service || null;
  let contactCache = context.contactCache || (service && service._contactCache) || null;
  if (!contactCache && (context.contacts || context.chats)) {
    try {
      const { ContactCache } = require("../conversation/context");
      contactCache = new ContactCache();
      if (context.contacts) contactCache.loadContacts(context.contacts);
      if (context.chats) contactCache.loadChats(context.chats);
    } catch (_) {}
  }

  // -------------------------------------------------------------
  // SCOPE A: Incoming / Downloaded Media
  // -------------------------------------------------------------
  if (scope === "all" || scope === "media") {
    const mediaIndex = context.mediaIndex || loadMediaIndex();
    for (const [mid, item] of Object.entries(mediaIndex)) {
      if (!matchesTimestamp(item.timestamp)) continue;
      if (!matchesChat(item.chatId)) continue;
      let mediaType = "document";
      const mime = item.mimetype || "";
      if (mime.startsWith("image/")) {
        mediaType = "image";
      } else if (mime.startsWith("video/")) {
        mediaType = "video";
      } else if (mime.startsWith("audio/")) {
        mediaType = "audio";
      }
      if (!matchesType(mediaType, mime)) {
        continue;
      }

      const senderId = item.sender || null;
      const senderName = contactCache ? contactCache.resolveSenderName(senderId) : senderId;
      if (!matchesSender(senderId, senderName)) continue;

      const chatName = contactCache ? contactCache.resolveChatName(item.chatId) : item.chatId;

      candidates.push({
        resultType: "media",
        id: mid,
        messageId: mid,
        chatId: item.chatId || null,
        chatName: chatName || null,
        senderId: senderId || null,
        senderName: senderName || null,
        timestamp: item.timestamp || null,
        filename: item.filename || null,
        caption: item.caption || null,
        content: item.filename || item.caption || "",
        metadata: {
          type: mediaType,
          mimetype: item.mimetype,
          size: item.size,
          sha256: item.sha256,
          filePath: item.filePath,
          pinned: Boolean(item.pinned),
        },
      });
    }
  }

  // -------------------------------------------------------------
  // SCOPE B: Address Book Contacts
  // -------------------------------------------------------------
  if ((scope === "all" || scope === "contacts") && !targetChatId && typeFilter === "all" && !sinceTs) {
    let contacts = [];
    if (context.contacts) {
      contacts = context.contacts;
    } else if (service && typeof service.getContacts === "function") {
      try {
        contacts = await service.getContacts();
      } catch (_) {}
    }

    for (const c of contacts) {
      const cid = c.id && (c.id._serialized || c.id);
      const name = c.name || c.pushname || "";
      if (!matchesSender(cid, name)) continue;

      candidates.push({
        resultType: "contact",
        id: cid,
        chatId: cid,
        chatName: name || cid,
        senderId: cid,
        senderName: name || cid,
        timestamp: null,
        filename: null,
        caption: null,
        content: `${name} ${c.number || ""}`.trim(),
        metadata: {
          number: c.number || null,
          pushname: c.pushname || null,
        },
      });
    }
  }

  // -------------------------------------------------------------
  // SCOPE C: Conversations / Chats
  // -------------------------------------------------------------
  if ((scope === "all" || scope === "chats") && typeFilter === "all") {
    let chats = [];
    if (context.chats) {
      chats = context.chats;
    } else if (service && typeof service.getChats === "function") {
      try {
        chats = await service.getChats({ limit: 50 });
      } catch (_) {}
    }

    for (const ch of chats) {
      const chId = ch.id && (ch.id._serialized || ch.id);
      if (!matchesChat(chId)) continue;
      if (!matchesTimestamp(ch.timestamp)) continue;

      const chatName = ch.name || (contactCache ? contactCache.resolveChatName(chId) : chId);
      if (senderQuery && !matchesSender(chId, chatName)) continue;

      candidates.push({
        resultType: "chat",
        id: chId,
        chatId: chId,
        chatName: chatName || chId,
        senderId: null,
        senderName: null,
        timestamp: ch.timestamp || null,
        filename: null,
        caption: null,
        content: chatName || "",
        metadata: {
          isGroup: Boolean(ch.isGroup),
          unreadCount: ch.unreadCount || 0,
          archived: Boolean(ch.archived),
          pinned: Boolean(ch.pinned),
        },
      });
    }
  }

  // -------------------------------------------------------------
  // SCOPE D: Messages
  // -------------------------------------------------------------
  if (scope === "all" || scope === "messages") {
    let messages = [];

    if (context.messages) {
      messages = context.messages;
    } else if (service) {
      if (targetChatId && typeof service.getHistory === "function") {
        try {
          messages = await service.getHistory({ chatId: targetChatId, limit: 100 });
        } catch (_) {}
      } else if (typeof service.getChats === "function") {
        try {
          const recentChats = await service.getChats({ limit: 20 });
          for (const ch of recentChats) {
            if (ch.lastMessage) messages.push(ch.lastMessage);
          }
        } catch (_) {}
      }
    }

    for (const m of messages) {
      if (!matchesTimestamp(m.timestamp)) continue;
      if (!matchesChat(m.chatId || m.from)) continue;
      if (!matchesType(m.type, m.mimetype)) continue;

      const senderId = m.fromMe ? "me" : (m.author || m.from);
      const senderName = m.senderName || (contactCache ? contactCache.resolveSenderName(senderId) : senderId);
      if (!matchesSender(senderId, senderName)) continue;

      const chatName = m.chatName || (contactCache ? contactCache.resolveChatName(m.chatId || m.from) : (m.chatId || m.from));

      candidates.push({
        resultType: "message",
        id: m.id,
        messageId: m.id,
        chatId: m.chatId || m.from || null,
        chatName: chatName || null,
        senderId: senderId || null,
        senderName: senderName || null,
        timestamp: m.timestamp || null,
        filename: m.filename || null,
        caption: m.caption || null,
        content: m.body || m.caption || m.filename || "",
        metadata: {
          type: m.type || (m.hasMedia ? "media" : "chat"),
          mimetype: m.mimetype || null,
          isGroup: Boolean(m.isGroup),
          fromMe: Boolean(m.fromMe),
          hasMedia: Boolean(m.hasMedia),
          hasQuotedMsg: Boolean(m.hasQuotedMsg),
          quotedMsg: m.quotedMsg || null,
        },
      });
    }
  }

  // -------------------------------------------------------------
  // 3. Relevance Scoring & Candidate Matching
  // -------------------------------------------------------------
  const scoredItems = [];

  for (const candidate of candidates) {
    const rel = calculateRelevance(candidate, query, nowSeconds);

    // If query was non-empty and score is 0, item did not match
    if (query && rel.relevanceScore <= 0) {
      continue;
    }

    scoredItems.push({
      resultType: candidate.resultType,
      id: candidate.id,
      chatId: candidate.chatId,
      chatName: candidate.chatName,
      senderId: candidate.senderId,
      senderName: candidate.senderName,
      timestamp: candidate.timestamp,
      content: candidate.content,
      filename: candidate.filename,
      caption: candidate.caption,
      relevanceScore: rel.relevanceScore,
      matchedFields: rel.matchedFields,
      scoreDetails: rel.scoreBreakdown,
      metadata: candidate.metadata || {},
    });
  }

  // -------------------------------------------------------------
  // 4. Deduplication & Sorting
  // -------------------------------------------------------------
  const deduplicated = deduplicateResults(scoredItems);

  // Sort descending by relevance score, secondary by timestamp
  deduplicated.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return (b.timestamp || 0) - (a.timestamp || 0);
  });

  // 5. Pagination
  const paginated = deduplicated.slice(offset, offset + limit);

  return {
    ok: true,
    query,
    scope,
    totalMatches: deduplicated.length,
    count: paginated.length,
    offset,
    limit,
    results: paginated,
  };
}

module.exports = {
  searchWhatsApp,
};
