"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  searchWhatsApp,
  parseDateToTimestamp,
  getZonedParts,
  zonedDateToTimestamp,
  TIMEZONE,
  calculateRelevance,
  deduplicateResults,
  SCORE_WEIGHTS,
} = require("../../src/search");
const { DaemonServer } = require("../../src/daemon/server");
const { WhatsAppMcpClient } = require("../../src/mcp/client");
const { registerTools } = require("../../src/mcp/tools");
const { ROUTES } = require("../../src/ipc/protocol");

// Mock reference Date: Saturday 2026-10-31 12:00:00 UTC = 17:00:00 PKT (Asia/Karachi)
const REF_NOW = new Date("2026-10-31T12:00:00.000Z");

// -------------------------------------------------------------
// 1. Natural-Language Date Parsing & Timezone (Asia/Karachi)
// -------------------------------------------------------------
test("Asia/Karachi timezone verification & zoned conversions", () => {
  assert.equal(TIMEZONE, "Asia/Karachi");

  const parts = getZonedParts(REF_NOW);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 10);
  assert.equal(parts.day, 31);
  assert.equal(parts.weekday, "saturday");
  assert.equal(parts.hour, 17); // 12:00 UTC + 5 = 17:00 PKT

  // zonedDateToTimestamp converts local PKT to UTC timestamp
  const tsStart = zonedDateToTimestamp(2026, 10, 31, 0, 0, 0);
  const tsEnd = zonedDateToTimestamp(2026, 10, 31, 23, 59, 59);
  assert.equal(tsEnd - tsStart, 86399);
});

test("Date parser handles 'today' and 'yesterday' in Asia/Karachi", () => {
  const tsTodayStart = parseDateToTimestamp("today", { endOfDay: false, now: REF_NOW });
  const tsTodayEnd = parseDateToTimestamp("today", { endOfDay: true, now: REF_NOW });
  assert.equal(tsTodayEnd - tsTodayStart, 86399);

  const tsYesterdayStart = parseDateToTimestamp("yesterday", { endOfDay: false, now: REF_NOW });
  const tsYesterdayEnd = parseDateToTimestamp("yesterday", { endOfDay: true, now: REF_NOW });
  assert.equal(tsYesterdayEnd - tsYesterdayStart, 86399);
  assert.equal(tsTodayStart - tsYesterdayStart, 86400);
});

test("Date parser handles '<N> days ago'", () => {
  const ts3DaysAgo = parseDateToTimestamp("3 days ago", { now: REF_NOW });
  const ts1DayAgo = parseDateToTimestamp("1 day ago", { now: REF_NOW });
  const tsToday = parseDateToTimestamp("today", { now: REF_NOW });

  assert.equal(tsToday - ts1DayAgo, 86400);
  assert.equal(tsToday - ts3DaysAgo, 3 * 86400);
});

test("Date parser handles 'last <weekday>' accurately", () => {
  // REF_NOW is Saturday.
  // "last Tuesday" -> 4 days back (Saturday -> Friday -> Thursday -> Wednesday -> Tuesday = 4 days)
  const tsLastTuesday = parseDateToTimestamp("last Tuesday", { now: REF_NOW });
  const tsToday = parseDateToTimestamp("today", { now: REF_NOW });
  assert.equal(tsToday - tsLastTuesday, 4 * 86400);

  // "last Saturday" on Saturday -> refers to exactly 7 days ago
  const tsLastSaturday = parseDateToTimestamp("last Saturday", { now: REF_NOW });
  assert.equal(tsToday - tsLastSaturday, 7 * 86400);
});

test("Date parser handles ISO dates and ranges ('date1..date2' and 'date1 to date2')", () => {
  const tsYmd = parseDateToTimestamp("2026-10-15", { now: REF_NOW });
  assert.ok(tsYmd > 0);

  const range1 = parseDateToTimestamp("2026-10-01..2026-10-10", { now: REF_NOW });
  assert.ok(range1.since && range1.until);
  assert.ok(range1.until > range1.since);

  const range2 = parseDateToTimestamp("yesterday to today", { now: REF_NOW });
  assert.ok(range2.since && range2.until);
  assert.ok(range2.until > range2.since);
});

