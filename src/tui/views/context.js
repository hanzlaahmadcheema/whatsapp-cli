"use strict";

const { T } = require("../theme");
const { relativeTime, clockTime, messageStats } = require("../model");
const { sectionHeader, truncate, chatName } = require("./utils");

// CONTEXT panel: contact identity, activity, media counts, actions.
// Structured so it can later absorb business info without re-layout.
function drawContext(s, region, chat, messages, accountNumber) {
  sectionHeader(s, region, "CONTEXT");

  if (!chat) {
    s.text(region.x + 2, region.y + 3, "no chat selected", T.hint);
    return;
  }

  const w = region.w;
  let y = region.y + 2;

  // identity
  s.text(region.x + 1, y, truncate(chatName(chat), w - 4), T.contextValue);
  y += 2;

  const stats = messageStats(messages);

  const rows = [
    ["Number", chat.id ? chat.id.split("@")[0] : "—"],
    ["State", chat.isGroup ? "GROUP" : presenceLabel(chat)],
    ["Last activity", chat.timestamp ? relativeTime(chat.timestamp) : "—"],
  ];
  for (const [label, value] of rows) {
    if (y > region.y + region.h - 2) break;
    s.text(region.x + 1, y, label + ":", T.contextLabel);
    s.text(region.x + 1 + label.length + 1, y, truncate(value, w - label.length - 4), T.contextValue);
    y += 1;
  }

  // activity
  y += 1;
  s.text(region.x + 1, y, "ACTIVITY", T.contextSection);
  y += 1;
  const actRows = [
    ["Last message", messages.length && messages[messages.length - 1].timestamp ? relativeTime(messages[messages.length - 1].timestamp) : "—"],
    ["Today", `${stats.today} msgs`],
    ["Loaded", `${stats.total} msgs`],
  ];
  for (const [label, value] of actRows) {
    if (y > region.y + region.h - 2) break;
    s.text(region.x + 2, y, label + ":", T.contextLabel);
    s.text(region.x + 2 + label.length + 1, y, truncate(value, w - label.length - 6), T.contextValue);
    y += 1;
  }

  // media
  y += 1;
  s.text(region.x + 1, y, "MEDIA", T.contextSection);
  y += 1;
  const medRows = [
    ["Images", String(stats.media.images)],
    ["Documents", String(stats.media.documents)],
    ["Audio", String(stats.media.audio)],
    ["Video", String(stats.media.video)],
    ["Other", String(stats.media.other)],
  ];
  for (const [label, value] of medRows) {
    if (y > region.y + region.h - 2) break;
    s.text(region.x + 2, y, label + ":", T.contextLabel);
    s.text(region.x + 2 + label.length + 1, y, value, T.contextValue);
    y += 1;
  }

  // actions
  y += 1;
  if (y < region.y + region.h - 1) {
    s.text(region.x + 1, y, "ACTIONS", T.contextSection);
    y += 1;
    s.text(region.x + 2, y, "c compose · r reply · a archive", T.hint);
  }
}

// No presence API in whatsapp-web.js; derive a plausible state from recency.
function presenceLabel(chat) {
  if (!chat.timestamp) return "inactive";
  const ago = Date.now() / 1000 - chat.timestamp;
  if (ago < 60) return "● online";
  if (ago < 3600) return "recent";
  return "inactive";
}

module.exports = { drawContext };
