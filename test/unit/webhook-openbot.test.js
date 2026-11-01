"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  SIGNING_PROFILES,
  OPENBOT_HEADERS,
  OPENBOT_MAX_BODY_BYTES,
  DELIVERY_STATUS,
} = require("../../src/webhook/constants");
const {
  signOpenBotPayload,
  verifyOpenBotSignature,
  validateDeliveryId,
} = require("../../src/webhook/security");
const {
  formatPayloadForProfile,
  checkProfileBodyConstraints,
  buildProfileHeaders,
  classifyProfileResponse,
} = require("../../src/webhook/profiles");
const {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  setEndpointSecret,
} = require("../../src/webhook/store");
const { dispatchWebhookRequest } = require("../../src/webhook/http");
const { DeliveryQueue } = require("../../src/webhook/queue");
const { WebhookBridge } = require("../../src/webhook/ingestion");

test("OpenBot Protocol: Exact HMAC-SHA256 signature generation and verification", async () => {
  const secret = "openbot_sec_0123456789abcdef0123456789abcdef";
  const timestamp = 1761990000;
  const deliveryId = "del_0123456789abcdef01234567";
  const rawBody = JSON.stringify({
    type: "message.received",
    occurredAt: "2025-11-01T10:30:00.000Z",
    data: { messageId: "msg_123", body: "Hello OpenBot" },
  });

  const signed = signOpenBotPayload(secret, rawBody, timestamp, deliveryId);

  assert.equal(typeof signed.signature, "string");
  assert.equal(signed.signature.length, 64);
  assert.equal(signed.headerValue, `sha256=${signed.signature}`);

  // Valid verification
  const valid = verifyOpenBotSignature({
    secret,
    rawBody,
    timestampHeader: String(timestamp),
    deliveryIdHeader: deliveryId,
    signatureHeader: signed.headerValue,
    toleranceSeconds: 300,
    nowSeconds: timestamp + 60, // 1 minute later
  });
  assert.equal(valid.ok, true);

  // Reject tampered body
  const tamperedBody = JSON.stringify({
    type: "message.received",
    occurredAt: "2025-11-01T10:30:00.000Z",
    data: { messageId: "msg_123", body: "Tampered body" },
  });
  const invalidBody = verifyOpenBotSignature({
    secret,
    rawBody: tamperedBody,
    timestampHeader: String(timestamp),
    deliveryIdHeader: deliveryId,
    signatureHeader: signed.headerValue,
    toleranceSeconds: 300,
    nowSeconds: timestamp,
  });
  assert.equal(invalidBody.ok, false);
  assert.equal(invalidBody.reason, "Signature mismatch");

  // Reject timestamp outside tolerance window (> 5 minutes)
  const expired = verifyOpenBotSignature({
    secret,
    rawBody,
    timestampHeader: String(timestamp),
    deliveryIdHeader: deliveryId,
    signatureHeader: signed.headerValue,
    toleranceSeconds: 300,
    nowSeconds: timestamp + 301, // 301s later
  });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /outside tolerance window/);

  // Reject tampered deliveryId
  const wrongDelId = verifyOpenBotSignature({
    secret,
    rawBody,
    timestampHeader: String(timestamp),
    deliveryIdHeader: "del_wrong_id",
    signatureHeader: signed.headerValue,
    toleranceSeconds: 300,
    nowSeconds: timestamp,
  });
  assert.equal(wrongDelId.ok, false);

  // Reject wrong secret
  const wrongSecret = verifyOpenBotSignature({
    secret: "wrong_secret_key",
    rawBody,
    timestampHeader: String(timestamp),
    deliveryIdHeader: deliveryId,
    signatureHeader: signed.headerValue,
    toleranceSeconds: 300,
    nowSeconds: timestamp,
  });
  assert.equal(wrongSecret.ok, false);
});

