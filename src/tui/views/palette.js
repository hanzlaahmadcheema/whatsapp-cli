"use strict";

const { T } = require("../theme");
const { truncate } = require("./utils");

// The palette catalog. Each entry maps a / key to an action the app performs.
// `keywords` extend search matching beyond the label.
const PALETTE_ITEMS = Object.freeze([
  { id: "send", label: "Send message", keys: "c", keywords: "send compose write" },
  { id: "search-chats", label: "Search conversations", keys: "/", keywords: "find filter chat" },
  { id: "search-contacts", label: "Search contacts", keys: ":", keywords: "contact phone" },
  { id: "seen", label: "Mark conversation seen", keys: "Enter", keywords: "read clear unread" },
  { id: "archive", label: "Archive conversation", keys: "a", keywords: "hide archive" },
  { id: "unarchive", label: "Unarchive conversation", keys: "", keywords: "show restore" },
  { id: "reply", label: "Reply to selected message", keys: "r", keywords: "answer quote" },
  { id: "forward", label: "Forward selected message", keys: "f", keywords: "share send" },
  { id: "refresh", label: "Refresh chats & status", keys: "r", keywords: "reload sync" },
  { id: "toggle-context", label: "Toggle context panel", keys: "x", keywords: "info details panel" },
  { id: "help", label: "Keyboard help", keys: "?", keywords: "keys shortcuts help" },
  { id: "quit", label: "Quit", keys: "q", keywords: "exit leave" },
]);

function filterPalette(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return PALETTE_ITEMS;
  const tokens = q.split(/\s+/);
  return PALETTE_ITEMS.filter((item) => {
    const words = [item.label, item.keywords, item.keys].join(" ").toLowerCase().split(/\s+/);
    return tokens.every((tok) => words.some((w) => w.startsWith(tok)));
  });
}

// Draw a centered overlay box. Returns the box region so input can be placed.
function drawPalette(s, width, height, query, selectedIndex) {
  const items = filterPalette(query);
  const boxW = Math.min(56, Math.max(32, width - 8));
  const listH = Math.min(items.length, 10);
  const boxH = listH + 3; // title + query + list
  const bx = Math.floor((width - boxW) / 2);
  const by = Math.max(1, Math.floor((height - boxH) / 2));

  s.box(bx, by, boxW, boxH, T.borderStrong, " COMMAND PALETTE ");
  s.text(bx + 1, by + 1, "/ " + query, T.paletteQuery);
  s.hline(bx + 1, by + 2, boxW - 2, "─", T.border);

  const start = Math.max(0, Math.min(selectedIndex, items.length - listH));
  for (let i = 0; i < listH; i++) {
    const item = items[start + i];
    if (!item) break;
    const isSel = start + i === selectedIndex;
    const y = by + 3 + i;
    s.fill(bx + 1, y, boxW - 2, 1, " ", isSel ? T.paletteSelection : {});
    const label = truncate(item.label, boxW - 12);
    s.text(bx + 2, y, label, isSel ? T.paletteSelection : { fg: "white" });
    if (item.keys) s.text(bx + boxW - 4 - item.keys.length, y, item.keys, isSel ? T.paletteSelection : T.muted);
  }
  if (items.length === 0) {
    s.text(bx + 2, by + 3, "no matching commands", T.hint);
  }
  return { x: bx, y: by, w: boxW, h: boxH, items };
}

module.exports = { drawPalette, filterPalette, PALETTE_ITEMS };
