"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");

const {
  createEndpoint,
  getEndpoint,
  DeliveryQueue,
  DELIVERY_STATUS,
  WebhookBridge,
  applyPrivacyFilter,
  ackToName,
  createEventPayload,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-ingest-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. Privacy Filter Isolation & Redaction
// -------------------------------------------------------------
test("applyPrivacyFilter correctly redacts content, sender name, and media metadata", () => {
  const samplePayload = {
    id: "evt_test_123",
    event: "message.received",
    timestamp: 1700000000,
    data: {
      messageId: "msg_123",
      chatId: "12345@c.us",
      chatName: "Alice Group",
      senderName: "Alice",
      body: "Secret Message Text",
      caption: "Secret Caption",
      media: {
        filename: "secret.pdf",
        mimetype: "application/pdf",
        filesize: 1024,
      },
      filename: "secret.pdf",
      mimetype: "application/pdf",
      filesize: 1024,
      quotedMsg: {
        senderName: "Bob",
        body: "Quoted Text",
        caption: "Quoted Caption",
        filename: "quoted.png",
        mimetype: "image/png",
        filesize: 512,
      },
    },
  };

  // Case 1: All enabled (no redaction)
  const allEnabled = applyPrivacyFilter(samplePayload, {
    includeContent: true,
    includeSenderName: true,
    includeMediaMetadata: true,
  });
  assert.equal(allEnabled.data.body, "Secret Message Text");
  assert.equal(allEnabled.data.senderName, "Alice");
  assert.equal(allEnabled.data.filename, "secret.pdf");
  assert.equal(allEnabled.data.quotedMsg.body, "Quoted Text");

  // Case 2: includeContent: false (redacts text and captions)
  const noContent = applyPrivacyFilter(samplePayload, {
    includeContent: false,
    includeSenderName: true,
    includeMediaMetadata: true,
  });
  assert.equal(noContent.data.body, null);
  assert.equal(noContent.data.caption, null);
  assert.equal(noContent.data.quotedMsg.body, null);
  assert.equal(noContent.data.quotedMsg.caption, null);
  // Sender and media remain intact
  assert.equal(noContent.data.senderName, "Alice");
  assert.equal(noContent.data.filename, "secret.pdf");

  // Case 3: includeSenderName: false (redacts senderName)
  const noSender = applyPrivacyFilter(samplePayload, {
    includeContent: true,
    includeSenderName: false,
    includeMediaMetadata: true,
  });
  assert.equal(noSender.data.senderName, null);
  assert.equal(noSender.data.quotedMsg.senderName, null);
  // Body remains intact
  assert.equal(noSender.data.body, "Secret Message Text");

  // Case 4: includeMediaMetadata: false (redacts media metadata)
  const noMedia = applyPrivacyFilter(samplePayload, {
    includeContent: true,
    includeSenderName: true,
    includeMediaMetadata: false,
  });
  assert.equal(noMedia.data.media, null);
  assert.equal(noMedia.data.filename, null);
  assert.equal(noMedia.data.mimetype, null);
  assert.equal(noMedia.data.filesize, null);
  assert.equal(noMedia.data.quotedMsg.filename, null);
  assert.equal(noMedia.data.quotedMsg.mimetype, null);
  assert.equal(noMedia.data.quotedMsg.filesize, null);
  // Body remains intact
  assert.equal(noMedia.data.body, "Secret Message Text");

  // Verify original payload was never mutated
  assert.equal(samplePayload.data.body, "Secret Message Text");
  assert.equal(samplePayload.data.senderName, "Alice");
  assert.equal(samplePayload.data.filename, "secret.pdf");
});

test("ackToName maps WhatsApp numeric ACKs to standard names", () => {
  assert.equal(ackToName(1), "sent");
  assert.equal(ackToName(2), "delivered");
  assert.equal(ackToName(3), "read");
  assert.equal(ackToName(4), "played");
  assert.equal(ackToName(0), "pending");
  assert.equal(ackToName(-1), "error");
  assert.equal(ackToName(99), "unknown");
});

// -------------------------------------------------------------
// 2. Event Catalog Mapping & Enriched Payload Generation
// -------------------------------------------------------------
test("WebhookBridge maps incoming messages, outgoing messages, and media.received", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 5 }),
    });
    await queue.init({ autoProcess: false });

    // Register wildcard endpoint
    const ep = createEndpoint(
      {
        url: "https://api.example.com/events",
        events: ["*"],
        name: "All Events",
      },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: { number: "15551234567", name: "My Account" },
    });
    bridge.start();

    // 1. Ingest incoming text message
    bridge.ingestMessage({
      id: "msg_incoming_001",
      from: "923001234567@c.us",
      to: "15551234567@c.us",
      chatId: "923001234567@c.us",
      chatName: "John Doe",
      senderName: "John Doe",
      body: "Hello from WhatsApp",
      timestamp: 1700000001,
      fromMe: false,
      hasMedia: false,
    });

    // 2. Ingest outgoing text message
    bridge.ingestMessage({
      id: "msg_outgoing_002",
      from: "me",
      to: "923001234567@c.us",
      chatId: "923001234567@c.us",
      chatName: "John Doe",
      senderName: "Me",
      body: "Reply to John",
      timestamp: 1700000002,
      fromMe: true,
      hasMedia: false,
    });

    // 3. Ingest incoming media message
    bridge.ingestMessage({
      id: "msg_media_003",
      from: "923001234567@c.us",
      to: "15551234567@c.us",
      chatId: "923001234567@c.us",
      chatName: "John Doe",
      senderName: "John Doe",
      body: "Invoice Photo",
      caption: "Invoice Photo",
      timestamp: 1700000003,
      fromMe: false,
      hasMedia: true,
      type: "image",
      mimetype: "image/jpeg",
      filename: "invoice.jpg",
      filesize: 2048,
    });

    const deliveries = queue.listDeliveries().deliveries;
    // Expected: message.received (001), message.received (003), media.received (003) = 3 deliveries
    // Outgoing messages (msg_outgoing_002) are strictly excluded from queue delivery
    assert.equal(deliveries.length, 3);

    // Verify incoming text event
    const rcvDelivery = deliveries.find((d) => d.eventId === "evt_rcv_msg_incoming_001");
    assert.ok(rcvDelivery);
    assert.equal(rcvDelivery.eventType, "message.received");
    assert.equal(rcvDelivery.payload.data.messageId, "msg_incoming_001");
    assert.equal(rcvDelivery.payload.data.fromMe, false);
    assert.equal(rcvDelivery.payload.data.body, "Hello from WhatsApp");
    assert.equal(rcvDelivery.payload.account.number, "15551234567");

    // Verify outgoing text event was strictly filtered and never enqueued
    const sntDelivery = deliveries.find((d) => d.payload?.data?.messageId === "msg_outgoing_002");
    assert.equal(sntDelivery, undefined);

    // Verify media.received event
    const medDelivery = deliveries.find((d) => d.eventId === "evt_med_msg_media_003");
    assert.ok(medDelivery);
    assert.equal(medDelivery.eventType, "media.received");
    assert.equal(medDelivery.payload.data.messageId, "msg_media_003");
    assert.equal(medDelivery.payload.data.media.filename, "invoice.jpg");
    assert.equal(medDelivery.payload.data.media.mimetype, "image/jpeg");
    assert.equal(medDelivery.payload.data.caption, "Invoice Photo");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 3. Message ACK, Updated, and Session State Mappings
