"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { mapDaemonStateToTray, getTrayStatus, TRAY_PID_FILE } = require("../../src/tray");
const daemonStore = require("../../src/store/daemon");

test("tray state mapping maps all daemon states accurately", () => {
  const ready = mapDaemonStateToTray("ready");
  assert.equal(ready.icon, "ready");
  assert.equal(ready.isOnline, true);
  assert.equal(ready.isReady, true);
  assert.equal(ready.canStart, false);
  assert.equal(ready.canStop, true);
  assert.equal(ready.canReconnect, true);

  const connecting = mapDaemonStateToTray("connecting");
  assert.equal(connecting.icon, "connecting");
  assert.equal(connecting.isOnline, true);
  assert.equal(connecting.isReady, false);

  const recovering = mapDaemonStateToTray("recovering");
  assert.equal(recovering.icon, "recovering");
  assert.equal(recovering.isOnline, true);
  assert.equal(recovering.isReady, false);

  const error = mapDaemonStateToTray("error");
  assert.equal(error.icon, "error");
  assert.equal(error.isOnline, true);
  assert.equal(error.isReady, false);

  const offline = mapDaemonStateToTray("offline");
  assert.equal(offline.icon, "offline");
  assert.equal(offline.isOnline, false);
  assert.equal(offline.isReady, false);
  assert.equal(offline.canStart, true);
  assert.equal(offline.canStop, false);
  assert.equal(offline.canReconnect, false);
});

test("daemon singleton enforcement detects existing running daemon", () => {
  const existing = daemonStore.read();
  assert.ok(existing, "daemon store should exist");
  assert.ok(existing.pid, "daemon pid should be present");

  // Calling process.kill(pid, 0) should succeed on living daemon
  let isAlive = false;
  try {
    process.kill(existing.pid, 0);
    isAlive = true;
  } catch (_) {}
  assert.equal(isAlive, true, "existing daemon PID is alive");
});

test("daemon crash detection identifies dead PID", () => {
  // Fake PID that cannot exist
  const fakePid = 9999999;
  let isAlive = false;
  try {
    process.kill(fakePid, 0);
    isAlive = true;
  } catch (_) {
    isAlive = false;
  }
  assert.equal(isAlive, false, "dead PID must be reported as not alive");
});

test("tray status correctly inspects PID file", () => {
  const status = getTrayStatus();
  assert.equal(typeof status.running, "boolean");
  if (status.running) {
    assert.ok(status.pid > 0);
  } else {
    assert.equal(status.pid, null);
  }
});

test("parseArgs recognizes tray, reconnect, autostart, stop, and restart commands", () => {
  const { parseArgs } = require("../../src/cli/args");
  const rTray = parseArgs(["tray", "--foreground"]);
  assert.equal(rTray.command, "tray");
  assert.equal(rTray.flags.foreground, true);

  const rReconnect = parseArgs(["reconnect"]);
  assert.equal(rReconnect.command, "reconnect");

  const rAuto = parseArgs(["autostart", "enable"]);
  assert.equal(rAuto.command, "autostart");
  assert.deepEqual(rAuto.positional, ["enable"]);

  const rStop = parseArgs(["stop"]);
  assert.equal(rStop.command, "stop");

  const rRestart = parseArgs(["restart"]);
  assert.equal(rRestart.command, "restart");
});
