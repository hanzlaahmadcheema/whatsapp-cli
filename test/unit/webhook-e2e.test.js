"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { EventEmitter } = require("events");

const { DaemonServer } = require("../../src/daemon/server");
const {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  DeliveryQueue,
  DELIVERY_STATUS,
  WebhookBridge,
  verifySignature,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-e2e-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRequest(port, method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            parsed = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// -------------------------------------------------------------
// End-to-End Verification Test Suite
// -------------------------------------------------------------
test("E2E Scenario 1-6: Endpoint CRUD, subscriptions, enable/disable, test dispatch, signature verification, and delivery history", async () => {
  const tempDir = createTempDir();
  const token = "e2e_token_alpha";

  // Mock receiver server to collect dispatches
  const receivedRequests = [];
  const receiverServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      receivedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ acknowledged: true }));
    });
  });
  await new Promise((r) => receiverServer.listen(0, "127.0.0.1", r));
  const receiverPort = receiverServer.address().port;
  const receiverUrl = `http://127.0.0.1:${receiverPort}/webhook`;

  // Start DaemonServer with webhook bridge
  class MockService extends EventEmitter {
    constructor() {
      super();
      this.state = "ready";
      this._subscribers = new Set();
      this.account = { number: "15551234567", name: "E2E WhatsApp User" };
    }
    subscribe(cb) {
      this._subscribers.add(cb);
      return () => this._subscribers.delete(cb);
    }
    broadcast(evt) {
      for (const cb of this._subscribers) cb(evt);
    }
  }

  const mockService = new MockService();
  const server = new DaemonServer({
    service: mockService,
    token,
    webhookDataDir: tempDir,
  });
  const daemonPort = await server.start();
  const authHeaders = { authorization: `Bearer ${token}` };

  try {
    // 1. Create an endpoint
    const createRes = await makeRequest(
      daemonPort,
      "POST",
      "/webhooks",
      {
        url: receiverUrl,
        name: "E2E Main Endpoint",
        events: ["message.received", "webhook.test"],
        privacy: { includeContent: true, includeSenderName: true },
        security: { allowLocalhost: true, requireHttps: false },
      },
      authHeaders
    );
    assert.equal(createRes.status, 201);
    const ep = createRes.body.endpoint;
    assert.ok(ep.id.startsWith("wh_"));
    assert.ok(ep.secret.startsWith("whsec_"));
    const plaintextSecret = ep.secret;

    // 2. Configure event subscriptions and verify privacy settings
    const getRes = await makeRequest(
      daemonPort,
      "GET",
      `/webhooks/${ep.id}`,
      null,
      authHeaders
    );
    assert.equal(getRes.status, 200);
    assert.deepEqual(getRes.body.endpoint.events, ["message.received", "webhook.test"]);
    assert.equal(getRes.body.endpoint.privacy.includeContent, true);
    // Secret is masked on subsequent retrieval
    assert.ok(getRes.body.endpoint.secret.includes("****"));

    // 3. Verify endpoint enable/disable behavior
    // Disable endpoint
    const disableRes = await makeRequest(
      daemonPort,
      "PATCH",
      `/webhooks/${ep.id}`,
      { enabled: false },
      authHeaders
    );
    assert.equal(disableRes.status, 200);
    assert.equal(disableRes.body.endpoint.enabled, false);

    // Broadcast a message while disabled
    mockService.broadcast({
      event: "message",
      id: "msg_disabled_test",
      from: "923001112222@c.us",
      body: "Should not be delivered while disabled",
      fromMe: false,
    });
    // Wait briefly
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receivedRequests.length, 0, "Disabled endpoint should receive zero events");

    // Re-enable endpoint
    const enableRes = await makeRequest(
      daemonPort,
      "PATCH",
      `/webhooks/${ep.id}`,
      { enabled: true },
      authHeaders
    );
    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.body.endpoint.enabled, true);

    // 4. Dispatch a test event
    const testRes = await makeRequest(
      daemonPort,
      "POST",
      `/webhooks/${ep.id}/test`,
      null,
      authHeaders
    );
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.delivered, true);
    assert.equal(receivedRequests.length, 1);

    // 5. Verify request signatures (HMAC-SHA256, timestamp, idempotency key)
    const testReq = receivedRequests[0];
    assert.ok(testReq.headers["x-wa-signature"]);
    assert.ok(testReq.headers["x-hub-signature-256"]);
    assert.ok(testReq.headers["x-wa-timestamp"]);
    assert.ok(testReq.headers["x-wa-event-id"]);
    assert.ok(testReq.headers["idempotency-key"]);

    // Cryptographically verify HMAC-SHA256 signature using plaintext secret
    const sigVerification = verifySignature({
      secret: plaintextSecret,
      payload: testReq.body,
      signatureHeader: testReq.headers["x-wa-signature"],
      timestampHeader: testReq.headers["x-wa-timestamp"],
    });
    assert.equal(sigVerification.ok, true, "Signature verification must succeed");

    // Broadcast an actual incoming message
    mockService.broadcast({
      event: "message",
      id: "msg_live_001",
      from: "923001112222@c.us",
      chatId: "923001112222@c.us",
      senderName: "Alice Tester",
      body: "Live WhatsApp message",
      fromMe: false,
      timestamp: 1700000500,
    });

    // Wait for queue dispatch
    let waitLoops = 0;
    while (receivedRequests.length < 2 && waitLoops < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waitLoops++;
    }
    assert.equal(receivedRequests.length, 2);

    const msgReq = receivedRequests[1];
    const msgSigVerification = verifySignature({
      secret: plaintextSecret,
      payload: msgReq.body,
      signatureHeader: msgReq.headers["x-wa-signature"],
    });
    assert.equal(msgSigVerification.ok, true);
    const parsedPayload = JSON.parse(msgReq.body);
    assert.equal(parsedPayload.event, "message.received");
    assert.equal(parsedPayload.data.messageId, "msg_live_001");
    assert.equal(parsedPayload.data.body, "Live WhatsApp message");

    // 6. Verify delivery history
    const historyRes = await makeRequest(
      daemonPort,
      "GET",
      `/webhooks/deliveries?endpointId=${ep.id}`,
      null,
      authHeaders
    );
    assert.equal(historyRes.status, 200);
    assert.ok(historyRes.body.total >= 1);
    const foundDelivery = historyRes.body.deliveries.find(
      (d) => d.payload?.data?.messageId === "msg_live_001"
    );
    assert.ok(foundDelivery);
    assert.equal(foundDelivery.status, "succeeded");
    assert.equal(foundDelivery.lastStatusCode, 200);
  } finally {
    server.stop();
    receiverServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("E2E Scenario 7-10: Simulated receiver failures, retry backoff, dead-letter, manual retry, and daemon crash recovery", async () => {
  const tempDir = createTempDir();
  const token = "e2e_token_retry";

  // Mock failing receiver: returns 503
  let shouldFail = true;
  let attemptCount = 0;
  const receiverServer = http.createServer((req, res) => {
    attemptCount++;
    if (shouldFail) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Temporarily Unavailable" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recovered: true }));
    }
  });
  await new Promise((r) => receiverServer.listen(0, "127.0.0.1", r));
  const receiverPort = receiverServer.address().port;
  const receiverUrl = `http://127.0.0.1:${receiverPort}/webhook/flaky`;

  const queue = new DeliveryQueue({
    dataDir: tempDir,
    maxAttempts: 3,
    initialBackoffMs: 25,
    maxBackoffMs: 60,
    jitter: false, // deterministic fast retry for tests
  });
  await queue.init();

  const ep = createEndpoint(
    {
      url: receiverUrl,
      events: ["message.received"],
      security: { allowLocalhost: true, requireHttps: false },
    },
    tempDir
  );

  try {
    // 7. Enqueue delivery and observe retry behavior
    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { text: "Retry Test" },
    });

    // 8. Wait for attempts to exhaust (maxAttempts: 3) and transition to dead_letter
    let waitLoops = 0;
    while (waitLoops < 60) {
      const current = queue.getDelivery(delivery.id);
      if (current && current.status === DELIVERY_STATUS.DEAD_LETTER) break;
      await new Promise((r) => setTimeout(r, 20));
      waitLoops++;
    }

    const deadItem = queue.getDelivery(delivery.id);
    assert.equal(deadItem.status, DELIVERY_STATUS.DEAD_LETTER);
    assert.equal(deadItem.attempts, 3);
    assert.ok(attemptCount >= 3);

    // 9. Manual retry: Fix receiver to succeed, then manually trigger retry
    shouldFail = false;
    const retriedItem = queue.retryDelivery(delivery.id);
    assert.equal(retriedItem.status, DELIVERY_STATUS.PENDING);
    assert.equal(retriedItem.manualRetries, 1);

    // Wait for successful redelivery
    waitLoops = 0;
    while (waitLoops < 40) {
      const current = queue.getDelivery(delivery.id);
      if (current && current.status === DELIVERY_STATUS.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 20));
      waitLoops++;
    }
    const finalItem = queue.getDelivery(delivery.id);
    assert.equal(finalItem.status, DELIVERY_STATUS.SUCCEEDED);

    // 10. Persistence across daemon restart (crash recovery)
    // Manually write an item in "delivering" state to queue.json to simulate sudden process death
    const queuePath = path.join(tempDir, "queue.json");
    const onDisk = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    const crashedDeliveryId = "del_crashed_sim_01";
    onDisk[crashedDeliveryId] = {
      id: crashedDeliveryId,
      eventId: "evt_crashed_sim_01",
      endpointId: ep.id,
      url: receiverUrl,
      eventType: "message.received",
      payload: { note: "Crashed in flight" },
      status: DELIVERY_STATUS.DELIVERING,
      attempts: 1,
      maxAttempts: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextAttemptAt: Date.now(),
      history: [],
    };
    fs.writeFileSync(queuePath, JSON.stringify(onDisk, null, 2), { mode: 0o600 });

    // Initialize fresh queue instance without autoProcess to inspect recovery
    const restartQueue = new DeliveryQueue({ dataDir: tempDir });
    await restartQueue.init({ autoProcess: false });

    // Verify crash recovery moved status from delivering -> pending
    const recovered = restartQueue.getDelivery(crashedDeliveryId);
    assert.equal(recovered.status, DELIVERY_STATUS.PENDING);
    assert.ok(recovered.history.some((h) => h.recovered === true));

    await restartQueue.shutdown();
  } finally {
    await queue.shutdown();
    receiverServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("E2E Scenario 11-13: Multi-endpoint privacy isolation, duplicate suppression, and queue pruning on deletion", async () => {
  const tempDir = createTempDir();

  const receivedByEndpointA = [];
  const receivedByEndpointB = [];

  const serverA = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      receivedByEndpointA.push(JSON.parse(buf));
      res.writeHead(200);
      res.end();
    });
  });
  const serverB = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      receivedByEndpointB.push(JSON.parse(buf));
      res.writeHead(200);
      res.end();
    });
  });

  await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
  await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
  const portA = serverA.address().port;
  const portB = serverB.address().port;

  const queue = new DeliveryQueue({ dataDir: tempDir });
  await queue.init();

  // Endpoint A: Full access
  const epA = createEndpoint(
    {
      url: `http://127.0.0.1:${portA}/hookA`,
      name: "Public Hook A",
      events: ["message.received"],
      privacy: { includeContent: true, includeSenderName: true, includeMediaMetadata: true },
      security: { allowLocalhost: true, requireHttps: false },
    },
    tempDir
  );

  // Endpoint B: Redacted privacy
  const epB = createEndpoint(
    {
      url: `http://127.0.0.1:${portB}/hookB`,
      name: "Private Hook B",
      events: ["message.received"],
      privacy: { includeContent: false, includeSenderName: false, includeMediaMetadata: false },
      security: { allowLocalhost: true, requireHttps: false },
    },
    tempDir
  );

  const bridge = new WebhookBridge({ queue, dataDir: tempDir });
  bridge.start();

  try {
    // 11. Dispatch single message event to both endpoints
    const msg = {
      id: "msg_multi_001",
      from: "923001234567@c.us",
      chatId: "923001234567@c.us",
      senderName: "Alice Corporate",
      body: "Confidential financial data",
      timestamp: 1700000600,
      fromMe: false,
      hasMedia: true,
      filename: "financials.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filesize: 4096,
    };

    bridge.ingestMessage(msg);

    // Wait for both receivers
    let waitLoops = 0;
    while ((receivedByEndpointA.length < 1 || receivedByEndpointB.length < 1) && waitLoops < 50) {
      await new Promise((r) => setTimeout(r, 20));
      waitLoops++;
    }

    assert.equal(receivedByEndpointA.length, 1);
    assert.equal(receivedByEndpointB.length, 1);

    // Verify Endpoint A received full unredacted data
    const payloadA = receivedByEndpointA[0];
    assert.equal(payloadA.data.body, "Confidential financial data");
    assert.equal(payloadA.data.senderName, "Alice Corporate");
    assert.equal(payloadA.data.media.filename, "financials.xlsx");

    // Verify Endpoint B received redacted data from the exact same event
    const payloadB = receivedByEndpointB[0];
    assert.equal(payloadB.data.body, null, "Endpoint B body must be redacted");
    assert.equal(payloadB.data.senderName, null, "Endpoint B senderName must be redacted");
    assert.equal(payloadB.data.media, null, "Endpoint B media must be redacted");
    assert.equal(payloadB.data.messageId, "msg_multi_001", "MessageId must be preserved");

    // 12. Duplicate event suppression
    bridge.ingestMessage(msg); // exact duplicate message ID
    bridge.ingestMessage(msg); // exact duplicate message ID
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(receivedByEndpointA.length, 1, "Duplicate messages must be suppressed");
    assert.equal(receivedByEndpointB.length, 1, "Duplicate messages must be suppressed");

    // 13. Endpoint deletion and queue cleanup behavior
    deleteEndpoint(epA.id, tempDir);
    assert.equal(getEndpoint(epA.id, tempDir), null);

    // Prune history
    const remaining = queue.pruneHistory({ maxEntries: 0 }); // prune all history
    assert.equal(remaining, 0);
  } finally {
    bridge.stop();
    await queue.shutdown();
    serverA.close();
    serverB.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