test("Date parser strictly rejects invalid date formats with descriptive error", () => {
  assert.throws(() => {
    parseDateToTimestamp("next month", { now: REF_NOW });
  }, /Invalid date specification/);

  assert.throws(() => {
    parseDateToTimestamp("invalid-garbage", { now: REF_NOW });
  }, /Invalid date specification/);

  assert.throws(() => {
    parseDateToTimestamp("last Funday", { now: REF_NOW });
  }, /Unknown day of the week/);

  assert.throws(() => {
    parseDateToTimestamp("2026-99-99", { now: REF_NOW });
  }, /Invalid calendar date/);
});

// -------------------------------------------------------------
// 2. Deterministic Relevance Scoring & Deduplication
// -------------------------------------------------------------
test("Relevance scoring hierarchy: exact sender > exact filename > exact content", () => {
  const nowSec = Math.floor(REF_NOW.getTime() / 1000);

  const senderMatch = calculateRelevance({
    senderName: "Alice Smith",
    content: "Different body text",
    timestamp: nowSec,
  }, "Alice Smith", nowSec);

  const filenameMatch = calculateRelevance({
    filename: "invoice.pdf",
    content: "Different body text",
    timestamp: nowSec,
  }, "invoice.pdf", nowSec);

  const contentMatch = calculateRelevance({
    content: "Meeting notes regarding project roadmap",
    timestamp: nowSec,
  }, "Meeting notes regarding project roadmap", nowSec);

  assert.ok(senderMatch.relevanceScore > filenameMatch.relevanceScore);
  assert.ok(filenameMatch.relevanceScore > contentMatch.relevanceScore);
  assert.ok(senderMatch.matchedFields.includes("sender"));
  assert.ok(filenameMatch.matchedFields.includes("filename"));
  assert.ok(contentMatch.matchedFields.includes("content"));
});

test("Relevance scoring handles whole-word, partial, and recency boosts", () => {
  const nowSec = Math.floor(REF_NOW.getTime() / 1000);

  // Exact word vs partial substring
  const wholeWord = calculateRelevance({
    content: "Please check the report today",
    timestamp: nowSec,
  }, "report", nowSec);

  const partialWord = calculateRelevance({
    content: "Please check thereporting today",
    timestamp: nowSec,
  }, "report", nowSec);

  assert.ok(wholeWord.relevanceScore > partialWord.relevanceScore);

  // Recency boost
  const recentItem = calculateRelevance({
    content: "Project budget discussion",
    timestamp: nowSec - 3600, // 1 hr ago
  }, "budget", nowSec);

  const oldItem = calculateRelevance({
    content: "Project budget discussion",
    timestamp: nowSec - 30 * 86400, // 30 days ago
  }, "budget", nowSec);

  assert.equal(recentItem.relevanceScore - oldItem.relevanceScore, SCORE_WEIGHTS.RECENCY_TODAY);
});

test("Deduplicate results by composite key preserving highest score and merging match fields", () => {
  const items = [
    {
      resultType: "message",
      id: "msg_123",
      relevanceScore: 40,
      matchedFields: ["content"],
    },
    {
      resultType: "message",
      id: "msg_123",
      relevanceScore: 90,
      matchedFields: ["sender"],
    },
    {
      resultType: "media",
      id: "msg_456",
      relevanceScore: 50,
      matchedFields: ["filename"],
    },
  ];

  const deduped = deduplicateResults(items);
  assert.equal(deduped.length, 2);

  const msg123 = deduped.find((x) => x.id === "msg_123");
  assert.equal(msg123.relevanceScore, 90);
  assert.ok(msg123.matchedFields.includes("sender"));
  assert.ok(msg123.matchedFields.includes("content"));
});

