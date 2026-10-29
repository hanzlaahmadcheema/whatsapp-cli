"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { MessageRingBuffer } = require("../../src/mcp/ring-buffer");
const { WhatsAppMcpClient } = require("../../src/mcp/client");
const { createMcpServer } = require("../../src/mcp/server");
const { parseArgs } = require("../../src/cli/args");

test("MessageRingBuffer pushes, bounds capacity, and deduplicates", () => {
  const buffer = new MessageRingBuffer(3);

  buffer.push({ id: "msg_1", body: "first", timestamp: 100 });
  buffer.push({ id: "msg_1", body: "first", timestamp: 100 }); // duplicate
  assert.equal(buffer.size, 1);

  buffer.push({ id: "msg_2", body: "second", timestamp: 200 });
  buffer.push({ id: "msg_3", body: "third", timestamp: 300 });
  buffer.push({ id: "msg_4", body: "fourth", timestamp: 400 }); // evicts msg_1

  assert.equal(buffer.size, 3);
  const items = buffer.get();
  assert.equal(items.length, 3);
  assert.equal(items[0].id, "msg_4"); // newest first
  assert.equal(items[2].id, "msg_2");
});

test("MessageRingBuffer filters by chatId and sinceTimestamp", () => {
  const buffer = new MessageRingBuffer(10);
  buffer.push({ id: "1", from: "15551111111@c.us", chatId: "15551111111@c.us", body: "hi", timestamp: 1000 });
  buffer.push({ id: "2", from: "15552222222@c.us", chatId: "15552222222@c.us", body: "hey", timestamp: 2000 });
  buffer.push({ id: "3", from: "15551111111@c.us", chatId: "15551111111@c.us", body: "there", timestamp: 3000 });

  const filteredChat = buffer.get({ chatId: "15551111111" });
  assert.equal(filteredChat.length, 2);
  assert.equal(filteredChat[0].id, "3");
  assert.equal(filteredChat[1].id, "1");

  const filteredTime = buffer.get({ sinceTimestamp: 2000 });
  assert.equal(filteredTime.length, 2);
  assert.equal(filteredTime[0].id, "3");
  assert.equal(filteredTime[1].id, "2");
});

test("createMcpServer registers all 7 tools and handles success and errors", async () => {
  const mockClient = {
    getStatus: async () => ({
      ok: true,
      state: "ready",
      account: { number: "15551234567", pushname: "Tester" },
    }),
    listChats: async (limit) => ({
      ok: true,
      count: 1,
      chats: [{ id: "15551234567@c.us", name: "Alice", unreadCount: 0 }],
    }),
    listContacts: async (name) => ({
      ok: true,
      count: 1,
      contacts: [{ id: "15551234567@c.us", name: "Alice", number: "15551234567" }],
    }),
    getChatHistory: async (target, limit) => ({
      ok: true,
      target,
      count: 1,
      messages: [{ id: "m1", body: "Hello", from: "15551234567@c.us", fromMe: false, timestamp: 123456 }],
    }),
    sendMessage: async (target, message) => {
      if (target === "fail") throw new Error("Delivery failed");
      return { ok: true, messageId: "m_out_1", to: target, timestamp: 123457 };
    },
    markSeen: async (target) => ({ ok: true, chatId: target }),
    getRecentMessages: (opts) => ({
      ok: true,
      count: 1,
      bufferedTotal: 1,
      messages: [{ id: "m_recent", body: "Recent text", timestamp: 123458 }],
    }),
  };

  const { server } = createMcpServer({ client: mockClient });
  const tools = server._registeredTools;

  assert.ok(tools["whatsapp_get_status"]);
  assert.ok(tools["whatsapp_list_chats"]);
  assert.ok(tools["whatsapp_list_contacts"]);
  assert.ok(tools["whatsapp_get_chat_history"]);
  assert.ok(tools["whatsapp_send_message"]);
  assert.ok(tools["whatsapp_mark_seen"]);
  assert.ok(tools["whatsapp_get_recent_messages"]);

  // Test status tool
  const statusRes = await tools["whatsapp_get_status"].handler({});
  assert.equal(statusRes.isError, false);
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.equal(statusData.state, "ready");
  assert.equal(statusData.account.number, "15551234567");

  // Test send message tool (success)
  const sendRes = await tools["whatsapp_send_message"].handler({ target: "15551234567", message: "Hi!" });
  assert.equal(sendRes.isError, false);
  const sendData = JSON.parse(sendRes.content[0].text);
  assert.equal(sendData.messageId, "m_out_1");

  // Test send message tool (error handling)
  const sendFailRes = await tools["whatsapp_send_message"].handler({ target: "fail", message: "Hi!" });
  assert.equal(sendFailRes.isError, true);
  const sendFailData = JSON.parse(sendFailRes.content[0].text);
  assert.equal(sendFailData.ok, false);
  assert.match(sendFailData.error.message, /Delivery failed/);

  // Test recent messages tool
  const recentRes = await tools["whatsapp_get_recent_messages"].handler({});
  assert.equal(recentRes.isError, false);
  const recentData = JSON.parse(recentRes.content[0].text);
  assert.equal(recentData.messages.length, 1);
  assert.equal(recentData.messages[0].id, "m_recent");
});

