"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  groupChats,
  inboxRows,
  relativeTime,
  ackInfo,
  mediaLabel,
  chatPreview,
  messageStats,
  dayLabel,
} = require("../../src/tui/model");

const NOW = 1_700_000_000;
const HOUR = 3600;

test("groupChats buckets unread into ACTION REQUIRED first", () => {
  const chats = [
    { id: "a@c.us", timestamp: NOW - 120, unreadCount: 2 },
    { id: "b@c.us", timestamp: NOW - 720, unreadCount: 0 },
    { id: "c@g.us", timestamp: NOW - 90000, unreadCount: 0 },
    { id: "d@c.us", timestamp: NOW - 100, unreadCount: 1 },
  ];
  const g = groupChats(chats, NOW);
  assert.deepStrictEqual(g.action.map((c) => c.id), ["d@c.us", "a@c.us"]);
  assert.deepStrictEqual(g.active.map((c) => c.id), ["b@c.us"]);
  assert.deepStrictEqual(g.recent.map((c) => c.id), ["c@g.us"]);
});

test("groupChats treats pinned chats as active regardless of age", () => {
  const chats = [{ id: "p@c.us", timestamp: NOW - 90000, unreadCount: 0, pinned: true }];
  const g = groupChats(chats, NOW);
  assert.deepStrictEqual(g.active.map((c) => c.id), ["p@c.us"]);
});

test("groupChats sorts newest first within each bucket", () => {
  const chats = [
    { id: "old@c.us", timestamp: NOW - 600, unreadCount: 1 },
    { id: "new@c.us", timestamp: NOW - 60, unreadCount: 1 },
  ];
  const g = groupChats(chats, NOW);
  assert.deepStrictEqual(g.action.map((c) => c.id), ["new@c.us", "old@c.us"]);
});

test("inboxRows emits headers before each non-empty bucket", () => {
  const chats = [
    { id: "a@c.us", timestamp: NOW - 60, unreadCount: 1 },
    { id: "b@c.us", timestamp: NOW - 720, unreadCount: 0 },
  ];
  const rows = inboxRows(chats, NOW);
  const types = rows.map((r) => r.type);
  const labels = rows.filter((r) => r.type === "header").map((r) => r.label);
  assert.deepStrictEqual(labels, ["ACTION REQUIRED", "ACTIVE"]);
  assert.ok(types.filter((t) => t === "header").length === 2);
  assert.ok(types.filter((t) => t === "chat").length === 2);
});

test("relativeTime renders compact human units", () => {
  assert.strictEqual(relativeTime(NOW, NOW), "now");
  assert.strictEqual(relativeTime(NOW - 30, NOW), "now");
  assert.strictEqual(relativeTime(NOW - 5 * 60, NOW), "5m");
  assert.strictEqual(relativeTime(NOW - 3 * HOUR, NOW), "3h");
  assert.strictEqual(relativeTime(NOW - 2 * 24 * HOUR, NOW), "2d");
});

test("ackInfo maps delivery states to glyphs", () => {
  assert.strictEqual(ackInfo(1).glyph, "✓");
  assert.strictEqual(ackInfo(2).glyph, "✓✓");
  assert.strictEqual(ackInfo(3).glyph, "✓✓");
  assert.strictEqual(ackInfo(3).style, "ackRead");
  assert.strictEqual(ackInfo(0).glyph, "◌");
  assert.strictEqual(ackInfo(-1).glyph, "✗");
  assert.strictEqual(ackInfo(undefined).glyph, "◌");
});

test("mediaLabel maps message types to compact blocks", () => {
  assert.strictEqual(mediaLabel("image"), "[IMG]");
  assert.strictEqual(mediaLabel("document"), "[DOC]");
  assert.strictEqual(mediaLabel("ptt"), "[VOICE]");
  assert.strictEqual(mediaLabel("sticker"), "[STICKER]");
  assert.strictEqual(mediaLabel("mystery"), "[ATTACH]");
});

test("chatPreview prefers media labels when a message has media", () => {
  const withMedia = {
    lastMessage: { hasMedia: true, type: "image", body: "the receipt" },
  };
  assert.strictEqual(chatPreview(withMedia), "[IMG] the receipt");
  const text = { lastMessage: { hasMedia: false, body: "call me" } };
  assert.strictEqual(chatPreview(text), "call me");
  assert.strictEqual(chatPreview({}), "no messages");
});

test("messageStats counts today and media by type", () => {
  const messages = [
    { timestamp: NOW - 30, hasMedia: true, type: "image" },
    { timestamp: NOW - 40, hasMedia: true, type: "document" },
    { timestamp: NOW - 10, hasMedia: false },
    { timestamp: NOW - 2 * 24 * HOUR, hasMedia: true, type: "image" },
  ];
  const s = messageStats(messages, NOW);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.today, 3);
  assert.strictEqual(s.media.images, 2);
  assert.strictEqual(s.media.documents, 1);
});

test("dayLabel distinguishes today, yesterday, and older dates", () => {
  const today = NOW;
  const yesterday = NOW - 24 * HOUR;
  const older = NOW - 5 * 24 * HOUR;
  assert.strictEqual(dayLabel(today, NOW * 1000), "TODAY");
  assert.strictEqual(dayLabel(yesterday, NOW * 1000), "YESTERDAY");
  assert.ok(dayLabel(older, NOW * 1000).length > 0);
  assert.notStrictEqual(dayLabel(older, NOW * 1000), "TODAY");
});
