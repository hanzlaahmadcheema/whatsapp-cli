"use strict";

const { request } = require("../cli/lib/transport");
const daemonStore = require("../store/daemon");
const { ROUTES } = require("../ipc/protocol");

class TuiApi {
  constructor() {
    this.base = null;
    this.token = null;
    this._lastFile = null;
  }

  refresh() {
    const d = daemonStore.read();
    if (d) {
      this.base = `http://${d.host}:${d.port}`;
      this.token = d.token;
      this._lastFile = d;
    }
    return this.base != null;
  }

  update(d) {
    this.base = `http://${d.host}:${d.port}`;
    this.token = d.token;
    this._lastFile = d;
  }

  get ready() {
    return this.base != null && this.token != null;
  }

  connected() {
    this.refresh();
    return this.ready;
  }

  async get(pathname, query) {
    if (!this.connected()) return { ok: false, error: { code: "NO_DAEMON" } };
    return request(this.base, this.token, "GET", pathname, null, { query });
  }

  async post(pathname, body) {
    if (!this.connected()) return { ok: false, error: { code: "NO_DAEMON" } };
    return request(this.base, this.token, "POST", pathname, body);
  }

  status() {
    return this.get(ROUTES.STATUS);
  }

  chats(limit = 100) {
    return this.get(ROUTES.CHATS, { limit });
  }

  history(chatId, limit = 50) {
    return this.get(ROUTES.HISTORY, { chatId, limit });
  }

  send(to, message) {
    return this.post(ROUTES.SEND, { to, message });
  }

  markSeen(chatId) {
    return this.post(ROUTES.CHAT_SEEN, { chatId });
  }

  setArchived(chatId, archived) {
    return this.post(ROUTES.CHAT_ARCHIVE, { chatId, archived });
  }

  logout() {
    return this.post(ROUTES.LOGOUT);
  }

  // Subscribe to the daemon SSE /receive stream. Returns an unsubscribe fn.
  // cb(event) is called with parsed event payloads: {event, ...}.
  subscribe(cb) {
    if (!this.connected()) return () => {};
    const { get } = require("http");
    const url = new URL(ROUTES.RECEIVE, this.base);
    const req = get(url, { headers: { "x-wa-token": this.token } }, (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data && data.event) cb(data);
          } catch (_) {}
        }
      });
    });
    req.on("error", () => {});
    return () => {
      try {
        req.destroy();
      } catch (_) {}
    };
  }
}

module.exports = { TuiApi };