test("OpenBot Protocol: Payload envelope formatting preserves full metadata", () => {
  const canonical = {
    id: "evt_rcv_msg_999",
    event: "message.received",
    timestamp: 1761990000,
    account: {
      number: "923266900001",
      name: "Corporate WA",
      jid: "923266900001@s.whatsapp.net",
    },
    data: {
      messageId: "msg_999",
      chatId: "12345@s.whatsapp.net",
      chatName: "Bob",
      senderName: "Bob",
      body: "Testing OpenBot envelope",
      timestamp: 1761990000,
    },
  };

  const openbotEnvelope = formatPayloadForProfile("openbot", canonical);

  assert.equal(openbotEnvelope.type, "message.received");
  assert.equal(openbotEnvelope.occurredAt, new Date(canonical.timestamp * 1000).toISOString());
  assert.equal(openbotEnvelope.data.body, "Testing OpenBot envelope");
  assert.equal(openbotEnvelope.data.messageId, "msg_999");
  assert.equal(openbotEnvelope.data.eventId, "evt_rcv_msg_999");
  assert.equal(openbotEnvelope.data.account.number, "923266900001");

  // Generic profile is unchanged
  const genericEnvelope = formatPayloadForProfile("generic", canonical);
  assert.deepEqual(genericEnvelope, canonical);
});

test("OpenBot Protocol: 64 KiB maximum request body constraint", () => {
  // Body <= 64 KiB passes
  const okBody = "a".repeat(1024);
  assert.equal(checkProfileBodyConstraints("openbot", okBody).ok, true);

  // Exact 64 KiB (65536 bytes) passes
  const limitBody = "b".repeat(65536);
  assert.equal(checkProfileBodyConstraints("openbot", limitBody).ok, true);

  // Body > 64 KiB (65537 bytes) is rejected
  const oversizedBody = "c".repeat(65537);
  const check = checkProfileBodyConstraints("openbot", oversizedBody);
  assert.equal(check.ok, false);
  assert.match(check.error, /exceeds OpenBot limit of 65536 bytes/);

  // Generic profile has no 64 KiB limit
  assert.equal(checkProfileBodyConstraints("generic", oversizedBody).ok, true);
});

test("OpenBot Protocol: Response code classification (200/202, 429/503, 400/401/404/413/415)", () => {
  // 200 and 202: accepted; do not retry
  assert.deepEqual(classifyProfileResponse("openbot", 200, null), {
    isSuccess: true,
    retryable: false,
  });
  assert.deepEqual(classifyProfileResponse("openbot", 202, null), {
    isSuccess: true,
    retryable: false,
  });

  // 429 and 503: retry later
  assert.deepEqual(classifyProfileResponse("openbot", 429, null), {
    isSuccess: false,
    retryable: true,
  });
  assert.deepEqual(classifyProfileResponse("openbot", 503, null), {
    isSuccess: false,
    retryable: true,
  });

  // 400, 401, 404, 413, 415: permanent errors requiring correction (do not retry)
  const permanentCodes = [400, 401, 404, 413, 415];
  for (const code of permanentCodes) {
    const res = classifyProfileResponse("openbot", code, null);
    assert.equal(res.isSuccess, false);
    assert.equal(res.retryable, false, `Status ${code} must be non-retryable`);
  }

  // Other 5xx (e.g. 500, 502, 504): retryable
  assert.equal(classifyProfileResponse("openbot", 500, null).retryable, true);
  assert.equal(classifyProfileResponse("openbot", 502, null).retryable, true);
  assert.equal(classifyProfileResponse("openbot", 504, null).retryable, true);

  // Network drops: retryable
  const networkErr = new Error("ECONNRESET");
  networkErr.code = "ECONNRESET";
  assert.equal(classifyProfileResponse("openbot", null, networkErr).retryable, true);
});