// -------------------------------------------------------------
// 3. Multi-Scope Unified Search Engine & Dedicated Filter Tests
// -------------------------------------------------------------
function createSearchFixtures(refDate = REF_NOW) {
  const nowSec = Math.floor(refDate.getTime() / 1000);
  return {
    now: refDate,
    mediaIndex: {
      med_img: {
        filename: "sunset_beach.jpg",
        caption: "Vacation sunset photo",
        chatId: "923119876543@c.us",
        sender: "923119876543@c.us",
        timestamp: nowSec - 3600, // 1 hour ago (today)
        mimetype: "image/jpeg",
        size: 2048,
      },
      med_doc: {
        filename: "Quarterly_Financial_Report.pdf",
        caption: "Q3 Finance audit summary",
        chatId: "923001234567@c.us",
        sender: "923001234567@c.us",
        timestamp: nowSec - 86400, // yesterday
        mimetype: "application/pdf",
        size: 1024,
      },
      med_vid: {
        filename: "demo_walkthrough.mp4",
        caption: "Product walkthrough video",
        chatId: "923001234567@c.us",
        sender: "923001234567@c.us",
        timestamp: nowSec - 2 * 86400, // 2 days ago
        mimetype: "video/mp4",
        size: 51200,
      },
      med_aud: {
        filename: "voice_note.ogg",
        caption: "Meeting audio recording",
        chatId: "923119876543@c.us",
        sender: "923119876543@c.us",
        timestamp: nowSec - 5 * 86400, // 5 days ago
        mimetype: "audio/ogg",
        size: 512,
      },
    },
    contacts: [
      { id: "923001234567@c.us", name: "Alice CFO", number: "923001234567" },
      { id: "923119876543@c.us", name: "Bob Engineer", number: "923119876543" },
      { id: "923330001122@c.us", name: "Charlie Designer", number: "923330001122" },
    ],
    chats: [
      { id: "923001234567@c.us", name: "Alice CFO", timestamp: nowSec - 1800, isGroup: false },
      { id: "120363045678@g.us", name: "Finance Committee", timestamp: nowSec - 3600, isGroup: true },
      { id: "923119876543@c.us", name: "Bob Engineer", timestamp: nowSec - 7200, isGroup: false },
    ],
    messages: [
      {
        id: "msg_fin_1",
        chatId: "120363045678@g.us",
        from: "923001234567@c.us",
        senderName: "Alice CFO",
        body: "Here is the final Finance report for review",
        timestamp: nowSec - 1800, // today
        type: "chat",
      },
      {
        id: "msg_tech_1",
        chatId: "923119876543@c.us",
        from: "923119876543@c.us",
        senderName: "Bob Engineer",
        body: "The deployment to production succeeded",
        timestamp: nowSec - 86400, // yesterday
        type: "chat",
      },
      {
        id: "msg_vid_1",
        chatId: "923001234567@c.us",
        from: "923001234567@c.us",
        senderName: "Alice CFO",
        body: "Review this clip",
        filename: "clip.mp4",
        timestamp: nowSec - 3 * 86400, // 3 days ago
        type: "video",
        mimetype: "video/mp4",
      },
      {
        id: "msg_aud_1",
        chatId: "923119876543@c.us",
        from: "923119876543@c.us",
        senderName: "Bob Engineer",
        body: "Voice memo",
        timestamp: nowSec - 6 * 86400, // 6 days ago
        type: "audio",
        mimetype: "audio/ogg",
      },
    ],
  };
}

test("Unified search: scope messages filters strictly to messages", async () => {
  const fixtures = createSearchFixtures();
  const res = await searchWhatsApp({ scope: "messages" }, fixtures);
  assert.equal(res.ok, true);
  assert.ok(res.results.length > 0);
  for (const item of res.results) {
    assert.equal(item.resultType, "message");
  }
});

test("Unified search: scope media filters strictly to incoming/downloaded media", async () => {
  const fixtures = createSearchFixtures();
  const res = await searchWhatsApp({ scope: "media" }, fixtures);
  assert.equal(res.ok, true);
  assert.ok(res.results.length > 0);
  for (const item of res.results) {
    assert.equal(item.resultType, "media");
    assert.ok(item.filename);
  }
  const filenames = res.results.map((r) => r.filename);
  assert.ok(filenames.includes("sunset_beach.jpg"));
  assert.ok(filenames.includes("Quarterly_Financial_Report.pdf"));
});

test("Unified search: scope contacts filters strictly to address book contacts", async () => {
  const fixtures = createSearchFixtures();
  const res = await searchWhatsApp({ scope: "contacts" }, fixtures);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 3);
  for (const item of res.results) {
    assert.equal(item.resultType, "contact");
  }
  const names = res.results.map((r) => r.senderName);
  assert.ok(names.includes("Alice CFO"));
  assert.ok(names.includes("Bob Engineer"));
  assert.ok(names.includes("Charlie Designer"));
});

