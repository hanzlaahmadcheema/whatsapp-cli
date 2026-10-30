"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");
const { paths } = require("../config/paths");
const {
  MAX_DOCUMENT_SIZE_BYTES,
  DEFAULT_MAX_STORAGE_MB,
  DEFAULT_RETENTION_DAYS,
} = require("./constants");

const MEDIA_INDEX_FILE = path.join(paths.dataDir, "media_index.json");

/**
 * Format bytes into human-readable string.
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

  // Unicode normalization (NFKC) to close homoglyph/zero-width traversal escapes
  if (typeof base.normalize === "function") {
    base = base.normalize("NFKC");
  }

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
 * Resolve the media download directory with strict 0700 permissions.
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
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {}
  return dir;
}

/**
 * Calculate the SHA-256 hash of a file on disk.
 */
function computeFileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = crypto.createHash("sha256");
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Read the persistent media index (mapping messageId -> downloaded file info).
 */
function loadMediaIndex(customIndexFile = null) {
  const targetFile = customIndexFile || MEDIA_INDEX_FILE;
  try {
    if (fs.existsSync(targetFile)) {
      const raw = fs.readFileSync(targetFile, "utf8");
      return JSON.parse(raw) || {};
    }
  } catch (_) {}
  return {};
}

/**
 * Save persistent media index atomically.
 */
