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
} = require("../../src/webhook");

function createTempDir(prefix = "wa-queue-idempotency-test-") {
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
  from = "923001234567@c.us",
  to = "923124706501@c.us",
  author = undefined,
  body = "Test body",
  timestamp = Math.floor(Date.now() / 1000),
  fromMe = false,
  hasMedia = false,
  type = "chat",
  media = null,
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
    mentionedIds: [],
    mimetype: media?.mimetype || null,
    filename: media?.filename || null,
    filesize: media?.filesize || null,
    caption: media?.caption || (hasMedia ? body : ""),
    _data: {
      id: { _serialized: id, id, fromMe, remote: from },
      notifyName: from.split("@")[0],
      mentionedJidList: [],
    },
  };
}

function createMockChat({
  id,
  name = "Chat",
  messages = [],
}) {
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const lastMsg = sortedMessages.length > 0 ? sortedMessages[sortedMessages.length - 1] : null;

  return {
    id: { _serialized: id },
    name,
    isGroup: false,
    isNewsletter: false,
    broadcast: false,
    unreadCount: messages.length,
    timestamp: lastMsg ? lastMsg.timestamp : Math.floor(Date.now() / 1000),
    lastMessage: lastMsg,
    messages: sortedMessages,
    async fetchMessages(searchOptions = {}) {
      const limit = searchOptions.limit || sortedMessages.length;
      return sortedMessages.slice(Math.max(0, sortedMessages.length - limit));
    },
  };
}

function createMockService({ chats = [] } = {}) {
  const service = new EventEmitter();
  service.state = "ready";
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

  const client = new EventEmitter();
  client.getChats = async () => chats;
  client.getState = async () => "CONNECTED";

  service.client = client;
  service.account = mockTapuAccount;
  return service;
}