test("Unified search: scope chats filters strictly to conversation threads", async () => {
  const fixtures = createSearchFixtures();
  const res = await searchWhatsApp({ scope: "chats" }, fixtures);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 3);
  for (const item of res.results) {
    assert.equal(item.resultType, "chat");
  }
  const chatNames = res.results.map((r) => r.chatName);
  assert.ok(chatNames.includes("Finance Committee"));
});

test("Unified search: scope all aggregates across messages, media, contacts, and chats", async () => {
  const fixtures = createSearchFixtures();
  const res = await searchWhatsApp({ scope: "all", query: "Finance" }, fixtures);
  assert.equal(res.ok, true);
  assert.ok(res.results.length >= 3);
  const types = new Set(res.results.map((r) => r.resultType));
  assert.ok(types.has("media"), "Should include media matching Finance");
  assert.ok(types.has("chat"), "Should include chat matching Finance");
  assert.ok(types.has("message"), "Should include message matching Finance");
});

test("Unified search: sender filtering by contact name, numeric phone number, and JID", async () => {
  const fixtures = createSearchFixtures();

  // 1. By display name substring
  const byName = await searchWhatsApp({ sender: "Alice" }, fixtures);
  assert.equal(byName.ok, true);
  assert.ok(byName.results.length > 0);
  for (const r of byName.results) {
    const matched =
      (r.senderName && r.senderName.toLowerCase().includes("alice")) ||
      (r.chatName && r.chatName.toLowerCase().includes("alice")) ||
      (r.senderId && r.senderId.includes("923001234567"));
    assert.ok(matched, `Expected Alice in sender/chat for item ${r.id}`);
  }

  // 2. By numeric phone digits
  const byDigits = await searchWhatsApp({ sender: "923119876543" }, fixtures);
  assert.equal(byDigits.ok, true);
  assert.ok(byDigits.results.length > 0);
  for (const r of byDigits.results) {
    const isBob =
      (r.senderId && r.senderId.includes("923119876543")) ||
      (r.senderName && r.senderName.includes("Bob")) ||
      (r.chatId && r.chatId.includes("923119876543")) ||
      (r.chatName && r.chatName.includes("Bob"));
    assert.ok(isBob, `Expected Bob for item ${r.id}`);
  }

  // 3. By exact JID
  const byJid = await searchWhatsApp({ sender: "923001234567@c.us" }, fixtures);
  assert.equal(byJid.ok, true);
  assert.ok(byJid.results.length > 0);

  // 4. Non-matching sender returns empty results safely
  const byNonexistent = await searchWhatsApp({ sender: "NonexistentPerson999" }, fixtures);
  assert.equal(byNonexistent.ok, true);
  assert.equal(byNonexistent.count, 0);
  assert.equal(byNonexistent.results.length, 0);
});

test("Unified search: offset pagination and limit boundary clamping", async () => {
  const fixtures = createSearchFixtures();

  // Page 1: limit 2, offset 0
  const page1 = await searchWhatsApp({ limit: 2, offset: 0 }, fixtures);
  assert.equal(page1.ok, true);
  assert.equal(page1.limit, 2);
  assert.equal(page1.offset, 0);
  assert.equal(page1.results.length, 2);

  // Page 2: limit 2, offset 2
  const page2 = await searchWhatsApp({ limit: 2, offset: 2 }, fixtures);
  assert.equal(page2.ok, true);
  assert.equal(page2.limit, 2);
  assert.equal(page2.offset, 2);
  assert.equal(page2.results.length, 2);

  // Ensure no overlap between page 1 and page 2
  const idsPage1 = page1.results.map((r) => `${r.resultType}:${r.id}`);
  const idsPage2 = page2.results.map((r) => `${r.resultType}:${r.id}`);
  for (const id of idsPage2) {
    assert.ok(!idsPage1.includes(id), `Page 2 item ${id} should not appear on page 1`);
  }

  // Large offset past total results returns empty array safely
  const pastEnd = await searchWhatsApp({ limit: 10, offset: 100 }, fixtures);
  assert.equal(pastEnd.ok, true);
  assert.equal(pastEnd.count, 0);
  assert.equal(pastEnd.results.length, 0);

  // Negative offset clamped to 0
  const negOffset = await searchWhatsApp({ limit: 2, offset: -5 }, fixtures);
  assert.equal(negOffset.offset, 0);
  assert.equal(negOffset.results.length, 2);

  // Excessive limit clamped to max 100
  const hugeLimit = await searchWhatsApp({ limit: 500 }, fixtures);
  assert.equal(hugeLimit.limit, 100);

  // Malformed non-numeric limit safely defaults to 20
  const badLimit = await searchWhatsApp({ limit: "invalid_num" }, fixtures);
  assert.equal(badLimit.limit, 20);
});