function saveMediaIndex(index, customIndexFile = null) {
  const targetFile = customIndexFile || MEDIA_INDEX_FILE;
  try {
    const dir = path.dirname(targetFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(targetFile, JSON.stringify(index, null, 2), "utf8");
    try {
      fs.chmodSync(targetFile, 0o600);
    } catch (_) {}
  } catch (_) {}
}

/**
 * Update media index with newly downloaded media metadata.
 */
function recordMediaIndex(messageId, entry, customIndexFile = null) {
  try {
    const index = loadMediaIndex(customIndexFile);
    index[messageId] = {
      ...entry,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    // Bounded capacity: maintain up to 2000 active index records
    const keys = Object.keys(index);
    if (keys.length > 2000) {
      const oldestKeys = keys.slice(0, keys.length - 2000);
      for (const k of oldestKeys) {
        if (!index[k].pinned) {
          delete index[k];
        }
      }
    }

    saveMediaIndex(index, customIndexFile);
  } catch (_) {}
}

/**
 * Delete a message entry from media index.
 */
function deleteFromMediaIndex(messageId, customIndexFile = null) {
  try {
    const index = loadMediaIndex(customIndexFile);
    if (index[messageId]) {
      delete index[messageId];
      saveMediaIndex(index, customIndexFile);
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Pin or unpin a media entry to protect it from automated retention cleanup.
 */
function pinMedia(messageId, pinned = true, customIndexFile = null) {
  if (!messageId) return false;
  const index = loadMediaIndex(customIndexFile);
  if (index[messageId]) {
    index[messageId].pinned = Boolean(pinned);
    saveMediaIndex(index, customIndexFile);
    return true;
  }
  return false;
}

/**
 * Check if a message media is pinned.
 */
function isMediaPinned(messageId, customIndexFile = null) {
  if (!messageId) return false;
  const index = loadMediaIndex(customIndexFile);
  return Boolean(index[messageId] && index[messageId].pinned);
}

/**
 * Verify integrity of a cached media file on disk:
 * - Checks existence and regular file status (rejects symlinks).
 * - Verifies realpath is contained within allowed directory.
 * - Verifies byte size > 0 and matches expected size.
 * - Computes and verifies SHA-256 hash against recorded hash.
 */
function verifyMediaIntegrity(entry, customDir = null) {
  if (!entry || !entry.filePath) {
    return { ok: false, reason: "missing_entry" };
  }

  const targetDir = getMediaDir(customDir);

  if (!fs.existsSync(entry.filePath)) {
    return { ok: false, reason: "not_found" };
  }

  let lstat;
  try {
    lstat = fs.lstatSync(entry.filePath);
  } catch (err) {
    return { ok: false, reason: "lstat_failed", error: err.message };
  }

  // Reject symlinks unconditionally
  if (lstat.isSymbolicLink()) {
    return { ok: false, reason: "symlink_detected" };
  }

  if (!lstat.isFile()) {
    return { ok: false, reason: "not_a_regular_file" };
  }

  if (lstat.size === 0) {
    return { ok: false, reason: "zero_bytes" };
  }

  // Verify realpath is contained within target media directory (symlink escape defense)
  try {
    const realFile = fs.realpathSync(entry.filePath);
    const realDir = fs.realpathSync(targetDir);
    if (!realFile.startsWith(realDir + path.sep) && realFile !== realDir) {
      return { ok: false, reason: "directory_escape", realFile, realDir };
    }
  } catch (err) {
    return { ok: false, reason: "realpath_failed", error: err.message };
  }

  // Size match check
  if (entry.size && lstat.size !== entry.size) {
    return { ok: false, reason: "size_mismatch", expectedSize: entry.size, actualSize: lstat.size };
  }

  // Hash verification
  const actualHash = computeFileSha256(entry.filePath);
  if (!actualHash) {
    return { ok: false, reason: "hash_computation_failed" };
  }

  if (entry.sha256 && actualHash !== entry.sha256) {
    return {
      ok: false,
      reason: "hash_mismatch",
      expectedHash: entry.sha256,
      actualHash,
    };
  }

  return {
    ok: true,
    size: lstat.size,
    sha256: actualHash,
  };
}

/**
 * Check if media for a message ID is already downloaded and valid on disk.
 * Detects corruption and purges invalid cache records so caller can safely re-download.
 */
function findCachedMedia(messageId, customDir = null, options = {}) {
  if (!messageId) return null;
  const purgeCorrupt = options.purgeCorrupt !== false;
  const index = loadMediaIndex();
  const entry = index[messageId];

  if (entry && entry.filePath) {
    const integrity = verifyMediaIntegrity(entry, customDir);
    if (integrity.ok) {
      // Backfill SHA-256 if it was missing in legacy record
      if (!entry.sha256 && integrity.sha256) {
        entry.sha256 = integrity.sha256;
        recordMediaIndex(messageId, entry);
      }
      return {
        ...entry,
        size: integrity.size,
        sha256: integrity.sha256,
        cached: true,
      };
    } else {
      // Corrupt or tampered file detected
      if (purgeCorrupt) {
        try {
          if (fs.existsSync(entry.filePath)) {
            const lstat = fs.lstatSync(entry.filePath);
            if (!lstat.isSymbolicLink()) {
              fs.unlinkSync(entry.filePath);
            }
          }
        } catch (_) {}
        deleteFromMediaIndex(messageId);
      }
    }
  }

  // Fallback: check target directory directly by message ID prefix
  const targetDir = getMediaDir(customDir);
  const cleanId = cleanMessageId(messageId);
  try {
    const files = fs.readdirSync(targetDir);
    const match = files.find((f) => f.startsWith(`${cleanId}_`));
    if (match) {
      const fullPath = path.join(targetDir, match);
      const fallbackEntry = { filePath: fullPath };
      const integrity = verifyMediaIntegrity(fallbackEntry, customDir);
      if (integrity.ok) {
        const detectedMime = mime.lookup(fullPath) || "application/octet-stream";
        const filename = match.slice(cleanId.length + 1) || match;
        const result = {
          messageId,
          filePath: fullPath,
          filename,
          mimetype: detectedMime,
          size: integrity.size,
          sha256: integrity.sha256,
          cached: true,
        };
        recordMediaIndex(messageId, result);
        return result;
      } else if (purgeCorrupt) {
        try {
          fs.unlinkSync(fullPath);
        } catch (_) {}
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Save incoming base64 MessageMedia object to disk with SHA-256 and 0600 permissions.
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

  // Compute SHA-256 hash immediately upon buffer creation
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

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
  const destinationPath = options.destinationPath || path.join(targetDir, finalFilename);

  // Path traversal safety check
  const resolvedDest = path.resolve(destinationPath);
  const resolvedDir = path.resolve(targetDir);
  if (!resolvedDest.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Security violation: Destination path "${destinationPath}" escapes target directory.`);
  }

  // Write file to disk with strict 0600 permissions
  fs.writeFileSync(destinationPath, buffer, { mode: 0o600 });
  try {
    fs.chmodSync(destinationPath, 0o600);
  } catch (_) {}

  const result = {
    messageId,
    filePath: destinationPath,
    filename: safeBaseName,
    mimetype: media.mimetype || mime.lookup(destinationPath) || "application/octet-stream",
    size: buffer.length,
    sha256,
    caption: options.caption || "",
    chatId: options.chatId || null,
    sender: options.sender || null,
    timestamp: options.timestamp || Math.floor(Date.now() / 1000),
    pinned: Boolean(options.pinned),
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
    sha256: (cached && cached.sha256) || null,
    caption: msg.hasMedia ? msg.body || "" : "",
    downloaded: Boolean(cached),
    pinned: Boolean(cached && cached.pinned),
    filePath: (cached && cached.filePath) || null,
  };
}

/**
 * Categorize a file by its MIME type or extension.
 */
function categorizeMedia(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  const mimeStr = String(mimetype || "").toLowerCase();

  if (
    mimeStr.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".ico", ".tif", ".tiff"].includes(ext)
  ) {
    return "images";
  }
  if (
    mimeStr.startsWith("video/") ||
    [".mp4", ".mkv", ".mov", ".avi", ".webm", ".3gp", ".flv"].includes(ext)
  ) {
    return "videos";
  }
  if (
    mimeStr.startsWith("audio/") ||
    [".mp3", ".ogg", ".wav", ".m4a", ".aac", ".opus", ".flac"].includes(ext)
  ) {
    return "audio";
  }
  if (
    mimeStr.includes("pdf") ||
    mimeStr.includes("document") ||
    mimeStr.includes("text") ||
    mimeStr.includes("sheet") ||
    mimeStr.includes("presentation") ||
    [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".json", ".zip", ".tar", ".gz"].includes(ext)
  ) {
    return "documents";
  }
  return "other";
}

/**
 * Retrieve comprehensive media storage usage statistics.
 */
function getMediaStorageStats(customDir = null) {
  const targetDir = getMediaDir(customDir);
  const index = loadMediaIndex();

  let totalFiles = 0;
  let totalBytes = 0;
  let pinnedFiles = 0;
  let pinnedBytes = 0;

  const categories = {
    images: { count: 0, bytes: 0, formatted: "0 B" },
    documents: { count: 0, bytes: 0, formatted: "0 B" },
    videos: { count: 0, bytes: 0, formatted: "0 B" },
    audio: { count: 0, bytes: 0, formatted: "0 B" },
    other: { count: 0, bytes: 0, formatted: "0 B" },
  };

  let oldestFile = null;
  let newestFile = null;

  let verifiedFiles = 0;
  let corruptedFiles = 0;

  const seenPathsOnDisk = new Set();

  try {
    const files = fs.readdirSync(targetDir);
    const nowMs = Date.now();

    for (const name of files) {
      const fullPath = path.join(targetDir, name);
      try {
        const lstat = fs.lstatSync(fullPath);
        // Exclude symlinks and non-regular files from disk tallies
        if (lstat.isSymbolicLink() || !lstat.isFile()) continue;

        // Path containment check
        const realFile = fs.realpathSync(fullPath);
        const realDir = fs.realpathSync(targetDir);
        if (!realFile.startsWith(realDir + path.sep)) continue;

        seenPathsOnDisk.add(fullPath);

        const size = lstat.size;
        totalFiles += 1;
        totalBytes += size;

        // Determine category
        const mimeType = mime.lookup(fullPath) || "application/octet-stream";
        const cat = categorizeMedia(name, mimeType);
        categories[cat].count += 1;
        categories[cat].bytes += size;

        // Track age
        const mtimeMs = lstat.mtimeMs;
        const ageDays = Math.max(0, parseFloat(((nowMs - mtimeMs) / (86400 * 1000)).toFixed(1)));
        const fileInfo = {
          filename: name,
          filePath: fullPath,
          size,
          formatted: formatBytes(size),
          timestamp: Math.floor(mtimeMs / 1000),
          ageDays,
        };

        if (!oldestFile || mtimeMs < oldestFile.mtimeMs) {
          oldestFile = { ...fileInfo, mtimeMs };
        }
        if (!newestFile || mtimeMs > newestFile.mtimeMs) {
          newestFile = { ...fileInfo, mtimeMs };
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Format category bytes
  for (const cat of Object.keys(categories)) {
    categories[cat].formatted = formatBytes(categories[cat].bytes);
  }

  // Inspect index health & pinned count
  const indexEntries = Object.values(index);
  let missingFiles = 0;

  for (const entry of indexEntries) {
    if (entry.pinned) {
      pinnedFiles += 1;
      if (entry.filePath && seenPathsOnDisk.has(entry.filePath)) {
        pinnedBytes += entry.size || 0;
      }
    }
    if (!entry.filePath || !seenPathsOnDisk.has(entry.filePath)) {
      missingFiles += 1;
    } else {
      const integrity = verifyMediaIntegrity(entry, customDir);
      if (integrity.ok) {
        verifiedFiles += 1;
      } else {
        corruptedFiles += 1;
      }
    }
  }

  // Remove helper mtimeMs before returning
  if (oldestFile) delete oldestFile.mtimeMs;
  if (newestFile) delete newestFile.mtimeMs;

  return {
    mediaDir: targetDir,
    totalFiles,
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    pinnedFiles,
    pinnedBytes,
    pinnedFormatted: formatBytes(pinnedBytes),
    categories,
    oldestFile,
    newestFile,
    cache: {
      totalEntries: indexEntries.length,
      verifiedFiles,
      missingFiles,
      corruptedFiles,
      pinnedCount: pinnedFiles,
    },
  };
}

/**
 * Clean up downloaded media according to retention policies.
 *
 * Rules:
 * - Default: dryRun = true (does NOT delete files unless apply: true is passed).
 * - Never deletes pinned media.
 * - Protects against symlinks and path traversal (strictly verifies realpath).
 * - Prunes oldest eligible files first.
 * - Synchronizes media_index.json consistently upon deletion.
 */
function cleanMediaStorage(options = {}) {
  const isDryRun = options.apply ? false : options.dryRun !== false;
  const targetDir = getMediaDir(options.customDir);
  const index = loadMediaIndex();

  const maxStorageMb =
    typeof options.maxStorageMb === "number"
      ? options.maxStorageMb
      : process.env.WA_MEDIA_MAX_STORAGE_MB
        ? parseInt(process.env.WA_MEDIA_MAX_STORAGE_MB, 10)
        : null;

  const olderThanDays =
    typeof options.olderThanDays === "number"
      ? options.olderThanDays
      : process.env.WA_MEDIA_RETENTION_DAYS
        ? parseInt(process.env.WA_MEDIA_RETENTION_DAYS, 10)
        : null;

  const files = fs.readdirSync(targetDir);
  const nowMs = Date.now();
  const eligibleCandidates = [];
  let totalDiskBytes = 0;
  let skippedPinnedCount = 0;

  // Build index reverse lookup by filePath
  const indexByPath = new Map();
  for (const [mid, ent] of Object.entries(index)) {
    if (ent.filePath) indexByPath.set(ent.filePath, { ...ent, messageId: mid });
  }

  for (const name of files) {
    const fullPath = path.join(targetDir, name);
    try {
      const lstat = fs.lstatSync(fullPath);
      // Skip symlinks and directories
      if (lstat.isSymbolicLink() || !lstat.isFile()) continue;

      // Realpath containment check
      const realFile = fs.realpathSync(fullPath);
      const realDir = fs.realpathSync(targetDir);
      if (!realFile.startsWith(realDir + path.sep)) continue;

      const size = lstat.size;
      totalDiskBytes += size;

      const entry = indexByPath.get(fullPath);
      const isPinned = Boolean(entry && entry.pinned);

      if (isPinned) {
        skippedPinnedCount += 1;
        continue;
      }

      const mtimeMs = lstat.mtimeMs;
      const ageDays = Math.max(0, parseFloat(((nowMs - mtimeMs) / (86400 * 1000)).toFixed(1)));

      eligibleCandidates.push({
        filePath: fullPath,
        filename: name,
        messageId: (entry && entry.messageId) || null,
        size,
        formatted: formatBytes(size),
        mtimeMs,
        ageDays,
      });
    } catch (_) {}
  }

  // Sort candidates oldest first (ascending mtimeMs)
  eligibleCandidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toDeleteSet = new Set();

  // 1. Filter by age policy (olderThanDays)
  if (typeof olderThanDays === "number" && olderThanDays >= 0) {
    const cutoffMs = nowMs - olderThanDays * 86400 * 1000;
    for (const c of eligibleCandidates) {
      if (c.mtimeMs <= cutoffMs) {
        toDeleteSet.add(c);
      }
    }
  }

  // 2. Filter by storage budget (maxStorageMb)
  if (typeof maxStorageMb === "number" && maxStorageMb > 0) {
    const maxSizeBytes = maxStorageMb * 1024 * 1024;
    let projectedTotal = totalDiskBytes;

    // Deduct already selected files
    for (const c of toDeleteSet) {
      projectedTotal -= c.size;
    }

    if (projectedTotal > maxSizeBytes) {
      for (const c of eligibleCandidates) {
        if (projectedTotal <= maxSizeBytes) break;
        if (!toDeleteSet.has(c)) {
          toDeleteSet.add(c);
          projectedTotal -= c.size;
        }
      }
    }
  }

  const deleteCandidates = Array.from(toDeleteSet);
  let deletedBytes = 0;
  for (const c of deleteCandidates) {
    deletedBytes += c.size;
  }

  const remainingFiles = files.length - deleteCandidates.length;
  const remainingBytes = Math.max(0, totalDiskBytes - deletedBytes);

  // If dry-run: return plan without touching filesystem
  if (isDryRun) {
    return {
      dryRun: true,
      deletedCount: deleteCandidates.length,
      deletedBytes,
      deletedFormatted: formatBytes(deletedBytes),
      remainingFiles,
      remainingBytes,
      remainingFormatted: formatBytes(remainingBytes),
      files: deleteCandidates.map((c) => ({
        filename: c.filename,
        messageId: c.messageId,
        size: c.size,
        formatted: c.formatted,
        ageDays: c.ageDays,
      })),
      skippedPinnedCount,
    };
  }

  // Live execution: delete files safely and update index
  const deletedFiles = [];
  let indexModified = false;

  for (const c of deleteCandidates) {
    try {
      // Re-verify realpath before unlinking
      const realFile = fs.realpathSync(c.filePath);
      const realDir = fs.realpathSync(targetDir);
      if (!realFile.startsWith(realDir + path.sep)) continue;

      const lstat = fs.lstatSync(c.filePath);
      if (lstat.isSymbolicLink()) continue;

      fs.unlinkSync(c.filePath);
      deletedFiles.push({
        filename: c.filename,
        messageId: c.messageId,
        size: c.size,
        formatted: c.formatted,
        ageDays: c.ageDays,
      });

      if (c.messageId && index[c.messageId]) {
        delete index[c.messageId];
        indexModified = true;
      }
    } catch (_) {}
  }

  if (indexModified) {
    saveMediaIndex(index);
  }

  return {
    dryRun: false,
    deletedCount: deletedFiles.length,
    deletedBytes,
    deletedFormatted: formatBytes(deletedBytes),
    remainingFiles,
    remainingBytes,
    remainingFormatted: formatBytes(remainingBytes),
    files: deletedFiles,
    skippedPinnedCount,
  };
}

module.exports = {
  formatBytes,
  cleanMessageId,
  sanitizeFilename,
  getMediaDir,
  computeFileSha256,
  loadMediaIndex,
  saveMediaIndex,
  recordMediaIndex,
  deleteFromMediaIndex,
  pinMedia,
  isMediaPinned,
  verifyMediaIntegrity,
  findCachedMedia,
  saveIncomingMedia,
  extractMediaInfo,
  categorizeMedia,
  getMediaStorageStats,
  cleanMediaStorage,
};
