"use strict";

const fs = require("fs");
const path = require("path");
const { paths } = require("../config/paths");

function ensureDataDir() {
  fs.mkdirSync(paths.dataDir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

module.exports = { readJson, writeJson, removeFile, ensureDataDir, paths };