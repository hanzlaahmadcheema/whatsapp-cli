"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const USER_CONFIG_DIR = path.join(os.homedir(), ".config", "whatsapp-cli");
const USER_SETTINGS_FILE = path.join(USER_CONFIG_DIR, "settings.json");
const USER_STATE_DIR = path.join(os.homedir(), ".local", "state", "whatsapp-cli");
const DEFAULT_LOG_FILE = path.join(USER_STATE_DIR, "daemon.log");

const DEFAULT_SETTINGS = Object.freeze({
  launchTrayOnLogin: false,
  autoStartDaemon: true,
  autoReconnectOnResume: true,
  maxRecoveryAttempts: 3,
  retryBackoffBaseMs: 2000,
  maxBackoffMs: 30000,
  networkTimeoutMs: 30000,
  notifications: {
    enabled: true,
    onConnected: true,
    onDisconnected: true,
    onReconnecting: true,
    onRecoverySuccess: true,
    onRecoveryFailure: true,
    cooldownMs: 10000,
  },
  logFile: DEFAULT_LOG_FILE,
});

function getSettingsPath() {
  return USER_SETTINGS_FILE;
}

function loadSettings() {
  try {
    if (fs.existsSync(USER_SETTINGS_FILE)) {
      const raw = fs.readFileSync(USER_SETTINGS_FILE, "utf8");
      const data = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...data,
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          ...(data.notifications || {}),
        },
      };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(updates = {}) {
  const current = loadSettings();
  const merged = {
    ...current,
    ...updates,
    notifications: {
      ...current.notifications,
      ...(updates.notifications || {}),
    },
  };

  try {
    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(USER_SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
  return merged;
}

module.exports = {
  DEFAULT_SETTINGS,
  USER_CONFIG_DIR,
  USER_SETTINGS_FILE,
  USER_STATE_DIR,
  DEFAULT_LOG_FILE,
  getSettingsPath,
  loadSettings,
  saveSettings,
};