test("OpenBot Protocol: Outbound HTTP dispatch, raw-body signing, and receiver verification", async () => {
  const secret = "openbot_secret_xyz_987654321";
  let receivedHeaders = null;
  let receivedRawBody = null;

  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedRawBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const deliveryId = "del_openbot_test_123456789";
    const canonicalPayload = {
      id: "evt_openbot_001",
      event: "message.received",
      timestamp: 1761990000,
      account: { number: "923266900001" },
      data: { messageId: "msg_test_001", body: "Hello OpenBot receiver" },
    };

    const attempt = await dispatchWebhookRequest({
      url: `http://127.0.0.1:${port}/webhook`,
      payload: canonicalPayload,
      secret,
      eventId: "evt_openbot_001",
      deliveryId,
      profile: "openbot",
      options: {
        security: { allowLocalhost: true },
      },
    });

    assert.equal(attempt.success, true);
    assert.equal(attempt.statusCode, 202);

    // Verify OpenBot headers
    assert.equal(receivedHeaders["content-type"], "application/json; charset=utf-8");
    assert.equal(receivedHeaders[OPENBOT_HEADERS.DELIVERY_ID], deliveryId);
    assert.ok(receivedHeaders[OPENBOT_HEADERS.TIMESTAMP]);
    assert.ok(receivedHeaders[OPENBOT_HEADERS.SIGNATURE].startsWith("sha256="));

    // Verify OpenBot payload envelope
    const parsedBody = JSON.parse(receivedRawBody);
    assert.equal(parsedBody.type, "message.received");
    assert.equal(parsedBody.data.messageId, "msg_test_001");
    assert.equal(parsedBody.data.eventId, "evt_openbot_001");

    // Verify cryptographic signature matches the received raw body
    const verification = verifyOpenBotSignature({
      secret,
      rawBody: receivedRawBody,
      timestampHeader: receivedHeaders[OPENBOT_HEADERS.TIMESTAMP],
      deliveryIdHeader: receivedHeaders[OPENBOT_HEADERS.DELIVERY_ID],
      signatureHeader: receivedHeaders[OPENBOT_HEADERS.SIGNATURE],
      toleranceSeconds: 300,
    });
    assert.equal(verification.ok, true);
  } finally {
    server.close();
  }
});

