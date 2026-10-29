"use strict";

const http = require("http");
const { URL } = require("url");
const { ROUTES, ok, fail, STATE } = require("../ipc/protocol");
const { generateToken, TOKEN_HEADER } = require("../ipc/token");
const daemonStore = require("../store/daemon");

class DaemonServer {
  constructor({ service, port = 0, host = "127.0.0.1" }) {
    this.service = service;
    this.host = host;
    this.port = port;
    this.token = generateToken();
    this.server = null;
    this.sseClients = new Set();
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  handle(req, res) {
    if (!this.authorize(req)) {
      return this.json(res, 401, fail("UNAUTHORIZED", "Missing or invalid token"));
    }
    const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const method = req.method;

    if (pathname === ROUTES.HEALTH && method === "GET") {
      return this.json(res, 200, ok({ state: this.service.state }));
    }
    if (pathname === ROUTES.STATUS && method === "GET") {
      return this.json(res, 200, ok(this.statusPayload()));
    }
    if (pathname === ROUTES.LOGIN && method === "GET") {
      return this.sse(res, "/login");
    }
    if (pathname === ROUTES.RECEIVE && method === "GET") {
      return this.sse(res, "/receive");
    }
    if (pathname === ROUTES.SEND && method === "POST") {
      return this.withBody(req, res, (body) => this.handleSend(res, body));
    }
    if (pathname === ROUTES.SEND_MEDIA && method === "POST") {
      return this.withBody(req, res, (body) => this.handleSendMedia(res, body));
    }
    if (pathname === ROUTES.CHATS && method === "GET") {
      return this.handleChats(req, res);
    }
    if (pathname === ROUTES.CONTACTS && method === "GET") {
      return this.handleContacts(req, res);
    }
    if (pathname === ROUTES.HISTORY && method === "GET") {
      return this.handleHistory(req, res);
    }
    if (pathname === ROUTES.LOGOUT && method === "POST") {
      return this.handleLogout(res);
    }
    if (pathname === ROUTES.CHAT_SEEN && method === "POST") {
      return this.withBody(req, res, (body) => this.handleChatAction(res, body, "markSeen"));
    }
    if (pathname === ROUTES.CHAT_ARCHIVE && method === "POST") {
      return this.withBody(req, res, (body) => this.handleChatAction(res, body, "setArchived", body && { archived: !!body.archived }));
    }

    return this.json(res, 404, fail("NOT_FOUND", `No route for ${method} ${pathname}`));
  }

  authorize(req) {
    return req.headers[TOKEN_HEADER] === this.token;
  }

  statusPayload() {
    return {
      state: this.service.state,
      account: this.service.account,
      lastError: this.service.lastError,
      nodeVersion: process.version,
      appVersion: require("../../package.json").version,
    };
  }

  async handleSend(res, body) {
    const { to, message } = body || {};
    if (!to || !message) {
      return this.json(res, 400, fail("BAD_REQUEST", "`to` and `message` are required"));
    }
    const result = await this.service.send({ to, body: message });
    return this.json(res, result.ok ? 200 : 409, result);
  }

  async handleSendMedia(res, body) {
    const { to, filePath, data, mimetype, filename, caption, sendMediaAsDocument, isImage } = body || {};
    if (!to || (!filePath && !data)) {
      return this.json(res, 400, fail("BAD_REQUEST", "`to` and either `filePath` or `data` are required"));
    }
    try {
      const { loadMessageMedia } = require("../media");
      const media = loadMessageMedia({
        filePath,
        data,
        mimetype,
        filename,
        isImage: !!isImage,
        isDocument: !!sendMediaAsDocument,
      });

      const result = await this.service.sendMedia({
        to,
        media,
        options: {
          caption: caption || undefined,
          sendMediaAsDocument: !!sendMediaAsDocument,
        },
      });
      return this.json(res, result.ok ? 200 : 409, result);
    } catch (err) {
      return this.json(res, 400, fail("INVALID_MEDIA", err && err.message ? err.message : String(err)));
    }
  }

  async handleChats(req, res) {
    const qs = new URL(req.url, "http://x").searchParams;
    const limit = parseInt(qs.get("limit") || "50", 10) || 50;
    const result = await this.service.getChats({ limit });
    return this.json(res, 200, ok({ chats: result }));
  }

  async handleContacts(req, res) {
    const qs = new URL(req.url, "http://x").searchParams;
    const name = qs.get("name") || "";
    const result = await this.service.getContacts({ name });
    return this.json(res, 200, ok({ contacts: result }));
  }

  async handleHistory(req, res) {
    const qs = new URL(req.url, "http://x").searchParams;
    const chatId = qs.get("chatId") || "";
    const limit = parseInt(qs.get("limit") || "50", 10) || 30;
    if (!chatId) {
      return this.json(res, 400, fail("BAD_REQUEST", "`chatId` is required"));
    }
    const result = await this.service.getHistory({ chatId, limit });
    return this.json(res, 200, ok({ messages: result }));
  }

  async handleChatAction(res, body, action, extra = {}) {
    const { chatId } = body || {};
    if (!chatId) {
      return this.json(res, 400, fail("BAD_REQUEST", "`chatId` is required"));
    }
    const result = await this.service[action]({ chatId, ...extra });
    return this.json(res, result.ok ? 200 : 409, result);
  }

  async handleLogout(res) {
    this.service.controller.stop();
    daemonStore.update({ logoutRequested: true });
    this.broadcast({ event: "logout" });
    await this.service.controller.client?.client?.logout?.();
    return this.json(res, 200, ok({ state: STATE.LOGGED_OUT }));
  }

  json(res, code, payload) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  sse(res, eventName) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ type: eventName, at: Date.now() })}\n\n`);
    const unsub = this.service.subscribe((event) => {
      if (res.writableEnded) return;
      res.write(`event: ${event.event || "event"}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    res.on("close", () => unsub());
    return res;
  }

  withBody(req, res, handler) {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        handler(JSON.parse(data || "{}"));
      } catch {
        this.json(res, 400, fail("BAD_JSON", "Invalid JSON body"));
      }
    });
  }
}

module.exports = { DaemonServer };