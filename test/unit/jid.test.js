"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  toJid,
  toContactJid,
  isValidNumber,
  isContactJid,
  isGroupJid,
  shortJid,
} = require("../../src/ipc/jid");

test("toContactJid normalizes international numbers", () => {
  assert.equal(toContactJid("+15551234567"), "15551234567@c.us");
  assert.equal(toContactJid("15551234567"), "15551234567@c.us");
  assert.equal(toContactJid(" 1 555 123 4567 "), "15551234567@c.us");
});

test("toContactJid preserves an already-formatted contact jid", () => {
  assert.equal(toJid("15551234567@c.us"), "15551234567@c.us");
});

test("toJid preserves group jid", () => {
  assert.equal(toJid("1234567890@g.us"), "1234567890@g.us");
});

test("toContactJid rejects invalid numbers with a helpful message", () => {
  assert.throws(() => toContactJid("abc"), /Invalid WhatsApp number/);
  assert.throws(() => toContactJid("123"), /Invalid WhatsApp number/);
});

test("isValidNumber matches 7-15 digit non-zero-leading numbers", () => {
  assert.equal(isValidNumber("15551234567"), true);
  assert.equal(isValidNumber("1234567"), true);
  assert.equal(isValidNumber("123456"), false);
  assert.equal(isValidNumber("015551234567"), false);
});

test("isContactJid and isGroupJid discriminate suffixes", () => {
  assert.equal(isContactJid("15551234567@c.us"), true);
  assert.equal(isContactJid("15551234567@g.us"), false);
  assert.equal(isGroupJid("12025-g173@g.us"), true);
  assert.equal(isGroupJid("15551234567@c.us"), false);
});

test("shortJid strips the domain suffix", () => {
  assert.equal(shortJid("15551234567@c.us"), "15551234567");
  assert.equal(shortJid("12025-g173@g.us"), "12025-g173");
});