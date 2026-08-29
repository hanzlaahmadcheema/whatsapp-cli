"use strict";

const { T } = require("../theme");
const { clockTime, dayLabel, dayKey, ackInfo, mediaLabel, isMeFrom } = require("../model");
const { sectionHeader, truncate, chatName } = require("./utils");
const { shortJid } = require("../../ipc/jid");

// Wrap text into lines of at most maxW columns (no hyphenation).
function wrapText(text, maxW) {
  const paragraphs = String(text || "").split("\n");
  const out = [];
  for (const p of paragraphs) {
    if (p.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of p.split(/\s+/)) {
      let wd = word;
      while (wd.length > maxW) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(wd.slice(0, maxW));
        wd = wd.slice(maxW);
      }
      const candidate = line ? `${line} ${wd}` : wd;
      if (candidate.length > maxW) {
        if (line) out.push(line);
        line = wd;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

// Pre-compute per-message layout: separators + wrapped lines + heights.
function layoutMessages(messages, textW) {
  const items = [];
  let lastDay = null;
  for (const m of messages) {
    const key = dayKey(m.timestamp);
    if (key !== lastDay) {
      items.push({ type: "sep", day: dayLabel(m.timestamp) });
      lastDay = key;
    }
    const body = m.hasMedia ? `${mediaLabel(m.type)}${m.body ? " " + m.body : ""}` : m.body || "";
    const lines = wrapText(body, textW);
    items.push({
      type: "msg",
      m,
      lines,
      h: 1 + Math.max(1, lines.length), // sender row + body rows
    });
  }
  return items;
}

// Bottom-anchored scroll: find the largest start index whose items still fill
// the pane from the bottom up.
function maxScroll(items, rows) {
  let used = 0;
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const h = items[i].type === "sep" ? 1 : items[i].h;
    if (used + h > rows) break;
    used += h;
    start = i;
  }
  return start;
}

// Height of an item in rows (seps are one line).
function itemH(item) {
  return item.type === "sep" ? 1 : item.h;
}

// Cumulative top y-offset of every item index in the laid-out pane.
function cumTop(items) {
  const top = [0];
  for (let i = 0; i < items.length; i++) top.push(top[i] + itemH(items[i]));
  return top;
}

// Return a msgScroll start index that keeps the message with `selectedId`
// fully on screen. Prefers the current scroll when the selection is already
// visible; otherwise shifts just enough to reveal the message.
function scrollToMessage(items, selectedId, scroll, rows) {
  const idx = items.findIndex((it) => it.type === "msg" && it.m && it.m.id === selectedId);
  if (idx < 0) return scroll;
  const top = cumTop(items);
  const msgTop = top[idx];
  const msgBot = top[idx + 1];
  const max = items.length - 1;

  // A window starting at s shows rows [top[s], top[s] + rows). The message is
  // fully visible when s satisfies both bounds.
  const sMax = findLastIndex(top, (v) => v <= msgTop, idx); // top[s] <= msgTop
  const sMin = findFirstIndex(top, (v) => v >= msgBot - rows, idx); // top[s] >= msgBot - rows
  if (sMin > sMax) return scroll; // message taller than the pane; leave as-is

  const cur = Math.max(0, Math.min(scroll, max));
  if (cur >= sMin && cur <= sMax) return cur;
  // pick the valid bound nearest the current scroll
  return cur < sMin ? sMin : sMax;
}

function findLastIndex(arr, pred, from) {
  for (let i = from; i >= 0; i--) if (pred(arr[i])) return i;
  return 0;
}

function findFirstIndex(arr, pred, from) {
  for (let i = 0; i <= from; i++) if (pred(arr[i])) return i;
  return from;
}

function drawConversation(s, region, messages, chat, selectedMsgId, msgScroll, focus) {
  const title = chat ? truncate(chatName(chat), Math.max(8, region.w - 14)) : "CONVERSATION";
  sectionHeader(s, region, "CONVERSATION", { right: chat ? title : undefined });

  if (!chat) {
    s.text(region.x + 2, region.y + 3, "select a chat →", T.hint);
    return;
  }
  const items = layoutMessages(messages, Math.max(10, region.w - 8));
  const rows = region.h - 2;
  const start = Math.max(0, Math.min(msgScroll, items.length - 1));
  let y = region.y + 2;
  let i = start;
  for (; i < items.length; i++) {
    const item = items[i];
    if (item.type === "sep") {
      if (y > region.y + region.h - 1) break;
      const sepStr = `── ${item.day} ──`;
      s.text(region.x + 1, y, sepStr, T.separator);
      y += 1;
      continue;
    }
    if (y + item.h > region.y + region.h) break;
    drawMessage(s, region, item.m, item.lines, item.h, y, selectedMsgId, chat);
    y += item.h;
  }

  if (messages.length === 0) {
    s.text(region.x + 2, region.y + 3, "no messages yet…", T.hint);
    return;
  }

  // scroll hints
  const moreUp = msgScroll > 0;
  const moreDown = i < items.length;
  if (moreUp) s.text(region.x + 1, region.y + region.h - 1, "▲ older", T.hint);
  if (moreDown) s.text(region.x + region.w - 8, region.y + region.h - 1, "▼ newer", T.hint);
}

function senderLabel(m, chat) {
  if (isMeFrom(m.from)) return "you";
  if (m.author && !chat.isGroup) return shortJid(m.from) || "?";
  if (m.author) return shortJid(m.author);
  return shortJid(m.from) || "?";
}

// Text drawn on top of a selected message must keep the highlight background,
// otherwise the glyphs render black-on-default (invisible). Every selected style
// therefore carries bg brightYellow explicitly.
const SEL_STYLE = Object.freeze({ fg: "black", bg: "brightYellow" });
const SEL_BOLD = Object.freeze({ fg: "black", bg: "brightYellow", bold: true });

function drawMessage(s, region, m, lines, h, y, selectedMsgId, chat) {
  const isSel = m.id && selectedMsgId === m.id;
  const isMe = isMeFrom(m.from);
  const px = region.x + 1;
  const w = region.w - 2;

  if (isSel) s.fill(px, y, w, h, " ", SEL_STYLE);

  const who = senderLabel(m, chat);
  const senderStyle = isSel
    ? SEL_BOLD
    : isMe
      ? T.senderMe
      : m.author
        ? T.senderGroup
        : T.senderOther;
  s.text(px, y, who, senderStyle);

  // right side of the header row: time + ack for own messages
  const ts = clockTime(m.timestamp);
  let rightStr = ts;
  if (isMe) {
    const ack = ackInfo(m.ack);
    rightStr = `${ts} ${ack.glyph}`;
  }
  if (rightStr) {
    const rx = region.x + region.w - rightStr.length - 1;
    if (rx > px + who.length + 1) s.text(rx, y, rightStr, isSel ? { fg: "black", bg: "brightYellow", dim: true } : T.timestamp);
  }

  // media flag in the header
  if (m.hasMedia && !isSel) {
    s.text(px + who.length + 1, y, mediaLabel(m.type), T.attachment);
  }
  if (m.isForwarded && !isSel) {
    s.text(px + who.length + 1 + (m.hasMedia ? mediaLabel(m.type).length + 1 : 0), y, "↦", T.muted);
  }

  // body lines
  const bodyStyle = isSel
    ? SEL_STYLE
    : isMe
      ? T.ownBody
      : T.otherBody;
  for (let li = 0; li < lines.length; li++) {
    s.text(px, y + 1 + li, lines[li], bodyStyle);
  }

  // selection marker
  if (isSel) {
    s.text(region.x + region.w - 2, y, "◀", SEL_BOLD);
  }
}

module.exports = { drawConversation, layoutMessages, maxScroll, wrapText, scrollToMessage };
