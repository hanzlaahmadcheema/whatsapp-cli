"use strict";

const TIMEZONE = "Asia/Karachi"; // UTC+5 permanently

const WEEKDAYS = Object.freeze({
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
});

/**
 * Extracts year, month, day, weekday, hour, minute, second in Asia/Karachi (UTC+5).
 */
function getZonedParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    parts[type] = value;
  }

  const hourRaw = parseInt(parts.hour, 10);
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    weekday: parts.weekday.toLowerCase(),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

/**
 * Converts a year, month, day, hour, minute, second in Asia/Karachi to UTC Unix seconds.
 */
function zonedDateToTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+05:00`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid constructed date: ${iso}`);
  }
  return Math.floor(d.getTime() / 1000);
}

/**
 * Parses natural-language dates, ISO dates, timestamps, or date ranges into Unix timestamp seconds.
 * Strictly throws an Error if the date input is invalid or unparseable.
 *
 * @param {string|number|Date} input
 * @param {object} options
 * @param {boolean} options.endOfDay - If true, resolves to 23:59:59 instead of 00:00:00.
 * @param {Date} options.now - Custom reference Date for testing.
 * @returns {number|null} Unix timestamp in seconds, or null if input is null/undefined.
 */
function parseDateToTimestamp(input, options = {}) {
  if (input === null || input === undefined || input === "") {
    return null;
  }

  const endOfDay = Boolean(options.endOfDay);
  const now = options.now instanceof Date ? options.now : new Date();

  // If already a Date object
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new Error("Invalid Date object provided.");
    }
    return Math.floor(input.getTime() / 1000);
  }

  // If already a number
  if (typeof input === "number") {
    if (isNaN(input) || input < 0) {
      throw new Error(`Invalid numeric timestamp: ${input}`);
    }
    return input > 1e11 ? Math.floor(input / 1000) : Math.floor(input);
  }

  const rawStr = String(input).trim();
  if (!rawStr) return null;

  // Pure digits: Unix timestamp
  if (/^\d+$/.test(rawStr)) {
    const num = parseInt(rawStr, 10);
    return num > 1e11 ? Math.floor(num / 1000) : num;
  }

  const lower = rawStr.toLowerCase();

  // 1. "today"
  if (lower === "today") {
    const z = getZonedParts(now);
    return zonedDateToTimestamp(
      z.year,
      z.month,
      z.day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
  }

  // 2. "yesterday"
  if (lower === "yesterday") {
    const yesterdayDate = new Date(now.getTime() - 86400000);
    const z = getZonedParts(yesterdayDate);
    return zonedDateToTimestamp(
      z.year,
      z.month,
      z.day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
  }

  // 3. "<N> days ago" or "<N> day ago"
  const daysAgoMatch = lower.match(/^(\d+)\s+days?\s+ago$/);
  if (daysAgoMatch) {
    const days = parseInt(daysAgoMatch[1], 10);
    const pastDate = new Date(now.getTime() - days * 86400000);
    const z = getZonedParts(pastDate);
    return zonedDateToTimestamp(
      z.year,
      z.month,
      z.day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
  }

  // 4. "last <weekday>" (e.g. "last Tuesday", "last Friday")
  const lastWeekdayMatch = lower.match(/^last\s+([a-z]+)$/);
  if (lastWeekdayMatch) {
    const dayName = lastWeekdayMatch[1];
    if (!(dayName in WEEKDAYS)) {
      throw new Error(`Unknown day of the week: "${dayName}". Supported: Monday - Sunday.`);
    }
    const targetDay = WEEKDAYS[dayName];
    const zNow = getZonedParts(now);
    const currentDay = WEEKDAYS[zNow.weekday];

    let diff = (currentDay - targetDay + 7) % 7;
    if (diff === 0) diff = 7; // E.g., on Saturday, "last Saturday" refers to 7 days ago

    const targetDate = new Date(now.getTime() - diff * 86400000);
    const zTarget = getZonedParts(targetDate);
    return zonedDateToTimestamp(
      zTarget.year,
      zTarget.month,
      zTarget.day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
  }

  // 5. Explicit date range: "date1..date2" or "date1 to date2"
  const rangeMatch = rawStr.match(/^(.+?)\s*(?:\.\.|\bto\b)\s*(.+)$/i);
  if (rangeMatch) {
    // If range is detected, return structured range
    const sinceTs = parseDateToTimestamp(rangeMatch[1], { endOfDay: false, now });
    const untilTs = parseDateToTimestamp(rangeMatch[2], { endOfDay: true, now });
    return { since: sinceTs, until: untilTs };
  }

  // 6. ISO Date: YYYY-MM-DD
  const ymdMatch = rawStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) {
      throw new Error(`Invalid calendar date: "${rawStr}"`);
    }
    return zonedDateToTimestamp(
      y,
      m,
      d,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    );
  }

  // 7. Full ISO 8601 or standard datetime: e.g. "2026-10-31T14:30:00Z"
  const parsedDate = new Date(rawStr);
  if (!isNaN(parsedDate.getTime())) {
    // If input had no timezone/time specified, adjust for local timezone if plain date
    return Math.floor(parsedDate.getTime() / 1000);
  }

  // Unrecognized date string: fail explicitly!
  throw new Error(
    `Invalid date specification: "${rawStr}". Supported formats: "yesterday", "last <day>", "<N> days ago", ISO dates (YYYY-MM-DD), or timestamps.`
  );
}

module.exports = {
  TIMEZONE,
  getZonedParts,
  zonedDateToTimestamp,
  parseDateToTimestamp,
};
