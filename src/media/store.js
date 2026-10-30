"use strict";

const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { paths } = require("../config/paths");
const { MAX_DOCUMENT_SIZE_BYTES } = require("./constants");

const MEDIA_INDEX_FILE = path.join(paths.dataDir, "media_index.json");

/**
 * Clean a WhatsApp message ID for safe filesystem use.
 * e.g., 'false_15551234567@c.us_3EB0ABC123' -> 'false_15551234567_c_us_3EB0ABC123'
 */
function cleanMessageId(messageId) {
  if (!messageId || typeof messageId !== "string") return "unknown_msg";
  return messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Sanitize a filename to prevent path traversal and illegal character issues across OSes.
 */
function sanitizeFilename(originalName, fallbackExt = "") {
  if (!originalName || typeof originalName !== "string") {
    const ext = fallbackExt ? (fallbackExt.startsWith(".") ? fallbackExt : `.${fallbackExt}`) : "";
    return `media_${Date.now()}${ext}`;
  }

  // Strip directory paths (prevents path traversal across POSIX and Windows separators)
  let base = path.basename(originalName.trim().replace(/\\/g, "/"));

  // Remove null bytes and control characters
  base = base.replace(/[\x00-\x1f\x7f]/g, "");

  // Remove illegal filename characters across Windows, Linux, and macOS: < > : " / \ | ? *
  base = base.replace(/[<>:"/\\|?*]/g, "_");

  // Collapse repeated underscores or spaces
  base = base.replace(/[_\s]+/g, "_");

  // Trim leading/trailing dots, underscores, spaces
  base = base.replace(/^[._\s]+|[._\s]+$/g, "");

  if (!base) {
    const ext = fallbackExt ? (fallbackExt.startsWith(".") ? fallbackExt : `.${fallbackExt}`) : "";
    return `media_${Date.now()}${ext}`;
  }

  // Bound filename length to 100 chars while preserving extension and trimming trailing punctuation
  const ext = path.extname(base);
  let nameWithoutExt = path.basename(base, ext).replace(/^[._\s]+|[._\s]+$/g, "");
  if (!nameWithoutExt) nameWithoutExt = "media";
  if (nameWithoutExt.length > 100) {
    nameWithoutExt = nameWithoutExt.slice(0, 100);
  }
  base = `${nameWithoutExt}${ext}`;

  return base;
}

/**
 * Resolve the media download directory.
 */
function getMediaDir(customDir = null) {
  const dir = customDir
    ? path.resolve(customDir)
    : process.env.WA_MEDIA_DIR
      ? path.resolve(process.env.WA_MEDIA_DIR)
      : path.join(paths.dataDir, "media");

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Read the persistent media index (mapping messageId -> downloaded file info).
 */
function loadMediaIndex() {
  try {
    if (fs.existsSync(MEDIA_INDEX_FILE)) {
      const raw = fs.readFileSync(MEDIA_INDEX_FILE, "utf8");
      return JSON.parse(raw) || {};
    }
  } catch (_) {}
  return {};
}

/**
 * Update media index with newly downloaded media metadata.
 */
function recordMediaIndex(messageId, entry) {
  try {
    const index = loadMediaIndex();
    index[messageId] = {
      ...entry,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    // Prune index if it exceeds 500 items
    const keys = Object.keys(index);
    if (keys.length > 500) {
      const oldestKeys = keys.slice(0, keys.length - 500);
      for (const k of oldestKeys) {
        delete index[k];
      }
    }

    if (!fs.existsSync(paths.dataDir)) {
      fs.mkdirSync(paths.dataDir, { recursive: true });
    }
    fs.writeFileSync(MEDIA_INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
  } catch (_) {}
}

/**
 * Check if media for a message ID is already downloaded and present on disk.
 */
function findCachedMedia(messageId, customDir = null) {
  if (!messageId) return null;
  const index = loadMediaIndex();
  const entry = index[messageId];

  if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
    try {
      const stat = fs.statSync(entry.filePath);
      if (stat.isFile() && stat.size > 0) {
        return {
          ...entry,
          size: stat.size,
          cached: true,
        };
      }
    } catch (_) {}
  }

  // Fallback: check target directory directly by message ID prefix
  const targetDir = getMediaDir(customDir);
  const cleanId = cleanMessageId(messageId);
  try {
    const files = fs.readdirSync(targetDir);
    const match = files.find((f) => f.startsWith(`${cleanId}_`));
    if (match) {
      const fullPath = path.join(targetDir, match);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size > 0) {
        const detectedMime = mime.lookup(fullPath) || "application/octet-stream";
        const filename = match.slice(cleanId.length + 1) || match;
        const result = {
          messageId,
          filePath: fullPath,
          filename,
          mimetype: detectedMime,
          size: stat.size,
          cached: true,
        };
        recordMediaIndex(messageId, result);
        return result;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Save incoming base64 MessageMedia object to disk.
 */
function saveIncomingMedia(messageId, media, options = {}) {
  if (!messageId) throw new Error("Message ID is required to save media.");
  if (!media || !media.data || typeof media.data !== "string") {
    throw new Error("Invalid media object: missing base64 data.");
  }

  const targetDir = getMediaDir(options.outputDir);

  // Validate base64 buffer and size
  const buffer = Buffer.from(media.data, "base64");
  if (buffer.length === 0) {
    throw new Error("Downloaded media is empty (0 bytes).");
  }

  const maxSize = options.maxSize || MAX_DOCUMENT_SIZE_BYTES;
  if (buffer.length > maxSize) {
    throw new Error(`Downloaded media size (${buffer.length} bytes) exceeds limit of ${maxSize} bytes.`);
  }

  // Determine file extension
  let ext = "";
  if (options.overrideFilename) {
    ext = path.extname(options.overrideFilename);
  } else if (media.filename) {
    ext = path.extname(media.filename);
  }
  if (!ext && media.mimetype) {
    const guessedExt = mime.extension(media.mimetype);
    if (guessedExt) ext = `.${guessedExt}`;
  }

  // Determine sanitized filename
  const cleanId = cleanMessageId(messageId);
  const rawBaseName = options.overrideFilename || media.filename || `attachment${ext}`;
  const safeBaseName = sanitizeFilename(rawBaseName, ext);
  const finalFilename = `${cleanId}_${safeBaseName}`;
  const destinationPath = path.join(targetDir, finalFilename);

  // Path traversal safety check
  const resolvedDest = path.resolve(destinationPath);
  const resolvedDir = path.resolve(targetDir);
  if (!resolvedDest.startsWith(resolvedDir)) {
    throw new Error(`Security violation: Destination path "${destinationPath}" escapes target directory.`);
  }

  // Write file to disk
  fs.writeFileSync(destinationPath, buffer, { mode: 0o600 });

  const result = {
    messageId,
    filePath: destinationPath,
    filename: safeBaseName,
    mimetype: media.mimetype || mime.lookup(destinationPath) || "application/octet-stream",
    size: buffer.length,
    caption: options.caption || "",
    chatId: options.chatId || null,
    sender: options.sender || null,
    timestamp: options.timestamp || Math.floor(Date.now() / 1000),
    cached: false,
  };

  recordMediaIndex(messageId, result);
  return result;
}

/**
 * Extract normalized media metadata from a WhatsApp Web message object.
 */
function extractMediaInfo(msg) {
  if (!msg) return null;
  const id = (msg.id && (msg.id._serialized || msg.id)) || null;
  const isFromMe = Boolean(msg.fromMe || (msg.id && msg.id.fromMe));
  const chatId = (msg.id && msg.id.remote) || (isFromMe ? msg.to : msg.from) || msg.from || null;

  const cached = id ? findCachedMedia(id) : null;

  return {
    messageId: id,
    chatId,
    from: isFromMe ? "me" : msg.from,
    to: msg.to || null,
    author: msg.author || null,
    fromMe: isFromMe,
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    hasMedia: Boolean(msg.hasMedia),
    type: msg.type || (msg.hasMedia ? "media" : "chat"),
    mimetype: msg.mimetype || (cached && cached.mimetype) || null,
    filename: msg.filename || (cached && cached.filename) || null,
    filesize: msg.size || msg.filesize || (cached && cached.size) || null,
    caption: msg.hasMedia ? msg.body || "" : "",
    downloaded: Boolean(cached),
    filePath: (cached && cached.filePath) || null,
  };
}

module.exports = {
  cleanMessageId,
  sanitizeFilename,
  getMediaDir,
  loadMediaIndex,
  findCachedMedia,
  saveIncomingMedia,
  extractMediaInfo,
};
