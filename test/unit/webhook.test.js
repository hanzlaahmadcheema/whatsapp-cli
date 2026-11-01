"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  signPayload,
  verifySignature,
  validateWebhookUrl,
  resolveAndValidateDestination,
  validateRedirect,
  isLoopback,
  isPrivateLan,
  isLinkLocal,
  isBlockedIp,
  normalizeIp,
  createEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  deleteEndpoint,
  rotateEndpointSecret,
  findEndpointsForEvent,
  maskSecret,
  getEndpointsFilePath,
  ensureWebhookDir,
  PERMISSIONS,
} = require("../../src/webhook");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-webhook-test-"));
}

// -------------------------------------------------------------
// 1. HMAC Generation, Verification & Tamper Detection
// -------------------------------------------------------------
test("HMAC-SHA256 generation, header formatting, and valid verification", () => {
  const secret = "whsec_test_secret_1234567890abcdef";
  const payload = { event: "message.received", data: { text: "Hello" } };
  const now = 1700000000;

  const signed = signPayload(secret, payload, now);
  assert.equal(signed.timestamp, now);
  assert.ok(signed.signature);
  assert.equal(signed.hubHeaderValue, `sha256=${signed.signature}`);
  assert.equal(signed.headerValue, `t=${now},v1=${signed.signature}`);

  // Verification succeeds with matching secret, payload, and headers
  const verified = verifySignature({
    secret,
    payload,
    signatureHeader: signed.hubHeaderValue,
    timestampHeader: now,
    nowSeconds: now + 10,
  });
  assert.equal(verified.ok, true);

  // Also succeeds using t=...,v1=... format
  const verifiedCombined = verifySignature({
    secret,
    payload,
    signatureHeader: signed.headerValue,
    nowSeconds: now + 10,
  });
  assert.equal(verifiedCombined.ok, true);
});

test("HMAC verification rejects tampered payload, incorrect secrets, and timestamps", () => {
  const secret = "whsec_secret_alpha";
  const payload = { event: "message.received", count: 1 };
  const now = 1700000000;
  const signed = signPayload(secret, payload, now);

  // 1. Tampered payload
  const tamperedPayload = { event: "message.received", count: 2 };
  const resTampered = verifySignature({
    secret,
    payload: tamperedPayload,
    signatureHeader: signed.hubHeaderValue,
    timestampHeader: now,
    nowSeconds: now,
  });
  assert.equal(resTampered.ok, false);
  assert.match(resTampered.reason, /Signature mismatch/);

  // 2. Wrong secret
  const resWrongSecret = verifySignature({
    secret: "whsec_secret_beta_different",
    payload,
    signatureHeader: signed.hubHeaderValue,
    timestampHeader: now,
    nowSeconds: now,
  });
  assert.equal(resWrongSecret.ok, false);
  assert.match(resWrongSecret.reason, /Signature mismatch/);

  // 3. Replay attack / expired timestamp (exceeds tolerance of 300s)
  const resExpired = verifySignature({
    secret,
    payload,
    signatureHeader: signed.hubHeaderValue,
    timestampHeader: now,
    toleranceSeconds: 300,
    nowSeconds: now + 400, // 400s later
  });
  assert.equal(resExpired.ok, false);
  assert.match(resExpired.reason, /Timestamp outside tolerance/);

  // 4. Future timestamp outside tolerance window
  const resFuture = verifySignature({
    secret,
    payload,
    signatureHeader: signed.hubHeaderValue,
    timestampHeader: now + 1000,
    toleranceSeconds: 300,
    nowSeconds: now,
  });
  assert.equal(resFuture.ok, false);
  assert.match(resFuture.reason, /Timestamp outside tolerance/);
});

// -------------------------------------------------------------
// 2. URL Validation & Security Constraints
// -------------------------------------------------------------
test("URL validation enforces valid protocols, ports, and blocks credentials", () => {
  // Valid HTTPS public endpoint
  const valid = validateWebhookUrl("https://api.example.com:8443/webhook/whatsapp");
  assert.equal(valid.protocol, "https:");
  assert.equal(valid.hostname, "api.example.com");
  assert.equal(valid.port, 8443);

  // Rejects invalid protocols
  assert.throws(() => validateWebhookUrl("ftp://api.example.com/webhook"), /Unsupported URL protocol/);
  assert.throws(() => validateWebhookUrl("file:///etc/passwd"), /Unsupported URL protocol/);
  assert.throws(() => validateWebhookUrl("javascript:alert(1)"), /Unsupported URL protocol/);

  // Rejects embedded credentials in URL
  assert.throws(
    () => validateWebhookUrl("https://admin:secret@api.example.com/webhook"),
    /Credentials \(username:password\) in webhook URLs are prohibited/
  );

  // Rejects invalid ports
  assert.throws(() => validateWebhookUrl("https://api.example.com:99999/hook"), /Invalid port/);

  // Rejects plain HTTP for remote public endpoints by default
  assert.throws(
    () => validateWebhookUrl("http://api.example.com/webhook"),
    /HTTPS is strictly required for remote public webhook endpoints/
  );
});

