"use strict";

const { T } = require("../theme");
const { truncate, chatName } = require("./utils");

// Compose workspace: a boxed region with a To: line and a body editor.
// Enter inserts a newline; Ctrl-S sends; Esc cancels. The real terminal
// cursor is placed at (cursorX, cursorY) when renderWithCursor is used.
function drawCompose(s, region, opts) {
  const { target, text, cursorRow, cursorCol, quoting, isReply } = opts;
  const w = region.w;
  const x = region.x;
  let y = region.y;

  s.fill(x, y, w, region.h, " ");
  s.text(x + 1, y, "COMPOSE", T.sectionTitle);
  if (quoting) {
    s.text(x + w - 4, y, isReply ? "[reply]" : "[fwd]", T.attachment);
  }
  s.hline(x, y + 1, w, "─", T.border);

  // To: line
  const toLabel = target ? truncate(chatName(target), Math.max(8, w - 14)) : "(no chat)";
  s.text(x + 1, y + 2, "To: ", T.contextLabel);
  s.text(x + 5, y + 2, toLabel, T.contextValue);

  // quoted context (reply/forward)
  let bodyTop = y + 4;
  if (quoting) {
    const quote = truncate(quoting.body || "", Math.max(8, w - 8));
    s.text(x + 1, y + 3, `┌ ${quoting.isMe ? "you" : "them"}: ${quote}`, T.muted);
    s.text(x + 1, y + 4, "└────────────────────────", T.muted);
    bodyTop = y + 5;
  }

  // body area
  s.hline(x, bodyTop - 1, w, "─", T.border);
  const lines = String(text || "").split("\n");
  let ty = bodyTop;
  for (const line of lines.slice(0, Math.max(1, region.h - (bodyTop - y) - 3))) {
    if (ty >= y + region.h - 3) break;
    s.text(x + 1, ty, line, T.ownBody);
    ty++;
  }

  // hint bar
  s.fill(x, y + region.h - 2, w, 1, " ");
  s.text(x + 1, y + region.h - 2, "Ctrl-S send · Enter newline · Esc cancel", T.hint);

  return {
    cursorX: x + 1 + (cursorCol || 0),
    cursorY: bodyTop + (cursorRow || 0),
  };
}

module.exports = { drawCompose };
