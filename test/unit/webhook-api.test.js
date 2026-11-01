"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { DaemonServer } = require("../../src/daemon/server");
const { parseArgs } = require("../../src/cli/args");
const { cmdWebhook } = require("../../src/cli/webhook");
const {
  createEndpoint,
  getEndpoint,
  listEndpoints,
  DeliveryQueue,
  DELIVERY_STATUS,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-api-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRequest(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
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
// 1. Authentication (Bearer & x-wa-token)
// -------------------------------------------------------------
test("Webhook REST API enforces authentication via Bearer token and x-wa-token", async () => {
  const tempDir = createTempDir();
  const token = "test_secret_token_12345";
  const dummyService = { state: "ready", subscribe: () => () => {} };

  const server = new DaemonServer({
    service: dummyService,
    token,
    webhookDataDir: tempDir,
  });
  const port = await server.start();

  try {
    // 1. Missing auth header -> 401
    const unauthRes = await makeRequest(port, "GET", "/webhooks");
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.body.ok, false);

    // 2. Invalid auth header -> 401
    const badTokenRes = await makeRequest(port, "GET", "/webhooks", null, {
      authorization: "Bearer wrong_token",
    });
    assert.equal(badTokenRes.status, 401);

    // 3. Valid x-wa-token -> 200
    const xTokenRes = await makeRequest(port, "GET", "/webhooks", null, {
      "x-wa-token": token,
    });
    assert.equal(xTokenRes.status, 200);
    assert.equal(xTokenRes.body.ok, true);

    // 4. Valid Authorization: Bearer <token> -> 200
    const bearerRes = await makeRequest(port, "GET", "/webhooks", null, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(bearerRes.status, 200);
    assert.equal(bearerRes.body.ok, true);
  } finally {
    server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 2. Endpoint CRUD & Safe Secret Output
// -------------------------------------------------------------
test("Webhook REST API performs CRUD, enforces SSRF policies, and shows secret only on creation", async () => {
  const tempDir = createTempDir();
  const token = "auth_tok_crud_test";
  const dummyService = { state: "ready", subscribe: () => () => {} };

  const server = new DaemonServer({
    service: dummyService,
    token,
    webhookDataDir: tempDir,
  });
  const port = await server.start();
  const authHeaders = { authorization: `Bearer ${token}` };

  try {
    // 1. Validation failure: Missing URL -> 400
    const noUrl = await makeRequest(port, "POST", "/webhooks", {}, authHeaders);
    assert.equal(noUrl.status, 400);

    // 2. SSRF enforcement: Plain HTTP remote URL blocked -> 400
    const insecureHttp = await makeRequest(
      port,
      "POST",
      "/webhooks",
      { url: "http://api.example.com/hook" },
      authHeaders
    );
    assert.equal(insecureHttp.status, 400);
    assert.match(insecureHttp.body.error.message, /HTTPS is strictly required/);

    // 3. Successful creation: Valid HTTPS endpoint -> 201
    const createRes = await makeRequest(
      port,
      "POST",
      "/webhooks",
      {
        url: "https://api.example.com/webhook/test",
        name: "Test Hook",
        events: ["message.received"],
      },
      authHeaders
    );
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.ok, true);
    const created = createRes.body.endpoint;
    assert.ok(created.id.startsWith("wh_"));
    // Unmasked secret is returned on creation!
    assert.ok(created.secret.startsWith("whsec_"));
    assert.ok(!created.secret.includes("****"));
    const endpointId = created.id;
    const plainSecret = created.secret;

    // 4. GET /webhooks - Listed endpoints have MASKED secrets
    const listRes = await makeRequest(port, "GET", "/webhooks", null, authHeaders);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.count, 1);
    const listed = listRes.body.endpoints[0];
    assert.equal(listed.id, endpointId);
    assert.ok(listed.secret.includes("****"));
    assert.notEqual(listed.secret, plainSecret);

    // 5. GET /webhooks/:id - Single endpoint has MASKED secret
    const getRes = await makeRequest(
      port,
      "GET",
      `/webhooks/${endpointId}`,
      null,
      authHeaders
    );
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.endpoint.id, endpointId);
    assert.ok(getRes.body.endpoint.secret.includes("****"));

    // 6. GET /webhooks/:unknownId -> 404
    const getUnknown = await makeRequest(
      port,
      "GET",
      "/webhooks/wh_nonexistent",
      null,
      authHeaders
    );
    assert.equal(getUnknown.status, 404);

    // 7. PATCH /webhooks/:id - Update endpoint name and status
    const updateRes = await makeRequest(
      port,
      "PATCH",
      `/webhooks/${endpointId}`,
      { name: "Updated Hook", enabled: false },
      authHeaders
    );
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.endpoint.name, "Updated Hook");
    assert.equal(updateRes.body.endpoint.enabled, false);

    // 8. DELETE /webhooks/:id
    const deleteRes = await makeRequest(
      port,
      "DELETE",
      `/webhooks/${endpointId}`,
      null,
      authHeaders
    );
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.body.deleted, true);

    // 9. Subsequent GET -> 404
    const getDeleted = await makeRequest(
      port,
      "GET",
      `/webhooks/${endpointId}`,
      null,
      authHeaders
    );
    assert.equal(getDeleted.status, 404);
  } finally {
    server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 3. Secret Rotation & Endpoint Testing
// -------------------------------------------------------------
test("Webhook REST API rotates secrets safely and dispatches test event", async () => {
  const tempDir = createTempDir();
  const token = "auth_tok_rotate_test";
  const dummyService = { state: "ready", subscribe: () => () => {} };

  // Set up a mock receiver for the test event
  let testReceived = false;
  const receiverServer = http.createServer((req, res) => {
    testReceived = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => receiverServer.listen(0, "127.0.0.1", resolve));
  const receiverPort = receiverServer.address().port;

  const server = new DaemonServer({
    service: dummyService,
    token,
    webhookDataDir: tempDir,
  });
  const daemonPort = await server.start();
  const authHeaders = { authorization: `Bearer ${token}` };

  try {
    // 1. Create endpoint with localhost allowed for receiver
    const createRes = await makeRequest(
      daemonPort,
      "POST",
      "/webhooks",
      {
        url: `http://127.0.0.1:${receiverPort}/hook`,
        name: "Local Test Endpoint",
        security: { allowLocalhost: true, requireHttps: false },
      },
      authHeaders
    );
    assert.equal(createRes.status, 201);
    const ep = createRes.body.endpoint;
    const initialSecret = ep.secret;

    // 2. Rotate secret
    const rotateRes = await makeRequest(
      daemonPort,
      "POST",
      `/webhooks/${ep.id}/rotate-secret`,
      null,
      authHeaders
    );
    assert.equal(rotateRes.status, 200);
    assert.ok(rotateRes.body.newSecret.startsWith("whsec_"));
    assert.notEqual(rotateRes.body.newSecret, initialSecret);
    // Secret in endpoint object returned is masked
    assert.ok(rotateRes.body.endpoint.secret.includes("****"));

    // 3. POST /webhooks/:id/test dispatches test event to endpoint
    const testRes = await makeRequest(
      daemonPort,
      "POST",
      `/webhooks/${ep.id}/test`,
      null,
      authHeaders
    );
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.delivered, true);
    assert.equal(testRes.body.attempt.statusCode, 200);
    assert.equal(testReceived, true);
  } finally {
    server.stop();
    receiverServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 4. Delivery Querying, Manual Retry, Stats & Cleanup
// -------------------------------------------------------------
test("Webhook REST API queries deliveries, performs manual retry, reports stats, and prunes history", async () => {
  const tempDir = createTempDir();
  const token = "auth_tok_queue_test";
  const dummyService = { state: "ready", subscribe: () => () => {} };

  const server = new DaemonServer({
    service: dummyService,
    token,
    webhookDataDir: tempDir,
  });
  const port = await server.start();
  const authHeaders = { authorization: `Bearer ${token}` };
  const queue = server.getWebhookQueue();

  try {
    // 1. Register endpoint and enqueue failed delivery
    const ep = createEndpoint(
      { url: "https://api.example.com/hook", events: ["*"] },
      tempDir
    );

    const delivery = queue.enqueue({
      endpointId: ep.id,
      eventType: "message.received",
      payload: { test: 123 },
    });

    // Artificially simulate failure
    const rawDelivery = queue._deliveries.get(delivery.id);
    rawDelivery.status = DELIVERY_STATUS.FAILED;
    rawDelivery.attempts = 1;
    rawDelivery.lastError = "Connection reset";
    queue._saveQueue();

    // 2. GET /webhooks/deliveries - Query deliveries
    const listDeliveriesRes = await makeRequest(
      port,
      "GET",
      "/webhooks/deliveries?status=failed",
      null,
      authHeaders
    );
    assert.equal(listDeliveriesRes.status, 200);
    assert.equal(listDeliveriesRes.body.total, 1);
    assert.equal(listDeliveriesRes.body.deliveries[0].id, delivery.id);

    // 3. GET /webhooks/deliveries/:deliveryId - Detail
    const detailRes = await makeRequest(
      port,
      "GET",
      `/webhooks/deliveries/${delivery.id}`,
      null,
      authHeaders
    );
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.delivery.id, delivery.id);

    // 4. POST /webhooks/deliveries/:deliveryId/retry - Manual retry
    const retryRes = await makeRequest(
      port,
      "POST",
      `/webhooks/deliveries/${delivery.id}/retry`,
      null,
      authHeaders
    );
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.delivery.manualRetries, 1);

    // 5. GET /webhooks/stats - Queue throughput and metrics
    const statsRes = await makeRequest(
      port,
      "GET",
      "/webhooks/stats",
      null,
      authHeaders
    );
    assert.equal(statsRes.status, 200);
    assert.equal(typeof statsRes.body.activeDeliveries, "number");
    assert.equal(typeof statsRes.body.pending, "number");

    // 6. POST /webhooks/clean - History pruning
    const cleanRes = await makeRequest(
      port,
      "POST",
      "/webhooks/clean",
      { maxEntries: 10, retentionDays: 7 },
      authHeaders
    );
    assert.equal(cleanRes.status, 200);
    assert.equal(typeof cleanRes.body.remaining, "number");
  } finally {
    server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 5. CLI Arguments & Command Parsing
// -------------------------------------------------------------
test("CLI argument parser recognizes webhook and webhooks commands with flags", () => {
  const parsed1 = parseArgs(["webhook", "list"]);
  assert.equal(parsed1.command, "webhook");
  assert.deepEqual(parsed1.positional, ["list"]);

  const parsed2 = parseArgs([
    "webhook",
    "add",
    "https://example.com/hook",
    "--name=MyHook",
    "--events=message.received,message.ack",
    "--allow-localhost",
  ]);
  assert.equal(parsed2.command, "webhook");
  assert.equal(parsed2.positional[0], "add");
  assert.equal(parsed2.positional[1], "https://example.com/hook");
  assert.equal(parsed2.flags.name, "MyHook");
  assert.equal(parsed2.flags.events, "message.received,message.ack");
  assert.equal(parsed2.flags["allow-localhost"], true);

  const parsed3 = parseArgs(["webhooks", "stats"]);
  assert.equal(parsed3.command, "webhooks");
  assert.deepEqual(parsed3.positional, ["stats"]);
});
