"use strict";

// Parser for the `:` command line. Pure + unit-testable.
// Grammar: `:verb arg1 arg2 ...` — first token is the verb, rest is the raw
// argument string (the message body must not be token-split).

const COMMANDS = Object.freeze({
  SEND: "send",
  SEARCH: "search",
  ARCHIVE: "archive",
  UNARCHIVE: "unarchive",
  SEEN: "seen",
  CONTACT: "contact",
  CHATS: "chats",
  STATUS: "status",
  HELP: "help",
  QUIT: "quit",
});

const ALIASES = Object.freeze({
  m: "send",
  msg: "send",
  s: "search",
  arch: "archive",
  unarch: "unarchive",
  mark: "seen",
  c: "contact",
  h: "help",
  q: "quit",
  x: "quit",
});

function normalizeVerb(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (ALIASES[v]) return ALIASES[v];
  return v;
}

// Parse "send +923266900001 hello world" -> {cmd:"send", args:["+923266900001","hello world"]}
function parseCommandLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const idx = trimmed.search(/\s/);
  const verb = idx === -1 ? trimmed : trimmed.slice(0, idx);
  const rest = idx === -1 ? "" : trimmed.slice(idx + 1).trim();
  return {
    raw: trimmed,
    verb: normalizeVerb(verb),
    args: rest ? rest.split(/\s+/) : [],
    argStr: rest,
    known: Object.values(COMMANDS).includes(normalizeVerb(verb)),
  };
}

module.exports = { parseCommandLine, COMMANDS, ALIASES };
