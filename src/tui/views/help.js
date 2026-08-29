"use strict";

const { T } = require("../theme");

// Contextual help: rendered on demand via `?`. Lists the actions available in
// the current mode so the interface never depends on memorizing shortcuts.
function drawHelp(s, region, mode) {
  s.fill(region.x, region.y, region.w, region.h, " ");
  const x = region.x + 2;
  let y = region.y + 2;

  const rows = helpRows(mode);
  s.text(x, y, `HELP — ${mode}`, T.sectionTitle);
  y += 2;
  for (const [keys, desc] of rows) {
    if (y >= region.y + region.h - 2) break;
    s.text(x, y, keys, { fg: "cyan", bold: true });
    s.text(x + 14, y, desc, T.muted);
    y += 1;
  }
  y += 1;
  s.text(x, y, "Press Esc to return", T.hint);
}

function helpRows(mode) {
  const common = [
    ["j / k / ↑ ↓", "navigate list"],
    ["Enter", "open / mark seen"],
    ["Esc", "back / cancel"],
    ["/", "command palette"],
    [":", "command mode"],
    ["?", "this help"],
    ["q / Ctrl-C", "quit"],
  ];
  const inbox = [
    ...common,
    ["c", "compose to selected"],
    ["r", "reply"],
    ["a", "archive selected"],
    ["x", "toggle context panel"],
    ["R", "refresh chats"],
  ];
  const conversation = [
    ...common,
    ["c", "compose"],
    ["r", "reply to selected msg"],
    ["f", "forward selected msg"],
    ["[ / ]", "scroll older / newer"],
    ["a", "archive chat"],
  ];
  const compose = [
    ["Ctrl-S", "send"],
    ["Enter", "newline"],
    ["Esc", "cancel"],
  ];
  const palette = [
    ["Type", "filter commands"],
    ["j / k / ↑ ↓", "select"],
    ["Enter", "run"],
    ["Esc", "close"],
  ];
  const command = [
    ["Type", "ex-style command"],
    ["Enter", "run"],
    ["Esc", "cancel"],
  ];
  switch (mode) {
    case "conversation": return conversation;
    case "compose": return compose;
    case "palette": return palette;
    case "command": return command;
    default: return inbox;
  }
}

module.exports = { drawHelp, helpRows };