// -------------------------------------------------------------
// Test 1: Crash after queue persistence but before checkpoint persistence
// -------------------------------------------------------------
test("1. Crash after queue persistence but before checkpoint persistence does not create duplicate deliveries", async () => {
  const tempDir = createTempDir();
  let queue1;
  let queue2;
  let bridge1;
  let bridge2;

  try {
    queue1 = new DeliveryQueue({ dataDir: tempDir });
    await queue1.init({ autoProcess: false });

    const ep = createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const cpStore1 = new CheckpointStore({ dataDir: tempDir });
    cpStore1.setBootstrapped(true);
    cpStore1.updateChatCheckpoint("923001234567@c.us", {
      lastMessageId: "init_msg",
      lastTimestamp: 1700000000,
    });

    const msg1 = createMockMsg({
      id: "msg_crash_window_101",
      from: "923001234567@c.us",
      body: "Message in crash window",
      timestamp: 1700000010,
    });

    const chat = createMockChat({
      id: "923001234567@c.us",
      messages: [msg1],
    });

    const service1 = createMockService({ chats: [chat] });
    bridge1 = new WebhookBridge({
      service: service1,
      queue: queue1,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore1,
    });

    // 1. Live message arrives: enqueue succeeds, but we simulate crash before checkpoint save!
    const origSave = cpStore1.save.bind(cpStore1);
    let simulatedCrashTriggered = false;
    cpStore1.save = () => {
      simulatedCrashTriggered = true;
      // Simulate ungraceful crash: abort without saving checkpoint to disk
      throw new Error("Simulated SIGKILL crash before checkpoint write");
    };

    assert.throws(() => {
      bridge1.ingestMessage({
        id: "msg_crash_window_101",
        from: "923001234567@c.us",
        chatId: "923001234567@c.us",
        body: "Message in crash window",
        timestamp: 1700000010,
        fromMe: false,
        isGroup: false,
      });
    }, /Simulated SIGKILL/);

    assert.equal(simulatedCrashTriggered, true);

    // Verify disk state before restart:
    // queue.json has 1 delivery
    const queueList1 = queue1.listDeliveries();
    assert.equal(queueList1.total, 1);
    const originalDeliveryId = queueList1.deliveries[0].id;
    assert.equal(queueList1.deliveries[0].eventId, "evt_rcv_msg_crash_window_101");

    // recovery_checkpoints.json on disk does NOT have msg_crash_window_101!
    const cpDiskCheck = new CheckpointStore({ dataDir: tempDir });
    cpDiskCheck.load();
    assert.equal(cpDiskCheck.isMessageProcessed("msg_crash_window_101"), false);
    assert.equal(cpDiskCheck.getChatCheckpoint("923001234567@c.us").lastMessageId, "init_msg");

    // Shut down instance 1 to simulate complete process death
    bridge1.stop();
    await queue1.shutdown();

    // 2. Daemon restarts: fresh queue, fresh bridge, fresh recovery coordinator
    queue2 = new DeliveryQueue({ dataDir: tempDir });
    await queue2.init({ autoProcess: false });

    const cpStore2 = new CheckpointStore({ dataDir: tempDir });
    cpStore2.load();

    const service2 = createMockService({ chats: [chat] });
    bridge2 = new WebhookBridge({
      service: service2,
      queue: queue2,
      dataDir: tempDir,
      account: mockTapuAccount,
      checkpointStore: cpStore2,
    });

    const coordinator = new MessageRecoveryCoordinator({
      bridge: bridge2,
      service: service2,
      checkpointStore: cpStore2,
      dataDir: tempDir,
    });

    // Reconnection recovery runs and attempts to reconcile the "uncheckpointed" message
    const res = await coordinator.reconcile();
    assert.equal(res.status, "completed");

    // 3. Verify queue-level idempotency: exactly 1 delivery exists!
    const queueList2 = queue2.listDeliveries();
    assert.equal(queueList2.total, 1, "Queue must contain strictly 1 delivery, not duplicate");
    assert.equal(queueList2.deliveries[0].id, originalDeliveryId, "Existing delivery ID must be preserved");
    assert.equal(queueList2.deliveries[0].status, DELIVERY_STATUS.PENDING);

    // 4. Verify checkpoint is now safely advanced
    assert.equal(cpStore2.isMessageProcessed("msg_crash_window_101"), true);
    assert.equal(cpStore2.getChatCheckpoint("923001234567@c.us").lastMessageId, "msg_crash_window_101");
  } finally {
    if (bridge1) bridge1.stop();
    if (bridge2) bridge2.stop();
    if (queue1) await queue1.shutdown();
    if (queue2) await queue2.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 2: Recovery attempting to enqueue the same event again
// -------------------------------------------------------------
test("2. Recovery attempting to enqueue the same event preserves delivery ID and suppresses duplicate", async () => {
  const tempDir = createTempDir();
  let queue;
  let bridge;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep = createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    // Initial enqueue of event
    const firstDelivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "msg_202" } },
      eventId: "evt_rcv_msg_202",
    });

    assert.ok(firstDelivery.id);
    assert.equal(queue.listDeliveries().total, 1);

    // Simulate recovery attempting to re-enqueue the identical event
    const duplicateDelivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "msg_202" } },
      eventId: "evt_rcv_msg_202",
    });

    // Idempotency: same delivery ID returned, queue count strictly 1
    assert.equal(duplicateDelivery.id, firstDelivery.id);
    assert.equal(duplicateDelivery.status, firstDelivery.status);
    assert.equal(queue.listDeliveries().total, 1);
  } finally {
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 3: Duplicate media-event insertion
// -------------------------------------------------------------
test("3. Duplicate media-event insertion is suppressed while message and media events coexist", async () => {
  const tempDir = createTempDir();
  let queue;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep = createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["*"] },
      tempDir
    );

    const messageEventId = "evt_rcv_media_303";
    const mediaEventId = "evt_med_media_303";

    // 1. Enqueue message.received
    const msgDelivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "media_303", hasMedia: true } },
      eventId: messageEventId,
    });

    // 2. Enqueue media.received (distinct eventId)
    const mediaDelivery1 = queue.enqueue({
      endpointId: ep.id,
      eventType: "media.received",
      payload: { data: { messageId: "media_303", mimetype: "image/png" } },
      eventId: mediaEventId,
    });

    assert.notEqual(msgDelivery.id, mediaDelivery1.id);
    assert.equal(queue.listDeliveries().total, 2);

    // 3. Attempt duplicate media.received enqueue
    const mediaDelivery2 = queue.enqueue({
      endpointId: ep.id,
      eventType: "media.received",
      payload: { data: { messageId: "media_303", mimetype: "image/png" } },
      eventId: mediaEventId,
    });

    // Duplicate media event is suppressed, original delivery ID and status preserved
    assert.equal(mediaDelivery2.id, mediaDelivery1.id);
    assert.equal(queue.listDeliveries().total, 2);
  } finally {
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 4: Same event ID sent to different endpoints
// -------------------------------------------------------------
test("4. Same event ID is dispatched independently to different endpoints without cross-endpoint collision", async () => {
  const tempDir = createTempDir();
  let queue;

  try {
    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epAlpha = createEndpoint(
      { url: "https://alpha.example.com/webhook", events: ["message.received"] },
      tempDir
    );
    const epBeta = createEndpoint(
      { url: "https://beta.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const sharedEventId = "evt_rcv_shared_404";

    // Enqueue for endpoint Alpha
    const deliveryAlpha1 = queue.enqueue({
      endpointId: epAlpha.id,
      eventType: "message.received",
      payload: { data: { messageId: "shared_404" } },
      eventId: sharedEventId,
    });

    // Enqueue for endpoint Beta (same event ID)
    const deliveryBeta = queue.enqueue({
      endpointId: epBeta.id,
      eventType: "message.received",
      payload: { data: { messageId: "shared_404" } },
      eventId: sharedEventId,
    });

    // Both endpoints receive distinct delivery records
    assert.notEqual(deliveryAlpha1.id, deliveryBeta.id);
    assert.equal(deliveryAlpha1.endpointId, epAlpha.id);
    assert.equal(deliveryBeta.endpointId, epBeta.id);
    assert.equal(queue.listDeliveries().total, 2);

    // Duplicate enqueue for endpoint Alpha is suppressed
    const deliveryAlpha2 = queue.enqueue({
      endpointId: epAlpha.id,
      eventType: "message.received",
      payload: { data: { messageId: "shared_404" } },
      eventId: sharedEventId,
    });

    assert.equal(deliveryAlpha2.id, deliveryAlpha1.id);
    assert.equal(queue.listDeliveries().total, 2);
  } finally {
    if (queue) await queue.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 5: Existing completed, pending, and dead-letter deliveries
// -------------------------------------------------------------
test("5. Idempotency respects existing completed, pending, and dead-letter deliveries", async () => {
  const tempDir = createTempDir();
  let server;
  let queue;

  try {
    // Ephemeral mock server
    let returnStatus = 200;
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(returnStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: returnStatus === 200 }));
      });
    });

    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });

    queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep = createEndpoint(
      {
        url: `http://127.0.0.1:${port}/webhook`,
        events: ["message.received"],
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // --- Scenario A: PENDING delivery ---
    const pendingDel = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_pending" } },
      eventId: "evt_pending_01",
    });
    assert.equal(pendingDel.status, DELIVERY_STATUS.PENDING);

    const dupPending = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_pending" } },
      eventId: "evt_pending_01",
    });
    assert.equal(dupPending.id, pendingDel.id);
    assert.equal(dupPending.status, DELIVERY_STATUS.PENDING);

    // --- Scenario B: COMPLETED (SUCCEEDED) delivery in history ---
    returnStatus = 200;
    const completedDel = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_success" } },
      eventId: "evt_success_01",
    });

    // Deliver it
    const dSuccess = queue._deliveries.get(completedDel.id);
    await queue._dispatchDelivery(dSuccess);
    const successRecord = queue.getDelivery(completedDel.id);
    assert.equal(successRecord.status, DELIVERY_STATUS.SUCCEEDED);

    // Attempt duplicate enqueue of succeeded event
    const dupCompleted = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_success" } },
      eventId: "evt_success_01",
    });
    assert.equal(dupCompleted.id, completedDel.id);
    assert.equal(dupCompleted.status, DELIVERY_STATUS.SUCCEEDED);

    // --- Scenario C: DEAD_LETTER delivery in history ---
    returnStatus = 400; // Permanent client error triggers immediate dead-letter
    const deadLetterDel = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_dead" } },
      eventId: "evt_dead_01",
      maxAttempts: 1,
    });

    const dDead = queue._deliveries.get(deadLetterDel.id);
    await queue._dispatchDelivery(dDead);
    const deadRecord = queue.getDelivery(deadLetterDel.id);
    assert.equal(deadRecord.status, DELIVERY_STATUS.DEAD_LETTER);

    // Attempt duplicate enqueue of dead-lettered event
    const dupDead = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "m_dead" } },
      eventId: "evt_dead_01",
    });
    assert.equal(dupDead.id, deadLetterDel.id);
    assert.equal(dupDead.status, DELIVERY_STATUS.DEAD_LETTER);

    // Active pending deliveries must contain ONLY the initial pending delivery
    const pendingList = queue.listDeliveries({ status: DELIVERY_STATUS.PENDING });
    assert.equal(pendingList.total, 1);
    assert.equal(pendingList.deliveries[0].id, pendingDel.id);
  } finally {
    if (queue) await queue.shutdown();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 6: Restart followed by duplicate enqueue
// -------------------------------------------------------------
test("6. Idempotency survives daemon restarts by resolving persisted queue state", async () => {
  const tempDir = createTempDir();
  let queue1;
  let queue2;

  try {
    queue1 = new DeliveryQueue({ dataDir: tempDir });
    await queue1.init({ autoProcess: false });

    const ep = createEndpoint(
      { url: "https://mock.example.com/webhook", events: ["message.received"] },
      tempDir
    );

    const delivery1 = queue1.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "msg_restart_606" } },
      eventId: "evt_restart_606",
    });

    assert.ok(delivery1.id);
    assert.equal(queue1.listDeliveries().total, 1);

    // Simulate process shutdown
    await queue1.shutdown();
    queue1 = null;

    // Simulate new daemon process starting up on same data directory
    queue2 = new DeliveryQueue({ dataDir: tempDir });
    await queue2.init({ autoProcess: false });

    // Attempt duplicate enqueue in the new daemon process
    const duplicateDelivery = queue2.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { data: { messageId: "msg_restart_606" } },
      eventId: "evt_restart_606",
    });

    // Idempotency survives restart: preserves original delivery ID and total remains 1
    assert.equal(duplicateDelivery.id, delivery1.id);
    assert.equal(duplicateDelivery.status, DELIVERY_STATUS.PENDING);
    assert.equal(queue2.listDeliveries().total, 1);
  } finally {
    if (queue1) await queue1.shutdown();
    if (queue2) await queue2.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
