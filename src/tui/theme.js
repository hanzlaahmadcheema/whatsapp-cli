"use strict";

// Semantic style roles for the Operations Messaging Console.
// Colors communicate state, not decoration. Box-drawing, whitespace and
// typography carry the structure so the UI stays legible in monochrome.

const RESET = "\x1b[0m";
const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34,
  magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90,
  brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};
const BG = Object.fromEntries(Object.entries(FG).map(([k, v]) => [k, v + 10]));

function style(st) {
  const parts = [];
  if (st.bold) parts.push(1);
  if (st.dim) parts.push(2);
  if (st.italic) parts.push(3);
  if (st.underline) parts.push(4);
  if (st.inverse) parts.push(7);
  if (st.fg) parts.push(FG[st.fg] || 0);
  if (st.bg) parts.push(BG[st.bg] || 0);
  return parts.length ? `\x1b[${parts.join(";")}m` : "";
}

const T = {
  // structural
  border: { dim: true },
  borderStrong: { fg: "gray" },
  sectionTitle: { fg: "cyan", bold: true },
  muted: { fg: "gray", dim: true },
  hint: { fg: "gray", dim: true, italic: true },
  plain: { fg: "white" },
  bold: { fg: "brightWhite", bold: true },

  // inbox semantics
  requiresAttention: { fg: "brightYellow", bold: true },
  active: { fg: "green" },
  inactive: { fg: "gray", dim: true },
  unreadBadge: { fg: "black", bg: "brightYellow", bold: true },
  selected: { fg: "black", bg: "brightCyan", bold: true },
  selectedDim: { fg: "gray", bg: "cyan", dim: true },
  groupHeader: { fg: "brightCyan", bold: true },
  preview: { fg: "gray" },
  timestamp: { fg: "gray", dim: true },
  pinned: { fg: "yellow" },
  archived: { fg: "gray", dim: true, italic: true },

  // conversation
  senderMe: { fg: "brightGreen", bold: true },
  senderOther: { fg: "cyan", bold: true },
  senderGroup: { fg: "magenta", bold: true },
  separator: { fg: "gray", dim: true },
  ownBody: { fg: "brightWhite" },
  otherBody: { fg: "white" },
  attachment: { fg: "brightMagenta", bold: true },
  ackSent: { fg: "gray" },
  ackDelivered: { fg: "cyan" },
  ackRead: { fg: "brightBlue" },
  selectionMark: { fg: "brightYellow", bold: true },

  // context panel
  contextLabel: { fg: "gray", dim: true },
  contextValue: { fg: "brightWhite" },
  contextSection: { fg: "cyan", bold: true },

  // status line
  ok: { fg: "green", bold: true },
  warn: { fg: "yellow", bold: true },
  err: { fg: "red", bold: true },
  footer: { fg: "white", dim: true },

  // palette / command
  paletteSelection: { fg: "black", bg: "brightCyan", bold: true },
  paletteQuery: { fg: "brightYellow" },
  commandPrompt: { fg: "brightYellow", bold: true },

  // error / notice
  notice: { fg: "white" },
  error: { fg: "brightRed", bold: true },
};

const ST = {
  titleBar: { fg: "brightWhite", bold: true },
  titleBarMuted: { fg: "white", dim: true },
  titleBarStatus: { fg: "black", bold: true },
  titleBarBg: { bg: "brightBlack" },
};

module.exports = { style, T, ST, FG, BG, RESET };
