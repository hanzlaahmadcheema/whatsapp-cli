"use strict";

// Pure, side-effect-free logic for the TUI: inbox grouping, relative time,
// ack glyphs, attachment labels, previews, and message stats. Kept free of
// the screen so it is unit-testable headlessly.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const ACTIVE_WINDOW_S = 24 * HOUR;

function isMeFrom(from) {
  return from === "me" || from === "status@broadcast" || !from;
}

// Group a flat chat list into attention buckets.
//  - ACTION REQUIRED: unread > 0
//  - ACTIVE: activity within 24h, or pinned
//  - RECENT: everything else (archived sinks to the bottom)
function groupChats(chats, now = Date.now() / 1000) {
  const buckets = { action: [], active: [], recent: [] };
  for (const c of chats || []) {
    const recency = now - (c.timestamp || 0);
    if ((c.unreadCount || 0) > 0) buckets.action.push(c);
    else if (c.pinned || (c.timestamp && recency <= ACTIVE_WINDOW_S)) buckets.active.push(c);
    else buckets.recent.push(c);
  }
  // Newest first within each bucket.
  const byTime = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
  buckets.action.sort(byTime);
  buckets.active.sort(byTime);
  buckets.recent.sort(byTime);
  return buckets;
}

// Flat ordered list of group headers + chat entries for rendering.
function inboxRows(chats, now) {
  const g = groupChats(chats, now);
  const rows = [];
  for (const [key, label] of [["action", "ACTION REQUIRED"], ["active", "ACTIVE"], ["recent", "RECENT"]]) {
    if (g[key].length === 0) continue;
    rows.push({ type: "header", key, label });
    for (const chat of g[key]) {
      rows.push({ type: "chat", chat, key });
    }
  }
  return rows;
}

// Indicator glyph per bucket.
const INDICATORS = { action: "!", active: "●", recent: "○" };

function relativeTime(ts, now = Date.now() / 1000) {
  if (!ts) return "";
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function clockTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Group messages into a day + time separator structure for the conversation.
function dayLabel(ts, nowMs = Date.now()) {
  const d = new Date(ts * 1000);
  const today = new Date(nowMs);
  const yest = new Date(today.getTime() - DAY * 1000);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "TODAY";
  if (sameDay(d, yest)) return "YESTERDAY";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
}

function dayKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Map message ack to a glyph + style flag.
// ack: -1 error, 0 pending, 1 sent, 2 delivered, 3 read, 4 played
function ackInfo(ack) {
  switch (ack) {
    case 3:
    case 4:
      return { glyph: "✓✓", style: "ackRead" };
    case 2:
      return { glyph: "✓✓", style: "ackDelivered" };
    case 1:
      return { glyph: "✓", style: "ackSent" };
    case -1:
      return { glyph: "✗", style: "err" };
    case 0:
    case null:
    case undefined:
    default:
      return { glyph: "◌", style: "ackSent" };
  }
}

// Compact label for a media message type.
function mediaLabel(type) {
  switch (type) {
    case "image":
      return "[IMG]";
    case "video":
      return "[VID]";
    case "audio":
      return "[AUD]";
    case "ptt":
      return "[VOICE]";
    case "document":
      return "[DOC]";
    case "sticker":
      return "[STICKER]";
    case "location":
      return "[LOCATION]";
    case "contact":
      return "[CONTACT]";
    case "poll":
      return "[POLL]";
    case "gif":
      return "[GIF]";
    case "revoked":
      return "[REVOKED]";
    default:
      return "[ATTACH]";
  }
}

// One-line preview for a chat row.
function chatPreview(chat) {
  const lm = chat.lastMessage;
  if (!lm) return "no messages";
  if (lm.hasMedia) {
    const cap = (lm.body || "").trim();
    const base = lm.type === "image" && cap ? `${mediaLabel(lm.type)} ${cap}` : mediaLabel(lm.type || "generic");
    return base;
  }
  return lm.body || "";
}

// Message stats for the CONTEXT panel.
function messageStats(messages, now = Date.now() / 1000) {
  let today = 0;
  const media = { images: 0, documents: 0, audio: 0, video: 0, other: 0 };
  for (const m of messages || []) {
    if (m.timestamp && now - m.timestamp < DAY) today++;
    if (!m.hasMedia) continue;
    switch (m.type) {
      case "image":
        media.images++;
        break;
      case "document":
        media.documents++;
        break;
      case "audio":
      case "ptt":
        media.audio++;
        break;
      case "video":
        media.video++;
        break;
      default:
        media.other++;
    }
  }
  return { total: messages ? messages.length : 0, today, media };
}

module.exports = {
  groupChats,
  inboxRows,
  INDICATORS,
  relativeTime,
  clockTime,
  dayLabel,
  dayKey,
  ackInfo,
  mediaLabel,
  chatPreview,
  messageStats,
  isMeFrom,
  ACTIVE_WINDOW_S,
};
