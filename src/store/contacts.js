"use strict";

const { paths } = require("../config/paths");
const { readJson, writeJson } = require("./json");

function read() {
  return readJson(paths.contactsFile, { contacts: {} });
}

function write(contacts) {
  writeJson(paths.contactsFile, { contacts });
}

function set(id, contact) {
  const current = read();
  current.contacts[id] = contact;
  write(current.contacts);
  return current.contacts;
}

function get(id) {
  return read().contacts[id] || null;
}

function list() {
  return Object.values(read().contacts);
}

module.exports = { read, write, set, get, list };