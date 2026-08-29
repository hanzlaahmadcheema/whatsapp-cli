"use strict";

const { paths } = require("../config/paths");
const { readJson, writeJson, removeFile } = require("./json");

function read() {
  return readJson(paths.daemonFile, null);
}

function write(daemonState) {
  writeJson(paths.daemonFile, daemonState);
}

function remove() {
  removeFile(paths.daemonFile);
}

function update(patch) {
  const current = read() || {};
  write({ ...current, ...patch });
  return read();
}

function isRunning() {
  const d = read();
  if (!d || !d.pid) return false;
  try {
    process.kill(d.pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

module.exports = { read, write, remove, update, isRunning };