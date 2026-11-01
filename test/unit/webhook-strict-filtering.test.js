"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const {
  createEndpoint,
  DeliveryQueue,
  DELIVERY_STATUS,
  WebhookBridge,
  SIGNING_PROFILES,
  verifyOpenBotSignature,
  OPENBOT_HEADERS,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-strict-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const mockTapuAccount = {
  number: "923124706501",
  jid: "923124706501@c.us",
  me: "923124706501@c.us",
  name: "Tapu",
  lid: "244410113613956@lid",
};

// -------------------------------------------------------------
// Test 1: Incoming personal text message -> dispatched
// -------------------------------------------------------------
test("1. Incoming personal text message is dispatched to webhook queue", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_personal_txt_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      chatName: "Alice Wonderland",
      senderName: "Alice",
      body: "Hello Tapu, how are you?",
      timestamp: 1700000001,
      fromMe: false,
      isGroup: false,
      hasMedia: false,
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);

    const d = deliveries[0];
    assert.equal(d.eventType, "message.received");
    assert.equal(d.payload.data.messageId, "msg_personal_txt_001");
    assert.equal(d.payload.data.body, "Hello Tapu, how are you?");
    assert.equal(d.payload.data.fromMe, false);
    assert.equal(d.payload.data.isGroup, false);
    assert.equal(d.payload.account.number, "923124706501");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 2: Incoming personal image/document/voice message -> dispatched
