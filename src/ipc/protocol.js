"use strict";

const ROUTES = Object.freeze({
  HEALTH: "/health",
  STATUS: "/status",
  LOGIN: "/login",
  SEND: "/send",
  CHATS: "/chats",
  CONTACTS: "/contacts",
  HISTORY: "/history",
  RECEIVE: "/receive",
  LOGOUT: "/logout",
  CHAT_SEEN: "/chat/seen",
  CHAT_ARCHIVE: "/chat/archive",
  SEND_MEDIA: "/send-media",
  MEDIA_INFO: "/media/info",
  MEDIA_DOWNLOAD: "/media/download",
  RECENT_MEDIA: "/media/recent",
  RECONNECT: "/reconnect",
  SUSPEND: "/suspend",
  RESUME: "/resume",
});

const STATE = Object.freeze({
  UNLINKED: "unlinked",
  CONNECTING: "connecting",
  LINKING: "linking",
  SYNCING: "syncing",
  READY: "ready",
  DEGRADED: "degraded",
  LOGGED_OUT: "logged_out",
  ERROR: "error",
});

function ok(data) {
  return { ok: true, ...data };
}

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

module.exports = { ROUTES, STATE, ok, fail };