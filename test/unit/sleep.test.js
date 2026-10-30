"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { SleepNotifier, checkNetworkReady } = require("../../src/daemon/sleep");

test("SleepNotifier parses PrepareForSleep signals correctly", () => {
  const notifier = new SleepNotifier({ disabled: true });
  let sawSuspend = false;
  let sawResume = false;

  notifier.on("suspend", () => {
    sawSuspend = true;
  });
  notifier.on("resume", () => {
    sawResume = true;
  });

  // Test true (suspend) line
  notifier._handleLine("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)");
  assert.equal(sawSuspend, true, "suspend event emitted on PrepareForSleep true");
  assert.equal(sawResume, false);

  // Test false (resume) line
  notifier._handleLine("/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)");
  assert.equal(sawResume, true, "resume event emitted on PrepareForSleep false");
});

test("SleepNotifier simulation helpers emit suspend and resume events", () => {
  const notifier = new SleepNotifier({ disabled: true });
  let events = [];

  notifier.on("suspend", (e) => events.push("suspend"));
  notifier.on("resume", (e) => events.push("resume"));

  notifier.simulateSuspend();
  notifier.simulateResume();

  assert.deepEqual(events, ["suspend", "resume"]);
});

test("checkNetworkReady succeeds immediately when DNS resolves", async () => {
  const mockDns = async (host) => ({ address: "1.2.3.4", family: 4 });
  const ready = await checkNetworkReady({
    timeoutMs: 1000,
    intervalMs: 100,
    dnsLookupFn: mockDns,
  });
  assert.equal(ready, true, "network is ready when DNS resolves");
});

test("checkNetworkReady retries transient DNS failure and succeeds", async () => {
  let attempts = 0;
  const mockDns = async (host) => {
    attempts++;
    if (attempts < 3) {
      throw new Error("ENOTFOUND temporary");
    }
    return { address: "1.2.3.4", family: 4 };
  };

  const ready = await checkNetworkReady({
    timeoutMs: 2000,
    intervalMs: 50,
    dnsLookupFn: mockDns,
  });
  assert.equal(ready, true, "succeeded after transient retries");
  assert.ok(attempts >= 3, "retried at least 3 times");
});

test("checkNetworkReady returns false after timeout on persistent DNS failure", async () => {
  const mockDns = async (host) => {
    throw new Error("ENETUNREACH");
  };

  const ready = await checkNetworkReady({
    timeoutMs: 150,
    intervalMs: 40,
    dnsLookupFn: mockDns,
  });
  assert.equal(ready, false, "returns false when network never becomes available");
});
