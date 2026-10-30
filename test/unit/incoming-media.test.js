"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const {
  cleanMessageId,
  sanitizeFilename,
  getMediaDir,
  saveIncomingMedia,
  findCachedMedia,
  extractMediaInfo,
} = require("../../src/media/store");
const { parseArgs } = require("../../src/cli/args");
const { createMcpServer } = require("../../src/mcp/server");
const { WhatsAppMcpClient } = require("../../src/mcp/client");
const { DaemonServer } = require("../../src/daemon/server");
const { MessageRingBuffer } = require("../../src/mcp/ring-buffer");

test("cleanMessageId sanitizes WhatsApp message IDs for filesystem safety", () => {
  assert.equal(cleanMessageId("false_15551234567@c.us_3EB0ABC123"), "false_15551234567_c_us_3EB0ABC123");
  assert.equal(cleanMessageId("true_120363000000@g.us_3EB0XYZ:1"), "true_120363000000_g_us_3EB0XYZ_1");
  assert.equal(cleanMessageId(null), "unknown_msg");
});

test("sanitizeFilename removes path traversal, control characters, and illegal symbols", () => {
  // Path traversal prevention
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("..\\..\\Windows\\System32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeFilename("../test.png"), "test.png");

  // Null bytes and control characters
  assert.equal(sanitizeFilename("invoice\x00_2026.pdf"), "invoice_2026.pdf");

  // Illegal Windows & Linux characters: < > : " / \ | ? *
  assert.equal(sanitizeFilename("report:final*v1?.docx"), "report_final_v1.docx");

  // Fallback when empty or dots
  const fallback = sanitizeFilename("...", ".jpg");
  assert.ok(fallback.startsWith("media_"));
  assert.ok(fallback.endsWith(".jpg"));
});

test("extractMediaInfo normalizes image and document message properties", () => {
  const mockImageMsg = {
    id: { _serialized: "false_923001234567@c.us_3EB0IMG1", remote: "923001234567@c.us" },
    from: "923001234567@c.us",
    to: "me",
    fromMe: false,
    author: null,
    body: "Look at this screenshot",
    timestamp: 1729000100,
    hasMedia: true,
    type: "image",
    mimetype: "image/png",
    filename: null,
    size: 245000,
  };

  const imgInfo = extractMediaInfo(mockImageMsg);
  assert.equal(imgInfo.messageId, "false_923001234567@c.us_3EB0IMG1");
  assert.equal(imgInfo.chatId, "923001234567@c.us");
  assert.equal(imgInfo.hasMedia, true);
  assert.equal(imgInfo.type, "image");
  assert.equal(imgInfo.mimetype, "image/png");
  assert.equal(imgInfo.caption, "Look at this screenshot");
  assert.equal(imgInfo.filesize, 245000);
  assert.equal(imgInfo.downloaded, false);

  const mockDocMsg = {
    id: { _serialized: "false_120363000000@g.us_3EB0DOC1", remote: "120363000000@g.us" },
    from: "120363000000@g.us",
    to: "me",
    fromMe: false,
    author: "923009999999@c.us",
    body: "Monthly financial report",
    timestamp: 1729000200,
    hasMedia: true,
    type: "document",
    mimetype: "application/pdf",
    filename: "Financial_Report_Q3.pdf",
    size: 1542000,
  };

  const docInfo = extractMediaInfo(mockDocMsg);
  assert.equal(docInfo.messageId, "false_120363000000@g.us_3EB0DOC1");
  assert.equal(docInfo.chatId, "120363000000@g.us");
  assert.equal(docInfo.author, "923009999999@c.us");
  assert.equal(docInfo.hasMedia, true);
  assert.equal(docInfo.type, "document");
  assert.equal(docInfo.filename, "Financial_Report_Q3.pdf");
  assert.equal(docInfo.caption, "Monthly financial report");
  assert.equal(docInfo.filesize, 1542000);
});

test("saveIncomingMedia writes file to disk and detects caching", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-test-"));
  const sampleData = Buffer.from("fake-image-bytes-12345").toString("base64");

  const mediaObj = {
    mimetype: "image/png",
    data: sampleData,
    filename: "diagram.png",
    filesize: 22,
  };

  const saved = saveIncomingMedia("false_15551234567@c.us_3EB0SAVETEST", mediaObj, {
    outputDir: tmpDir,
    caption: "Diagram caption",
  });

  assert.ok(fs.existsSync(saved.filePath));
  assert.equal(saved.filename, "diagram.png");
  assert.equal(saved.mimetype, "image/png");
  assert.equal(saved.size, 22);
  assert.equal(saved.caption, "Diagram caption");
  assert.equal(saved.cached, false);

  // Check findCachedMedia detects it
  const cached = findCachedMedia("false_15551234567@c.us_3EB0SAVETEST", tmpDir);
  assert.ok(cached);
  assert.equal(cached.filePath, saved.filePath);
  assert.equal(cached.cached, true);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("saveIncomingMedia enforces size limits and rejects empty or oversized data", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-err-"));

  // Empty data
  assert.throws(
    () => saveIncomingMedia("msg1", { data: "", mimetype: "image/png" }, { outputDir: tmpDir }),
    /missing base64 data/i
  );

  // Oversized data
  const largeData = Buffer.alloc(100).toString("base64");
  assert.throws(
    () => saveIncomingMedia("msg2", { data: largeData, mimetype: "image/png" }, { outputDir: tmpDir, maxSize: 50 }),
    /exceeds limit/i
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("MessageRingBuffer getMedia filters media messages by type, chat, and timestamp", () => {
  const buffer = new MessageRingBuffer(20);

  buffer.push({
    id: "m_txt",
    hasMedia: false,
    body: "just text",
    timestamp: 1000,
  });

  buffer.push({
    id: "m_img",
    hasMedia: true,
    type: "image",
    mimetype: "image/jpeg",
    chatId: "15551234567@c.us",
    body: "photo caption",
    timestamp: 2000,
  });

  buffer.push({
    id: "m_doc",
    hasMedia: true,
    type: "document",
    mimetype: "application/pdf",
    chatId: "15559876543@c.us",
    filename: "contract.pdf",
    timestamp: 3000,
  });

  // All media
  const allMedia = buffer.getMedia();
  assert.equal(allMedia.length, 2);

  // Filter by type
  const images = buffer.getMedia({ type: "image" });
  assert.equal(images.length, 1);
  assert.equal(images[0].id, "m_img");

  const docs = buffer.getMedia({ type: "document" });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].id, "m_doc");

  // Filter by chatId
  const chatMedia = buffer.getMedia({ chatId: "15551234567" });
  assert.equal(chatMedia.length, 1);
  assert.equal(chatMedia[0].id, "m_img");

  // Filter by timestamp
  const recentMedia = buffer.getMedia({ sinceTimestamp: 2500 });
  assert.equal(recentMedia.length, 1);
  assert.equal(recentMedia[0].id, "m_doc");
});

test("DaemonServer handles /media/info, /media/download, and /media/recent", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-server-media-"));

  const mockService = {
    state: "ready",
    getMediaInfo: async ({ messageId }) => {
      if (messageId === "not_found") {
        return { ok: false, error: { code: "NOT_FOUND", message: "Not found" } };
      }
      return {
        ok: true,
        media: {
          messageId,
          type: "image",
          mimetype: "image/png",
          filename: "test.png",
          filesize: 1234,
          caption: "Test caption",
        },
      };
    },
    downloadMedia: async ({ messageId, outputDir, filename }) => {
      if (messageId === "fail_expired") {
        return { ok: false, error: { code: "MEDIA_EXPIRED", message: "Media is expired" } };
      }
      return {
        ok: true,
        messageId,
        filePath: path.join(tmpDir, "saved.png"),
        filename: filename || "saved.png",
        mimetype: "image/png",
        size: 1234,
        caption: "Test caption",
        cached: false,
      };
    },
    getRecentMedia: async ({ type, limit }) => {
      return [
        {
          messageId: "msg_1",
          type: "image",
          filename: "photo.jpg",
          caption: "Recent photo",
          timestamp: 1729000000,
        },
      ];
    },
  };

  const server = new DaemonServer({ service: mockService, token: "test_token" });
  const httpServer = http.createServer((req, res) => server.handle(req, res));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;

  const req = (urlPath, method = "GET", body = null) => {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, base);
      const options = {
        method,
        headers: { "x-wa-token": "test_token", "content-type": "application/json" },
      };
      const r = http.request(u, options, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(buf) }));
      });
      r.on("error", reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  };

  // Test /media/info
  const infoRes = await req("/media/info?messageId=valid_msg_1");
  assert.equal(infoRes.status, 200);
  assert.equal(infoRes.data.ok, true);
  assert.equal(infoRes.data.media.messageId, "valid_msg_1");

  const infoNotFound = await req("/media/info?messageId=not_found");
  assert.equal(infoNotFound.status, 404);
  assert.equal(infoNotFound.data.ok, false);

  // Test /media/download
  const dlRes = await req("/media/download", "POST", { messageId: "valid_msg_1" });
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.data.ok, true);
  assert.equal(dlRes.data.filename, "saved.png");

  const dlExpired = await req("/media/download", "POST", { messageId: "fail_expired" });
  assert.equal(dlExpired.status, 409);
  assert.equal(dlExpired.data.ok, false);
  assert.equal(dlExpired.data.error.code, "MEDIA_EXPIRED");

  // Test /media/recent
  const recRes = await req("/media/recent?limit=5");
  assert.equal(recRes.status, 200);
  assert.equal(recRes.data.ok, true);
  assert.equal(recRes.data.count, 1);
  assert.equal(recRes.data.media[0].filename, "photo.jpg");

  await new Promise((resolve) => httpServer.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("createMcpServer registers all 13 tools and handles incoming media tools", async () => {
  const mockClient = {
    getRecentMedia: async ({ chatId, type, limit }) => ({
      ok: true,
      count: 1,
      media: [{ messageId: "msg_media_1", type: "image", filename: "test.png", downloaded: false }],
    }),
    downloadMedia: async (messageId, { outputDir, filename } = {}) => {
      if (messageId === "fail") throw new Error("Download failed: expired");
      return {
        ok: true,
        messageId,
        filePath: "/tmp/test.png",
        filename: "test.png",
        mimetype: "image/png",
        size: 1024,
        caption: "Downloaded photo",
        cached: false,
      };
    },
    getMediaInfo: async (messageId) => {
      if (messageId === "fail") throw new Error("Message not found");
      return {
        ok: true,
        media: {
          messageId,
          type: "document",
          mimetype: "application/pdf",
          filename: "report.pdf",
          filesize: 2048,
          caption: "Q3 Report",
          downloaded: false,
        },
      };
    },
  };

  const { server } = createMcpServer({ client: mockClient });
  const tools = server._registeredTools;

  assert.equal(Object.keys(tools).length, 13);
  assert.ok(tools["whatsapp_search"]);
  assert.ok(tools["whatsapp_get_recent_media"]);
  assert.ok(tools["whatsapp_download_media"]);
  assert.ok(tools["whatsapp_get_media_info"]);

  // Test whatsapp_get_recent_media
  const recRes = await tools["whatsapp_get_recent_media"].handler({ type: "image", limit: 5 });
  assert.equal(recRes.isError, false);
  const recData = JSON.parse(recRes.content[0].text);
  assert.equal(recData.count, 1);
  assert.equal(recData.media[0].messageId, "msg_media_1");

  // Test whatsapp_download_media
  const dlRes = await tools["whatsapp_download_media"].handler({ messageId: "msg_media_1" });
  assert.equal(dlRes.isError, false);
  const dlData = JSON.parse(dlRes.content[0].text);
  assert.equal(dlData.filePath, "/tmp/test.png");

  // Test whatsapp_download_media failure
  const dlFail = await tools["whatsapp_download_media"].handler({ messageId: "fail" });
  assert.equal(dlFail.isError, true);
  const dlFailData = JSON.parse(dlFail.content[0].text);
  assert.ok(dlFailData.error.message.includes("Download failed"));

  // Test whatsapp_get_media_info
  const infoRes = await tools["whatsapp_get_media_info"].handler({ messageId: "msg_media_1" });
  assert.equal(infoRes.isError, false);
  const infoData = JSON.parse(infoRes.content[0].text);
  assert.equal(infoData.media.filename, "report.pdf");
});

test("parseArgs recognizes media and download-media commands", () => {
  const r1 = parseArgs(["media", "--chat", "15551234567", "--type", "image"]);
  assert.equal(r1.command, "media");
  assert.equal(r1.flags.chat, "15551234567");
  assert.equal(r1.flags.type, "image");

  const r2 = parseArgs(["download-media", "false_15551234567@c.us_3EB0XYZ", "--out", "/tmp/file.pdf"]);
  assert.equal(r2.command, "download-media");
  assert.equal(r2.positional[0], "false_15551234567@c.us_3EB0XYZ");
  assert.equal(r2.flags.out, "/tmp/file.pdf");

  const r3 = parseArgs(["download", "false_15551234567@c.us_3EB0XYZ"]);
  assert.equal(r3.command, "download");
  assert.equal(r3.positional[0], "false_15551234567@c.us_3EB0XYZ");
});
