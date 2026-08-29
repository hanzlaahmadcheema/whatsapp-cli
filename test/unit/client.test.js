"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { WhatsAppClient, setClientFactory } = require("../../src/whatsapp/client");
const { STATE } = require("../../src/ipc/protocol");

function makeMockClient() {
  const mock = new EventEmitter();
  mock.initialize = async () => {};
  mock.logout = async () => {};
  mock.sendMessage = async (to, body) => ({
    id: { _serialized: `SENT:${to}:${body}` },
  });
  mock.getChats = async () => [];
  mock.getContacts = async () => [];
  mock.getChatById = async (id) => ({
    id,
    fetchMessages: async () => [],
  });
  mock.destroy = async () => {};
  return mock;
}

test("WhatsAppClient emits qr and transitions to linking", async () => {
  const mock = makeMockClient();
  setClientFactory(() => mock);
  const wc = new WhatsAppClient({});
  await wc.initialize();
  let sawQr = null;
  wc.on("qr", (qr) => (sawQr = qr));
  mock.emit("qr", "QRDATA");
  assert.equal(sawQr, "QRDATA");
  assert.equal(wc.state, STATE.LINKING);
});

test("WhatsAppClient forwards ready and authenticated", async () => {
  const mock = makeMockClient();
  setClientFactory(() => mock);
  const wc = new WhatsAppClient({});
  await wc.initialize();

  let ready = false;
  wc.on("ready", () => (ready = true));
  mock.emit("authenticated");
  assert.equal(wc.state, STATE.SYNCING);
  mock.emit("ready");
  assert.equal(ready, true);
  assert.equal(wc.state, STATE.READY);
});

test("disconnect with logout reason flags logout", async () => {
  const mock = makeMockClient();
  setClientFactory(() => mock);
  const wc = new WhatsAppClient({});
  await wc.initialize();

  let evt = null;
  wc.on("disconnect", (e) => (evt = e));
  mock.emit("disconnected", "LOGOUT");
  assert.equal(evt.isLogout, true);

  let evt2 = null;
  wc.on("disconnect", (e) => (evt2 = e));
  mock.emit("disconnected", "network changed");
  assert.equal(evt2.isLogout, false);
});

test("buildClientOptions uses local cache and pinned auth dir", () => {
  const { buildClientOptions } = require("../../src/config");
  const opts = buildClientOptions({ authDir: "/tmp/wa/auth", cacheDir: "/tmp/wa/cache" });
  assert.equal(opts.webVersionCache.type, "local");
  assert.equal(opts.webVersionCache.path, "/tmp/wa/cache");
  assert.ok(opts.authStrategy, "authStrategy present");
  assert.ok(opts.puppeteer);
});