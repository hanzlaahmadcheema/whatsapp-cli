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

async function cmdSendImage(argv) {
  const { base, token } = await getDaemon();
  let target = argv.positional[0];
  const filePath = argv.positional[1];
  const caption = argv.flags.caption || argv.flags.c || argv.positional.slice(2).join(" ");

  if (!target || !filePath) {
    console.error("Usage: wa send-image <number|group|me> <filePath> [caption]");
    process.exit(2);
  }

  const { validateFile } = require("../media");
  let valid;
  try {
    valid = validateFile(filePath, { isImage: true });
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
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

  console.log(`\n${EMOJI.arrow} ${pc.dim("Sending image to")} ${pc.bold(isGroup ? pc.yellow("group") : pc.cyan("contact"))} ${pc.bold(shortJid(jid))} (${pc.dim(valid.filename)})...\n`);
  const res = await request(base, token, "POST", ROUTES.SEND_MEDIA, {
    to: jid,
    filePath: valid.resolvedPath,
    caption: caption || undefined,
    isImage: true,
    sendMediaAsDocument: false,
  });

  if (res.ok) {
    console.log(`${EMOJI.ok} ${pc.green("Sent.")} ${pc.dim("messageId:")} ${pc.cyan(res.messageId || "(unknown)")}`);
  } else {
    console.error(`${EMOJI.fail} ${pc.red("Failed:")} ${res.error && res.error.message}`);
    process.exit(1);
  }
}

async function cmdSendFile(argv) {
  const { base, token } = await getDaemon();
  let target = argv.positional[0];
  const filePath = argv.positional[1];
  const caption = argv.flags.caption || argv.flags.c || argv.positional.slice(2).join(" ");
  const customName = argv.flags.name || argv.flags.filename;

  if (!target || !filePath) {
    console.error("Usage: wa send-file <number|group|me> <filePath> [caption] [--name <filename>]");
    process.exit(2);
  }

  const { validateFile } = require("../media");
  let valid;
  try {
    valid = validateFile(filePath, { isDocument: true, filename: customName });
  } catch (err) {
    console.error(`${EMOJI.fail} ${pc.red(err.message)}`);
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

  console.log(`\n${EMOJI.arrow} ${pc.dim("Sending document to")} ${pc.bold(isGroup ? pc.yellow("group") : pc.cyan("contact"))} ${pc.bold(shortJid(jid))} (${pc.dim(valid.filename)})...\n`);
  const res = await request(base, token, "POST", ROUTES.SEND_MEDIA, {
    to: jid,
    filePath: valid.resolvedPath,
    filename: valid.filename,
    caption: caption || undefined,
    isImage: false,
    sendMediaAsDocument: true,
  });

  if (res.ok) {
    console.log(`${EMOJI.ok} ${pc.green("Sent.")} ${pc.dim("messageId:")} ${pc.cyan(res.messageId || "(unknown)")}`);
  } else {
    console.error(`${EMOJI.fail} ${pc.red("Failed:")} ${res.error && res.error.message}`);
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


async function cmdReconnect() {
  const { base, token } = await getDaemon();
  process.stdout.write(`${pc.cyan("⟳")} Reconnecting WhatsApp session…\n`);
  try {
    const res = await request(base, token, "POST", ROUTES.RECONNECT);
    if (res.ok) {
      console.log(`${EMOJI.ok} Reconnected successfully. State: ${pc.green(res.state || "ready")}`);
    } else {
      console.error(`${EMOJI.fail} Reconnect failed: ${pc.red(res.error?.message || "Unknown error")}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`${EMOJI.fail} Reconnect request failed: ${pc.red(err.message)}`);
    process.exit(1);
  }
}

async function cmdStop() {
  const daemonStore = require("../store/daemon");
  const existing = daemonStore.read();
  if (!existing || !existing.pid) {
    console.log(`${pc.dim("WhatsApp daemon is not running.")}`);
    return;
  }
  let alive = false;
  try {
    process.kill(existing.pid, 0);
    alive = true;
  } catch (_) {}

  if (alive) {
    try {
      process.kill(existing.pid, "SIGTERM");
      console.log(`${EMOJI.ok} Sent stop signal to WhatsApp daemon (pid ${existing.pid}).`);
    } catch (err) {
      console.error(`${EMOJI.fail} Failed to stop daemon: ${err.message}`);
    }
  } else {
    console.log(`${pc.dim("WhatsApp daemon was not running.")}`);
  }
  daemonStore.remove();
}

async function cmdRestart() {
  await cmdStop();
  await new Promise((r) => setTimeout(r, 1000));
  const { spawnDetached } = require("../daemon");
  spawnDetached();
  console.log(`${EMOJI.ok} Restarted WhatsApp daemon.`);
}

async function cmdTray(argv) {
  const { startTrayManager, stopTrayManager, getTrayStatus } = require("../tray");
  if (argv && argv.flags && argv.flags.stop) {
    const res = stopTrayManager();
    if (res.stopped) {
      console.log(`${EMOJI.ok} WhatsApp tray manager stopped (pid ${res.pid}).`);
    } else {
      console.log(`${pc.dim("WhatsApp tray manager is not running.")}`);
    }
    return;
  }

  if (argv && argv.flags && argv.flags.status) {
    const status = getTrayStatus();
    if (status.running) {
      console.log(`${EMOJI.ok} WhatsApp tray manager is running (pid ${status.pid}).`);
    } else {
      console.log(`${pc.dim("WhatsApp tray manager is not running.")}`);
    }
    return;
  }

  const foreground = Boolean(argv && argv.flags && (argv.flags.foreground || argv.flags.f));
  const res = startTrayManager({ foreground });
  if (res.alreadyRunning) {
    console.log(`${EMOJI.ok} WhatsApp tray manager is already running (pid ${res.pid}).`);
  } else if (res.detached) {
    console.log(`${EMOJI.ok} WhatsApp tray manager started in background (pid ${res.pid}).`);
  }
}

async function cmdAutostart(argv) {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { execSync } = require("child_process");
  const { saveSettings, loadSettings } = require("../config/settings");
  const { paths } = require("../config/paths");

  const action = ((argv && argv.positional && argv.positional[0]) || "status").toLowerCase();
  const systemdUserDir = path.join(os.homedir(), ".config", "systemd", "user");
  const trayServiceDest = path.join(systemdUserDir, "whatsapp-tray.service");
  const daemonServiceDest = path.join(systemdUserDir, "whatsapp-daemon.service");
  const trayServiceSrc = path.join(paths.root, "systemd", "whatsapp-tray.service");
  const daemonServiceSrc = path.join(paths.root, "systemd", "whatsapp-daemon.service");

  if (action === "enable") {
    fs.mkdirSync(systemdUserDir, { recursive: true });
    fs.copyFileSync(trayServiceSrc, trayServiceDest);
    fs.copyFileSync(daemonServiceSrc, daemonServiceDest);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      execSync("systemctl --user enable whatsapp-tray.service", { stdio: "ignore" });
      execSync("systemctl --user enable whatsapp-daemon.service", { stdio: "ignore" });
      saveSettings({ launchTrayOnLogin: true });
      console.log(`${EMOJI.ok} Enabled WhatsApp autostart services (systemd user unit).`);
    } catch (err) {
      console.error(`${EMOJI.fail} Failed to enable systemd autostart: ${err.message}`);
      process.exit(1);
    }
  } else if (action === "disable") {
    try {
      execSync("systemctl --user disable whatsapp-tray.service", { stdio: "ignore" });
      execSync("systemctl --user disable whatsapp-daemon.service", { stdio: "ignore" });
      if (fs.existsSync(trayServiceDest)) fs.unlinkSync(trayServiceDest);
      if (fs.existsSync(daemonServiceDest)) fs.unlinkSync(daemonServiceDest);
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      saveSettings({ launchTrayOnLogin: false });
      console.log(`${EMOJI.ok} Disabled WhatsApp autostart services.`);
    } catch (err) {
      console.error(`${EMOJI.fail} Failed to disable systemd autostart: ${err.message}`);
      process.exit(1);
    }
  } else {
    const settings = loadSettings();
    let trayEnabled = false;
    let daemonEnabled = false;
    try {
      const out = execSync("systemctl --user is-enabled whatsapp-tray.service 2>/dev/null", { encoding: "utf8" }).trim();
      trayEnabled = out === "enabled";
    } catch (_) {}
    try {
      const out = execSync("systemctl --user is-enabled whatsapp-daemon.service 2>/dev/null", { encoding: "utf8" }).trim();
      daemonEnabled = out === "enabled";
    } catch (_) {}

    console.log(`${pc.bold("WhatsApp Autostart Status:")}`);
    console.log(`  Tray manager autostart: ${trayEnabled ? pc.green("enabled") : pc.dim("disabled")}`);
    console.log(`  Daemon autostart:       ${daemonEnabled ? pc.green("enabled") : pc.dim("disabled")}`);
    console.log(`  Config launchTrayOnLogin: ${settings.launchTrayOnLogin ? pc.green("true") : pc.dim("false")}`);
  }
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
  "send-image": cmdSendImage,
  sendimage: cmdSendImage,
  image: cmdSendImage,
  "send-file": cmdSendFile,
  sendfile: cmdSendFile,
  "send-doc": cmdSendFile,
  document: cmdSendFile,
  file: cmdSendFile,
  tray: cmdTray,
  reconnect: cmdReconnect,
  autostart: cmdAutostart,
  stop: cmdStop,
  restart: cmdRestart,
};

module.exports = handlers;