test("OpenBot Protocol: Stable retries reuse exact serialized rawBody & deliveryId with fresh timestamp/signature", async () => {
  const secret = "openbot_secret_retry_test";
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString("utf8"),
      });

      if (requests.length === 1) {
        // First attempt fails with 503 Service Unavailable (retryable)
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service Unavailable" }));
      } else {
        // Second attempt succeeds with 200 OK
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-retry-test-"));
  const queue = new DeliveryQueue({
    dataDir: tempDir,
    maxAttempts: 3,
    initialBackoffMs: 50,
    maxBackoffMs: 100,
    timeoutMs: 1000,
  });

  try {
    const ep = createEndpoint(
      {
        url: `http://127.0.0.1:${port}/webhook`,
        name: "OpenBot Retry Receiver",
        profile: "openbot",
        secret,
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // Enqueue an event
    const canonicalPayload = {
      id: "evt_stable_retry_001",
      event: "message.received",
      timestamp: 1761990000,
      data: { messageId: "msg_stable_001", body: "Stable retry body" },
    };

    queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: canonicalPayload,
      eventId: "evt_stable_retry_001",
    });

    // Wait for both attempts (attempt 1 -> 503, backoff -> attempt 2 -> 200)
    let loops = 0;
    while (requests.length < 2 && loops < 50) {
      await new Promise((r) => setTimeout(r, 40));
      loops++;
    }

    assert.equal(requests.length, 2, "Expected 2 delivery attempts");

    const req1 = requests[0];
    const req2 = requests[1];

    // 1. Exact raw body is 100% identical and reused across retries
    assert.equal(req1.rawBody, req2.rawBody, "Exact serialized body must be reused across retries");

    // 2. Delivery ID is stable across retries
    const delId1 = req1.headers[OPENBOT_HEADERS.DELIVERY_ID];
    const delId2 = req2.headers[OPENBOT_HEADERS.DELIVERY_ID];
    assert.ok(delId1);
    assert.equal(delId1, delId2, "Delivery ID must be identical across retries");

    // 3. Both attempts have valid signatures according to their respective timestamps
    const v1 = verifyOpenBotSignature({
      secret,
      rawBody: req1.rawBody,
      timestampHeader: req1.headers[OPENBOT_HEADERS.TIMESTAMP],
      deliveryIdHeader: delId1,
      signatureHeader: req1.headers[OPENBOT_HEADERS.SIGNATURE],
    });
    assert.equal(v1.ok, true);

    const v2 = verifyOpenBotSignature({
      secret,
      rawBody: req2.rawBody,
      timestampHeader: req2.headers[OPENBOT_HEADERS.TIMESTAMP],
      deliveryIdHeader: delId2,
      signatureHeader: req2.headers[OPENBOT_HEADERS.SIGNATURE],
    });
    assert.equal(v2.ok, true);
  } finally {
    await queue.shutdown();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenBot Protocol: Permanent error (400, 401, 404, 413, 415) transitions to DEAD_LETTER immediately", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    callCount++;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Request" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-permanent-err-"));
  const queue = new DeliveryQueue({
    dataDir: tempDir,
    maxAttempts: 5,
    initialBackoffMs: 20,
  });

  try {
    const ep = createEndpoint(
      {
        url: `http://127.0.0.1:${port}/webhook`,
        profile: "openbot",
        security: { allowLocalhost: true },
      },
      tempDir
    );

    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { event: "message.received", data: { text: "Permanent err test" } },
    });

    let loops = 0;
    while (callCount === 0 && loops < 25) {
      await new Promise((r) => setTimeout(r, 20));
      loops++;
    }

    // Wait a brief moment to ensure no retry happens
    await new Promise((r) => setTimeout(r, 60));

    // Call count must remain 1 (no retries for 400)
    assert.equal(callCount, 1);

    const record = queue.getDelivery(delivery.id);
    assert.equal(record.status, DELIVERY_STATUS.DEAD_LETTER);
    assert.equal(record.attempts, 1);
  } finally {
    await queue.shutdown();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenBot Protocol: Oversized payload (> 64 KiB) dead-letters pre-flight without socket creation", async () => {
  let serverHit = false;
  const server = http.createServer((req, res) => {
    serverHit = true;
    res.writeHead(200);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-oversize-"));
  const queue = new DeliveryQueue({
    dataDir: tempDir,
    maxAttempts: 3,
  });

  try {
    const ep = createEndpoint(
      {
        url: `http://127.0.0.1:${port}/webhook`,
        profile: "openbot",
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // Payload body exceeding 64 KiB
    const largeData = {
      messageId: "msg_large",
      body: "X".repeat(70000), // > 65536 bytes
    };

    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { event: "message.received", data: largeData },
    });

    await new Promise((r) => setTimeout(r, 100));

    assert.equal(serverHit, false, "Server must not be contacted when payload exceeds 64 KiB");
    const record = queue.getDelivery(delivery.id);
    assert.equal(record.status, DELIVERY_STATUS.DEAD_LETTER);
    assert.match(record.lastError, /exceeds OpenBot limit/);
  } finally {
    await queue.shutdown();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenBot Protocol: Endpoint preservation, secret import, and duplicate prevention", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-preserve-"));

  try {
    const existingSecret = "existing_openbot_secret_12345";
    const targetUrl = "https://signal.openbot.run/api/v1/webhook";

    // 1. Initial registration
    const ep1 = createEndpoint(
      {
        url: targetUrl,
        name: "Initial OpenBot Endpoint",
        profile: "generic",
      },
      tempDir
    );
    assert.ok(ep1.id);
    assert.equal(ep1.url, targetUrl);

    // 2. Safeguard #1: Configuring the endpoint at signal.openbot.run does not create a duplicate
    const ep2 = createEndpoint(
      {
        url: targetUrl,
        profile: "openbot",
        secret: existingSecret,
      },
      tempDir
    );

    assert.equal(ep2.id, ep1.id, "Existing endpoint ID must be preserved; no duplicate created");
    assert.equal(ep2.profile, "openbot");

    // Verify store has only 1 endpoint
    const all = listEndpoints(tempDir);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, ep1.id);
    assert.equal(all[0].profile, "openbot");
    assert.equal(all[0].secret.startsWith("whsec_"), false, "Must not replace with random whsec_");
    assert.match(all[0].secret, /\*+2345$/); // Masked secret check (last 4 characters)

    // 3. Test setEndpointSecret explicitly
    const newCustomSecret = "my_new_custom_secret_abcde";
    setEndpointSecret(ep1.id, newCustomSecret, tempDir);

    const fetched = getEndpoint(ep1.id, tempDir, { exposeSecret: true });
    assert.equal(fetched.secret, newCustomSecret);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenBot Protocol & Generic Webhook: Multi-endpoint coexistence with distinct profiles", async () => {
  const receivedByGeneric = [];
  const receivedByOpenBot = [];

  const genericServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedByGeneric.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const openbotServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedByOpenBot.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => genericServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => openbotServer.listen(0, "127.0.0.1", resolve));
  const genericPort = genericServer.address().port;
  const openbotPort = openbotServer.address().port;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-profile-test-"));
  const queue = new DeliveryQueue({ dataDir: tempDir });
  const bridge = new WebhookBridge({ queue, dataDir: tempDir });

  try {
    // Endpoint A: Generic Profile
    createEndpoint(
      {
        url: `http://127.0.0.1:${genericPort}/webhook`,
        name: "Generic Endpoint",
        profile: "generic",
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // Endpoint B: OpenBot Profile
    createEndpoint(
      {
        url: `http://127.0.0.1:${openbotPort}/webhook`,
        name: "OpenBot Endpoint",
        profile: "openbot",
        security: { allowLocalhost: true },
      },
      tempDir
    );

    // Ingest a message
    bridge.ingestMessage({
      id: "msg_coexist_001",
      chatId: "12345@s.whatsapp.net",
      chatName: "Test Group",
      senderName: "Alice",
      body: "Coexistence test message",
      timestamp: 1761990000,
    });

    let loops = 0;
    while ((receivedByGeneric.length < 1 || receivedByOpenBot.length < 1) && loops < 50) {
      await new Promise((r) => setTimeout(r, 20));
      loops++;
    }

    assert.equal(receivedByGeneric.length, 1);
    assert.equal(receivedByOpenBot.length, 1);

    // Verify Generic receiver got Generic headers and canonical envelope
    const gen = receivedByGeneric[0];
    assert.ok(gen.headers["x-hub-signature-256"], "Generic must include x-hub-signature-256");
    assert.ok(gen.headers["x-wa-signature"], "Generic must include x-wa-signature");
    assert.equal(gen.body.event, "message.received");
    assert.equal(gen.body.data.body, "Coexistence test message");

    // Verify OpenBot receiver got OpenBot headers and OpenBot envelope
    const ob = receivedByOpenBot[0];
    assert.ok(ob.headers[OPENBOT_HEADERS.SIGNATURE], "OpenBot must include x-openbot-signature");
    assert.ok(ob.headers[OPENBOT_HEADERS.DELIVERY_ID], "OpenBot must include x-openbot-delivery-id");
    assert.ok(ob.headers[OPENBOT_HEADERS.TIMESTAMP], "OpenBot must include x-openbot-timestamp");
    assert.equal(ob.body.type, "message.received");
    assert.equal(ob.body.data.body, "Coexistence test message");
    assert.equal(ob.body.data.eventId, gen.body.id, "Both must reference the exact same event");
  } finally {
    bridge.stop();
    await queue.shutdown();
    genericServer.close();
    openbotServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
