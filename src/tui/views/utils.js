"use strict";

// Shared drawing helpers used by the view modules. Pure functions over the
// Screen cell buffer; each takes (s, region, ...) where region = {x,y,w,h}.

const { T } = require("../theme");
const { shortJid } = require("../../ipc/jid");

function sectionHeader(s, region, title, opts = {}) {
  const x = region.x;
  const y = region.y;
  const w = region.w;
  s.fill(x, y, w, 1, " ");
  s.text(x + 1, y, title, T.sectionTitle);
  if (opts.right) {
    const r = String(opts.right);
    s.text(Math.max(x + 1, x + w - r.length - 1), y, r, T.muted);
  }
  s.hline(x, y + 1, w, "─", T.border);
}

function hline(s, region, y, ch = "─", style = T.border) {
  s.hline(region.x, y, region.w, ch, style);
}

function divider(s, x, y0, y1, ch = "│", style = T.border) {
  s.vline(x, y0, y1 - y0 + 1, ch, style);
}

// Truncate with ellipsis at a byte width.
function truncate(str, maxW) {
  str = String(str == null ? "" : str);
  if (maxW <= 0) return "";
  if (str.length <= maxW) return str;
  if (maxW <= 1) return "…";
  return str.slice(0, maxW - 1) + "…";
}

// Short label for a chat: prefer the saved name, else the number suffix.
function chatName(chat) {
  if (chat && chat.name) return chat.name;
  return chat && chat.id ? shortJid(chat.id) : "?";
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { sectionHeader, hline, divider, truncate, chatName, clamp };
