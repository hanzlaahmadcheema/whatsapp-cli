"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  isClientUsable,
  fetchAccountInfo,
  normalizeAccount,
  withTimeout,
} = require("../../src/whatsapp/probe");

function fakeClient({ failTimes = 0, chats = [], info } = {}) {
let calls = 0;
  return {
    getChats() {
      calls += 1;
      if (calls <= failTimes) return Promise.reject(new Error("boom"));
      return Promise.resolve(chats);
    },
    getContactById: async () => ({}),
    info: info || { wid: { user: "15551234567" }, pushname: "Tester" },
    calls: () => calls,
  };
}

test("isClientUsable returns true when getChats resolves", async () => {
  const client = fakeClient({ chats: [{ id: "x" }] });
  assert.equal(await isClientUsable(client, { attempts: 2, delayMs: 1 }), true);
});

test("isClientUsable retries transient failures", async () => {
  const client = fakeClient({ failTimes: 2, chats: [] });
  assert.equal(await isClientUsable(client, { attempts: 4, delayMs: 1 }), true);
});

test("isClientUsable returns false after max attempts", async () => {
  const client = fakeClient({ failTimes: 99, chats: [] });
  assert.equal(await isClientUsable(client, { attempts: 2, delayMs: 1 }), false);
});

test("isClientUsable handles null client", async () => {
  assert.equal(await isClientUsable(null), false);
});

test("fetchAccountInfo normalizes client.info", async () => {
  const info = await fetchAccountInfo(fakeClient());
  assert.equal(info.number, "15551234567");
  assert.equal(info.me, "15551234567@c.us");
  assert.equal(info.pushname, "Tester");
});

test("normalizeAccount guards null input", () => {
  assert.equal(normalizeAccount(null), null);
});

test("withTimeout resolves values immediately and rejects on timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 1000), 1);
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 10),
    /probe timeout/
  );
});