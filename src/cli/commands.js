"use strict";

const qrcode = require("qrcode-terminal");
const { ensureDaemon, request, daemonUrl } = require("./lib/transport");
const { toJid, isGroupJid, shortJid } = require("../ipc/jid");
const { ROUTES } = require("../ipc/protocol");
const { pc, EMOJI, header, section, pair, table, delimiter } = require("./lib/theme");

async function getDaemon() {
  return ensureDaemon();
}

async function cmdLogin() {
  const { base, token } = await getDaemon();
  process.stdout.write(pc.dim("Waiting for QR from daemon...\n"));

  const res = await request(base, token, "GET", ROUTES.STATUS);
  if (res.ok && res.state === "ready") {
    console.log(`${EMOJI.ok} ${pc.green("Already linked and ready.")}`);
    return;
  }

  await streamLogin(base, token);
}

function streamLogin(base, token) {
  return new Promise((resolve, reject) => {
    const { get } = require("http");
    const url = new URL(ROUTES.LOGIN, base);
    const req = get(
      url,
      { headers: { "x-wa-token": token } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error("login stream failed: HTTP " + res.statusCode));
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            handleSSE(part);
          }
        });
        res.on("end", () => {
          if (buf) handleSSE(buf);
          resolve();
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);

    function handleSSE(block) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) return;
      try {
        const data = JSON.parse(dataLine.slice(6));
        if (data.event === "state" && data.state === "ready") {
          console.log(`\n${EMOJI.ok} ${pc.green("Linked and ready.")}`);
          resolve();
        } else if (data.event === "qr" || (data.event === "state" && data.state === "linking")) {
          const qr = data.qr || (data.event === "qr" ? data.qr : null);
          if (data.qr) {
            console.log(`\n${pc.bold(pc.yellow("Scan this QR code with WhatsApp:"))}\n`);
            qrcode.generate(data.qr, { small: true });
          }
        } else if (data.event === "logged_out") {
          console.log(`${EMOJI.fail} ${pc.red("Session logged out.")}`);
        } else if (data.event === "auth_failure") {
          console.log(`${EMOJI.fail} ${pc.red("Authentication failed:")} ${data.message || ""}`);
        }
      } catch (_) {}
    }
  });
}

async function cmdStatus() {
  const { base, token } = await getDaemon();
  const res = await request(base, token, "GET", ROUTES.STATUS);
  if (!res.ok) {
    console.log(`${EMOJI.fail} ${pc.red("status: error")}`);
    return;
  }
  const { state, account, lastError } = res;
  const stateColor =
    state === "ready"
      ? pc.green
      : state === "connecting"
        ? pc.yellow
        : state === "logged_out"
          ? pc.red
          : pc.cyan;

  console.log(header("wa status"));
  console.log(pair("State", stateColor(state)));
  if (account) {
    console.log("");
    console.log(section("Account"));
    console.log(`  ${pair("number", pc.cyan(account.number))}`);
    if (account.pushname) console.log(`  ${pair("name", account.pushname)}`);
  }
  if (lastError) console.log(`\n${EMOJI.fail} ${pc.red("Last error:")} ${lastError}`);
  const d = require("../store/daemon").read();
  if (d) console.log(`\n${pc.dim("Daemon pid:")} ${pc.cyan(d.pid)} ${pc.dim("port:")} ${pc.cyan(d.port)}`);
}

