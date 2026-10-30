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
// 3. Multi-Scope Unified Search Engine
// -------------------------------------------------------------
test("Search across messages, media, contacts, and chats with filters", async () => {
  const mockNow = new Date("2026-10-31T10:00:00Z");
  const nowSec = Math.floor(mockNow.getTime() / 1000);

  const mockContext = {
    now: mockNow,
    mediaIndex: {
      med_1: {
        filename: "Quarterly_Financial_Report.pdf",
        caption: "Q3 audit summary",
        chatId: "923001234567@c.us",
        sender: "923001234567@c.us",
        timestamp: nowSec - 1800,
        mimetype: "application/pdf",
        size: 1024,
      },
      med_2: {
        filename: "sunset_beach.jpg",
        caption: "Vacation photo",
        chatId: "923119876543@c.us",
        sender: "923119876543@c.us",
        timestamp: nowSec - 7200,
        mimetype: "image/jpeg",
        size: 2048,
      },
    },
    contacts: [
      { id: "923001234567@c.us", name: "Alice CFO", number: "923001234567" },
      { id: "923119876543@c.us", name: "Bob Engineer", number: "923119876543" },
    ],
    chats: [
      { id: "923001234567@c.us", name: "Alice CFO", timestamp: nowSec - 1800, isGroup: false },
      { id: "120363045678@g.us", name: "Finance Committee", timestamp: nowSec - 3600, isGroup: true },
    ],
    messages: [
      {
        id: "msg_fin_1",
        chatId: "120363045678@g.us",
        from: "923001234567@c.us",
        senderName: "Alice CFO",
        body: "Here is the final report for review",
        timestamp: nowSec - 1000,
        type: "chat",
      },
      {
        id: "msg_tech_1",
        chatId: "923119876543@c.us",
        from: "923119876543@c.us",
        senderName: "Bob Engineer",
        body: "The deployment to production succeeded",
        timestamp: nowSec - 500,
        type: "chat",
      },
    ],
  };

  // 1. Query matching across multiple scopes: "report"
  const resReport = await searchWhatsApp({ query: "report" }, mockContext);
  assert.equal(resReport.ok, true);
  assert.ok(resReport.totalMatches >= 2);
  const matchedTypes = resReport.results.map((r) => r.resultType);
  assert.ok(matchedTypes.includes("media"));
  assert.ok(matchedTypes.includes("message"));

  // 2. Query scoped to media only
  const resMedia = await searchWhatsApp({ query: "sunset", scope: "media" }, mockContext);
  assert.equal(resMedia.ok, true);
  assert.equal(resMedia.results.length, 1);
  assert.equal(resMedia.results[0].resultType, "media");
  assert.equal(resMedia.results[0].filename, "sunset_beach.jpg");

  // 3. Sender filter
  const resSender = await searchWhatsApp({ sender: "Alice" }, mockContext);
  assert.equal(resSender.ok, true);
  for (const r of resSender.results) {
    const isAlice = (r.senderName && r.senderName.includes("Alice")) || (r.chatName && r.chatName.includes("Alice"));
    assert.ok(isAlice);
  }

  // 4. Type filter: image
  const resImage = await searchWhatsApp({ type: "image" }, mockContext);
  assert.equal(resImage.ok, true);
  assert.equal(resImage.results.length, 1);
  assert.equal(resImage.results[0].filename, "sunset_beach.jpg");

  // 5. Date filter: since yesterday
  const resSince = await searchWhatsApp({ since: "yesterday" }, mockContext);
  assert.equal(resSince.ok, true);
  assert.ok(resSince.results.length > 0);

  // 6. Pagination: limit and offset
  const resPage1 = await searchWhatsApp({ limit: 1, offset: 0 }, mockContext);
  const resPage2 = await searchWhatsApp({ limit: 1, offset: 1 }, mockContext);
  assert.equal(resPage1.results.length, 1);
  assert.equal(resPage2.results.length, 1);
  assert.notEqual(resPage1.results[0].id, resPage2.results[0].id);
});

// -------------------------------------------------------------
// 4. Daemon HTTP Endpoint /search
// -------------------------------------------------------------
test("Daemon GET /search route handles auth, query params, and errors", async () => {
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

  const server = new DaemonServer({ service: mockService, token: "secret_token_123" });

  // 1. Unauthorized request
  const unauthReq = {
    url: "/search?query=hello",
    method: "GET",
    headers: {},
  };
  let unauthStatus = null;
  let unauthData = null;
  const unauthRes = {
    writeHead: (st) => (unauthStatus = st),
    end: (d) => (unauthData = JSON.parse(d)),
  };
  await server.handle(unauthReq, unauthRes);
  assert.equal(unauthStatus, 401);
  assert.equal(unauthData.ok, false);
  assert.equal(unauthData.error.code, "UNAUTHORIZED");

  // 2. Authorized search request
  const authReq = {
    url: "/search?query=hello&scope=messages",
    method: "GET",
    headers: { "x-wa-token": "secret_token_123" },
  };
  let authStatus = null;
  let authData = null;
  const authRes = {
    writeHead: (st) => (authStatus = st),
    end: (d) => (authData = JSON.parse(d)),
  };
  await server.handle(authReq, authRes);
  assert.equal(authStatus, 200);
  assert.equal(authData.ok, true);
  assert.equal(authData.query, "hello");
  assert.equal(authData.results[0].id, "msg_test_http");

  // 3. Invalid date parameter error
  const errReq = {
    url: "/search?since=invalid",
    method: "GET",
    headers: { "x-wa-token": "secret_token_123" },
  };
  let errStatus = null;
  let errData = null;
  const errRes = {
    writeHead: (st) => (errStatus = st),
    end: (d) => (errData = JSON.parse(d)),
  };
  await server.handle(errReq, errRes);
  assert.equal(errStatus, 400);
  assert.equal(errData.ok, false);
  assert.equal(errData.error.code, "SEARCH_ERROR");
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
