"use strict";

const { T } = require("../theme");
const { INDICATORS, relativeTime, chatPreview } = require("../model");
const { sectionHeader, truncate, chatName } = require("./utils");

// Render the attention-grouped inbox. rows is the flat list produced by
// model.inboxRows([...]). selectedIndex is an index into rows; only chat rows
// are selectable. Group headers and semantic indicators frame the list.
function drawInbox(s, region, rows, selectedIndex, filter, listScroll) {
  sectionHeader(s, region, "INBOX", { right: filter ? `/${filter}` : undefined });

  if (!rows || rows.length === 0) {
    s.text(region.x + 2, region.y + 3, filter ? "no matching chats" : "no chats yet", T.hint);
    return;
  }

  const availH = region.h - 2; // rows below the header line
  let y = region.y + 2;
  let rendered = 0;
  let i = listScroll || 0;

  for (; i < rows.length && rendered < availH; i++, rendered++) {
    const row = rows[i];
    if (row.type === "header") {
      const headerStr = `${INDICATORS[row.key] || " "} ${row.label}`;
      s.text(region.x + 1, y, headerStr, T.groupHeader);
      s.hline(region.x + headerStr.length + 2, y, Math.max(0, region.w - headerStr.length - 3), "─", T.border);
      y += 1;
      continue;
    }
    drawChatRow(s, region, y, row.chat, i === selectedIndex);
    y += 1;
  }

  // scroll hints
  if (listScroll > 0) s.text(region.x + 1, region.y + region.h - 1, "▲", T.hint);
  if (i < rows.length) s.text(region.x + region.w - 2, region.y + region.h - 1, "▼", T.hint);
}

// One row: indicator · name + preview on the left, timestamp + unread badge
// right-aligned. Single line keeps scroll math simple and density high.
function drawChatRow(s, region, y, chat, isSel) {
  const w = region.w;
  const name = truncate(chatName(chat), Math.max(6, w - 28));
  const preview = truncate(chatPreview(chat), Math.max(4, w - name.length - 14));
  const isAction = (chat.unreadCount || 0) > 0;
  const indicator = isAction ? "!" : chat.pinned ? "●" : chat.timestamp ? "●" : "○";
  const indicatorStyle = isAction
    ? T.requiresAttention
    : chat.pinned
      ? T.pinned
      : chat.timestamp
        ? T.active
        : T.inactive;

  if (isSel) s.fill(region.x, y, w, 1, " ", T.selected);

  s.text(region.x + 1, y, indicator, isSel ? { fg: "brightYellow", bold: true } : indicatorStyle);
  const prefix = chat.isGroup ? "▸" : " ";
  s.text(region.x + 3, y, prefix, isSel ? T.selected : T.muted);
  s.text(region.x + 5, y, name, isSel ? T.selected : chat.isGroup ? { fg: "yellow" } : T.bold);

  // right-aligned zone: unread badge then timestamp
  let rightX = region.x + w - 1;
  const unread = chat.unreadCount || 0;
  if (unread > 0) {
    const badge = String(unread);
    const bx = region.x + w - badge.length - 1;
    s.text(bx, y, badge, isSel ? T.selected : T.unreadBadge);
    rightX = bx - 2;
  }
  const ts = relativeTime(chat.timestamp);
  if (ts) {
    const tx = rightX - ts.length;
    if (tx > region.x + 5 + name.length + 1) {
      s.text(tx, y, ts, isSel ? T.selectedDim : T.timestamp);
    }
  }

  // preview between name and right zone
  if (preview && region.x + 5 + name.length + 1 + preview.length <= rightX) {
    s.text(region.x + 5 + name.length + 1, y, preview, isSel ? T.selectedDim : T.preview);
  }
}

module.exports = { drawInbox };