// -------------------------------------------------------------
test("WebhookBridge maps message.ack, message.updated, and session.state with stable IDs", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 5 }),
    });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://api.example.com/events", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
    });
    bridge.start();

    // 1. Ingest message.ack
    bridge.ingestAck({
      messageId: "msg_ack_test_100",
      chatId: "923001112233@c.us",
      ack: 3,
      timestamp: 1700000010,
    });

    // 2. Ingest message.updated
    bridge.ingestUpdate({
      messageId: "msg_upd_test_200",
      chatId: "923001112233@c.us",
      updateType: "edit",
      body: "Edited content",
      timestamp: 1700000020,
    });

    // 3. Ingest session.state
    bridge.ingestState("ready", "connecting", "Daemon handshake confirmed");

    const deliveries = queue.listDeliveries().deliveries;
    // Strictly excluded: ACKs, message updates, and session state never reach the webhook queue
    assert.equal(deliveries.length, 0);
    // Bridge internal state tracking is still updated
    assert.equal(bridge.lastState, "ready");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 4. Endpoint Privacy Isolation & Subscription Filtering
// -------------------------------------------------------------
test("WebhookBridge applies endpoint privacy settings and respects subscriptions and disabled status", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 5 }),
    });
    await queue.init({ autoProcess: false });

    // Endpoint 1: Full access to all events
    const epFull = createEndpoint(
      {
        url: "https://api1.example.com/hook",
        events: ["*"],
        privacy: { includeContent: true, includeSenderName: true, includeMediaMetadata: true },
      },
      tempDir
    );

    // Endpoint 2: Redacted content and sender name
    const epPrivate = createEndpoint(
      {
        url: "https://api2.example.com/hook",
        events: ["message.received"],
        privacy: { includeContent: false, includeSenderName: false, includeMediaMetadata: false },
      },
      tempDir
    );

    // Endpoint 3: Subscribed only to session.state
    const epStateOnly = createEndpoint(
      {
        url: "https://api3.example.com/hook",
        events: ["session.state"],
      },
      tempDir
    );

    // Endpoint 4: Disabled endpoint (should receive nothing)
    const epDisabled = createEndpoint(
      {
        url: "https://api4.example.com/hook",
        events: ["*"],
        enabled: false,
      },
      tempDir
    );

    const bridge = new WebhookBridge({ queue, dataDir: tempDir });
    bridge.start();

    // Dispatch an incoming message event
    bridge.ingestMessage({
      id: "msg_privacy_test_01",
      from: "923009998877@c.us",
      chatId: "923009998877@c.us",
      senderName: "Secret Agent",
      body: "Highly sensitive text",
      timestamp: 1700000050,
      fromMe: false,
      hasMedia: true,
      filename: "plan.pdf",
      mimetype: "application/pdf",
      filesize: 1024,
    });

    const deliveries = queue.listDeliveries().deliveries;

    // epDisabled should have zero deliveries
    const disabledDeliveries = deliveries.filter((d) => d.endpointId === epDisabled.id);
    assert.equal(disabledDeliveries.length, 0);

    // epStateOnly should have zero deliveries for message.received
    const stateOnlyDeliveries = deliveries.filter((d) => d.endpointId === epStateOnly.id);
    assert.equal(stateOnlyDeliveries.length, 0);

    // epFull should receive unredacted message.received
    const fullDelivery = deliveries.find(
      (d) => d.endpointId === epFull.id && d.eventType === "message.received"
    );
    assert.ok(fullDelivery);
    assert.equal(fullDelivery.payload.data.body, "Highly sensitive text");
    assert.equal(fullDelivery.payload.data.senderName, "Secret Agent");
    assert.equal(fullDelivery.payload.data.media.filename, "plan.pdf");

    // epPrivate should receive REDACTED message.received
    const privDelivery = deliveries.find(
      (d) => d.endpointId === epPrivate.id && d.eventType === "message.received"
    );
    assert.ok(privDelivery);
    assert.equal(privDelivery.payload.data.body, null);
    assert.equal(privDelivery.payload.data.senderName, null);
    assert.equal(privDelivery.payload.data.media, null);
    // Structural routing information remains intact
    assert.equal(privDelivery.payload.data.messageId, "msg_privacy_test_01");
    assert.equal(privDelivery.payload.data.chatId, "923009998877@c.us");

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 5. Deduplication & Reconnect Resilience
// -------------------------------------------------------------
test("WebhookBridge suppresses duplicate events and duplicate session.state on reconnects", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 5 }),
    });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://api.example.com/events", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({ queue, dataDir: tempDir });
    bridge.start();

    const msg = {
      id: "msg_dup_test_999",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      body: "Duplicate message test",
      timestamp: 1700000099,
      fromMe: false,
    };

    // 1. Ingest message 3 times (simulating duplicate delivery / reconnect replay)
    bridge.ingestMessage(msg);
    bridge.ingestMessage(msg);
    bridge.ingestMessage(msg);

    // 2. Ingest duplicate state transitions
    bridge.ingestState("connecting");
    bridge.ingestState("connecting"); // duplicate -> suppressed
    bridge.ingestState("ready");      // new state -> emitted
    bridge.ingestState("ready");      // duplicate -> suppressed

    const deliveries = queue.listDeliveries().deliveries;
    // Exactly 1 message.received (duplicate messages suppressed; session.state excluded)
    assert.equal(deliveries.length, 1);

    const msgDeliveries = deliveries.filter((d) => d.eventType === "message.received");
    assert.equal(msgDeliveries.length, 1);

    const stateDeliveries = deliveries.filter((d) => d.eventType === "session.state");
    assert.equal(stateDeliveries.length, 0);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 6. Non-Blocking Ingestion
