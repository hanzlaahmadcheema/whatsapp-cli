"use strict";

const MAX_IMAGE_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB
const MAX_DOCUMENT_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const EXT_TO_IMAGE_MIME = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
});

module.exports = {
  MAX_IMAGE_SIZE_BYTES,
  MAX_DOCUMENT_SIZE_BYTES,
  EXT_TO_IMAGE_MIME,
};
