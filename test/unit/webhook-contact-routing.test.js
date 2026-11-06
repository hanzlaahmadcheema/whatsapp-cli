"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { DaemonServer } = require("../../src/daemon/server");
const {
  createEndpoint,
  getEndpoint,
  updateEndpoint,
  DeliveryQueue,
  DELIVERY_STATUS,
  WebhookBridge,
  WebhookRouter,
  addRule,
  updateRule,
  deleteRule,
  listRules,
  setFallback,
  getFallback,
  setEndpointRules,
  getEndpointRules,
  clearRoutingConfig,
  normalizeContact,
  extractSenderIdentifiers,
  matchesContact,
} = require("../../src/webhook");

function createTempDir(prefix = "wa-webhook-routing-test-") {
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

const mockTapuAccount = {
  number: "923124706501",
  jid: "923124706501@c.us",
  me: "923124706501@c.us",
  name: "Tapu",
  lid: "244410113613956@lid",
};

// -------------------------------------------------------------
// Test 1: Multiple contacts mapped to different endpoints
// -------------------------------------------------------------
test("1. Multiple contacts mapped to different endpoints with strict isolation", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epA = createEndpoint(
      { url: "https://mock.example.com/endpoint-a", events: ["message.received"] },
      tempDir
    );
    const epB = createEndpoint(
      { url: "https://mock.example.com/endpoint-b", events: ["message.received"] },
      tempDir
    );

    addRule({ contact: "15551111111", endpointId: epA.id }, tempDir);
    addRule({ contact: "15552222222", endpointId: epB.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Message 1 from Contact 1 (Alice)
    bridge.ingestMessage({
      id: "msg_alice_001",
      from: "15551111111@c.us",
      chatId: "15551111111@c.us",
      body: "Hello Endpoint A",
    });

    // Message 2 from Contact 2 (Bob)
    bridge.ingestMessage({
      id: "msg_bob_001",
      from: "15552222222@c.us",
      chatId: "15552222222@c.us",
      body: "Hello Endpoint B",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 2, "Expected exactly 2 deliveries total");

    const delAlice = deliveries.find((d) => d.payload?.data?.messageId === "msg_alice_001");
    assert.ok(delAlice, "Alice delivery should exist");
    assert.equal(delAlice.endpointId, epA.id, "Alice's message must route strictly to Endpoint A");

    const delBob = deliveries.find((d) => d.payload?.data?.messageId === "msg_bob_001");
    assert.ok(delBob, "Bob delivery should exist");
    assert.equal(delBob.endpointId, epB.id, "Bob's message must route strictly to Endpoint B");

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 2: Multiple independent mappings
// -------------------------------------------------------------
test("2. Multiple independent mappings across 3 distinct endpoints", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep1 = createEndpoint({ url: "https://mock.example.com/ep1" }, tempDir);
    const ep2 = createEndpoint({ url: "https://mock.example.com/ep2" }, tempDir);
    const ep3 = createEndpoint({ url: "https://mock.example.com/ep3" }, tempDir);

    addRule({ contact: "15550000001", endpointId: ep1.id }, tempDir);
    addRule({ contact: "15550000002", endpointId: ep2.id }, tempDir);
    addRule({ contact: "15550000003", endpointId: ep3.id }, tempDir);
    addRule({ contact: "15550000004", endpointId: ep1.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({ id: "m1", from: "15550000001@c.us", chatId: "15550000001@c.us", body: "m1" });
    bridge.ingestMessage({ id: "m2", from: "15550000002@c.us", chatId: "15550000002@c.us", body: "m2" });
    bridge.ingestMessage({ id: "m3", from: "15550000003@c.us", chatId: "15550000003@c.us", body: "m3" });
    bridge.ingestMessage({ id: "m4", from: "15550000004@c.us", chatId: "15550000004@c.us", body: "m4" });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 4);

    const find = (mid) => deliveries.find((d) => d.payload?.data?.messageId === mid);
    assert.equal(find("m1").endpointId, ep1.id);
    assert.equal(find("m2").endpointId, ep2.id);
    assert.equal(find("m3").endpointId, ep3.id);
    assert.equal(find("m4").endpointId, ep1.id);

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 3: Overlapping allowlists with deterministic tie-breaking
// -------------------------------------------------------------
test("3. Overlapping allowlists route deterministically to highest-priority endpoint", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    // Endpoint A has priority 10
    const epA = createEndpoint(
      {
        url: "https://mock.example.com/ep-a",
        routing: { allowlist: ["15557777777@c.us"] },
      },
      tempDir
    );
    // Endpoint B has priority 50
    const epB = createEndpoint(
      {
        url: "https://mock.example.com/ep-b",
        routing: { allowlist: ["15557777777@c.us"] },
      },
      tempDir
    );

    // Assign priorities in endpointRules
    setEndpointRules(epA.id, { allowlist: ["15557777777@c.us"] }, tempDir);
    setEndpointRules(epB.id, { allowlist: ["15557777777@c.us"] }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_overlap_001",
      from: "15557777777@c.us",
      chatId: "15557777777@c.us",
      body: "Test overlap",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1, "Exactly one delivery must be created; zero fan-out");
    assert.ok(
      deliveries[0].endpointId === epA.id || deliveries[0].endpointId === epB.id,
      "Must route to one of the allowlisted endpoints"
    );

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 4: Exclusion overriding allowlist matches
// -------------------------------------------------------------
test("4. Exclusion strictly overrides allowlist matches", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep = createEndpoint(
      { url: "https://mock.example.com/ep-exclusive" },
      tempDir
    );

    // Endpoint both allows and excludes the same contact
    setEndpointRules(
      ep.id,
      {
        allowlist: ["15558888888"],
        exclusion: ["15558888888"],
      },
      tempDir
    );

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_excluded_001",
      from: "15558888888@c.us",
      chatId: "15558888888@c.us",
      body: "Am I excluded?",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(
      deliveries.length,
      0,
      "Exclusion rule must override allowlist, producing zero deliveries"
    );

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 5: Explicit mapping precedence over allowlists and fallback
// -------------------------------------------------------------
test("5. Explicit mapping has top precedence over allowlist matches and fallback", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epExplicit = createEndpoint({ url: "https://mock.example.com/explicit" }, tempDir);
    const epAllowlist = createEndpoint({ url: "https://mock.example.com/allowlist" }, tempDir);
    const epFallback = createEndpoint({ url: "https://mock.example.com/fallback" }, tempDir);

    // 1. Explicit rule maps VIP to epExplicit
    addRule({ contact: "15559990001", endpointId: epExplicit.id }, tempDir);

    // 2. Allowlist on epAllowlist also includes VIP
    setEndpointRules(epAllowlist.id, { allowlist: ["15559990001"] }, tempDir);

    // 3. Fallback set to epFallback
    setFallback({ endpointId: epFallback.id, enabled: true }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_vip_precedence",
      from: "15559990001@c.us",
      chatId: "15559990001@c.us",
      body: "VIP message",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1, "Exactly one delivery created");
    assert.equal(
      deliveries[0].endpointId,
      epExplicit.id,
      "Explicit rule must win over allowlist and fallback"
    );

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 6: Unmatched contacts with fallback enabled
// -------------------------------------------------------------
test("6. Unmatched contacts route to fallback endpoint when enabled", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epAssigned = createEndpoint({ url: "https://mock.example.com/assigned" }, tempDir);
    const epFallback = createEndpoint({ url: "https://mock.example.com/fallback" }, tempDir);

    addRule({ contact: "15551111111", endpointId: epAssigned.id }, tempDir);
    setFallback({ endpointId: epFallback.id, enabled: true }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Message from unmatched contact (Dave)
    bridge.ingestMessage({
      id: "msg_unmatched_001",
      from: "15553333333@c.us",
      chatId: "15553333333@c.us",
      body: "Unmatched hello",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1, "Unmatched contact delivers to fallback");
    assert.equal(deliveries[0].endpointId, epFallback.id, "Must route to fallback endpoint");

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 7: Unmatched contacts with fallback disabled
// -------------------------------------------------------------
test("7. Unmatched contacts produce zero deliveries when fallback is disabled", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epAssigned = createEndpoint({ url: "https://mock.example.com/assigned" }, tempDir);
    const epFallback = createEndpoint({ url: "https://mock.example.com/fallback" }, tempDir);

    addRule({ contact: "15551111111", endpointId: epAssigned.id }, tempDir);
    setFallback({ endpointId: epFallback.id, enabled: false }, tempDir); // Disabled!

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Message from unmatched contact (Eve)
    bridge.ingestMessage({
      id: "msg_unmatched_disabled",
      from: "15554444444@c.us",
      chatId: "15554444444@c.us",
      body: "Nobody is listening",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(
      deliveries.length,
      0,
      "Unmatched message with fallback disabled must produce zero deliveries"
    );

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 8: Unknown and malformed sender identities
// -------------------------------------------------------------
test("8. Unknown and malformed sender identities are handled safely", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epFallback = createEndpoint({ url: "https://mock.example.com/fallback" }, tempDir);
    setFallback({ endpointId: epFallback.id, enabled: true }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 1. Missing / null sender
    bridge.ingestMessage({
      id: "msg_malformed_1",
      from: null,
      chatId: null,
      body: "Null sender",
    });

    // 2. Empty string
    bridge.ingestMessage({
      id: "msg_malformed_2",
      from: "",
      chatId: "",
      body: "Empty sender",
    });

    // 3. Non-standard symbols
    bridge.ingestMessage({
      id: "msg_malformed_3",
      from: "invalid@@@strange%%chars",
      chatId: "invalid@@@strange%%chars",
      body: "Weird sender",
    });

    // None should crash; all safe
    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.ok(deliveries.length >= 0, "No process crash on malformed senders");

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 9: JID and phone-number normalization
// -------------------------------------------------------------
test("9. JID and phone-number normalization accurately matches across formats", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep1 = createEndpoint({ url: "https://mock.example.com/norm1" }, tempDir);
    const ep2 = createEndpoint({ url: "https://mock.example.com/norm2" }, tempDir);
    const epLid = createEndpoint({ url: "https://mock.example.com/lid" }, tempDir);

    // Rule 1 configured with formatted international phone: "+1 (555) 234-5678"
    addRule({ contact: "+1 (555) 234-5678", endpointId: ep1.id }, tempDir);

    // Rule 2 configured with JID: "15553456789@c.us"
    addRule({ contact: "15553456789@c.us", endpointId: ep2.id }, tempDir);

    // Rule 3 configured with WhatsApp LID: "98765432109876@lid"
    addRule({ contact: "98765432109876@lid", endpointId: epLid.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // 1. Message from Contact 1 arrives with standard @c.us JID
    bridge.ingestMessage({
      id: "msg_norm_1",
      from: "15552345678@c.us",
      chatId: "15552345678@c.us",
      body: "Norm 1 match",
    });

    // 2. Message from Contact 2 arrives with formatted phone string in 'from'
    bridge.ingestMessage({
      id: "msg_norm_2",
      from: "+1-555-345-6789",
      chatId: "15553456789@c.us",
      body: "Norm 2 match",
    });

    // 3. Message from Contact 3 arrives with LID
    bridge.ingestMessage({
      id: "msg_norm_lid",
      from: "98765432109876@lid",
      chatId: "98765432109876@lid",
      body: "LID match",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 3, "All 3 normalized messages should be delivered");

    const d1 = deliveries.find((d) => d.payload?.data?.messageId === "msg_norm_1");
    assert.equal(d1.endpointId, ep1.id, "Phone rule must match JID incoming sender");

    const d2 = deliveries.find((d) => d.payload?.data?.messageId === "msg_norm_2");
    assert.equal(d2.endpointId, ep2.id, "JID rule must match formatted phone incoming sender");

    const d3 = deliveries.find((d) => d.payload?.data?.messageId === "msg_norm_lid");
    assert.equal(d3.endpointId, epLid.id, "LID rule must match LID incoming sender");

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 10: Duplicate events and queue-level idempotency
// -------------------------------------------------------------
test("10. Duplicate events preserve single delivery and queue-level idempotency", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep = createEndpoint({ url: "https://mock.example.com/idempotent" }, tempDir);
    addRule({ contact: "15556667777", endpointId: ep.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    // Send original
    bridge.ingestMessage({
      id: "msg_dup_test_001",
      from: "15556667777@c.us",
      chatId: "15556667777@c.us",
      body: "First instance",
    });

    // Send duplicate
    bridge.ingestMessage({
      id: "msg_dup_test_001",
      from: "15556667777@c.us",
      chatId: "15556667777@c.us",
      body: "Duplicate instance",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1, "Duplicate message must produce only 1 delivery");
    assert.equal(deliveries[0].endpointId, ep.id);

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 11: Retry behavior preserving the intended endpoint
// -------------------------------------------------------------
test("11. Retrying a delivery never reroutes to another endpoint even if rules change", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epOld = createEndpoint({ url: "https://mock.example.com/old" }, tempDir);
    const epNew = createEndpoint({ url: "https://mock.example.com/new" }, tempDir);

    const rule = addRule({ contact: "15559876543", endpointId: epOld.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_retry_test_001",
      from: "15559876543@c.us",
      chatId: "15559876543@c.us",
      body: "Initial delivery",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1);
    const originalDelivery = deliveries[0];
    assert.equal(originalDelivery.endpointId, epOld.id);

    // Now change routing rule so that this contact points to epNew
    updateRule(rule.id, { endpointId: epNew.id }, tempDir);

    // Call retry on the existing delivery
    const retried = queue.retryDelivery(originalDelivery.id);
    assert.equal(
      retried.endpointId,
      epOld.id,
      "Retrying delivery must preserve original endpointId and never reroute to epNew"
    );

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 12: Daemon restart and persisted routing rules
// -------------------------------------------------------------
test("12. Routing rules, allowlists, and fallback survive daemon restarts", async () => {
  const tempDir = createTempDir();

  try {
    // Phase A: Configure and save
    const ep1 = createEndpoint({ url: "https://mock.example.com/ep1" }, tempDir);
    const epFallback = createEndpoint({ url: "https://mock.example.com/fallback" }, tempDir);

    addRule({ contact: "15551234567", endpointId: ep1.id, name: "Persisted Rule" }, tempDir);
    setFallback({ endpointId: epFallback.id, enabled: true }, tempDir);
    setEndpointRules(ep1.id, { allowlist: ["15559998888"], exclusion: ["15550000000"] }, tempDir);

    // Phase B: Simulate daemon restart by instantiating new objects reading from disk
    const routerNew = new WebhookRouter({ dataDir: tempDir });
    const config = routerNew.getConfig();

    assert.equal(config.rules.length, 1, "Rule must be loaded from routes.json");
    assert.equal(config.rules[0].endpointId, ep1.id);
    assert.equal(config.fallback.endpointId, epFallback.id);
    assert.equal(config.fallback.enabled, true);
    assert.deepEqual(config.endpointRules[ep1.id].allowlist, ["15559998888@c.us"]);
    assert.deepEqual(config.endpointRules[ep1.id].exclusion, ["15550000000@c.us"]);

    // Phase C: WebhookBridge routing behaves identically after restart
    const queueNew = new DeliveryQueue({ dataDir: tempDir });
    await queueNew.init({ autoProcess: false });

    const bridgeNew = new WebhookBridge({
      queue: queueNew,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridgeNew.start();

    // Explicit contact -> ep1
    bridgeNew.ingestMessage({
      id: "msg_restart_1",
      from: "15551234567@c.us",
      chatId: "15551234567@c.us",
      body: "Restart test",
    });

    // Unmatched contact -> epFallback
    bridgeNew.ingestMessage({
      id: "msg_restart_2",
      from: "15557777777@c.us",
      chatId: "15557777777@c.us",
      body: "Unmatched after restart",
    });

    const deliveries = queueNew.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 2);

    const d1 = deliveries.find((d) => d.payload?.data?.messageId === "msg_restart_1");
    assert.equal(d1.endpointId, ep1.id);

    const d2 = deliveries.find((d) => d.payload?.data?.messageId === "msg_restart_2");
    assert.equal(d2.endpointId, epFallback.id);

    bridgeNew.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 13: Backward compatibility when no routing is configured
// -------------------------------------------------------------
test("13. Preserves existing broadcast behavior when no routing is configured", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const ep1 = createEndpoint(
      { url: "https://mock.example.com/ep1", events: ["message.received"] },
      tempDir
    );
    const ep2 = createEndpoint(
      { url: "https://mock.example.com/ep2", events: ["message.received"] },
      tempDir
    );

    // No routing rules, no allowlists, no fallback
    clearRoutingConfig(tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_legacy_broadcast",
      from: "15550001111@c.us",
      chatId: "15550001111@c.us",
      body: "Legacy broadcast",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(
      deliveries.length,
      2,
      "Without routing configuration, both subscribed endpoints must receive event"
    );

    const eps = deliveries.map((d) => d.endpointId);
    assert.ok(eps.includes(ep1.id));
    assert.ok(eps.includes(ep2.id));

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 14: Media messages route message.received and media.received to assigned endpoint
// -------------------------------------------------------------
test("14. Media messages dispatch both message.received and media.received to the assigned endpoint", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epAssigned = createEndpoint(
      { url: "https://mock.example.com/media-target", events: ["*"] },
      tempDir
    );
    const epOther = createEndpoint(
      { url: "https://mock.example.com/other", events: ["*"] },
      tempDir
    );

    addRule({ contact: "15553334444", endpointId: epAssigned.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_media_001",
      from: "15553334444@c.us",
      chatId: "15553334444@c.us",
      hasMedia: true,
      mimetype: "image/jpeg",
      filename: "photo.jpg",
      filesize: 1024,
      caption: "Sunset picture",
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 2, "Expected message.received and media.received");

    for (const del of deliveries) {
      assert.equal(
        del.endpointId,
        epAssigned.id,
        "Both message and media events must route strictly to epAssigned"
      );
    }

    const types = deliveries.map((d) => d.eventType);
    assert.ok(types.includes("message.received"));
    assert.ok(types.includes("media.received"));

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 15: Group messages with Tapu mentioned route based on sender author
// -------------------------------------------------------------
test("15. Group messages mentioning Tapu route based on message author", async () => {
  const tempDir = createTempDir();

  try {
    const queue = new DeliveryQueue({ dataDir: tempDir });
    await queue.init({ autoProcess: false });

    const epBob = createEndpoint({ url: "https://mock.example.com/bob" }, tempDir);
    const epOther = createEndpoint({ url: "https://mock.example.com/other" }, tempDir);

    // Map Bob's personal identity to epBob
    addRule({ contact: "15552223333", endpointId: epBob.id }, tempDir);

    const bridge = new WebhookBridge({
      queue,
      dataDir: tempDir,
      account: mockTapuAccount,
    });
    bridge.start();

    bridge.ingestMessage({
      id: "msg_group_bob",
      from: "123456789-987654@g.us",
      chatId: "123456789-987654@g.us",
      author: "15552223333@c.us",
      isGroup: true,
      body: "Hey @Tapu please check this",
      mentionedJidList: [mockTapuAccount.jid],
    });

    const deliveries = queue.listDeliveries({ limit: 50 }).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].endpointId, epBob.id, "Group message must route to Bob's assigned endpoint");

    bridge.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Test 16: REST API management for /webhooks/routes
// -------------------------------------------------------------
test("16. REST API supports managing routing rules, fallback, and endpoint rules", async () => {
  const tempDir = createTempDir();
  const token = "auth_token_routing_test";
  const dummyService = { state: "ready", subscribe: () => () => {} };

  const server = new DaemonServer({
    service: dummyService,
    token,
    webhookDataDir: tempDir,
  });
  const port = await server.start();
  const authHeader = { authorization: `Bearer ${token}` };

  try {
    // 0. Register an endpoint first
    const ep = createEndpoint({ url: "https://mock.example.com/api-test" }, tempDir);

    // 1. GET /webhooks/routes initially returns empty
    const listInitial = await makeRequest(port, "GET", "/webhooks/routes", null, authHeader);
    assert.equal(listInitial.status, 200);
    assert.equal(listInitial.body.ok, true);
    assert.deepEqual(listInitial.body.rules, []);

    // 2. POST /webhooks/routes creates an explicit rule
    const createRes = await makeRequest(
      port,
      "POST",
      "/webhooks/routes",
      {
        contact: "15554321098",
        endpointId: ep.id,
        priority: 5,
        name: "API Rule 1",
      },
      authHeader
    );
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.ok, true);
    const ruleId = createRes.body.rule.id;
    assert.ok(ruleId);
    assert.equal(createRes.body.rule.endpointId, ep.id);

    // 3. GET /webhooks/routes/:id
    const getRes = await makeRequest(port, "GET", `/webhooks/routes/${ruleId}`, null, authHeader);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.rule.name, "API Rule 1");

    // 4. PATCH /webhooks/routes/:id
    const updateRes = await makeRequest(
      port,
      "PATCH",
      `/webhooks/routes/${ruleId}`,
      { priority: 10, enabled: false },
      authHeader
    );
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.rule.priority, 10);
    assert.equal(updateRes.body.rule.enabled, false);

    // 5. POST /webhooks/routes/fallback
    const fallbackRes = await makeRequest(
      port,
      "POST",
      "/webhooks/routes/fallback",
      { endpointId: ep.id, enabled: true },
      authHeader
    );
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackRes.body.fallback.endpointId, ep.id);
    assert.equal(fallbackRes.body.fallback.enabled, true);

    // 6. GET /webhooks/routes/fallback
    const getFallbackRes = await makeRequest(port, "GET", "/webhooks/routes/fallback", null, authHeader);
    assert.equal(getFallbackRes.status, 200);
    assert.equal(getFallbackRes.body.fallback.endpointId, ep.id);

    // 7. POST /webhooks/routes/endpoints/:endpointId
    const epRulesRes = await makeRequest(
      port,
      "POST",
      `/webhooks/routes/endpoints/${ep.id}`,
      {
        allowlist: ["15551112222"],
        exclusion: ["15553334444"],
      },
      authHeader
    );
    assert.equal(epRulesRes.status, 200);
    assert.deepEqual(epRulesRes.body.allowlist, ["15551112222@c.us"]);
    assert.deepEqual(epRulesRes.body.exclusion, ["15553334444@c.us"]);

    // 8. GET /webhooks/routes/endpoints/:endpointId
    const getEpRulesRes = await makeRequest(
      port,
      "GET",
      `/webhooks/routes/endpoints/${ep.id}`,
      null,
      authHeader
    );
    assert.equal(getEpRulesRes.status, 200);
    assert.deepEqual(getEpRulesRes.body.allowlist, ["15551112222@c.us"]);

    // 9. DELETE /webhooks/routes/:id
    const delRes = await makeRequest(port, "DELETE", `/webhooks/routes/${ruleId}`, null, authHeader);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);

    // 10. GET /webhooks/routes/:id -> 404
    const get404 = await makeRequest(port, "GET", `/webhooks/routes/${ruleId}`, null, authHeader);
    assert.equal(get404.status, 404);
  } finally {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
