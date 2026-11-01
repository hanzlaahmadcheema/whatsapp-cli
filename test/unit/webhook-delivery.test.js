"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const {
  createEndpoint,
  verifySignature,
  dispatchWebhookRequest,
  DeliveryQueue,
  DELIVERY_STATUS,
  calculateBackoff,
  isRetryableHttpStatus,
  isRetryableError,
  sanitizeDelivery,
  DEFAULT_SECURITY_CONFIG,
} = require("../../src/webhook");

// Helper to create a temporary isolated directory for tests
function createTempDir(prefix = "wa-webhook-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -------------------------------------------------------------
// 1. Backoff, Jitter, and Retry Classification
// -------------------------------------------------------------
test("calculateBackoff computes exponential delay and respects bounds and jitter", () => {
  // Deterministic backoff without jitter
  const opts = {
    initialBackoffMs: 1000,
    maxBackoffMs: 8000,
    backoffFactor: 2,
    jitter: false,
  };

  assert.equal(calculateBackoff(1, opts), 1000);
  assert.equal(calculateBackoff(2, opts), 2000);
  assert.equal(calculateBackoff(3, opts), 4000);
  assert.equal(calculateBackoff(4, opts), 8000);
  assert.equal(calculateBackoff(5, opts), 8000); // capped at maxBackoffMs

  // With jitter enabled: within bounds [50, calculated]
  const jittered = calculateBackoff(3, { ...opts, jitter: true });
  assert.ok(jittered >= 50 && jittered <= 4000);
});

test("isRetryableHttpStatus and isRetryableError classify errors accurately", () => {
  // Status codes
  assert.equal(isRetryableHttpStatus(200), false);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(403), false);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(408), true); // Request timeout
  assert.equal(isRetryableHttpStatus(429), true); // Rate limit
  assert.equal(isRetryableHttpStatus(500), true); // Server error
  assert.equal(isRetryableHttpStatus(502), true);
  assert.equal(isRetryableHttpStatus(503), true);

  // Error objects
  assert.equal(isRetryableError(new Error("Security violation (SSRF)")), false);
  assert.equal(isRetryableError(new Error("Redirect rejected: maxRedirects")), false);

  const connReset = new Error("read ECONNRESET");
  connReset.code = "ECONNRESET";
  assert.equal(isRetryableError(connReset), true);

  const timeout = new Error("Delivery request timed out after 10000ms");
  timeout.code = "ETIMEDOUT";
  assert.equal(isRetryableError(timeout), true);
});

// -------------------------------------------------------------
// 2. HTTP POST Delivery with HMAC, Pinned IP & Redirect Enforcement
// -------------------------------------------------------------
test("dispatchWebhookRequest dispatches signed POST and receiver verifies HMAC", async () => {
  let receivedHeaders = null;
  let receivedBody = "";

  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/webhook/receive`;
  const secret = "whsec_test_secret_0123456789abcdef0123456789abcdef";
  const eventId = "evt_test_123456";
  const deliveryId = "del_test_abcdef";
  const payload = {
    event: "message.received",
    data: { id: "msg_1", text: "Hello Webhook" },
  };

  try {
    const result = await dispatchWebhookRequest({
      url: testUrl,
      payload,
      secret,
      eventId,
      deliveryId,
      options: {
        security: { allowLocalhost: true, requireHttps: false },
        timeoutMs: 3000,
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.ok(result.durationMs >= 0);

    // Verify received headers
    assert.equal(receivedHeaders["x-wa-event-id"], eventId);
    assert.equal(receivedHeaders["idempotency-key"], deliveryId);
    assert.ok(receivedHeaders["x-wa-signature"]);
    assert.ok(receivedHeaders["x-hub-signature-256"]);
    assert.ok(receivedHeaders["x-wa-timestamp"]);

    // Verify signature using Phase 1 verifier
    const verification = verifySignature({
      secret,
      payload: receivedBody,
      signatureHeader: receivedHeaders["x-wa-signature"],
      timestampHeader: receivedHeaders["x-wa-timestamp"],
    });
    assert.equal(verification.ok, true);
  } finally {
    server.close();
  }
});

test("dispatchWebhookRequest disables redirects by default and respects maxRedirects", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount++;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/target" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ final: true }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const redirectUrl = `http://127.0.0.1:${port}/redirect`;
  const secret = "whsec_test_secret_0123456789abcdef0123456789abcdef";

  try {
    // 1. Default policy: maxRedirects = 0 -> Rejects redirect
    const rejectedResult = await dispatchWebhookRequest({
      url: redirectUrl,
      payload: { hello: "world" },
      secret,
      eventId: "evt_1",
      deliveryId: "del_1",
      options: {
        security: { allowLocalhost: true, requireHttps: false, maxRedirects: 0 },
      },
    });

    assert.equal(rejectedResult.success, false);
    assert.equal(rejectedResult.statusCode, 302);
    assert.match(rejectedResult.error, /Redirect rejected: maxRedirects \(0\) exceeded/);

    // 2. Allowed redirect: maxRedirects = 1 -> Follows redirect safely
    const allowedResult = await dispatchWebhookRequest({
      url: redirectUrl,
      payload: { hello: "world" },
      secret,
      eventId: "evt_2",
      deliveryId: "del_2",
      options: {
        security: { allowLocalhost: true, requireHttps: false, maxRedirects: 1 },
      },
    });

    assert.equal(allowedResult.success, true);
    assert.equal(allowedResult.statusCode, 200);
  } finally {
    server.close();
  }
});