async function cmdSend(argv) {
  const { base, token } = await getDaemon();
  let target = argv.positional[0];
  const message = argv.positional.slice(1).join(" ");
  if (!target || !message) {
    console.error("Usage: wa send <number|group|me> <message>");
    process.exit(2);
  }
  let jid;
  try {
    if (target === "me" || target === "self") {
      const status = await request(base, token, "GET", ROUTES.STATUS);
      if (!status.ok || status.state !== "ready" || !status.account || !status.account.number) {
        console.error(`${EMOJI.fail} ${pc.red("Cannot resolve self: daemon not ready or no account number.")}`);
        process.exit(1);
      }
      target = status.account.number;
    }
    jid = toJid(target);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const isGroup = isGroupJid(jid);

  const status = await request(base, token, "GET", ROUTES.STATUS);
  if (status.ok && status.state !== "ready") {
    console.error(`${EMOJI.fail} ${pc.red("Daemon is not ready.")} Run \`wa status\` to check.`);
    process.exit(1);
  }

  console.log(`\n${EMOJI.arrow} ${pc.dim("Sending")} ${pc.bold(isGroup ? pc.yellow("group") : pc.cyan("contact"))} ${pc.bold(shortJid(jid))}...\n`);
  const res = await request(base, token, "POST", ROUTES.SEND, { to: jid, message });
  if (res.ok) {
    console.log(`${EMOJI.ok} ${pc.green("Sent.")} ${pc.dim("messageId:")} ${pc.cyan(res.messageId || "(unknown)")}`);
  } else {
    console.error(`${EMOJI.fail} ${pc.red("Failed:")} ${res.error && res.error.message}`);
    if (res.error && res.error.code === "NOT_READY") {
      console.error(`  ${pc.dim("Try:")} wa status`);
      console.error(`  ${pc.dim("The daemon may still be syncing, or the login session expired.")}`);
    }
    process.exit(1);
  }
}

async function cmdChats(argv) {
  const { base, token } = await getDaemon();
  const limit = argv.flags.limit || "50";
  const res = await request(base, token, "GET", ROUTES.CHATS, null, {
    query: { limit },
  });
  const chats = (res.ok && res.chats) || [];
  if (chats.length === 0) {
    console.log(`${pc.dim("No chats.")}`);
    return;
  }
  console.log(header(`chats (${chats.length})`));
  const rows = chats.map((c) => [
    pc.cyan(c.id ? shortJid(c.id) : "?"),
    c.name || c.id || "",
    c.isGroup ? pc.yellow("group") : pc.dim("dm"),
  ]);
  console.log(table(rows) + "\n");
}

async function cmdContacts(argv) {
  const { base, token } = await getDaemon();
  const name = argv.flags.name || "";
  const res = await request(base, token, "GET", ROUTES.CONTACTS, null, {
    query: name ? { name } : {},
  });
  const contacts = (res.ok && res.contacts) || [];
  if (contacts.length === 0) {
    console.log(`${pc.dim("No contacts.")}`);
    return;
  }
  console.log(header(`contacts (${contacts.length})` + (name ? ` matching "${name}"` : "")));
  const rows = contacts.map((c) => [pc.cyan(c.number || "?"), c.name || pc.dim("—")]);
  console.log(table(rows) + "\n");
}

async function cmdHistory(argv) {
  const { base, token } = await getDaemon();
  const target = argv.positional[0];
  if (!target) {
    console.error(`${pc.red("Usage:")} wa history <contact|group>`);
    process.exit(2);
  }
  let jid;
  try {
    jid = toJid(target);
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
    process.exit(2);
  }
  const limit = argv.flags.limit || "50";
  const res = await request(base, token, "GET", ROUTES.HISTORY, null, {
    query: { chatId: jid, limit },
  });
  const messages = (res.ok && res.messages) || [];
  if (messages.length === 0) {
    console.log(`${pc.dim("No messages.")}`);
    return;
  }
  console.log(header(`history · ${shortJid(jid)} (last ${messages.length})`));
  const rows = messages.map((m) => {
    const d = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : "";
    const who = m.from === "me" ? pc.green("me") : pc.cyan(shortJid(m.from) || "?");
    return [pc.dim(d), who, pc.bold(m.body || "")];
  });
  console.log(table(rows) + "\n");
}

async function cmdReceive() {
  const { base, token } = await getDaemon();
  const oneShot = process.argv.includes("--once");
  process.stdout.write(`${pc.bold(pc.magenta("●"))} ${pc.dim("Watching for incoming messages...")} ${pc.dim("Ctrl-C to stop")}\n`);
  await new Promise((resolve) => {
    const { get } = require("http");
    const url = new URL(ROUTES.RECEIVE, base);
    const req = get(url, { headers: { "x-wa-token": token } }, (res) => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.event === "message") {
              const from = data.from || "?";
              const body = data.body || "";
              const d = data.timestamp ? new Date(data.timestamp * 1000).toLocaleString() : "";
              console.log(`${pc.dim(d)}  ${pc.cyan(shortJid(from))}: ${pc.bold(body)}`);
            }
          } catch (_) {}
        }
      });
      res.on("end", resolve);
    });
    req.on("error", resolve);
  });
}

async function cmdLogout() {
  const { base, token } = await getDaemon();
  await request(base, token, "POST", ROUTES.LOGOUT);
  console.log(`${EMOJI.y} ${pc.green("Logged out.")}`);
}

async function cmdDaemon() {
  const { base, token } = await getDaemon();
  const res = await request(base, token, "GET", ROUTES.STATUS);
  const stateColor =
    res.ok ? pc.green : res.state === "connecting" ? pc.yellow : pc.red;
  console.log(pair("Daemon state", stateColor(res.ok ? res.state : "unknown")));
}

async function cmdTui() {
  const { runTui } = require("../tui");
  await runTui();
}

async function cmdMcp() {
  const { startMcpServer } = require("../mcp");
  await startMcpServer();
}

const handlers = {
  login: cmdLogin,
  status: cmdStatus,
  send: cmdSend,
  chats: cmdChats,
  contacts: cmdContacts,
  history: cmdHistory,
  receive: cmdReceive,
  logout: cmdLogout,
  daemon: cmdDaemon,
  tui: cmdTui,
  mcp: cmdMcp,
};

module.exports = handlers;