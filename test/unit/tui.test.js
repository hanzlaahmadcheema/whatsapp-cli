"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { parseCommandLine, COMMANDS } = require("../../src/tui/views/command");
const { computeLayout, cycleFocus } = require("../../src/tui/layout");
const { filterPalette } = require("../../src/tui/views/palette");
const { wrapText, layoutMessages, scrollToMessage } = require("../../src/tui/views/conversation");
const { Screen } = require("../../src/tui/screen");

test("parseCommandLine extracts verb and args", () => {
  const p = parseCommandLine("send 923266900001 hello world");
  assert.strictEqual(p.verb, "send");
  assert.deepStrictEqual(p.args, ["923266900001", "hello", "world"]);
  assert.strictEqual(p.argStr, "923266900001 hello world");
  assert.strictEqual(p.known, true);
});

test("parseCommandLine handles aliases", () => {
  assert.strictEqual(parseCommandLine("m 923 1 hi").verb, "send");
  assert.strictEqual(parseCommandLine("q").verb, "quit");
});

test("parseCommandLine treats unknown verbs as unknown but parseable", () => {
  const p = parseCommandLine("frobnicate the widget");
  assert.strictEqual(p.verb, "frobnicate");
  assert.strictEqual(p.known, false);
  assert.deepStrictEqual(p.args, ["the", "widget"]);
});

test("parseCommandLine returns null for empty input", () => {
  assert.strictEqual(parseCommandLine(""), null);
  assert.strictEqual(parseCommandLine("   "), null);
});

test("computeLayout renders three regions on wide terminals", () => {
  const l = computeLayout({ width: 170, height: 40, focus: "inbox", contextOpen: true });
  assert.strictEqual(l.responsive, "wide");
  assert.ok(l.inbox.w > 0);
  assert.ok(l.conversation.w > 0);
  assert.ok(l.context.w > 0);
  assert.strictEqual(l.inbox.x, 0);
  assert.strictEqual(l.conversation.x, l.inbox.w);
  assert.strictEqual(l.context.x, l.conversation.x + l.conversation.w);
});

test("computeLayout omits context on medium unless toggled", () => {
  const closed = computeLayout({ width: 120, height: 40, focus: "inbox", contextOpen: false });
  assert.strictEqual(closed.responsive, "medium");
  assert.strictEqual(closed.context, null);

  const open = computeLayout({ width: 120, height: 40, focus: "inbox", contextOpen: true });
  assert.ok(open.context);
});

test("computeLayout shows a single region on narrow terminals", () => {
  const l = computeLayout({ width: 80, height: 24, focus: "conversation", contextOpen: false });
  assert.strictEqual(l.responsive, "narrow");
  assert.strictEqual(l.conversation.w, 80);
  assert.strictEqual(l.inbox, null);
  assert.strictEqual(l.context, null);
});

test("cycleFocus walks inbox -> conversation -> context -> inbox", () => {
  assert.strictEqual(cycleFocus("inbox"), "conversation");
  assert.strictEqual(cycleFocus("conversation"), "context");
  assert.strictEqual(cycleFocus("context"), "inbox");
  assert.strictEqual(cycleFocus("inbox", -1), "context");
});

test("filterPalette matches on word prefixes, not substrings", () => {
  const ids = (q) => filterPalette(q).map((i) => i.id);
  assert.deepStrictEqual(ids("arch"), ["archive"]);
  assert.deepStrictEqual(ids("archiv"), ["archive"]);
  assert.deepStrictEqual(ids("search"), ["search-chats", "search-contacts"]);
  assert.deepStrictEqual(ids("find"), ["search-chats"]);
  assert.deepStrictEqual(ids(""), filterPalette("").map((i) => i.id));
});

test("filterPalette supports multi-word queries", () => {
  assert.deepStrictEqual(filterPalette("send mes").map((i) => i.id), ["send", "forward"]);
});

test("filterPalette matches key and keyword metadata", () => {
  assert.deepStrictEqual(filterPalette("enter").map((i) => i.id), ["seen"]);
  assert.deepStrictEqual(filterPalette("reload").map((i) => i.id), ["refresh"]);
});

test("scrollToMessage keeps a selected message on screen", () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ id: "m" + i, from: "x@c.us", body: "message number " + i, timestamp: 1000 + i * 60, ack: 2 });
  }
  const items = layoutMessages(messages, 50);
  const rows = 16;

  // scrolling older (up) from the bottom must reveal the older selection
  let scroll = 33;
  for (const id of ["m38", "m35", "m30", "m20", "m10", "m0"]) {
    scroll = scrollToMessage(items, id, scroll, rows);
    assert.ok(scrollToMessageVisible(items, id, scroll, rows), `${id} not visible at scroll ${scroll}`);
  }
});

test("scrollToMessage keeps an already-visible selection stable", () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ id: "m" + i, from: "x@c.us", body: "message number " + i, timestamp: 1000 + i * 60, ack: 2 });
  }
  const items = layoutMessages(messages, 50);
  const rows = 16;
  const scroll = scrollToMessage(items, "m39", 33, rows);
  assert.strictEqual(scrollToMessage(items, "m38", scroll, rows), scroll);
});

test("selected message text keeps its highlight background", () => {
  const s = new Screen();
  s.width = 60;
  s.height = 20;
  s.cells = s.emptyCells();
  const region = { x: 0, y: 0, w: 60, h: 20 };
  const messages = [{ id: "m1", from: "x@c.us", body: "highlight me", timestamp: 1000, ack: 2 }];
  const chat = { id: "x@c.us", name: "X", isGroup: false };
  const { drawConversation } = require("../../src/tui/views/conversation");
  drawConversation(s, region, messages, chat, "m1", 0, true);

  let textCellsWithBg = 0;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const cell = s.cells[y][x];
      if (cell && cell.ch !== " " && cell.st && cell.st.bg === "brightYellow") textCellsWithBg++;
    }
  }
  assert.ok(textCellsWithBg >= "highlight me".length, "selected message text lost its highlight background");
});

function scrollToMessageVisible(items, id, scroll, rows) {
  const idx = items.findIndex((it) => it.type === "msg" && it.m.id === id);
  let top = 0;
  for (let i = 0; i < idx; i++) top += items[i].type === "sep" ? 1 : items[i].h;
  const bot = top + (items[idx].type === "sep" ? 1 : items[idx].h);
  let winTop = 0;
  for (let i = 0; i < scroll; i++) winTop += items[i].type === "sep" ? 1 : items[i].h;
  return top >= winTop && bot <= winTop + rows;
}