// -------------------------------------------------------------
// 3. IPv4 & IPv6 Classification and Normalization
// -------------------------------------------------------------
test("IP classification detects loopback, private LAN, link-local, and IPv4-mapped IPv6", () => {
  // 1. Loopback
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.0.1.5"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("93.184.216.34"), false);

  // 2. Private LAN (RFC 1918 / RFC 4193)
  assert.equal(isPrivateLan("10.0.0.1"), true);
  assert.equal(isPrivateLan("172.16.5.4"), true);
  assert.equal(isPrivateLan("192.168.1.100"), true);
  assert.equal(isPrivateLan("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateLan("fc00::1"), true);
  assert.equal(isPrivateLan("fd12:3456::1"), true);
  assert.equal(isPrivateLan("8.8.8.8"), false);

  // 3. Link-Local & Cloud Metadata (169.254.169.254)
  assert.equal(isLinkLocal("169.254.169.254"), true);
  assert.equal(isLinkLocal("169.254.1.1"), true);
  assert.equal(isLinkLocal("::ffff:169.254.169.254"), true);
  assert.equal(isLinkLocal("fe80::1"), true);
  assert.equal(isLinkLocal("1.1.1.1"), false);

  // 4. Normalized IP handles IPv4-mapped IPv6
  const mapped = normalizeIp("::ffff:192.168.1.50");
  assert.equal(mapped.version, 4);
  assert.equal(mapped.ip, "192.168.1.50");
});

test("isBlockedIp blocks special, multicast, carrier-grade NAT, and cloud metadata", () => {
  // AWS/GCP/Azure Metadata address ALWAYS blocked
  const metadata = isBlockedIp("169.254.169.254");
  assert.equal(metadata.blocked, true);
  assert.match(metadata.reason, /cloud metadata/);

  // Carrier-grade NAT (100.64.0.0/10)
  const cgnat = isBlockedIp("100.64.1.1");
  assert.equal(cgnat.blocked, true);
  assert.match(cgnat.reason, /Carrier-Grade NAT/);

  // Multicast & Broadcast
  assert.equal(isBlockedIp("224.0.0.1").blocked, true);
  assert.equal(isBlockedIp("255.255.255.255").blocked, true);
  assert.equal(isBlockedIp("ff02::1").blocked, true);

  // Public IP is not blocked
  assert.equal(isBlockedIp("93.184.216.34").blocked, false);
});

// -------------------------------------------------------------
// 4. Localhost and LAN Opt-In Policies
// -------------------------------------------------------------
test("Localhost and LAN destinations require explicit configuration opt-in", () => {
  // Localhost blocked without opt-in
  assert.throws(
    () => validateWebhookUrl("http://localhost:8080/webhook", { allowLocalhost: false }),
    /HTTP localhost endpoints are blocked by default/
  );
  assert.throws(
    () => validateWebhookUrl("http://127.0.0.1:8080/webhook", { allowLocalhost: false }),
    /HTTP localhost endpoints are blocked by default/
  );

  // Localhost allowed with explicit opt-in
  const localAllowed = validateWebhookUrl("http://localhost:8080/webhook", { allowLocalhost: true });
  assert.equal(localAllowed.isLocalhost, true);
  assert.equal(localAllowed.hostname, "localhost");

  // LAN blocked without opt-in
  assert.throws(
    () => validateWebhookUrl("http://192.168.1.50:8000/webhook", { allowLan: false }),
    /HTTP private LAN endpoints are blocked by default/
  );

  // LAN allowed with explicit opt-in
  const lanAllowed = validateWebhookUrl("http://192.168.1.50:8000/webhook", { allowLan: true });
  assert.equal(lanAllowed.hostname, "192.168.1.50");
});

// -------------------------------------------------------------
// 5. DNS Rebinding Protection & Redirect Policies
// -------------------------------------------------------------
test("resolveAndValidateDestination protects against DNS rebinding and resolves pinned IPs", async () => {
  // Mock DNS lookup returning safe public IP
  const mockPublicDns = async (hostname) => [{ address: "93.184.216.34", family: 4 }];
  const safeDest = await resolveAndValidateDestination(
    "https://api.example.com/webhook",
    {},
    mockPublicDns
  );
  assert.equal(safeDest.pinnedIp, "93.184.216.34");
  assert.deepEqual(safeDest.resolvedIps, ["93.184.216.34"]);

  // Mock DNS rebinding attack: public hostname resolving to internal private IP
  const mockRebindingDns = async (hostname) => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(
    async () => resolveAndValidateDestination("https://legit-looking-domain.com/hook", {}, mockRebindingDns),
    /Security violation \(SSRF\): Hostname "legit-looking-domain\.com" resolved to blocked IP 127\.0\.0\.1/
  );

  // Mock DNS resolving to cloud metadata IP
  const mockCloudMetaDns = async (hostname) => [{ address: "169.254.169.254", family: 4 }];
  await assert.rejects(
    async () => resolveAndValidateDestination("https://attacker-domain.com/hook", {}, mockCloudMetaDns),
    /Security violation \(SSRF\): Hostname "attacker-domain\.com" resolved to blocked IP 169\.254\.169\.254/
  );
});

test("validateRedirect disables redirects by default and enforces maxRedirects", () => {
  // Default maxRedirects is 0 (redirects rejected)
  assert.throws(
    () => validateRedirect("https://api.example.com/redirected", { maxRedirects: 0 }, 1),
    /Redirect rejected: maxRedirects \(0\) exceeded/
  );

  // When permitted up to 2, redirect 1 is validated
  const validated = validateRedirect("https://api.example.com/redirected", { maxRedirects: 2 }, 1);
  assert.equal(validated.url, "https://api.example.com/redirected");

  // Redirect count reaching limit is rejected
  assert.throws(
    () => validateRedirect("https://api.example.com/redirected", { maxRedirects: 2 }, 2),
    /Redirect rejected: maxRedirects \(2\) exceeded/
  );
});

// -------------------------------------------------------------
// 6. Endpoint CRUD, Secret Masking & Secret Rotation
// -------------------------------------------------------------
test("Endpoint CRUD, secret masking, and rotation", () => {
  const tmpDir = makeTempDir();
  try {
    // 1. Create Endpoint
    const created = createEndpoint(
      {
        url: "https://agent.example.com/webhook",
        name: "Production Agent",
        events: ["message.received", "message.ack"],
        privacy: { includeContent: true, includeSenderName: false },
      },
      tmpDir
    );

    assert.ok(created.id.startsWith("wh_"));
    assert.ok(created.secret.startsWith("whsec_"));
    assert.equal(created.name, "Production Agent");
    assert.deepEqual(created.events, ["message.received", "message.ack"]);
    assert.equal(created.privacy.includeSenderName, false);

    // 2. List endpoints: secrets MUST be masked
    const list = listEndpoints(tmpDir);
    assert.equal(list.length, 1);
    assert.notEqual(list[0].secret, created.secret);
    assert.match(list[0].secret, /^whsec_\*{8}[a-f0-9]{4}$/);

    // 3. Get single endpoint: secret masked by default
    const retrieved = getEndpoint(created.id, tmpDir);
    assert.notEqual(retrieved.secret, created.secret);
    assert.match(retrieved.secret, /^whsec_\*{8}[a-f0-9]{4}$/);

    // 4. Update endpoint
    const updated = updateEndpoint(
      created.id,
      {
        name: "Updated Agent Name",
        enabled: false,
        events: ["*"],
      },
      tmpDir
    );
    assert.equal(updated.name, "Updated Agent Name");
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.events, ["*"]);

    // 5. Secret rotation
    const originalSecret = created.secret;
    const rotated = rotateEndpointSecret(created.id, tmpDir);
    assert.ok(rotated.newSecret.startsWith("whsec_"));
    assert.notEqual(rotated.newSecret, originalSecret);
    assert.notEqual(rotated.endpoint.secret, rotated.newSecret); // masked in endpoint view

    // 6. Event subscription finder
    // Re-enable endpoint for event finding test
    updateEndpoint(created.id, { enabled: true }, tmpDir);
    const subscribers = findEndpointsForEvent("message.received", tmpDir);
    assert.equal(subscribers.length, 1);
    assert.equal(subscribers[0].id, created.id);
    assert.equal(subscribers[0].secret, rotated.newSecret); // Unmasked internal copy for dispatcher

    // 7. Delete endpoint
    const delRes = deleteEndpoint(created.id, tmpDir);
    assert.equal(delRes.ok, true);
    assert.equal(listEndpoints(tmpDir).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 7. Storage Permissions, Atomic Writes & Symlink Safety
// -------------------------------------------------------------
test("Storage permissions (0700/0600), atomic writes, and symlink protection", () => {
  const tmpDir = makeTempDir();
  try {
    ensureWebhookDir(tmpDir);

    // Verify directory mode on POSIX
    if (process.platform !== "win32") {
      const dirStat = fs.statSync(tmpDir);
      assert.equal(dirStat.mode & 0o777, PERMISSIONS.DIR_MODE);
    }

    // Create an endpoint to trigger persistence
    const ep = createEndpoint(
      { url: "https://secure.example.com/hook" },
      tmpDir
    );
    assert.ok(ep.id);

    const endpointsFile = getEndpointsFilePath(tmpDir);
    assert.ok(fs.existsSync(endpointsFile));

    // Verify file mode on POSIX
    if (process.platform !== "win32") {
      const fileStat = fs.statSync(endpointsFile);
      assert.equal(fileStat.mode & 0o777, PERMISSIONS.FILE_MODE);
    }

    // Symlink protection: if endpoints file is a symlink pointing outside, access must be blocked
    const symlinkDir = makeTempDir();
    try {
      const externalTarget = path.join(symlinkDir, "malicious.json");
      fs.writeFileSync(externalTarget, "{}", "utf8");

      const evilDir = makeTempDir();
      try {
        const symlinkPath = path.join(evilDir, "endpoints.json");
        fs.symlinkSync(externalTarget, symlinkPath);

        assert.throws(
          () => getEndpointsFilePath(evilDir),
          /Security violation: endpoints file is a symbolic link/
        );
      } finally {
        fs.rmSync(evilDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(symlinkDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
