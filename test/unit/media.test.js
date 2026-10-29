"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const {
  validateFile,
  loadMessageMedia,
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOCUMENT_SIZE_BYTES,
} = require("../../src/media");
const { DaemonServer } = require("../../src/daemon/server");
const { parseArgs } = require("../../src/cli/args");
const { TOKEN_HEADER } = require("../../src/ipc/token");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-test-"));
}

test("validateFile validates existing regular files and detects MIME types", (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const imgPath = path.join(tmpDir, "test.png");
  // 1x1 transparent PNG base64 decoded
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(imgPath, pngBytes);

  const docPath = path.join(tmpDir, "sample.pdf");
  fs.writeFileSync(docPath, "%PDF-1.4 sample content");

  // Valid image
  const imgValid = validateFile(imgPath, { isImage: true });
  assert.equal(imgValid.filename, "test.png");
  assert.equal(imgValid.mimetype, "image/png");
  assert.equal(imgValid.size, pngBytes.length);

  // Valid document
  const docValid = validateFile(docPath, { isDocument: true });
  assert.equal(docValid.filename, "sample.pdf");
  assert.equal(docValid.mimetype, "application/pdf");
  assert.ok(docValid.size > 0);

  // Custom filename
  const customDoc = validateFile(docPath, { isDocument: true, filename: "renamed.pdf" });
  assert.equal(customDoc.filename, "renamed.pdf");
});

test("validateFile enforces security checks and size limits", (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Non-existent file
  assert.throws(
    () => validateFile(path.join(tmpDir, "ghost.png")),
    /File not found/
  );

  // Directory check
  assert.throws(
    () => validateFile(tmpDir),
    /Path is not a regular file/
  );

  // Empty file (0 bytes)
  const emptyPath = path.join(tmpDir, "empty.png");
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  assert.throws(
    () => validateFile(emptyPath),
    /File is empty \(0 bytes\)/
  );

  // Non-image as image
  const txtPath = path.join(tmpDir, "notes.txt");
  fs.writeFileSync(txtPath, "Hello text");
  assert.throws(
    () => validateFile(txtPath, { isImage: true }),
    /not a supported image format/
  );

  // Size limit check
  const bigPath = path.join(tmpDir, "big.png");
  fs.writeFileSync(bigPath, Buffer.alloc(500));
  assert.throws(
    () => validateFile(bigPath, { isImage: true, maxSize: 200 }),
    /exceeds the maximum allowed limit/
  );
});

test("loadMessageMedia creates MessageMedia instances", (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const imgPath = path.join(tmpDir, "test.jpg");
  fs.writeFileSync(imgPath, Buffer.from("fake jpeg content"));

  const mediaFromFile = loadMessageMedia({ filePath: imgPath, isImage: true });
  assert.equal(mediaFromFile.mimetype, "image/jpeg");
  assert.equal(mediaFromFile.filename, "test.jpg");
  assert.ok(mediaFromFile.data.length > 0);

  const mediaFromData = loadMessageMedia({
    data: "aGVsbG8=",
    filename: "test.txt",
    mimetype: "text/plain",
  });
  assert.equal(mediaFromData.mimetype, "text/plain");
  assert.equal(mediaFromData.filename, "test.txt");
  assert.equal(mediaFromData.data, "aGVsbG8=");
});

test("DaemonServer handles POST /send-media", async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const imgPath = path.join(tmpDir, "photo.png");
  fs.writeFileSync(imgPath, Buffer.from("png data"));

  let lastSent = null;
  const mockService = {
    state: "ready",
    sendMedia: async ({ to, media, options }) => {
      lastSent = { to, media, options };
      return {
        ok: true,
        to,
        messageId: "media_msg_123",
        filename: media.filename,
        mimetype: media.mimetype,
      };
    },
  };

  const server = new DaemonServer({ service: mockService });
  const port = await server.start();
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${port}`;
  const token = server.token;
  const headers = {
    [TOKEN_HEADER]: token,
    "content-type": "application/json",
  };

  // Test successful send media
  const res = await fetch(`${base}/send-media`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: "15551234567@c.us",
      filePath: imgPath,
      caption: "A nice photo",
      isImage: true,
    }),
  }).then((r) => r.json());

  assert.equal(res.ok, true);
  assert.equal(res.messageId, "media_msg_123");
  assert.equal(lastSent.to, "15551234567@c.us");
  assert.equal(lastSent.options.caption, "A nice photo");
  assert.equal(lastSent.media.filename, "photo.png");

  // Test missing recipient
  const failRes = await fetch(`${base}/send-media`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filePath: imgPath }),
  }).then((r) => r.json());

  assert.equal(failRes.ok, false);
  assert.equal(failRes.error.code, "BAD_REQUEST");

  // Test non-existent file
  const notFoundRes = await fetch(`${base}/send-media`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to: "15551234567@c.us", filePath: "/non/existent/file.png" }),
  }).then((r) => r.json());

  assert.equal(notFoundRes.ok, false);
  assert.equal(notFoundRes.error.code, "INVALID_MEDIA");
});

test("parseArgs recognizes send-image and send-file commands", () => {
  const r1 = parseArgs(["send-image", "15551234567", "./photo.jpg", "A caption"]);
  assert.equal(r1.command, "send-image");
  assert.deepEqual(r1.positional, ["15551234567", "./photo.jpg", "A caption"]);

  const r2 = parseArgs(["send-file", "15551234567", "./report.pdf", "--name=annual.pdf"]);
  assert.equal(r2.command, "send-file");
  assert.equal(r2.flags.name, "annual.pdf");
  assert.deepEqual(r2.positional, ["15551234567", "./report.pdf"]);
});
