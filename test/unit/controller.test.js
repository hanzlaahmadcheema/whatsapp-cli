"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { Controller } = require("../../src/daemon/controller");
const { WhatsAppClient } = require("../../src/whatsapp/client");

function makeMockClient({ hangInitialize = false } = {}) {
  const mock = new EventEmitter();
  mock.initialize = async () => {
    if (hangInitialize) await new Promise(() => {});
  };
  mock.logout = async () => {};
  mock.sendMessage = async (to, body) => ({ id: { _serialized: "m1" } });
  mock.getChats = async () => [{ id: "x@c.us" }];
  mock.getContacts = async () => [];
  mock.getContactById = async () => ({});
  mock.getChatById = async () => ({ fetchMessages: async () => [] });
  mock.destroy = async () => {};
  mock.info = { wid: { user: "15551234567" }, pushname: "Tester" };
  return mock;
}

function installMockFactory(mock) {
  const { setClientFactory } = require("../../src/whatsapp/client");
  setClientFactory(() => mock);
  return mock;
}

test("Controller start initializes the injected client", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);
  const ctrl = new Controller({});
  await ctrl.start();
  assert.ok(ctrl.client, "client available");
  assert.equal(ctrl.getState(), "connecting");
});

test("Controller ready fires after probe succeeds", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);
  const ctrl = new Controller({});
  const events = [];
  ctrl.on("ready", () => events.push("ready"));
  ctrl.on("probe_done", ({ usable }) => events.push(`probe:${usable}`));

  await ctrl.start();
  await ctrl.handleReadinessProbe();
  assert.ok(events.includes("probe:true"));
  assert.ok(events.includes("ready"));
});
test("Controller escalates to logged_out on logout disconnect", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);
  const ctrl = new Controller({});
  let loggedOut = false;
  ctrl.on("logged_out", () => (loggedOut = true));
  await ctrl.start();
  mock.emit("disconnected", "LOGOUT");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(loggedOut, true);
});

test("Controller schedules reconnect on transient disconnect", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);
  const ctrl = new Controller({});
  let sawReconnect = false;
  ctrl.on("reconnect", () => (sawReconnect = true));
  await ctrl.start();
  mock.emit("disconnected");
  assert.equal(sawReconnect, true);
  assert.ok(ctrl.reconnectTimer, "a reconnect timer was scheduled");
  ctrl.stop();
});

test("Controller re-arms backoff when initialize hangs (laptop sleep)", async () => {
  const mock = makeMockClient({ hangInitialize: true });
  installMockFactory(mock);
  // Tiny timeouts so the hung init exhausts quickly in-test.
  const ctrl = new Controller({
    destroyTimeoutMs: 10,
    initTimeoutMs: 30,
    backoffBaseMs: 10,
  });
  let reconnects = 0;
  let errors = 0;
  ctrl.on("reconnect", () => reconnects++);
  ctrl.on("reconnect_error", () => errors++);
  // initialize() hangs, so start() itself rejects on the init timeout — fire
  // and forget (matching daemon/index.js) and swallow the expected rejection.
  void ctrl.start().catch(() => {});

  mock.emit("disconnected");
  await new Promise((r) => setTimeout(r, 5));
  // The reconnect must fire even though initialize() never settles.
  assert.equal(reconnects, 1, "a reconnect attempt was scheduled");
  await new Promise((r) => setTimeout(r, 150));
  // Without the hang-guard, reconnect_error never fires and the daemon
  // silently stays "connecting" forever — exactly the sleep/wake stall.
  assert.ok(errors >= 1, "hung initialize surfaced as reconnect_error");
  // And the loop must continue attempting instead of wedging.
  assert.ok(reconnects >= 2, "backoff loop kept re-arming after the hang");
  ctrl.stop();
});

test("Controller logged_out clears reconnect loop", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);
  const ctrl = new Controller({});
  await ctrl.start();
  mock.emit("disconnected", "LOGOUT");
  await new Promise((r) => setTimeout(r, 5));
  ctrl.stop();
});