test("Unified search: until date filter and explicit date range boundaries", async () => {
  const fixtures = createSearchFixtures();

  // Filter until yesterday: excludes items timestamped today
  const untilYesterday = await searchWhatsApp({ until: "yesterday" }, fixtures);
  assert.equal(untilYesterday.ok, true);
  const untilYesterdayIds = untilYesterday.results.map((r) => r.id);
  // med_img (1 hr ago) and msg_fin_1 (1800s ago) are from today; they must be excluded
  assert.ok(!untilYesterdayIds.includes("med_img"));
  assert.ok(!untilYesterdayIds.includes("msg_fin_1"));
  // med_doc (yesterday) and med_vid (2 days ago) must be included
  assert.ok(untilYesterdayIds.includes("med_doc"));

  // Combined since + until range: past 4 days until yesterday
  const rangeSearch = await searchWhatsApp({ since: "4 days ago", until: "yesterday" }, fixtures);
  assert.equal(rangeSearch.ok, true);
  const rangeIds = rangeSearch.results.map((r) => r.id);
  // med_img (today) excluded
  assert.ok(!rangeIds.includes("med_img"));
  // med_aud (5 days ago) excluded
  assert.ok(!rangeIds.includes("med_aud"));
  // med_doc (yesterday) included
  assert.ok(rangeIds.includes("med_doc"));
  // med_vid (2 days ago) included
  assert.ok(rangeIds.includes("med_vid"));
});

test("Unified search: supported media type filters (image, doc/document, video, audio, chat/text)", async () => {
  const fixtures = createSearchFixtures();

  // 1. Image filter
  const imgRes = await searchWhatsApp({ type: "image" }, fixtures);
  assert.equal(imgRes.ok, true);
  assert.ok(imgRes.results.length > 0);
  for (const r of imgRes.results) {
    const isImg =
      (r.metadata && r.metadata.mimetype && r.metadata.mimetype.startsWith("image/")) ||
      (r.filename && /\.(jpg|jpeg|png|webp|gif)$/i.test(r.filename));
    assert.ok(isImg, `Expected image item for ${r.id}`);
  }

  // 2. Document filter (both 'document' and 'doc')
  const docRes1 = await searchWhatsApp({ type: "document" }, fixtures);
  const docRes2 = await searchWhatsApp({ type: "doc" }, fixtures);
  assert.equal(docRes1.ok, true);
  assert.equal(docRes2.ok, true);
  assert.equal(docRes1.results.length, docRes2.results.length);
  for (const r of docRes1.results) {
    const isDoc = r.metadata && r.metadata.mimetype && r.metadata.mimetype.includes("pdf");
    assert.ok(isDoc, `Expected document item for ${r.id}`);
  }

  // 3. Video filter
  const vidRes = await searchWhatsApp({ type: "video" }, fixtures);
  assert.equal(vidRes.ok, true);
  assert.ok(vidRes.results.length > 0);
  for (const r of vidRes.results) {
    const isVid =
      (r.metadata && r.metadata.mimetype && r.metadata.mimetype.startsWith("video/")) ||
      (r.filename && /\.mp4$/i.test(r.filename));
    assert.ok(isVid, `Expected video item for ${r.id}`);
  }

  // 4. Audio filter
  const audRes = await searchWhatsApp({ type: "audio" }, fixtures);
  assert.equal(audRes.ok, true);
  assert.ok(audRes.results.length > 0);
  for (const r of audRes.results) {
    const isAud =
      (r.metadata && r.metadata.mimetype && r.metadata.mimetype.startsWith("audio/")) ||
      (r.filename && /\.ogg$/i.test(r.filename));
    assert.ok(isAud, `Expected audio item for ${r.id}`);
  }

  // 5. Chat / text filter
  const textRes = await searchWhatsApp({ type: "chat" }, fixtures);
  assert.equal(textRes.ok, true);
  for (const r of textRes.results) {
    assert.equal(r.resultType, "message");
    assert.ok(!r.metadata || !r.metadata.hasMedia);
  }
});

