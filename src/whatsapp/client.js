"use strict";

const { EventEmitter } = require("events");
const { buildClientOptions } = require("../config");
const { STATE } = require("../ipc/protocol");

let _clientFactory = null;

function setClientFactory(fn) {
  _clientFactory = fn;
}

function defaultClientFactory(options) {
  const { Client } = require("whatsapp-web.js");
  return new Client(options);
}

class WhatsAppClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.state = STATE.UNLINKED;
    this.lastError = null;
    this.latestQr = null;
    this.accountInfo = null;
    this.client = null;
    this.readyAt = null;
  }

  buildOptions() {
    return buildClientOptions(this.opts);
  }

  async initialize() {
    this.setState(STATE.CONNECTING);
    const factory = _clientFactory || defaultClientFactory;
    this.client = factory(this.buildOptions());
    this.attachEvents(this.client);
    if (typeof this.client.initialize === "function") {
      await this.client.initialize();
    }
    return this.client;
  }

  attachEvents(client) {
    client.on("qr", (qr) => {
      this.latestQr = qr;
      this.setState(STATE.LINKING);
      this.emit("qr", qr);
    });

    client.on("authenticated", () => {
      this.setState(STATE.SYNCING);
      this.emit("authenticated");
    });

    client.on("auth_failure", (err) => {
      this.lastError = String((err && err.message) || err);
      this.setState(STATE.LOGGED_OUT);
      this.emit("auth_failure", err);
    });

    client.on("ready", () => {
      this.readyAt = Date.now();
      this.setState(STATE.READY);
      this.emit("ready");
    });

    client.on("disconnected", (reason) => {
      this.handleDisconnect(reason);
    });

    client.on("message", (msg) => {
      this.emit("message", msg);
    });
  }

  handleDisconnect(reason) {
    const message = String(reason || "");
    const isLogout = /logout/i.test(message) || message === "LOGOUT";
    this.emit("disconnect", { reason: message, isLogout });
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
  }
}

module.exports = { WhatsAppClient, setClientFactory, defaultClientFactory };