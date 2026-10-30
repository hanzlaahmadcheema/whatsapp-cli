"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  saveIncomingMedia,
  findCachedMedia,
  verifyMediaIntegrity,
  getMediaStorageStats,
  cleanMediaStorage,
  pinMedia,
  isMediaPinned,
  computeFileSha256,
  sanitizeFilename,
} = require("../../src/media/store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-test-"));
}

test("SHA-256 calculation, storage, and integrity verification", () => {
  const tmpDir = makeTempDir();
  try {
    const rawData = "WhatsApp test file content for SHA-256 verification";
    const base64Data = Buffer.from(rawData).toString("base64");
    const expectedHash = crypto.createHash("sha256").update(Buffer.from(rawData)).digest("hex");

    const saved = saveIncomingMedia(
      "msg_hash_test_1",
      { data: base64Data, filename: "report.pdf", mimetype: "application/pdf" },
      { outputDir: tmpDir }
    );

    assert.equal(saved.sha256, expectedHash);
    assert.equal(saved.size, rawData.length);
    assert.ok(fs.existsSync(saved.filePath));

    // Verify disk integrity
    const integrity = verifyMediaIntegrity(saved, tmpDir);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.sha256, expectedHash);
    assert.equal(integrity.size, rawData.length);

    // Verify findCachedMedia returns valid cached media
    const cached = findCachedMedia("msg_hash_test_1", tmpDir);
    assert.ok(cached);
    assert.equal(cached.cached, true);
    assert.equal(cached.sha256, expectedHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Corruption detection and cache auto-healing / purging", () => {
  const tmpDir = makeTempDir();
  try {
    const rawData = "Legitimate document content before tampering";
    const base64Data = Buffer.from(rawData).toString("base64");

    const saved = saveIncomingMedia(
      "msg_corrupt_test_1",
      { data: base64Data, filename: "contract.docx", mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { outputDir: tmpDir }
    );

    assert.ok(fs.existsSync(saved.filePath));

    // Tamper with the file on disk (same length, different bytes -> triggers hash_mismatch)
    const tampered = Buffer.from(rawData);
    tampered[0] = tampered[0] === 0x41 ? 0x42 : 0x41;
    fs.writeFileSync(saved.filePath, tampered);

    // verifyMediaIntegrity should detect hash mismatch
    const integrity = verifyMediaIntegrity(saved, tmpDir);
    assert.equal(integrity.ok, false);
    assert.equal(integrity.reason, "hash_mismatch");

    // findCachedMedia with purgeCorrupt should delete the corrupted file and return null
    const cached = findCachedMedia("msg_corrupt_test_1", tmpDir, { purgeCorrupt: true });
    assert.equal(cached, null);
    assert.equal(fs.existsSync(saved.filePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Storage statistics categorization, file counts, and age tracking", () => {
  const tmpDir = makeTempDir();
  try {
    // Create fixtures for categories
    // 1. Image
    saveIncomingMedia(
      "msg_stat_img",
      { data: Buffer.from("fake image bytes").toString("base64"), filename: "photo.jpg", mimetype: "image/jpeg" },
      { outputDir: tmpDir }
    );

    // 2. Document
    saveIncomingMedia(
      "msg_stat_doc",
      { data: Buffer.from("fake pdf content 123456").toString("base64"), filename: "paper.pdf", mimetype: "application/pdf" },
      { outputDir: tmpDir }
    );

    // 3. Audio
    saveIncomingMedia(
      "msg_stat_audio",
      { data: Buffer.from("voice note 123").toString("base64"), filename: "voice.ogg", mimetype: "audio/ogg" },
      { outputDir: tmpDir }
    );

    // 4. Video
    saveIncomingMedia(
      "msg_stat_video",
      { data: Buffer.from("video stream sample").toString("base64"), filename: "clip.mp4", mimetype: "video/mp4" },
      { outputDir: tmpDir }
    );

    const stats = getMediaStorageStats(tmpDir);

    assert.equal(stats.totalFiles, 4);
    assert.ok(stats.totalBytes > 0);
    assert.equal(stats.categories.images.count, 1);
    assert.equal(stats.categories.documents.count, 1);
    assert.equal(stats.categories.audio.count, 1);
    assert.equal(stats.categories.videos.count, 1);
    assert.equal(stats.categories.other.count, 0);

    assert.ok(stats.newestFile);
    assert.ok(stats.oldestFile);
    assert.equal(stats.cache.verifiedFiles >= 4, true);
    assert.equal(stats.cache.corruptedFiles, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Retention and cleanup: default is dry-run, preserves files", () => {
  const tmpDir = makeTempDir();
  try {
    saveIncomingMedia(
      "msg_clean_dryrun",
      { data: Buffer.from("test cleanup dry run").toString("base64"), filename: "old.txt", mimetype: "text/plain" },
      { outputDir: tmpDir }
    );

    // Default cleanMediaStorage (no dryRun flag specified -> defaults to dryRun: true)
    const result = cleanMediaStorage({
      olderThanDays: 0, // Targets all files
      customDir: tmpDir,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.deletedCount, 1);
    assert.ok(result.deletedBytes > 0);

    // File MUST still exist on disk!
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Retention and cleanup: age pruning and storage quota enforcement with apply: true", () => {
  const tmpDir = makeTempDir();
  try {
    // Create 3 files with different sizes and timestamps
    const file1 = saveIncomingMedia(
      "msg_quota_1",
      { data: Buffer.from("AAA ".repeat(100)).toString("base64"), filename: "f1.txt", mimetype: "text/plain" },
      { outputDir: tmpDir }
    );
    const file2 = saveIncomingMedia(
      "msg_quota_2",
      { data: Buffer.from("BBB ".repeat(100)).toString("base64"), filename: "f2.txt", mimetype: "text/plain" },
      { outputDir: tmpDir }
    );
    const file3 = saveIncomingMedia(
      "msg_quota_3",
      { data: Buffer.from("CCC ".repeat(100)).toString("base64"), filename: "f3.txt", mimetype: "text/plain" },
      { outputDir: tmpDir }
    );

    // Artificially age file1 to 40 days ago
    const past40Days = new Date(Date.now() - 40 * 86400 * 1000);
    fs.utimesSync(file1.filePath, past40Days, past40Days);

    // Artificially age file2 to 20 days ago
    const past20Days = new Date(Date.now() - 20 * 86400 * 1000);
    fs.utimesSync(file2.filePath, past20Days, past20Days);

    // Clean files older than 30 days with apply: true
    const cleanResult = cleanMediaStorage({
      olderThanDays: 30,
      apply: true,
      customDir: tmpDir,
    });

    assert.equal(cleanResult.dryRun, false);
    assert.equal(cleanResult.deletedCount, 1);
    assert.equal(cleanResult.files[0].messageId, "msg_quota_1");

    // file1 must be deleted, file2 and file3 must remain
    assert.equal(fs.existsSync(file1.filePath), false);
    assert.equal(fs.existsSync(file2.filePath), true);
    assert.equal(fs.existsSync(file3.filePath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Pinned media is strictly immune from automated deletion", () => {
  const tmpDir = makeTempDir();
  try {
    const file1 = saveIncomingMedia(
      "msg_pinned_1",
      { data: Buffer.from("Important confidential pinned document").toString("base64"), filename: "vital.pdf", mimetype: "application/pdf" },
      { outputDir: tmpDir, pinned: true }
    );

    const file2 = saveIncomingMedia(
      "msg_unpinned_1",
      { data: Buffer.from("Ephemeral unpinned attachment").toString("base64"), filename: "temp.txt", mimetype: "text/plain" },
      { outputDir: tmpDir, pinned: false }
    );

    // Explicitly pin file1 in index
    pinMedia("msg_pinned_1", true);
    assert.equal(isMediaPinned("msg_pinned_1"), true);
    assert.equal(isMediaPinned("msg_unpinned_1"), false);

    // Make both files 100 days old
    const past100Days = new Date(Date.now() - 100 * 86400 * 1000);
    fs.utimesSync(file1.filePath, past100Days, past100Days);
    fs.utimesSync(file2.filePath, past100Days, past100Days);

    // Run aggressive cleanup with apply: true
    const cleanResult = cleanMediaStorage({
      olderThanDays: 1,
      apply: true,
      customDir: tmpDir,
    });

    assert.equal(cleanResult.deletedCount, 1);
    assert.equal(cleanResult.skippedPinnedCount, 1);
    assert.equal(cleanResult.files[0].messageId, "msg_unpinned_1");

    // Pinned file MUST survive!
    assert.equal(fs.existsSync(file1.filePath), true);
    // Unpinned file must be deleted!
    assert.equal(fs.existsSync(file2.filePath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Filesystem safety: directory permissions (0700) and file permissions (0600)", () => {
  const tmpDir = makeTempDir();
  try {
    const saved = saveIncomingMedia(
      "msg_perm_test",
      { data: Buffer.from("Secure file permissions test").toString("base64"), filename: "secret.key", mimetype: "application/octet-stream" },
      { outputDir: tmpDir }
    );

    const dirStat = fs.statSync(tmpDir);
    const fileStat = fs.statSync(saved.filePath);

    // On POSIX systems, verify permission bits (0700 for dir, 0600 for file)
    if (process.platform !== "win32") {
      const dirMode = dirStat.mode & 0o777;
      const fileMode = fileStat.mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Filesystem safety: symlink immunity and directory traversal prevention", () => {
  const tmpDir = makeTempDir();
  const externalDir = makeTempDir();
  try {
    // 1. Filename sanitization neutralizes path traversal across OSes
    assert.equal(sanitizeFilename("../../etc/shadow"), "shadow");
    assert.equal(sanitizeFilename("..\\..\\Windows\\System32\\cmd.exe"), "cmd.exe");

    // 2. Destination path escaping target directory throws Security violation
    assert.throws(
      () => {
        saveIncomingMedia(
          "msg_escape_1",
          { data: Buffer.from("bad").toString("base64"), filename: "test.txt" },
          { outputDir: tmpDir, destinationPath: path.resolve(tmpDir, "../../outside.txt") }
        );
      },
      /Security violation/
    );

    // 3. Symlink immunity during integrity check and cleanup
    if (process.platform !== "win32") {
      const realExternalFile = path.join(externalDir, "secret_external.txt");
      fs.writeFileSync(realExternalFile, "Important host file");

      const symlinkInMediaDir = path.join(tmpDir, "symlink_test.txt");
      fs.symlinkSync(realExternalFile, symlinkInMediaDir);

      // verifyMediaIntegrity must reject symlinks
      const integrity = verifyMediaIntegrity({ filePath: symlinkInMediaDir }, tmpDir);
      assert.equal(integrity.ok, false);
      assert.equal(integrity.reason, "symlink_detected");

      // cleanMediaStorage must NEVER delete the symlinked external file
      const cleanResult = cleanMediaStorage({
        olderThanDays: 0,
        apply: true,
        customDir: tmpDir,
      });

      assert.equal(cleanResult.deletedCount, 0);
      assert.equal(fs.existsSync(realExternalFile), true);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("Daemon HTTP server endpoints: /media/stats and /media/clean", async (t) => {
  const { EventEmitter } = require("events");
  const { setClientFactory } = require("../../src/whatsapp/client");
  const { WhatsAppService } = require("../../src/daemon/service");
  const { DaemonServer } = require("../../src/daemon/server");
  const { STATE } = require("../../src/ipc/protocol");
  const { TOKEN_HEADER } = require("../../src/ipc/token");

  const mock = new EventEmitter();
  mock.initialize = async () => {};
  setClientFactory(() => mock);

  const service = new WhatsAppService({});
  service.state = STATE.READY;

  const server = new DaemonServer({ service });
  const port = await server.start();
  t.after(() => {
    server.stop();
    service.stop();
  });

  const base = `http://127.0.0.1:${port}`;
  const h = { [TOKEN_HEADER]: server.token };

  // 1. GET /media/stats
  const statsRes = await fetch(`${base}/media/stats`, { headers: h }).then((r) => r.json());
  assert.equal(statsRes.ok, true);
  assert.ok(statsRes.stats);
  assert.ok(typeof statsRes.stats.totalFiles === "number");
  assert.ok(statsRes.stats.categories.images);
  assert.ok(statsRes.stats.categories.documents);

  // 2. POST /media/clean with dry-run default
  const cleanRes = await fetch(`${base}/media/clean`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ olderThanDays: 365 }),
  }).then((r) => r.json());

  assert.equal(cleanRes.ok, true);
  assert.equal(cleanRes.result.dryRun, true);
  assert.ok(typeof cleanRes.result.deletedCount === "number");

  // 3. Unauthorized request rejection
  const unauth = await fetch(`${base}/media/stats`).then((r) => r.json());
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error.code, "UNAUTHORIZED");
});