test("Unified search: invalid filters and malformed parameters fail safely", async () => {
  const fixtures = createSearchFixtures();

  // Invalid since date throws descriptive Error
  await assert.rejects(
    async () => searchWhatsApp({ since: "not-a-valid-date-spec" }, fixtures),
    /Invalid date specification/
  );

  // Invalid until date throws descriptive Error
  await assert.rejects(
    async () => searchWhatsApp({ until: "gibberish_date" }, fixtures),
    /Invalid date specification/
  );

  // Unknown scope returns empty array safely without throwing
  const unknownScope = await searchWhatsApp({ scope: "unsupported_scope_xyz" }, fixtures);
  assert.equal(unknownScope.ok, true);
  assert.equal(unknownScope.count, 0);
  assert.equal(unknownScope.results.length, 0);

  // Unknown type filter returns empty array safely without throwing
  const unknownType = await searchWhatsApp({ type: "unsupported_type_xyz" }, fixtures);
  assert.equal(unknownType.ok, true);
  assert.equal(unknownType.count, 0);
  assert.equal(unknownType.results.length, 0);

  // Malformed chatId handled safely
  const badChat = await searchWhatsApp({ chatId: "malformed:chat:::id???" }, fixtures);
  assert.equal(badChat.ok, true);

  // Empty query string matches all items based on recency
  const emptyQuery = await searchWhatsApp({ query: "" }, fixtures);
  assert.equal(emptyQuery.ok, true);
  assert.ok(emptyQuery.results.length > 0);
});

// -------------------------------------------------------------
// 4. Daemon HTTP Endpoint /search
// -------------------------------------------------------------
test("Daemon GET /search route handles Bearer token, x-wa-token, and rejects invalid/missing auth", async () => {
  const mockService = {
    state: "ready",
    account: { wid: "15551234567@c.us" },
    search: async (opts) => {
      if (opts.since === "invalid") {
        throw new Error("Invalid date specification");
      }
      return {
        ok: true,
        query: opts.query,
        scope: opts.scope,
        totalMatches: 1,
        count: 1,
        results: [
          {
            resultType: "message",
            id: "msg_test_http",
            content: "Mock HTTP search message",
            relevanceScore: 85,
          },
        ],
      };
    },
  };

  const server = new DaemonServer({ service: mockService, token: "daemon_secret_token_123" });

  const executeRequest = async (headers, url = "/search?query=hello&scope=messages") => {
    let status = null;
    let data = null;
    const req = {
      url,
      method: "GET",
      headers,
    };
    const res = {
      writeHead: (st) => (status = st),
      end: (d) => (data = JSON.parse(d)),
    };
    await server.handle(req, res);
    return { status, data };
  };

  // 1. Missing authentication returns 401
  const unauth = await executeRequest({});
  assert.equal(unauth.status, 401);
  assert.equal(unauth.data.ok, false);
  assert.equal(unauth.data.error.code, "UNAUTHORIZED");

  // 2. Valid Authorization: Bearer <token> returns 200
  const bearerAuth = await executeRequest({ authorization: "Bearer daemon_secret_token_123" });
  assert.equal(bearerAuth.status, 200);
  assert.equal(bearerAuth.data.ok, true);
  assert.equal(bearerAuth.data.query, "hello");
  assert.equal(bearerAuth.data.results[0].id, "msg_test_http");

  // 3. Valid x-wa-token header returns 200
  const headerAuth = await executeRequest({ "x-wa-token": "daemon_secret_token_123" });
  assert.equal(headerAuth.status, 200);
  assert.equal(headerAuth.data.ok, true);
  assert.equal(headerAuth.data.query, "hello");

  // 4. Invalid Authorization: Bearer <token> returns 401
  const badBearer = await executeRequest({ authorization: "Bearer wrong_secret_token" });
  assert.equal(badBearer.status, 401);
  assert.equal(badBearer.data.ok, false);
  assert.equal(badBearer.data.error.code, "UNAUTHORIZED");

  // 5. Invalid x-wa-token header returns 401
  const badHeader = await executeRequest({ "x-wa-token": "wrong_secret_token" });
  assert.equal(badHeader.status, 401);
  assert.equal(badHeader.data.ok, false);
  assert.equal(badHeader.data.error.code, "UNAUTHORIZED");

  // 6. Unsupported Authorization scheme (Basic) returns 401
  const basicAuth = await executeRequest({ authorization: "Basic dXNlcjpwYXNz" });
  assert.equal(basicAuth.status, 401);
  assert.equal(basicAuth.data.ok, false);
  assert.equal(basicAuth.data.error.code, "UNAUTHORIZED");

  // 7. Invalid date parameter returns 400 SEARCH_ERROR
  const errDate = await executeRequest(
    { authorization: "Bearer daemon_secret_token_123" },
    "/search?since=invalid"
  );
  assert.equal(errDate.status, 400);
  assert.equal(errDate.data.ok, false);
  assert.equal(errDate.data.error.code, "SEARCH_ERROR");
});

