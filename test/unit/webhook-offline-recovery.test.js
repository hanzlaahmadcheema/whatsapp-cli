"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { EventEmitter } = require("events");

const {
  createEndpoint,
  DeliveryQueue,
  DELIVERY_STATUS,
  WebhookBridge,
  CheckpointStore,
  MessageRecoveryCoordinator,
  SIGNING_PROFILES,
  verifyOpenBotSignature,
  OPENBOT_HEADERS,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-recovery-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const mockTapuAccount = {
  number: "923124706501",
  jid: "923124706501@c.us",
  me: "923124706501@c.us",
  name: "Tapu",
  lid: "244410113613956@lid",
};

function createMockMsg({
  id,
  from,
  to = "923124706501@c.us",
  author = undefined,
  body = "Test message body",
  timestamp = Math.floor(Date.now() / 1000),
  fromMe = false,
  hasMedia = false,
  type = "chat",
  mentionedIds = [],
  media = null,
  quotedMsg = null,
}) {
  return {
    id: { _serialized: id, id, fromMe, remote: from },
    from,
    to,
    author,
    body: hasMedia ? (media?.caption || body) : body,
    timestamp,
    fromMe,
    hasMedia,
    type: type || (hasMedia ? "image" : "chat"),
    mentionedIds,
    mimetype: media?.mimetype || null,
    filename: media?.filename || null,
    filesize: media?.filesize || null,
    caption: media?.caption || (hasMedia ? body : ""),
    quotedMsg,
    _data: {
      id: { _serialized: id, id, fromMe, remote: from },
      notifyName: from.split("@")[0],
      mentionedJidList: mentionedIds,
      caption: media?.caption || (hasMedia ? body : ""),
    },
  };
}

function createMockChat({
  id,
  name = "Chat",
  isGroup = false,
  isNewsletter = false,
  broadcast = false,
  messages = [],
  unreadCount = 0,
  fetchError = null,
}) {
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const lastMsg = sortedMessages.length > 0 ? sortedMessages[sortedMessages.length - 1] : null;

  const chatObj = {
    id: { _serialized: id },
    name,
    formattedTitle: name,
    isGroup,
    isNewsletter,
    broadcast,
    unreadCount: unreadCount || messages.length,
    timestamp: lastMsg ? lastMsg.timestamp : Math.floor(Date.now() / 1000),
    lastMessage: lastMsg,
    messages: sortedMessages,
    async fetchMessages(searchOptions = {}) {
      if (fetchError) {
        throw fetchError;
      }
      const limit = searchOptions.limit || chatObj.messages.length;
      return chatObj.messages.slice(Math.max(0, chatObj.messages.length - limit));
    },
  };

  return chatObj;
}

function createMockService({ chats = [], state = "ready", client = null } = {}) {
  const service = new EventEmitter();
  service.state = state;
  service._subscribers = new Set();
  service.subscribe = (cb) => {
    service._subscribers.add(cb);
    return () => service._subscribers.delete(cb);
  };
  service.broadcast = (event) => {
    for (const cb of service._subscribers.values()) {
      try {
        cb(event);
      } catch (_) {}
    }
  };

  const mockClient = client || new EventEmitter();
  if (!mockClient.getChats) {
    mockClient.getChats = async () => chats;
  }
  if (!mockClient.getState) {
    mockClient.getState = async () => "CONNECTED";
  }

  service.client = mockClient;
  service.account = mockTapuAccount;
  return service;
}

// -------------------------------------------------------------
// Test 1: Messages received while offline and recovered
// -------------------------------------------------------------
test("1. Messages received while daemon is offline are recovered after reconnection", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "msg_init_00",
      lastTimestamp: 1700000100,
    });

    const missedMsg1 = createMockMsg({
      id: "msg_off_01",
      from: "923001234567@c.us",
      body: "First missed offline message",
      timestamp: 1700000110,
    });
    const missedMsg2 = createMockMsg({
      id: "msg_off_02",
      from: "923001234567@c.us",
      body: "Second missed offline message",
      timestamp: 1700000120,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Alice",
      messages: [missedMsg1, missedMsg2],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    const res = await coordinator.reconcile();
    assert.equal(res.status, "completed");
    assert.equal(res.totalProcessed, 2);

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 2);

    const chronological = deliveries.slice().sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    assert.equal(chronological[0].payload.data.messageId, "msg_off_01");
    assert.equal(chronological[0].payload.data.body, "First missed offline message");
    assert.equal(chronological[1].payload.data.messageId, "msg_off_02");
    assert.equal(chronological[1].payload.data.body, "Second missed offline message");

    const updatedCp = cpStore.getChatCheckpoint("923001234567@c.us");
    assert.equal(updatedCp.lastMessageId, "msg_off_02");
    assert.equal(updatedCp.lastTimestamp, 1700000120);
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 2: Multiple missed messages across multiple chats (chronological)
// -------------------------------------------------------------
test("2. Multiple missed messages across multiple chats are processed chronologically", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("chat_alpha@c.us", {
      lastMessageId: "alpha_0",
      lastTimestamp: 1700000200,
    });
    cpStore.updateChatCheckpoint("chat_beta@c.us", {
      lastMessageId: "beta_0",
      lastTimestamp: 1700000200,
    });

    const msgAlpha1 = createMockMsg({
      id: "alpha_1",
      from: "chat_alpha@c.us",
      body: "Alpha message 1",
      timestamp: 1700000210,
    });
    const msgAlpha2 = createMockMsg({
      id: "alpha_2",
      from: "chat_alpha@c.us",
      body: "Alpha message 2",
      timestamp: 1700000230,
    });

    const msgBeta1 = createMockMsg({
      id: "beta_1",
      from: "chat_beta@c.us",
      body: "Beta message 1",
      timestamp: 1700000220,
    });
    const msgBeta2 = createMockMsg({
      id: "beta_2",
      from: "chat_beta@c.us",
      body: "Beta message 2",
      timestamp: 1700000240,
    });

    const chatAlpha = createMockChat({
      id: "chat_alpha@c.us",
      name: "Alpha Chat",
      messages: [msgAlpha2, msgAlpha1], // Deliberately unsorted in input
    });
    const chatBeta = createMockChat({
      id: "chat_beta@c.us",
      name: "Beta Chat",
      messages: [msgBeta2, msgBeta1],
    });

    const service = createMockService({ chats: [chatAlpha, chatBeta] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 4);

    // Alpha chat messages are processed in chronological order (alpha_1 then alpha_2)
    const alphaDeliveries = deliveries
      .filter((d) => d.payload.data.chatId === "chat_alpha@c.us")
      .sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    assert.equal(alphaDeliveries.length, 2);
    assert.equal(alphaDeliveries[0].payload.data.messageId, "alpha_1");
    assert.equal(alphaDeliveries[1].payload.data.messageId, "alpha_2");

    // Beta chat messages are processed in chronological order (beta_1 then beta_2)
    const betaDeliveries = deliveries
      .filter((d) => d.payload.data.chatId === "chat_beta@c.us")
      .sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    assert.equal(betaDeliveries.length, 2);
    assert.equal(betaDeliveries[0].payload.data.messageId, "beta_1");
    assert.equal(betaDeliveries[1].payload.data.messageId, "beta_2");

    assert.equal(cpStore.getChatCheckpoint("chat_alpha@c.us").lastMessageId, "alpha_2");
    assert.equal(cpStore.getChatCheckpoint("chat_beta@c.us").lastMessageId, "beta_2");
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 3: Duplicate live and recovered message events (race prevention)
// -------------------------------------------------------------
test("3. Duplicate live and recovered messages are prevented across race conditions", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "race_0",
      lastTimestamp: 1700000300,
    });

    const raceMsg1 = createMockMsg({
      id: "msg_race_01",
      from: "923001234567@c.us",
      body: "Race condition test message 1",
      timestamp: 1700000310,
    });
    const raceMsg2 = createMockMsg({
      id: "msg_race_02",
      from: "923001234567@c.us",
      body: "Race condition test message 2",
      timestamp: 1700000320,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Alice",
      messages: [raceMsg1, raceMsg2],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    // 1. Live message arrives first for msg_race_01
    bridge.ingestMessage({
      id: "msg_race_01",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Race condition test message 1",
      timestamp: 1700000310,
      fromMe: false,
      isGroup: false,
    });

    assert.equal(queue.listDeliveries().deliveries.length, 1);

    // 2. Recovery reconciles chat history (which contains both msg_race_01 and msg_race_02)
    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    // msg_race_01 should NOT be re-enqueued, msg_race_02 should be enqueued
    let deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.some((d) => d.payload.data.messageId === "msg_race_01"));
    assert.ok(deliveries.some((d) => d.payload.data.messageId === "msg_race_02"));

    // 3. Now simulate a live duplicate arriving for msg_race_02 (which was recovered)
    bridge.ingestMessage({
      id: "msg_race_02",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Race condition test message 2",
      timestamp: 1700000320,
      fromMe: false,
      isGroup: false,
    });

    // Delivery count must strictly remain 2
    deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 2);
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 4: Daemon crash during recovery (checkpoint persists intermediate progress)
// -------------------------------------------------------------
test("4. Daemon crash during recovery persists intermediate progress and resumes without duplicates", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;
  let restartBridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("chat_crash@c.us", {
      lastMessageId: "crash_0",
      lastTimestamp: 1700000400,
    });

    const m1 = createMockMsg({ id: "m1", from: "chat_crash@c.us", timestamp: 1700000410 });
    const m2 = createMockMsg({ id: "m2", from: "chat_crash@c.us", timestamp: 1700000420 });
    const m3 = createMockMsg({ id: "m3", from: "chat_crash@c.us", timestamp: 1700000430 });
    const m4 = createMockMsg({ id: "m4", from: "chat_crash@c.us", timestamp: 1700000440 });

    const chat = createMockChat({
      id: "chat_crash@c.us",
      messages: [m1, m2, m3, m4],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    // Simulate crash after m2: intercept ingestMessage to simulate ungraceful stop
    let count = 0;
    const origIngest = bridge.ingestMessage.bind(bridge);
    bridge.ingestMessage = (summary, opts) => {
      origIngest(summary, opts);
      count++;
      if (count === 2) {
        coordinator.stop(); // simulate crash immediately after m2
      }
    };

    await coordinator.reconcile();

    // After simulated crash, only m1 and m2 were captured
    assert.equal(queue.listDeliveries().deliveries.length, 2);

    // Verify checkpoint file on disk was saved with m2
    const diskStore = new CheckpointStore({ dataDir: tempDir });
    diskStore.load();
    const diskCp = diskStore.getChatCheckpoint("chat_crash@c.us");
    assert.equal(diskCp.lastMessageId, "m2");
    assert.equal(diskCp.lastTimestamp, 1700000420);
    assert.equal(diskStore.isMessageProcessed("m1"), true);
    assert.equal(diskStore.isMessageProcessed("m2"), true);
    assert.equal(diskStore.isMessageProcessed("m3"), false);

    // Now restart fresh coordinator with new instance pointing to same tempDir
    const restartCpStore = new CheckpointStore({ dataDir: tempDir });
    restartCpStore.load();
    restartBridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: restartCpStore,
    });
    const restartCoordinator = new MessageRecoveryCoordinator({
      bridge: restartBridge,
      service,
      checkpointStore: restartCpStore,
      dataDir: tempDir,
    });

    await restartCoordinator.reconcile();

    // Deliveries must now contain exactly m1, m2, m3, m4 with 0 duplicates!
    const allDeliveries = queue.listDeliveries().deliveries;
    assert.equal(allDeliveries.length, 4);
    const msgIds = allDeliveries
      .slice()
      .sort((a, b) => a.payload.timestamp - b.payload.timestamp)
      .map((d) => d.payload.data.messageId);
    assert.deepEqual(msgIds, ["m1", "m2", "m3", "m4"]);

    const finalCp = restartCpStore.getChatCheckpoint("chat_crash@c.us");
    assert.equal(finalCp.lastMessageId, "m4");
    assert.equal(finalCp.lastTimestamp, 1700000440);
  } finally {
    if (bridge) bridge.stop();
    if (restartBridge) restartBridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 5: Repeated reconnects (debounced single execution, zero duplicates)
// -------------------------------------------------------------
test("5. Repeated rapid reconnects are debounced and produce zero duplicate webhook events", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;
  let coordinator;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("chat_debounce@c.us", {
      lastMessageId: "deb_0",
      lastTimestamp: 1700000500,
    });

    const debMsg = createMockMsg({
      id: "deb_msg_1",
      from: "chat_debounce@c.us",
      body: "Single debounced message",
      timestamp: 1700000510,
    });

    const chat = createMockChat({
      id: "chat_debounce@c.us",
      messages: [debMsg],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    coordinator.start();

    // Emit 5 ready/recovery events in rapid succession within 30ms
    service.emit("ready");
    service.emit("recovery_success", { attempt: 1 });
    service.broadcast({ event: "state", state: "ready" });
    service.emit("ready");
    service.broadcast({ event: "state", state: "ready" });

    // Wait for the 250ms debounce timer plus async processing
    await new Promise((resolve) => setTimeout(resolve, 400));

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "deb_msg_1");
  } finally {
    if (coordinator) coordinator.stop();
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 6: Group messages with Tapu mentioned (dispatched)
// -------------------------------------------------------------
test("6. Group messages explicitly mentioning Tapu are dispatched during recovery", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("120363028123456789@g.us", {
      lastMessageId: "grp_0",
      lastTimestamp: 1700000600,
    });

    const groupMentionMsg = createMockMsg({
      id: "grp_mention_01",
      from: "120363028123456789@g.us",
      author: "923009999999@c.us",
      body: "@Tapu please review this pull request",
      timestamp: 1700000610,
      mentionedIds: ["923124706501@c.us"],
    });

    const groupChat = createMockChat({
      id: "120363028123456789@g.us",
      name: "Engineering Team",
      isGroup: true,
      messages: [groupMentionMsg],
    });

    const service = createMockService({ chats: [groupChat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "grp_mention_01");
    assert.equal(deliveries[0].payload.data.isGroup, true);
    assert.deepEqual(deliveries[0].payload.data.mentionedJidList, ["923124706501@c.us"]);
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 7: Group messages without Tapu mentioned (strictly ignored)
// -------------------------------------------------------------
test("7. Group messages without Tapu mentioned are strictly ignored and advance checkpoint", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("120363028123456789@g.us", {
      lastMessageId: "grp_0",
      lastTimestamp: 1700000700,
    });

    const msgNoMention = createMockMsg({
      id: "grp_no_mention",
      from: "120363028123456789@g.us",
      author: "923009999999@c.us",
      body: "Hey everyone, lunch is here!",
      timestamp: 1700000710,
      mentionedIds: [],
    });

    const msgOtherMention = createMockMsg({
      id: "grp_other_mention",
      from: "120363028123456789@g.us",
      author: "923009999999@c.us",
      body: "@Bob check this out",
      timestamp: 1700000720,
      mentionedIds: ["923001111111@c.us"],
    });

    const groupChat = createMockChat({
      id: "120363028123456789@g.us",
      name: "Engineering Team",
      isGroup: true,
      messages: [msgNoMention, msgOtherMention],
    });

    const service = createMockService({ chats: [groupChat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    // Neither message qualifies, queue must have 0 deliveries
    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 0);

    // But checkpoint must advance past them so they are not re-processed
    const updatedCp = cpStore.getChatCheckpoint("120363028123456789@g.us");
    assert.equal(updatedCp.lastMessageId, "grp_other_mention");
    assert.equal(updatedCp.lastTimestamp, 1700000720);
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 8: Personal media messages (dispatched with metadata and caption)
// -------------------------------------------------------------
test("8. Recovered personal media messages dispatch message.received and media.received", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      {
        url: "https://mock.example.com/webhook",
        events: ["message.received", "media.received"],
      },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "media_0",
      lastTimestamp: 1700000800,
    });

    const mediaMsg = createMockMsg({
      id: "media_msg_01",
      from: "923001234567@c.us",
      body: "Project design mockup",
      timestamp: 1700000810,
      hasMedia: true,
      type: "image",
      media: {
        mimetype: "image/png",
        filename: "mockup.png",
        filesize: 1048576,
        caption: "Project design mockup",
      },
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Alice",
      messages: [mediaMsg],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 2);

    const msgRecv = deliveries.find((d) => d.eventType === "message.received");
    const mediaRecv = deliveries.find((d) => d.eventType === "media.received");

    assert.ok(msgRecv);
    assert.equal(msgRecv.payload.data.messageId, "media_msg_01");
    assert.equal(msgRecv.payload.data.hasMedia, true);
    assert.equal(msgRecv.payload.data.media.mimetype, "image/png");
    assert.equal(msgRecv.payload.data.media.filename, "mockup.png");
    assert.equal(msgRecv.payload.data.media.filesize, 1048576);
    assert.equal(msgRecv.payload.data.media.caption, "Project design mockup");

    assert.ok(mediaRecv);
    assert.equal(mediaRecv.payload.data.messageId, "media_msg_01");
    assert.equal(mediaRecv.payload.data.caption, "Project design mockup");
    assert.equal(mediaRecv.payload.data.media.mimetype, "image/png");
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 9: Channel and broadcast exclusion (strictly ignored)
// -------------------------------------------------------------
test("9. WhatsApp Channels and broadcasts are strictly excluded during historical recovery", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);

    let channelFetchCalled = false;
    let broadcastFetchCalled = false;

    const channelChat = {
      id: { _serialized: "120363028999999999@newsletter" },
      name: "BBC News",
      isNewsletter: true,
      unreadCount: 10,
      timestamp: 1700000950,
      async fetchMessages() {
        channelFetchCalled = true;
        return [createMockMsg({ id: "chan_1", from: "120363028999999999@newsletter" })];
      },
    };

    const broadcastChat = {
      id: { _serialized: "status@broadcast" },
      name: "Status Broadcast",
      broadcast: true,
      unreadCount: 5,
      timestamp: 1700000950,
      async fetchMessages() {
        broadcastFetchCalled = true;
        return [createMockMsg({ id: "broad_1", from: "status@broadcast" })];
      },
    };

    const personalChat = createMockChat({
      id: "personal_allowed@c.us",
      name: "Bob",
      messages: [
        createMockMsg({
          id: "msg_allowed_1",
          from: "personal_allowed@c.us",
          timestamp: 1700000960,
        }),
      ],
    });

    const service = createMockService({
      chats: [channelChat, broadcastChat, personalChat],
    });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    await coordinator.reconcile();

    // Verify channel and broadcast chats were never fetched
    assert.equal(channelFetchCalled, false);
    assert.equal(broadcastFetchCalled, false);

    // Only personal chat message was enqueued
    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "msg_allowed_1");
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 10: Recovery pagination and large backlogs (> 100 messages)
// -------------------------------------------------------------
test("10. Large message backlogs (> 100 messages) are recovered incrementally across batches", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("chat_backlog@c.us", {
      lastMessageId: "backlog_0",
      lastTimestamp: 1700001000,
    });

    // Create 120 messages
    const totalMsgs = 120;
    const messages = [];
    for (let i = 1; i <= totalMsgs; i++) {
      messages.push(
        createMockMsg({
          id: `backlog_msg_${String(i).padStart(3, "0")}`,
          from: "chat_backlog@c.us",
          body: `Backlog message #${i}`,
          timestamp: 1700001000 + i,
        })
      );
    }

    const chat = createMockChat({
      id: "chat_backlog@c.us",
      messages,
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    // Run coordinator with batchSize of 50
    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
      batchSize: 50,
      maxCycleMessages: 200,
    });

    const res = await coordinator.reconcile();
    assert.equal(res.status, "completed");
    assert.equal(res.totalProcessed, 120);

    // Default listDeliveries limits to 50, so pass limit: 200
    const listResult = queue.listDeliveries({ limit: 200 });
    assert.equal(listResult.total, 120);
    assert.equal(listResult.deliveries.length, 120);

    const chronological = listResult.deliveries
      .slice()
      .sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    assert.equal(chronological[0].payload.data.messageId, "backlog_msg_001");
    assert.equal(chronological[119].payload.data.messageId, "backlog_msg_120");

    const finalCp = cpStore.getChatCheckpoint("chat_backlog@c.us");
    assert.equal(finalCp.lastMessageId, "backlog_msg_120");
    assert.equal(finalCp.lastTimestamp, 1700001120);
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 11: Missing or inaccessible history (reports error honestly)
// -------------------------------------------------------------
test("11. Inaccessible history records error honestly and retains recovery checkpoint without advancing", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("chat_inaccessible@c.us", {
      lastMessageId: "saved_checkpoint_id",
      lastTimestamp: 1700002000,
    });

    const failingChat = createMockChat({
      id: "chat_inaccessible@c.us",
      name: "Charlie",
      unreadCount: 3,
      messages: [],
      fetchError: new Error("IndexedDB read failure: Frame detached"),
    });

    const service = createMockService({ chats: [failingChat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    const res = await coordinator.reconcile();
    assert.equal(res.status, "completed");
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].status, "inaccessible_history");
    assert.ok(res.errors[0].error.includes("IndexedDB read failure"));

    // Checkpoint must NOT be corrupted or advanced
    const cp = cpStore.getChatCheckpoint("chat_inaccessible@c.us");
    assert.equal(cp.lastMessageId, "saved_checkpoint_id");
    assert.equal(cp.lastTimestamp, 1700002000);
    assert.ok(cp.lastError.includes("IndexedDB read failure"));
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 12: Checkpoint persistence and baseline bootstrap
// -------------------------------------------------------------
test("12. Initial bootstrap baseline prevents historical replay; subsequent recovery functions normally", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    assert.equal(cpStore.isBootstrapped(), false);

    const oldMsg = createMockMsg({
      id: "old_msg_001",
      from: "bootstrap_chat@c.us",
      body: "Old past message",
      timestamp: 1700003000,
    });

    const chat = createMockChat({
      id: "bootstrap_chat@c.us",
      name: "David",
      messages: [oldMsg],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    // 1. First run: establishes baseline, dispatches 0 messages
    const resBootstrap = await coordinator.reconcile();
    assert.equal(resBootstrap.status, "bootstrapped");
    assert.equal(queue.listDeliveries().deliveries.length, 0);

    assert.equal(cpStore.isBootstrapped(), true);
    assert.equal(cpStore.getChatCheckpoint("bootstrap_chat@c.us").lastMessageId, "old_msg_001");

    // 2. New message arrives in history after baseline
    const newMsg = createMockMsg({
      id: "new_msg_002",
      from: "bootstrap_chat@c.us",
      body: "New message received after bootstrap",
      timestamp: 1700003050,
    });
    chat.messages.push(newMsg);
    chat.timestamp = 1700003050;
    chat.lastMessage = newMsg;

    // 3. Second run: recovers only new message
    const resRecovery = await coordinator.reconcile();
    assert.equal(resRecovery.status, "completed");
    assert.equal(resRecovery.totalProcessed, 1);

    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "new_msg_002");
    assert.equal(deliveries[0].payload.data.body, "New message received after bootstrap");
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 13: OpenBot delivery after successful message recovery
// -------------------------------------------------------------
test("13. Recovered message delivers to OpenBot endpoint with valid HMAC signature and headers", async () => {
  const tempDir = createTempDir();
  let server;
  let queue;
  let bridge;

  try {
    const receivedRequests = [];
    server = http.createServer((req, res) => {
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
        res.end(JSON.stringify({ ok: true, received: true }));
      });
    });

    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(server.address().port);
      });
    });

    const targetUrl = `http://127.0.0.1:${port}/openbot/webhook`;
    const openbotSecret = "openbot_sec_abcdef0123456789abcdef0123456789";

    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    // Allow localhost for testing mock receiver
    const ep = createEndpoint(
      {
        url: targetUrl,
        events: ["message.received"],
        profile: SIGNING_PROFILES.OPENBOT,
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // Set signing secret for endpoint
    const { setEndpointSecret } = require("../../src/webhook/store");
    setEndpointSecret(ep.id, openbotSecret, tempDir);

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "openbot_init",
      lastTimestamp: 1700004000,
    });

    const missedMsg = createMockMsg({
      id: "msg_openbot_recovered_01",
      from: "923001234567@c.us",
      body: "Important payload for OpenBot",
      timestamp: 1700004010,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Alice",
      messages: [missedMsg],
    });

    const service = createMockService({ chats: [chat] });
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
    });

    // 1. Recover missed message into delivery queue
    await coordinator.reconcile();
    queue.processQueue();

    // Wait briefly for in-flight HTTP delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 2. Verify received HTTP request on mock server
    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.method, "POST");

    // Verify OpenBot headers
    const sigHeader = req.headers["x-openbot-signature"];
    const tsHeader = req.headers["x-openbot-timestamp"];
    const idHeader = req.headers["x-openbot-delivery-id"];

    assert.ok(sigHeader, "x-openbot-signature must be present");
    assert.ok(tsHeader, "x-openbot-timestamp must be present");
    assert.ok(idHeader, "x-openbot-delivery-id must be present");

    // Verify HMAC-SHA256 signature validity
    const verified = verifyOpenBotSignature({
      rawBody: req.body,
      secret: openbotSecret,
      signatureHeader: sigHeader,
      timestampHeader: tsHeader,
      deliveryIdHeader: idHeader,
    });
    assert.equal(verified.ok, true, "Signature verification must succeed");

    // Verify OpenBot JSON body structure ({ type, occurredAt, data })
    const parsedBody = JSON.parse(req.body);
    assert.equal(parsedBody.type, "message.received");
    assert.ok(parsedBody.occurredAt);
    assert.equal(parsedBody.data.messageId, "msg_openbot_recovered_01");
    assert.equal(parsedBody.data.body, "Important payload for OpenBot");
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 14: System resume event triggers reconciliation automatically
// -------------------------------------------------------------
test("14. System resume event triggers reconciliation automatically", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      {
        url: "https://example.com/webhook",
        events: ["message.received"],
      },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.load();
    cpStore.setBootstrapped(true);
    cpStore.save();

    const missedMsg = createMockMsg({
      id: "msg_resume_test_01",
      from: "923001234567@c.us",
      body: "Sent while sleeping",
      timestamp: 1700000100,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Bob",
      messages: [missedMsg],
    });

    const service = createMockService({ chats: [chat] });
    service.sleepNotifier = new EventEmitter();

    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
      autoSweep: false,
    });
    coordinator.start();

    // Trigger resume event on sleepNotifier
    service.sleepNotifier.emit("resume");

    // Wait for debounce (250ms) + reconciliation
    await new Promise((r) => setTimeout(r, 400));

    // Check delivery queue
    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "msg_resume_test_01");

    coordinator.stop();
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 15: WhatsApp client reconnect triggers reconciliation
// -------------------------------------------------------------
test("15. WhatsApp client reconnect (change_state CONNECTED) triggers reconciliation", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      {
        url: "https://example.com/webhook",
        events: ["message.received"],
      },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.load();
    cpStore.setBootstrapped(true);
    cpStore.save();

    const missedMsg = createMockMsg({
      id: "msg_reconnect_test_01",
      from: "923001234567@c.us",
      body: "Sent while network was offline",
      timestamp: 1700000200,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Charlie",
      messages: [missedMsg],
    });

    const client = new EventEmitter();
    client.getChats = async () => [chat];
    client.getState = async () => "CONNECTED";

    const service = createMockService({ chats: [chat], client });

    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      client,
      checkpointStore: cpStore,
      dataDir: tempDir,
      autoSweep: false,
    });
    coordinator.start();

    // Simulate WhatsApp Web WebSocket reconnect
    client.emit("change_state", "CONNECTED");

    // Wait for debounce (250ms) + reconciliation
    await new Promise((r) => setTimeout(r, 400));

    // Check delivery queue
    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "msg_reconnect_test_01");

    coordinator.stop();
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 16: Periodic auto-sweep sweeps chats and recovers missed messages
// -------------------------------------------------------------
test("16. Periodic auto-sweep sweeps chats and recovers missed messages", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      {
        url: "https://example.com/webhook",
        events: ["message.received"],
      },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.load();
    cpStore.setBootstrapped(true);
    cpStore.save();

    const missedMsg = createMockMsg({
      id: "msg_autosweep_01",
      from: "923001234567@c.us",
      body: "Caught by periodic sweep",
      timestamp: 1700000300,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      name: "Dave",
      messages: [missedMsg],
    });

    const service = createMockService({ chats: [chat] });

    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge,
      service,
      checkpointStore: cpStore,
      dataDir: tempDir,
      autoSweep: true,
      sweepIntervalMs: 50, // fast sweep for test
    });
    coordinator.start();

    // Wait for auto-sweep interval to fire
    await new Promise((r) => setTimeout(r, 150));

    // Check delivery queue
    const deliveries = queue.listDeliveries().deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.data.messageId, "msg_autosweep_01");

    coordinator.stop();
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 17: Outgoing messages (fromMe: true) do not advance chat checkpoint
// -------------------------------------------------------------
test("17. Outgoing messages (fromMe: true) do not advance chat checkpoint past un-reconciled incoming messages", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    createEndpoint(
      {
        url: "https://example.com/webhook",
        events: ["message.received"],
      },
      tempDir
    );

    const cpStore = new CheckpointStore({ dataDir: tempDir });
    cpStore.load();
    cpStore.setBootstrapped(true);
    cpStore.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "msg_init",
      lastTimestamp: 1000,
    });
    cpStore.save();

    const service = createMockService();
    bridge = new WebhookBridge({
      service,
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore,
    });

    // Ingest an outgoing reply sent at ts 2000
    bridge.ingestMessage({
      id: "out_reply_01",
      chatId: "923001234567@c.us",
      fromMe: true,
      timestamp: 2000,
      body: "Outgoing reply sent from phone",
    });

    // Verify chat checkpoint was NOT bumped to 2000 by the outgoing message
    const cp = cpStore.getChatCheckpoint("923001234567@c.us");
    assert.equal(
      cp.lastTimestamp,
      1000,
      "Checkpoint timestamp must not advance from outgoing message"
    );
    assert.equal(
      cp.lastMessageId,
      "msg_init",
      "Checkpoint lastMessageId must not be overwritten by outgoing message"
    );
    assert.equal(
      cpStore.isMessageProcessed("out_reply_01"),
      true,
      "Outgoing message ID must be marked processed"
    );
  } finally {
    if (bridge) bridge.stop();
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