test("WhatsAppMcpClient validates targets and message bodies", async () => {
  const client = new WhatsAppMcpClient();

  await assert.rejects(
    async () => client.sendMessage("", "test"),
    /Recipient target is required/
  );

  await assert.rejects(
    async () => client.sendMessage("15551234567", "   "),
    /Message text cannot be empty/
  );

  await assert.rejects(
    async () => client.getChatHistory(""),
    /Recipient target is required/
  );

  await assert.rejects(
    async () => client.markSeen(""),
    /Recipient target is required/
  );

  client.destroy();
});

test("WhatsAppMcpClient communicates with mock daemon HTTP server", async (t) => {
  const token = "test-secret-token-1234567890";
  let sseClientRes = null;

  const server = http.createServer((req, res) => {
    if (req.headers["x-wa-token"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { message: "Unauthorized" } }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: "ready" }));
      return;
    }

    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        state: "ready",
        account: { number: "15551234567", pushname: "Daemon Account" },
        nodeVersion: process.version,
        appVersion: "1.0.0",
      }));
      return;
    }

    if (req.url.startsWith("/chats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        chats: [{ id: "15559876543@c.us", name: "Bob", unreadCount: 2 }],
      }));
      return;
    }

    if (req.url.startsWith("/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        messages: [{ id: "msg_h1", body: "History test", timestamp: 1700000000 }],
      }));
      return;
    }

    if (req.url === "/send" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          messageId: "mock_msg_99",
          to: parsed.to,
          timestamp: Date.now(),
        }));
      });
      return;
    }

    if (req.url === "/chat/seen" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, chatId: "15559876543@c.us" }));
      return;
    }

    if (req.url === "/receive") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: connected\ndata: {}\n\n");
      sseClientRes = res;
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => {
    if (sseClientRes) {
      try { sseClientRes.end(); } catch (_) {}
    }
    server.close();
  });

  const client = new WhatsAppMcpClient();
  client.base = `http://127.0.0.1:${port}`;
  client.token = token;
  // Override getConnection to reuse the mock base/token
  client.getConnection = async () => {
    client._ensureSseWatcher();
    return { base: client.base, token: client.token };
  };

  // Test getStatus
  const status = await client.getStatus();
  assert.equal(status.ok, true);
  assert.equal(status.state, "ready");
  assert.equal(status.account.number, "15551234567");

  // Test listChats
  const chats = await client.listChats(10);
  assert.equal(chats.ok, true);
  assert.equal(chats.chats[0].name, "Bob");

  // Test getChatHistory
  const history = await client.getChatHistory("15559876543", 5);
  assert.equal(history.ok, true);
  assert.equal(history.messages[0].id, "msg_h1");

  // Test sendMessage
  const sent = await client.sendMessage("15559876543", "Hello from MCP test");
  assert.equal(sent.ok, true);
  assert.equal(sent.messageId, "mock_msg_99");

  // Test markSeen
  const seen = await client.markSeen("15559876543");
  assert.equal(seen.ok, true);

  // Test SSE message reception in ring buffer
  assert.ok(sseClientRes, "SSE client connected");
  sseClientRes.write(
    `event: message\ndata: ${JSON.stringify({
      event: "message",
      id: "live_msg_1",
      chatId: "15559876543@c.us",
      from: "15559876543@c.us",
      body: "Live message over SSE",
      timestamp: 1700000050,
    })}\n\n`
  );

  // Give brief moment for SSE chunk parse
  await new Promise((r) => setTimeout(r, 100));

  const recent = client.getRecentMessages();
  assert.equal(recent.count, 1);
  assert.equal(recent.messages[0].id, "live_msg_1");
  assert.equal(recent.messages[0].body, "Live message over SSE");

  // Test token sanitization
  const sanitized = client._sanitizeError(new Error(`Failed with ${token} at endpoint`));
  assert.ok(!sanitized.includes(token));
  assert.ok(sanitized.includes("[REDACTED]"));

  client.destroy();
});

test("parseArgs recognizes mcp command", () => {
  const r = parseArgs(["mcp"]);
  assert.equal(r.command, "mcp");
});