// -------------------------------------------------------------
// 5. MCP Tool Registration & Execution
// -------------------------------------------------------------
test("MCP server registers whatsapp_search tool (13 total tools) and handles execution", async () => {
  const registeredTools = [];
  const mockServer = {
    tool: (name, description, schema, handler) => {
      registeredTools.push({ name, description, schema, handler });
    },
  };

  const mockClient = {
    getStatus: async () => ({ ok: true }),
    listChats: async () => ({ ok: true }),
    listContacts: async () => ({ ok: true }),
    getChatHistory: async () => ({ ok: true }),
    getLastInteraction: async () => ({ ok: true }),
    sendMessage: async () => ({ ok: true }),
    sendFile: async () => ({ ok: true }),
    markAsRead: async () => ({ ok: true }),
    getRecentMessages: async () => ({ ok: true }),
    getRecentMedia: async () => ({ ok: true }),
    downloadMedia: async () => ({ ok: true }),
    getMediaInfo: async () => ({ ok: true }),
    search: async (opts) => ({
      ok: true,
      query: opts.query,
      results: [{ resultType: "contact", id: "c1", name: "Alice" }],
    }),
  };

  registerTools(mockServer, mockClient);

  // Exactly 13 tools registered
  assert.equal(registeredTools.length, 13);

  // All 12 original tools preserved
  const expectedOriginalTools = [
    "whatsapp_get_status",
    "whatsapp_list_chats",
    "whatsapp_list_contacts",
    "whatsapp_get_chat_history",
    "whatsapp_send_message",
    "whatsapp_mark_seen",
    "whatsapp_get_recent_messages",
    "whatsapp_send_image",
    "whatsapp_send_document",
    "whatsapp_get_recent_media",
    "whatsapp_download_media",
    "whatsapp_get_media_info",
  ];
  for (const toolName of expectedOriginalTools) {
    assert.ok(registeredTools.some((t) => t.name === toolName), `Expected tool ${toolName} to be registered`);
  }

  // 13th tool is whatsapp_search
  const searchTool = registeredTools.find((t) => t.name === "whatsapp_search");
  assert.ok(searchTool, "whatsapp_search tool must be registered");
  assert.ok(searchTool.description.includes("search across"));

  // Execute tool handler successfully
  const toolResult = await searchTool.handler({ query: "Alice", scope: "contacts" });
  assert.equal(toolResult.isError, false);
  const parsedContent = JSON.parse(toolResult.content[0].text);
  assert.equal(parsedContent.ok, true);
  assert.equal(parsedContent.query, "Alice");
});

// -------------------------------------------------------------
// 6. Read-Only Safety Verification
// -------------------------------------------------------------
test("Search engine is strictly read-only and never invokes mutative operations", async () => {
  let mutationsAttempted = 0;

  const strictService = {
    send: () => { mutationsAttempted++; },
    sendMedia: () => { mutationsAttempted++; },
    markSeen: () => { mutationsAttempted++; },
    setArchived: () => { mutationsAttempted++; },
    cleanMedia: () => { mutationsAttempted++; },
    getChats: async () => [],
    getContacts: async () => [],
    getHistory: async () => [],
  };

  await searchWhatsApp({ query: "hello", scope: "all" }, {
    service: strictService,
    mediaIndex: {},
  });

  assert.equal(mutationsAttempted, 0, "No state mutations must be attempted by search");
});