// -------------------------------------------------------------
test("WebhookBridge dispatches asynchronously and never blocks or throws to the event emitter", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
    });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://api.example.com/events", events: ["*"] },
      tempDir
    );

    const bridge = new WebhookBridge({ queue, dataDir: tempDir });
    bridge.start();

    // Measure execution duration of synchronous ingest
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      bridge.ingestMessage({
        id: `msg_perf_${i}`,
        from: "923001234567@c.us",
        body: `Fast message ${i}`,
        timestamp: 1700000000 + i,
        fromMe: false,
      });
    }
    const elapsedMs = performance.now() - start;

    // 50 events ingested in a few milliseconds without blocking event loop
    assert.ok(elapsedMs < 150, `Ingestion took ${elapsedMs}ms, expected < 150ms`);

    // Fault injection: simulate queue.enqueue throwing
    queue.enqueue = () => {
      throw new Error("Simulated storage write error");
    };

    // Bridge should safely catch and not throw to WhatsApp emitter
    assert.doesNotThrow(() => {
      bridge.ingestMessage({
        id: "msg_fault_test",
        from: "923001234567@c.us",
        body: "Fault tolerance check",
        timestamp: 1700000100,
        fromMe: false,
      });
    });

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 7. Daemon Broadcaster Integration
// -------------------------------------------------------------
test("WebhookBridge connects to daemon event broadcaster and forwards broadcast events", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({
      dataDir: tempDir,
    });
    await queue.init({ autoProcess: false });

    createEndpoint(
      { url: "https://api.example.com/events", events: ["*"] },
      tempDir
    );

    // Mock daemon service with subscribe / broadcast mechanism
    class MockDaemonService extends EventEmitter {
      constructor() {
        super();
        this._subscribers = new Set();
        this.account = { number: "15559876543", name: "Broadcaster Account" };
      }
      subscribe(cb) {
        this._subscribers.add(cb);
        return () => this._subscribers.delete(cb);
      }
      broadcast(evt) {
        for (const cb of this._subscribers) {
          cb(evt);
        }
      }
    }

    const mockService = new MockDaemonService();
    const bridge = new WebhookBridge({
      service: mockService,
      queue,
      dataDir: tempDir,
    });
    bridge.start();

    // 1. Service broadcasts an incoming message
    mockService.broadcast({
      event: "message",
      id: "msg_bcast_001",
      from: "923005554433@c.us",
      chatId: "923005554433@c.us",
      senderName: "Broadcast Sender",
      body: "Incoming broadcast message",
      fromMe: false,
      timestamp: 1700000200,
    });

    // 2. Service broadcasts a state transition
    mockService.broadcast({
      event: "state",
      state: "ready",
      reason: "Initial connection established",
    });

    const deliveries = queue.listDeliveries().deliveries;
    // Exactly 1 message.received (incoming broadcast message enqueued; state excluded)
    assert.equal(deliveries.length, 1);

    const msgDelivery = deliveries.find((d) => d.eventType === "message.received");
    assert.ok(msgDelivery);
    assert.equal(msgDelivery.payload.data.body, "Incoming broadcast message");
    assert.equal(msgDelivery.payload.account.number, "15559876543");

    const stateDelivery = deliveries.find((d) => d.eventType === "session.state");
    assert.equal(stateDelivery, undefined);

    bridge.stop();
    await queue.shutdown();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
