"use strict";

// Responsive three-region workspace:
//   ┌───────────┬──────────────────┬──────────┐
//   │  INBOX    │  CONVERSATION    │ CONTEXT  │
//   └───────────┴──────────────────┴──────────┘
// Wide (>=WIDE): all three visible.
// Medium (>=MEDIUM): inbox + conversation; context toggled as an overlay panel.
// Narrow (<MEDIUM): single maximized region, Tab cycles focus.

const WIDE = 160;
const MEDIUM = 100;
const MIN_INBOX = 24;
const MIN_CONTEXT = 26;

function isWide(width) {
  return width >= WIDE;
}

function isMedium(width) {
  return width >= MEDIUM;
}

// Returns region geometry for the current width.
// focus: "inbox" | "conversation" | "context" (narrow mode drives the split).
// contextOpen: whether the CONTEXT panel is shown in medium mode.
function computeLayout({ width, height, focus = "conversation", contextOpen = false }) {
  const headerH = 1;
  const footerH = 1;
  const bodyTop = headerH;
  const bodyH = Math.max(1, height - headerH - footerH);

  if (isWide(width)) {
    const inboxW = clamp(Math.floor(width * 0.3), MIN_INBOX, 44);
    const ctxW = clamp(Math.floor(width * 0.2), MIN_CONTEXT, 34);
    return {
      header: { x: 0, y: 0, w: width, h: headerH },
      footer: { x: 0, y: height - footerH, w: width, h: footerH },
      inbox: { x: 0, y: bodyTop, w: inboxW, h: bodyH },
      conversation: { x: inboxW, y: bodyTop, w: width - inboxW - ctxW, h: bodyH },
      context: { x: width - ctxW, y: bodyTop, w: ctxW, h: bodyH },
      contextOpen: true,
      responsive: "wide",
    };
  }

  if (isMedium(width)) {
    const inboxW = clamp(Math.floor(width * 0.34), MIN_INBOX, 38);
    let context = null;
    if (contextOpen) {
      const ctxW = clamp(Math.floor(width * 0.24), MIN_CONTEXT, 32);
      context = { x: width - ctxW, y: bodyTop, w: ctxW, h: bodyH };
    }
    const convW = width - inboxW - (context ? context.w : 0);
    return {
      header: { x: 0, y: 0, w: width, h: headerH },
      footer: { x: 0, y: height - footerH, w: width, h: footerH },
      inbox: { x: 0, y: bodyTop, w: inboxW, h: bodyH },
      conversation: { x: inboxW, y: bodyTop, w: convW, h: bodyH },
      context,
      contextOpen: !!context,
      responsive: "medium",
    };
  }

  // Narrow: single maximized region.
  const regions = { inbox: null, conversation: null, context: null };
  regions[focus] = { x: 0, y: bodyTop, w: width, h: bodyH };
  return {
    header: { x: 0, y: 0, w: width, h: headerH },
    footer: { x: 0, y: height - footerH, w: width, h: footerH },
    inbox: regions.inbox,
    conversation: regions.conversation,
    context: regions.context,
    contextOpen: false,
    responsive: "narrow",
  };
}

function cycleFocus(focus, direction = 1) {
  const order = ["inbox", "conversation", "context"];
  const i = order.indexOf(focus);
  if (i === -1) return "inbox";
  return order[(i + direction + order.length) % order.length];
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { computeLayout, cycleFocus, isWide, isMedium, WIDE, MEDIUM };