// -------------------------------------------------------------
test("2. Incoming personal image, document, and voice messages are dispatched with media metadata", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received", "media.received"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 2a. Image message
    bridge.ingestMessage({
      id: "msg_img_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Check out this screenshot",
      caption: "Check out this screenshot",
      timestamp: 1700000002,
      fromMe: false,
      isGroup: false,
      hasMedia: true,
      type: "image",
      mimetype: "image/png",
      filename: "screenshot.png",
      filesize: 65536,
    });

    // 2b. Document message
    bridge.ingestMessage({
      id: "msg_doc_002",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Contract PDF",
      caption: "Contract PDF",
      timestamp: 1700000003,
      fromMe: false,
      isGroup: false,
      hasMedia: true,
      type: "document",
      mimetype: "application/pdf",
      filename: "contract.pdf",
      filesize: 1048576,
    });

    // 2c. Voice note (PTT)
    bridge.ingestMessage({
      id: "msg_voice_003",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "",
      caption: "",
      timestamp: 1700000004,
      fromMe: false,
      isGroup: false,
      hasMedia: true,
      type: "ptt",
      mimetype: "audio/ogg; codecs=opus",
      filename: "voice.ogg",
      filesize: 32768,
    });

    const deliveries = queue.listDeliveries().deliveries;
    // Each media message produces 1 message.received and 1 media.received = 6 deliveries
    assert.equal(deliveries.length, 6);

    const imgMsg = deliveries.find((d) => d.eventId === "evt_rcv_msg_img_001");
    assert.ok(imgMsg);
    assert.equal(imgMsg.payload.data.media.filename, "screenshot.png");
    assert.equal(imgMsg.payload.data.media.mimetype, "image/png");

    const imgMedia = deliveries.find((d) => d.eventId === "evt_med_msg_img_001");
    assert.ok(imgMedia);
    assert.equal(imgMedia.eventType, "media.received");
    assert.equal(imgMedia.payload.data.media.filename, "screenshot.png");

    const docMsg = deliveries.find((d) => d.eventId === "evt_rcv_msg_doc_002");
    assert.ok(docMsg);
    assert.equal(docMsg.payload.data.media.mimetype, "application/pdf");

    const voiceMsg = deliveries.find((d) => d.eventId === "evt_rcv_msg_voice_003");
    assert.ok(voiceMsg);
    assert.equal(voiceMsg.payload.data.type, "ptt");
    assert.equal(voiceMsg.payload.data.media.mimetype, "audio/ogg; codecs=opus");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 3: Group message explicitly mentioning Tapu -> dispatched
// -------------------------------------------------------------
test("3. Group message explicitly mentioning Tapu (phone or LID) is dispatched", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 3a. Mention by phone JID
    bridge.ingestMessage({
      id: "msg_group_mention_001",
      from: "120363028391823@g.us",
      chatId: "120363028391823@g.us",
      chatName: "Dev Team",
      author: "923009999999@c.us",
      senderName: "Bob",
      body: "@923124706501 please check the logs",
      timestamp: 1700000010,
      fromMe: false,
      isGroup: true,
      hasMedia: false,
      mentionedJidList: ["923124706501@c.us"],
    });

    // 3b. Mention by Linked Identity (@lid)
    bridge.ingestMessage({
      id: "msg_group_mention_002",
      from: "120363028391823@g.us",
      chatId: "120363028391823@g.us",
      chatName: "Dev Team",
      author: "923008888888@c.us",
      senderName: "Charlie",
      body: "@Tapu look at this PR",
      timestamp: 1700000011,
      fromMe: false,
      isGroup: true,
      hasMedia: false,
      mentionedJidList: ["244410113613956@lid"],
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 2);

    const d1 = deliveries.find((d) => d.payload.data.messageId === "msg_group_mention_001");
    assert.ok(d1);
    assert.equal(d1.payload.data.isGroup, true);
    assert.deepEqual(d1.payload.data.mentionedJidList, ["923124706501@c.us"]);

    const d2 = deliveries.find((d) => d.payload.data.messageId === "msg_group_mention_002");
    assert.ok(d2);
    assert.equal(d2.payload.data.isGroup, true);
    assert.deepEqual(d2.payload.data.mentionedJidList, ["244410113613956@lid"]);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 4: Group message mentioning another participant only -> ignored
// -------------------------------------------------------------
test("4. Group message mentioning another participant only is ignored", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Group message mentioning only Charlie (not Tapu)
    bridge.ingestMessage({
      id: "msg_group_other_mention_001",
      from: "120363028391823@g.us",
      chatId: "120363028391823@g.us",
      chatName: "Dev Team",
      author: "923009999999@c.us",
      senderName: "Bob",
      body: "@923008888888 please review",
      timestamp: 1700000020,
      fromMe: false,
      isGroup: true,
      hasMedia: false,
      mentionedJidList: ["923008888888@c.us"],
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 5: Group message without mentions -> ignored
// -------------------------------------------------------------
test("5. Group message without mentions is ignored even with name in text string", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 5a. General group message with no mentions
    bridge.ingestMessage({
      id: "msg_group_no_mention_001",
      from: "120363028391823@g.us",
      chatId: "120363028391823@g.us",
      chatName: "Dev Team",
      author: "923009999999@c.us",
      senderName: "Bob",
      body: "Good morning team!",
      timestamp: 1700000030,
      fromMe: false,
      isGroup: true,
      hasMedia: false,
      mentionedJidList: [],
    });

    // 5b. Message containing literal text "@Tapu" but NO structured WhatsApp mention
    bridge.ingestMessage({
      id: "msg_group_text_only_fake_mention_002",
      from: "120363028391823@g.us",
      chatId: "120363028391823@g.us",
      chatName: "Dev Team",
      author: "923009999999@c.us",
      senderName: "Bob",
      body: "Hey @Tapu are you there?",
      timestamp: 1700000031,
      fromMe: false,
      isGroup: true,
      hasMedia: false,
      mentionedJidList: [], // empty: text-only matching is forbidden
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 6: WhatsApp Channel update/post -> ignored
// -------------------------------------------------------------
test("6. WhatsApp Channel (Newsletter) updates and posts are ignored", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    // Endpoint subscribed to wildcard "*"
    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 6a. WhatsApp Channel message (@newsletter suffix)
    bridge.ingestMessage({
      id: "msg_channel_post_001",
      from: "120363426210317653@newsletter",
      chatId: "120363426210317653@newsletter",
      chatName: "Tech News Daily",
      body: "Breaking tech news released today!",
      timestamp: 1700000040,
      fromMe: false,
      isGroup: false, // In WhatsApp Web, channels have isGroup: false
      isNewsletter: true,
      hasMedia: false,
    });

    // 6b. Status broadcast (@broadcast suffix)
    bridge.ingestMessage({
      id: "msg_status_broadcast_002",
      from: "status@broadcast",
      chatId: "status@broadcast",
      body: "My WhatsApp Status update",
      timestamp: 1700000041,
      fromMe: false,
      broadcast: true,
      hasMedia: false,
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 7: Channel reaction -> ignored
// -------------------------------------------------------------
test("7. WhatsApp Channel reaction is ignored", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Reaction in a WhatsApp Channel
    bridge.ingestMessage({
      id: "msg_channel_reaction_001",
      from: "120363426210317653@newsletter",
      chatId: "120363426210317653@newsletter",
      type: "reaction",
      reaction: {
        parentMsgKey: { remote: "120363426210317653@newsletter" },
        emoji: "👍",
      },
      timestamp: 1700000050,
      fromMe: false,
      isNewsletter: true,
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 8: Delivery/read receipt -> ignored
// -------------------------------------------------------------
test("8. Delivery receipts and read receipts (ACKs) are ignored and never enqueued", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    // Endpoint subscribed to wildcard "*"
    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Ingest delivery receipt (ACK 2)
    bridge.ingestAck({
      messageId: "msg_receipt_001",
      chatId: "923001234567@c.us",
      ack: 2,
      timestamp: 1700000060,
    });

    // Ingest read receipt (ACK 3)
    bridge.ingestAck({
      messageId: "msg_receipt_002",
      chatId: "923001234567@c.us",
      ack: 3,
      timestamp: 1700000061,
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 9: Outgoing message -> ignored
// -------------------------------------------------------------
test("9. Outgoing messages (fromMe: true) are strictly ignored and never dispatched", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 9a. Outgoing text message
    bridge.ingestMessage({
      id: "msg_outgoing_txt_001",
      from: "me",
      to: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "My outgoing answer to Alice",
      timestamp: 1700000070,
      fromMe: true,
      hasMedia: false,
    });

    // 9b. Outgoing media message
    bridge.ingestMessage({
      id: "msg_outgoing_img_002",
      from: "me",
      to: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Sent an attachment",
      timestamp: 1700000071,
      fromMe: true,
      hasMedia: true,
      mimetype: "image/jpeg",
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 10: Duplicate qualifying message -> dispatched only once
// -------------------------------------------------------------
test("10. Duplicate qualifying message is dispatched only once", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    const qualifyingMsg = {
      id: "msg_qualifying_replay_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Important incoming ping",
      timestamp: 1700000080,
      fromMe: false,
      isGroup: false,
      hasMedia: false,
    };

    // Ingest the identical message 3 times (simulating re-delivery / reconnect replay)
    bridge.ingestMessage(qualifyingMsg);
    bridge.ingestMessage(qualifyingMsg);
    bridge.ingestMessage(qualifyingMsg);

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "msg_qualifying_replay_001");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 11: Quoted-message context remains intact
// -------------------------------------------------------------
test("11. Quoted-message context remains intact in dispatched payload", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    const quotedPayload = {
      id: "msg_quoted_orig_999",
      senderName: "Alice Wonderland",
      author: "923001112222@c.us",
      body: "Can someone approve the budget?",
      caption: null,
      hasMedia: false,
      type: "chat",
    };

    bridge.ingestMessage({
      id: "msg_reply_with_quote_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      senderName: "Bob Smith",
      body: "Yes, approved!",
      timestamp: 1700000090,
      fromMe: false,
      isGroup: false,
      hasMedia: false,
      hasQuotedMsg: true,
      quotedMsg: quotedPayload,
    });

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);

    const deliveredData = deliveries[0].payload.data;
    assert.equal(deliveredData.hasQuotedMsg, true);
    assert.ok(deliveredData.quotedMsg);
    assert.equal(deliveredData.quotedMsg.id, "msg_quoted_orig_999");
    assert.equal(deliveredData.quotedMsg.senderName, "Alice Wonderland");
    assert.equal(deliveredData.quotedMsg.body, "Can someone approve the budget?");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 12: Existing endpoint subscriptions and OpenBot signing remain unaffected
// -------------------------------------------------------------
test("12. Existing endpoint subscriptions and OpenBot signing remain unaffected", async () => {
  const tempDir = createTempDir();

  // 1. Create a local mock HTTP server that records received headers and body
  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      receivedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockReceiverUrl = `http://127.0.0.1:${port}/openbot-webhook`;

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
    });
    await queue.init();

    const openbotSecret = "whsec_test_openbot_secret_xyz123";
    const endpoint = createEndpoint(
      {
        url: mockReceiverUrl,
        events: ["message.received"],
        profile: SIGNING_PROFILES.OPENBOT,
        secret: openbotSecret,
        security: { allowLocalhost: true },
      },
      tempDir,
      { exposeSecret: true }
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Ingest qualifying incoming message
    bridge.ingestMessage({
      id: "msg_openbot_test_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      senderName: "Alice",
      body: "Hello OpenBot!",
      timestamp: 1700000100,
      fromMe: false,
      isGroup: false,
      hasMedia: false,
      mentionedJidList: [],
    });

    // Wait for delivery to reach mock receiver
    let loops = 0;
    while (receivedRequests.length < 1 && loops < 50) {
      await new Promise((r) => setTimeout(r, 20));
      loops++;
    }

    // Verify mock server received the request with exact OpenBot protocol
    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];

    // Check OpenBot headers
    assert.ok(req.headers[OPENBOT_HEADERS.TIMESTAMP]);
    assert.ok(req.headers[OPENBOT_HEADERS.DELIVERY_ID]);
    assert.ok(req.headers[OPENBOT_HEADERS.SIGNATURE]);

    // Check OpenBot JSON envelope
    const parsedEnvelope = JSON.parse(req.body);
    assert.equal(parsedEnvelope.type, "message.received");
    assert.ok(parsedEnvelope.occurredAt);
    assert.equal(parsedEnvelope.data.messageId, "msg_openbot_test_001");
    assert.equal(parsedEnvelope.data.body, "Hello OpenBot!");

    // Verify HMAC-SHA256 signature using OpenBot verification helper
    const verification = verifyOpenBotSignature({
      rawBody: req.body,
      secret: openbotSecret,
      signatureHeader: req.headers[OPENBOT_HEADERS.SIGNATURE],
      timestampHeader: req.headers[OPENBOT_HEADERS.TIMESTAMP],
      deliveryIdHeader: req.headers[OPENBOT_HEADERS.DELIVERY_ID],
    });

    assert.equal(verification.ok, true);

    bridge.stop();
    await queue.shutdown();
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
