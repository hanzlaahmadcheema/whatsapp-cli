"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const paths = {
  root: ROOT,
  dataDir: path.join(ROOT, ".data"),
  authDir: path.join(ROOT, ".wwebjs_auth"),
  cacheDir: path.join(ROOT, ".wwebjs_cache"),
  daemonFile: path.join(ROOT, ".data", "daemon.json"),
  stateFile: path.join(ROOT, ".data", "state.json"),
  contactsFile: path.join(ROOT, ".data", "contacts.json"),
  configFile: path.join(ROOT, ".data", "config.json"),
};

module.exports = { paths };