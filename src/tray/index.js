"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { paths } = require("../config/paths");

const TRAY_PID_FILE = path.join(paths.dataDir, "tray.pid");
const MANAGER_SCRIPT = path.join(__dirname, "manager.py");

/**
 * Pure mapping function between daemon state and tray presentation.
 * Used by both tray-manager and automated tests.
 */
function mapDaemonStateToTray(state) {
  switch (state) {
    case "ready":
      return {
        icon: "ready",
        label: "Ready",
        isOnline: true,
        isReady: true,
        canStart: false,
        canStop: true,
        canReconnect: true,
      };
    case "connecting":
    case "linking":
    case "syncing":
      return {
        icon: "connecting",
        label: "Connecting…",
        isOnline: true,
        isReady: false,
        canStart: false,
        canStop: true,
        canReconnect: true,
      };
    case "recovering":
      return {
        icon: "recovering",
        label: "Recovering…",
        isOnline: true,
        isReady: false,
        canStart: false,
        canStop: true,
        canReconnect: true,
      };
    case "error":
    case "logged_out":
      return {
        icon: "error",
        label: "Error",
        isOnline: true,
        isReady: false,
        canStart: false,
        canStop: true,
        canReconnect: true,
      };
    case "offline":
    default:
      return {
        icon: "offline",
        label: "Offline",
        isOnline: false,
        isReady: false,
        canStart: true,
        canStop: false,
        canReconnect: false,
      };
  }
}

function getTrayStatus() {
  if (!fs.existsSync(TRAY_PID_FILE)) {
    return { running: false, pid: null };
  }
  try {
    const raw = fs.readFileSync(TRAY_PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!pid) return { running: false, pid: null };
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (_) {
    return { running: false, pid: null };
  }
}

function startTrayManager(opts = {}) {
  const status = getTrayStatus();
  if (status.running) {
    return { running: true, pid: status.pid, alreadyRunning: true };
  }

  const pythonExec = "/usr/bin/python3";
  const foreground = opts.foreground || false;

  if (foreground) {
    const child = spawn(pythonExec, [MANAGER_SCRIPT], {
      stdio: "inherit",
      env: process.env,
    });
    return { running: true, pid: child.pid, child };
  }

  const child = spawn(pythonExec, [MANAGER_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  try {
    if (!fs.existsSync(paths.dataDir)) {
      fs.mkdirSync(paths.dataDir, { recursive: true });
    }
    fs.writeFileSync(TRAY_PID_FILE, String(child.pid), "utf8");
  } catch (_) {}

  return { running: true, pid: child.pid, detached: true };
}

function stopTrayManager() {
  const status = getTrayStatus();
  if (!status.running || !status.pid) {
    if (fs.existsSync(TRAY_PID_FILE)) {
      try {
        fs.unlinkSync(TRAY_PID_FILE);
      } catch (_) {}
    }
    return { stopped: false, notRunning: true };
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch (_) {}

  try {
    if (fs.existsSync(TRAY_PID_FILE)) {
      fs.unlinkSync(TRAY_PID_FILE);
    }
  } catch (_) {}

  return { stopped: true, pid: status.pid };
}

module.exports = {
  mapDaemonStateToTray,
  getTrayStatus,
  startTrayManager,
  stopTrayManager,
  TRAY_PID_FILE,
  MANAGER_SCRIPT,
};
