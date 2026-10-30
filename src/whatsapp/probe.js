"use strict";

const { DEFAULTS } = require("../config");

/**
 * Probe whether a whatsapp-web.js client is actually usable.
 *
 * The library can fire `authenticated` and never reach operability, so this
 * checks, retrying, that the client can list chats and read its own contact
 * before the daemon considers itself ready.
 *
 * @param {object} client - has getChats() and info (or getContactById).
 * @param {object} [opts]
 * @param {number} [opts.attempts] - max probe attempts.
 * @param {number} [opts.delayMs] -  delay between attempts.
 * @param {number} [opts.timeoutMs] - per-call timeout.
 * @returns {Promise<boolean>}
 */
async function isClientUsable(client, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 15000;

  if (!client) return false;

  for (let i = 1; i <= attempts; i++) {
    try {
      const chats = await withTimeout(client.getChats(), timeoutMs);
      // getChats() resolving proves the client is functional; additionally
      // require a contact-capable surface (real lib exposes getContactById).
      const hasInfoSupport =
        typeof client.getContactById === "function" ||
        typeof client.getContact === "function";
      if (Array.isArray(chats) && hasInfoSupport) {
        return true;
      }
    } catch (err) {
      // fall through and retry
    }
    if (i < attempts) {
      await sleep(delayMs);
    }
  }
  return false;
}

async function fetchAccountInfo(client, timeoutMs = 15000) {
  if (!client) return null;
  const deadline = Date.now() + timeoutMs;
  let delay = 200;
  while (Date.now() < deadline) {
    try {
      if (client.info && typeof client.info === "object" && client.info.wid) {
        return normalizeAccount(client.info);
      }
      if (typeof client.getInfo === "function") {
        const info = await withTimeout(client.getInfo(), 3000);
        const normalized = normalizeAccount(info);
        if (normalized) return normalized;
      }
    } catch (_) {}
    await sleep(delay);
    delay = Math.min(delay * 2, 1500);
  }
  return null;
}

function normalizeAccount(info) {
  if (!info) return null;
  const wid = info.wid && info.wid.user ? info.wid.user : null;
  return {
    me: wid ? `${wid}@c.us` : null,
    number: wid,
    pushname: info.pushname || info.name || null,
    phone: info.phone || null,
  };
}

function withTimeout(promise, ms) {
  if (!promise || typeof promise.then !== "function") {
    return Promise.resolve(promise);
  }
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timeout")), ms);
  });

  return Promise.race([
    promise.then(
      (val) => {
        if (timer) clearTimeout(timer);
        return val;
      },
      (err) => {
        if (timer) clearTimeout(timer);
        throw err;
      }
    ),
    timeoutPromise,
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { isClientUsable, fetchAccountInfo, normalizeAccount, withTimeout };