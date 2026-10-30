"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");

const { Controller } = require("../../src/daemon/controller");
const { WhatsAppService } = require("../../src/daemon/service");
const { STATE } = require("../../src/ipc/protocol");

function makeMockClient({ failProbe = false, failInit = false } = {}) {
  const mock = new EventEmitter();
  mock.initialize = async () => {
    if (failInit) throw new Error("Initialization failed");
  };
  mock.logout = async () => {};
  mock.sendMessage = async () => ({ id: { _serialized: "m1" } });
  mock.getChats = async () => {
    if (failProbe) throw new Error("Probe failed: not operable");
    return [{ id: "x@c.us" }];
  };
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

test("successful readiness probe after recovery transitions to READY", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);

  const ctrl = new Controller({
    destroyTimeoutMs: 10,
    initTimeoutMs: 100,
    backoffBaseMs: 10,
    maxRecoveryAttempts: 3,
  });

  await ctrl.start();
  const res = await ctrl.recover();
  assert.equal(res, true, "recover() returned true on successful probe");
  assert.equal(ctrl.getState(), STATE.READY, "state is READY after successful recovery");
  ctrl.stop();
});

test("multiple simultaneous recovery requests share the same promise", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);

  const ctrl = new Controller({
    destroyTimeoutMs: 10,
    initTimeoutMs: 100,
    backoffBaseMs: 10,
    maxRecoveryAttempts: 3,
  });

  await ctrl.start();

  // Call recover twice concurrently
  const [res1, res2] = await Promise.all([ctrl.recover(), ctrl.recover()]);
  assert.equal(res1, true);
  assert.equal(res2, true);
  assert.equal(ctrl.getState(), STATE.READY);
  ctrl.stop();
});

test("failed recovery escalates to ERROR after max attempts exhausted", async () => {
  // Mock client that fails readiness probe every time
  const mock = makeMockClient({ failProbe: true });
  installMockFactory(mock);

  const ctrl = new Controller({
    destroyTimeoutMs: 10,
    initTimeoutMs: 50,
    backoffBaseMs: 10,
    maxRecoveryAttempts: 2,
    probeAttempts: 1,
    probeDelayMs: 5,
  });

  await ctrl.start();

  let recoveryFailedEvent = null;
  ctrl.on("recovery_failed", (data) => {
    recoveryFailedEvent = data;
  });

  try {
    await ctrl.recover();
    assert.fail("recover() should have thrown when attempts exhausted");
  } catch (err) {
    assert.ok(err, "error thrown");
  }

  assert.equal(ctrl.getState(), STATE.ERROR, "escalates to ERROR state instead of looping forever");
  assert.ok(recoveryFailedEvent, "recovery_failed event was emitted");
  assert.equal(recoveryFailedEvent.attempts, 2);
  ctrl.stop();
});

test("resume recovery waits for network and handles network unavailable", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);

  const ctrl = new Controller({
    destroyTimeoutMs: 10,
    initTimeoutMs: 50,
    backoffBaseMs: 10,
    maxRecoveryAttempts: 2,
    probeAttempts: 1,
    probeDelayMs: 5,
  });

  await ctrl.start();

  // Mock dns lookup that permanently fails
  const failingDns = async () => {
    throw new Error("ENETUNREACH");
  };

  try {
    await ctrl.resume({
      autoReconnect: true,
      networkTimeoutMs: 80,
      dnsLookupFn: failingDns,
    });
    assert.fail("resume should throw when network unavailable");
  } catch (err) {
    assert.ok(err.message.includes("Network not available"));
  }

  assert.equal(ctrl.getState(), STATE.ERROR, "transitions to ERROR when network unavailable");
  ctrl.stop();
});

test("service suspends on PrepareForSleep and resumes cleanly on wake", async () => {
  const mock = makeMockClient();
  installMockFactory(mock);

  const service = new WhatsAppService({
    sleepOpts: { disabled: true },
    maxRecoveryAttempts: 2,
  });

  await service.start();
  assert.equal(service.state, STATE.CONNECTING);

  // Simulate suspend
  service.handleSuspend();
  assert.equal(service.state, STATE.CONNECTING);
  assert.ok(service.lastError.includes("suspended"));

  // Simulate resume with working mock dns
  const workingDns = async () => ({ address: "1.2.3.4", family: 4 });
  await service.controller.resume({
    autoReconnect: true,
    networkTimeoutMs: 500,
    dnsLookupFn: workingDns,
  });

  assert.equal(service.controller.getState(), STATE.READY);
  service.stop();
});
