"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { WhatsAppService } = require("../../src/daemon/service");
const { DaemonServer } = require("../../src/daemon/server");
const { STATE } = require("../../src/ipc/protocol");
const { TOKEN_HEADER } = require("../../src/ipc/token");
const { paths } = require("../../src/config/paths");
const fs = require("fs");

function makeMockClient() {
  const mock = new EventEmitter();
  mock.initialize = async () => {};
  mock.logout = async () => {};
  mock.sendMessage = async (to, body) => ({
    id: { _serialized: `m:${to}:${body}` },
  });
  mock.getChats = async () => [{ id: { _serialized: "15551234567@c.us" } }];
  mock.getContactById = async () => ({});
  mock.getContacts = async () => [
    {
      id: { _serialized: "15551234567@c.us" },
      name: "Alex",
      pushname: "Alex P",
      number: "15551234567",
    },
  ];
  mock.getChatById = async (id) => ({
    id: { _serialized: id },
    fetchMessages: async () => [
      { id: { _serialized: "m1" }, from: "me", to: id, body: "hello", timestamp: 1700000000 },
    ],
  });
  mock.info;
  return mock;
}

test("daemon serves status, send, chats, contacts, history over HTTP", async (t) => {
  const { setClientFactory } = require("../../src/whatsapp/client");
  const mock = makeMockClient();
  setClientFactory(() => mock);

  const service = new WhatsAppService({});
  await service.start();
  service.state = STATE.READY;

  const server = new DaemonServer({ service });
  const port = await server.start();
  t.after(async () => server.stop());

  const base = `http://127.0.0.1:${port}`;
  const token = server.token;
  const h = { [TOKEN_HEADER]: token };
  const get = (p) => fetch(base + p, { headers: h }).then((r) => r.json());

  const status = await get("/status");
  assert.equal(status.ok, true);
  assert.equal(status.state, STATE.READY);

  const send = await fetch(base + "/send", {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ to: "15551234567@c.us", message: "hi" }),
  }).then((r) => r.json());
  assert.equal(send.ok, true);
  assert.equal(send.messageId, "m:15551234567@c.us:hi");

  const chats = await get("/chats?limit=5");
  assert.equal(chats.ok, true);
  assert.equal(chats.chats.length, 1);

  const contacts = await get("/contacts");
  assert.equal(contacts.ok, true);
  assert.equal(contacts.contacts[0].number, "15551234567");

  const history = await get("/history?chatId=15551234567@c.us&limit=5");
  assert.equal(history.ok, true);
  assert.equal(history.messages[0].body, "hello");
});

test("daemon rejects requests with a bad token", async (t) => {
  const { setClientFactory } = require("../../src/whatsapp/client");
  setClientFactory(() => makeMockClient());

  const service = new WhatsAppService({});
  service.state = STATE.READY;
  const server = new DaemonServer({ service });
  const port = await server.start();
  t.after(async () => server.stop());

  const res = await fetch(`http://127.0.0.1:${port}/status`, {
    headers: { [TOKEN_HEADER]: "wrong" },
  });
  assert.equal(res.status, 401);
});

test("send returns NOT_READY before the session is healthy", async () => {
  const { setClientFactory } = require("../../src/whatsapp/client");
  setClientFactory(() => makeMockClient());

  const service = new WhatsAppService({});
  const res = await service.send({ to: "15551234567@c.us", body: "hi" });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NOT_READY");
});

test("service broadcasts state and qr to subscribers", () => {
  const { setClientFactory } = require("../../src/whatsapp/client");
  setClientFactory(() => makeMockClient());
  const service = new WhatsAppService({});
  const seen = [];
  service.subscribe((e) => seen.push(e.event));

  const qrClient = service.controller.client;
  qrClient.emit("qr", "ABC123");
  assert.ok(seen.includes("qr"));
});

test("service detects detached-frame errors and triggers recovery", async () => {
  const { setClientFactory } = require("../../src/whatsapp/client");
  setClientFactory(() => makeMockClient());
  const service = new WhatsAppService({});
  service.state = STATE.READY;

  const err = new Error("Attempted to use detached Frame '04CB7E...'");
  assert.equal(service.isFrameError(err), true);
  assert.equal(service.isFrameError(new Error("some other error")), false);

  // recovery kicks the state to CONNECTING and broadcasts a reason
  const states = [];
  service.subscribe((e) => states.push(e));
  const recoverPromise = service.recoverFromFrameFailure("getChats");
  assert.equal(service.state, STATE.CONNECTING);
  assert.match(service.lastError, /reconnecting/);
  await recoverPromise;
  assert.ok(states.some((e) => e.state === STATE.CONNECTING));
});

test("store daemon file roundtrip", () => {
  const daemon = require("../../src/store/daemon");
  const orig = paths.daemonFile;
  paths.daemonFile = "/tmp/opencode/wa-daemon-test.json";
  try {
    daemon.write({ pid: 42, port: 9999, token: "tok" });
    assert.equal(daemon.read().port, 9999);
    daemon.update({ state: "ready" });
    assert.equal(daemon.read().state, "ready");
  } finally {
    try {
      fs.unlinkSync(paths.daemonFile);
    } catch (_) {}
    paths.daemonFile = orig;
  }
});