"use strict";

const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const {
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOCUMENT_SIZE_BYTES,
  EXT_TO_IMAGE_MIME,
} = require("./constants");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("File path is required.");
  }

  const resolved = path.resolve(filePath.trim());

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: "${filePath}"`);
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new Error(`Cannot stat file "${filePath}": ${err.message}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: "${filePath}"`);
  }

  if (stat.size === 0) {
    throw new Error(`File is empty (0 bytes): "${filePath}"`);
  }

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (_) {
    throw new Error(`File is not readable (permission denied): "${filePath}"`);
  }

  const maxSize =
    options.maxSize || (options.isImage ? MAX_IMAGE_SIZE_BYTES : MAX_DOCUMENT_SIZE_BYTES);
  if (stat.size > maxSize) {
    throw new Error(
      `File size (${formatBytes(stat.size)}) exceeds the maximum allowed limit of ${formatBytes(maxSize)}.`
    );
  }

  let mimeType = options.mimetype;
  if (!mimeType) {
    mimeType = mime.lookup(resolved) || null;
  }

  const ext = path.extname(resolved).toLowerCase();
  if (options.isImage) {
    if (!mimeType || !mimeType.startsWith("image/")) {
      mimeType = EXT_TO_IMAGE_MIME[ext] || null;
      if (!mimeType) {
        throw new Error(
          `File "${path.basename(resolved)}" is not a supported image format. Supported formats: JPEG, PNG, WebP, GIF, BMP, SVG.`
        );
      }
    }
  } else {
    if (!mimeType) {
      mimeType = "application/octet-stream";
    }
  }

  const filename = options.filename ? String(options.filename).trim() : path.basename(resolved);

  return {
    resolvedPath: resolved,
    filename,
    mimetype: mimeType,
    size: stat.size,
  };
}

function loadMessageMedia(options = {}) {
  const { MessageMedia } = require("whatsapp-web.js");

  if (options.filePath) {
    const valid = validateFile(options.filePath, {
      isImage: !!options.isImage,
      isDocument: !!options.isDocument,
      maxSize: options.maxSize,
      filename: options.filename,
      mimetype: options.mimetype,
    });

    const data = fs.readFileSync(valid.resolvedPath, "base64");
    return new MessageMedia(valid.mimetype, data, valid.filename, valid.size);
  }

  if (options.data) {
    if (typeof options.data !== "string" || !options.data.trim()) {
      throw new Error("Base64 media data cannot be empty.");
    }

    const data = options.data.trim();
    const filename = options.filename ? String(options.filename).trim() : "file";
    let mimeType = options.mimetype;

    if (!mimeType) {
      if (options.isImage) {
        mimeType = "image/jpeg";
      } else {
        mimeType = mime.lookup(filename) || "application/octet-stream";
      }
    }

    return new MessageMedia(mimeType, data, filename, options.size || null);
  }

  throw new Error("Either `filePath` or `data` (base64) must be provided.");
}

const store = require("./store");

module.exports = {
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOCUMENT_SIZE_BYTES,
  EXT_TO_IMAGE_MIME,
  formatBytes,
  validateFile,
  loadMessageMedia,
  ...store,
};
