"use strict";

const CONTACT_SUFFIX = "@c.us";
const GROUP_SUFFIX = "@g.us";

function stripDigits(input) {
  return String(input).replace(/[^\d]/g, "");
}

function isValidNumber(input) {
  const digits = stripDigits(input);
  return /^[1-9]\d{6,14}$/.test(digits);
}

function isContactJid(input) {
  return /^[1-9]\d{6,14}@c\.us$/.test(input);
}

function isGroupJid(input) {
  return /^[\w-]+@g\.us$/.test(input);
}

function toContactJid(input) {
  const digits = stripDigits(input);
  if (!isValidNumber(digits)) {
    throw new Error(
      `Invalid WhatsApp number: "${input}". Use an international number like 15551234567.`
    );
  }
  return `${digits}${CONTACT_SUFFIX}`;
}

function toJid(input) {
  if (isContactJid(input)) return input;
  if (isGroupJid(input)) return input;
  return toContactJid(input);
}

function shortJid(jid) {
  return String(jid).split("@")[0] || "";
}

module.exports = {
  CONTACT_SUFFIX,
  GROUP_SUFFIX,
  isValidNumber,
  toContactJid,
  isContactJid,
  isGroupJid,
  toJid,
  shortJid,
};