test("dispatchWebhookRequest blocks SSRF destinations before network socket creation", async () => {
  const secret = "whsec_test_secret_0123456789abcdef0123456789abcdef";

  // Blocked AWS metadata IP with HTTPS to verify IP classification
  const result = await dispatchWebhookRequest({
    url: "https://169.254.169.254/latest/meta-data",
    payload: { probe: true },
    secret,
    eventId: "evt_ssrf",
    deliveryId: "del_ssrf",
  });

  assert.equal(result.success, false);
  assert.equal(result.retryable, false); // SSRF is permanent failure
  assert.match(result.error, /Security violation \(SSRF\)/);
});

// -------------------------------------------------------------
// 3. Durable Queue, Crash Recovery & Atomic Persistence
// -------------------------------------------------------------
test("DeliveryQueue persists state to disk with 0600 permissions and recovers crashed deliveries", async () => {
  const testDir = createTempDir();

  try {
    // 1. Create an endpoint in the test store
    const ep = createEndpoint(
      {
        url: "https://api.example.com/webhook",
        events: ["message.received"],
        name: "Test Endpoint",
      },
      testDir
    );

    // 2. Initialize queue
    const queue = new DeliveryQueue({
      dataDir: testDir,
      concurrency: 2,
      dispatchFn: async () => ({
        success: true,
        statusCode: 200,
        durationMs: 10,
        error: null,
      }),
    });
    await queue.init();

    // 3. Enqueue delivery
    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { text: "Crash recovery test" },
    });

    assert.ok(delivery.id.startsWith("del_"));
    assert.ok(delivery.eventId.startsWith("evt_"));

    // Verify storage file permissions
    const queuePath = path.join(testDir, "queue.json");
    assert.ok(fs.existsSync(queuePath));
    const stat = fs.statSync(queuePath);
    // On POSIX, check 0600
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }

    // 4. Simulate a crash: simulate process death while a delivery was in-flight ("delivering")
    const onDiskQueue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    const crashedDeliveryId = Object.keys(onDiskQueue)[0];
    assert.ok(crashedDeliveryId);
    onDiskQueue[crashedDeliveryId].status = DELIVERY_STATUS.DELIVERING;
    fs.writeFileSync(queuePath, JSON.stringify(onDiskQueue, null, 2), {
      mode: 0o600,
    });

    // 5. Create a new queue instance (simulating restart) and initialize
    const recoveredQueue = new DeliveryQueue({
      dataDir: testDir,
      concurrency: 2,
    });
    await recoveredQueue.init({ autoProcess: false });

    // Verify crash recovery reverted "delivering" -> "pending"
    const recoveredItem = recoveredQueue.getDelivery(crashedDeliveryId);
    assert.equal(recoveredItem.status, DELIVERY_STATUS.PENDING);
    assert.ok(recoveredItem.history.some((h) => h.recovered === true));

    await recoveredQueue.shutdown();
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 4. Bounded Concurrency & Per-Endpoint Isolation
// -------------------------------------------------------------
test("DeliveryQueue enforces per-endpoint serialization and bounded global concurrency", async () => {
  const testDir = createTempDir();

  try {
    const ep1 = createEndpoint(
      { url: "https://api1.example.com/hook", events: ["*"] },
      testDir
    );
    const ep2 = createEndpoint(
      { url: "https://api2.example.com/hook", events: ["*"] },
      testDir
    );

    let activeGlobalCount = 0;
    let maxObservedGlobal = 0;
    const activePerEndpoint = new Map();
    let maxObservedPerEndpoint = 0;

    const slowDispatcher = async ({ url }) => {
      activeGlobalCount++;
      maxObservedGlobal = Math.max(maxObservedGlobal, activeGlobalCount);

      const count = (activePerEndpoint.get(url) || 0) + 1;
      activePerEndpoint.set(url, count);
      maxObservedPerEndpoint = Math.max(maxObservedPerEndpoint, count);

      await new Promise((r) => setTimeout(r, 40));

      activeGlobalCount--;
      activePerEndpoint.set(url, activePerEndpoint.get(url) - 1);

      return { success: true, statusCode: 200, durationMs: 40 };
    };

    const queue = new DeliveryQueue({
      dataDir: testDir,
      concurrency: 3, // max 3 global
      perEndpointConcurrency: 1, // strictly 1 per endpoint
      dispatchFn: slowDispatcher,
    });
    await queue.init();

    // Enqueue 3 items for ep1 and 2 items for ep2
    queue.enqueue({ endpointId: ep1.id, eventType: "message.received", payload: { n: 1 } });
    queue.enqueue({ endpointId: ep1.id, eventType: "message.received", payload: { n: 2 } });
    queue.enqueue({ endpointId: ep1.id, eventType: "message.received", payload: { n: 3 } });
    queue.enqueue({ endpointId: ep2.id, eventType: "message.received", payload: { n: 4 } });
    queue.enqueue({ endpointId: ep2.id, eventType: "message.received", payload: { n: 5 } });

    // Wait for all 5 deliveries to complete
    let waitCount = 0;
    while (waitCount < 50) {
      const stats = queue.getStats();
      if (stats.succeeded === 5) break;
      await new Promise((r) => setTimeout(r, 20));
      waitCount++;
    }

    const stats = queue.getStats();
    assert.equal(stats.succeeded, 5);
    // Per-endpoint isolation ensured no more than 1 in flight for the same endpoint
    assert.equal(maxObservedPerEndpoint, 1);
    // Global concurrency never exceeded 3
    assert.ok(maxObservedGlobal <= 3);

    await queue.shutdown();
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 5. Dead-Lettering and Manual Retry
// -------------------------------------------------------------
test("DeliveryQueue dead-letters after max attempts and supports manual retry", async () => {
  const testDir = createTempDir();

  try {
    const ep = createEndpoint(
      { url: "https://failing.example.com/hook", events: ["*"] },
      testDir
    );

    let attemptsCount = 0;
    const failingDispatcher = async () => {
      attemptsCount++;
      return {
        success: false,
        statusCode: 503,
        error: "HTTP 503 Service Unavailable",
        retryable: true,
        durationMs: 5,
      };
    };

    const queue = new DeliveryQueue({
      dataDir: testDir,
      maxAttempts: 3,
      initialBackoffMs: 20, // fast retry for test
      maxBackoffMs: 50,
      jitter: false,
      dispatchFn: failingDispatcher,
    });
    await queue.init();

    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { fail: true },
    });

    // Wait for it to exhaust all 3 attempts and transition to dead_letter
    let waitCount = 0;
    while (waitCount < 60) {
      const current = queue.getDelivery(delivery.id);
      if (current && current.status === DELIVERY_STATUS.DEAD_LETTER) break;
      await new Promise((r) => setTimeout(r, 25));
      waitCount++;
    }

    const deadItem = queue.getDelivery(delivery.id);
    assert.equal(deadItem.status, DELIVERY_STATUS.DEAD_LETTER);
    assert.equal(deadItem.attempts, 3);
    assert.equal(attemptsCount, 3);

    // Manual retry: transitions dead_letter back to pending and attempts again
    let succeedOnManual = false;
    queue._dispatchFn = async () => {
      if (succeedOnManual) {
        return { success: true, statusCode: 200, durationMs: 5 };
      }
      return failingDispatcher();
    };
    succeedOnManual = true;

    const retried = queue.retryDelivery(delivery.id);
    assert.equal(retried.status, DELIVERY_STATUS.PENDING);
    assert.equal(retried.manualRetries, 1);

    // Wait for successful delivery
    waitCount = 0;
    while (waitCount < 40) {
      const current = queue.getDelivery(delivery.id);
      if (current && current.status === DELIVERY_STATUS.SUCCEEDED) break;
      await new Promise((r) => setTimeout(r, 20));
      waitCount++;
    }

    const finalItem = queue.getDelivery(delivery.id);
    assert.equal(finalItem.status, DELIVERY_STATUS.SUCCEEDED);
    assert.equal(finalItem.manualRetries, 1);

    await queue.shutdown();
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 6. Delivery History & Bounded Retention
// -------------------------------------------------------------
test("DeliveryQueue records history and prunes entries beyond capacity", async () => {
  const testDir = createTempDir();

  try {
    const ep = createEndpoint(
      { url: "https://success.example.com/hook", events: ["*"] },
      testDir
    );

    const queue = new DeliveryQueue({
      dataDir: testDir,
      maxHistoryEntries: 3, // keep max 3 entries
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 1 }),
    });
    await queue.init();

    // Enqueue 5 items sequentially
    for (let i = 1; i <= 5; i++) {
      queue.enqueue({
        endpointId: ep.id,
        eventType: "message.received",
        payload: { index: i },
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    const list = queue.listDeliveries();
    // Bounded capacity strictly kept 3 most recent entries in history
    assert.equal(list.total, 3);
    assert.equal(list.deliveries.length, 3);

    // Oldest entries (index 1 and 2) were pruned; indexes 3, 4, 5 remain
    const payloads = list.deliveries.map((d) => d.payload.index);
    assert.deepEqual(payloads, [5, 4, 3]);

    await queue.shutdown();
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 7. Security: Secrets Are Never Exposed in Records or Queue Files
// -------------------------------------------------------------
test("Webhook queue and delivery records never leak endpoint secrets", async () => {
  const testDir = createTempDir();

  try {
    const ep = createEndpoint(
      { url: "https://secure.example.com/hook", events: ["*"] },
      testDir
    );

    const queue = new DeliveryQueue({
      dataDir: testDir,
      dispatchFn: async () => ({ success: true, statusCode: 200, durationMs: 5 }),
    });
    await queue.init();

    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { sensitive: "data" },
    });

    // 1. Delivery object returned by enqueue has no secret
    assert.equal(delivery.secret, undefined);

    // 2. Queue file on disk contains no secret
    const queueFile = fs.readFileSync(path.join(testDir, "queue.json"), "utf8");
    assert.ok(!queueFile.includes(ep.secret));

    // Wait for completion
    await new Promise((r) => setTimeout(r, 30));

    // 3. History file on disk contains no secret
    const historyFile = fs.readFileSync(path.join(testDir, "history.json"), "utf8");
    assert.ok(!historyFile.includes(ep.secret));

    // 4. getDelivery and listDeliveries do not expose secrets
    const fetched = queue.getDelivery(delivery.id);
    assert.equal(fetched.secret, undefined);

    await queue.shutdown();
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
