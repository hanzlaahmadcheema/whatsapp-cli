"use strict";

const crypto = require("crypto");
const { readJson, writeJson } = require("../store/json");
const { paths } = require("../config/paths");

const TOKEN_HEADER = "x-wa-token";

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getOrCreateToken() {
  const d = readJson(paths.daemonFile, null);
  if (d && d.token) return d.token;
  const token = generateToken();
  const current = d || {};
  writeJson(paths.daemonFile, { ...current, token });
  return token;
}

module.exports = { TOKEN_HEADER, generateToken, getOrCreateToken };