"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { parseArgs } = require("../../src/cli/args");

test("parses login without arguments", () => {
  const r = parseArgs(["login"]);
  assert.equal(r.command, "login");
  assert.deepEqual(r.positional, []);
});

test("parses send with number and message body", () => {
  const r = parseArgs(["send", "+15551234567", "hello", "there"]);
  assert.equal(r.command, "send");
  assert.deepEqual(r.positional, ["+15551234567", "hello", "there"]);
});

test("parses --flag value and --flag=value forms", () => {
  const r1 = parseArgs(["chats", "--limit", "5"]);
  assert.equal(r1.flags.limit, "5");
  const r2 = parseArgs(["history", "15551234567@c.us", "--limit=10"]);
  assert.equal(r2.flags.limit, "10");
});

test("treats unknown leading token as usage error context", () => {
  const r = parseArgs(["pizza"]);
  assert.equal(r.command, null);
  assert.deepEqual(r.positional, ["pizza"]);
});

test("courses the short dash flags", () => {
  const r = parseArgs(["send", "-g", "123@c.us", "hi"]);
  assert.equal(r.flags.g, "123@c.us");
});