"use strict";

const { paths } = require("../config/paths");
const { readJson, writeJson } = require("./json");

function read() {
  return readJson(paths.stateFile, {});
}

function write(state) {
  writeJson(paths.stateFile, state);
}

function update(patch) {
  const current = read();
  const next = { ...current, ...patch };
  write(next);
  return next;
}

module.exports = { read, write, update };