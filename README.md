# wa — WhatsApp CLI

A two-process WhatsApp client for the terminal: a long-lived background daemon
speaks to WhatsApp Web through [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js)
+ Puppeteer, and a thin CLI frontend (or a full-screen TUI) drives it over a
token-authenticated loopback HTTP API.

```
┌──────────────┐  local HTTP  ┌───────────────────────┐  Puppeteer   ┌─────────────┐
│  wa (CLI)    │ ───────────► │  wa daemon            │ ───────────► │ WhatsApp Web │
│  wa tui (TUI)│              │  auth, probe, recover │              └─────────────┘
└──────────────┘              └───────────────────────┘
```

## Requirements

- Node.js >= 18
- A WhatsApp account to link (personal use)

## Install

```sh
npm install          # postinstall patches whatsapp-web.js (see below)
npm link             # exposes the `wa` binary
```

## Quick start

```sh
wa login      # print a QR code, scan with WhatsApp ▶ Linked devices
wa chats      # list recent chats
wa tui        # full-screen terminal UI (list, history, reply)
wa send 923001234567 "hello from wa"
wa history 923001234567
wa receive    # stream incoming messages
wa logout     # unlink the device
```

`wa status` reports the daemon state, your account, and the daemon pid/port.

## How it works

- **Daemon.** `src/daemon/` is a long-lived HTTP server bound to `127.0.0.1`.
  All requests must carry the `x-wa-token` header from `.data/daemon.json`
  (created with a fresh random token each launch).
- **Frontend.** `src/cli/` auto-spawns the daemon on first use
  (`ensureDaemon`), then issues HTTP calls. `src/tui/` is a zero-dependency
  ANSI full-screen UI built on the same HTTP protocol.
- **Liveness.** If the daemon is killed, the next `wa` command spawns it again
  and the saved LocalAuth session is reused — no QR re-scan.
- **Recovery.** WhatsApp Web reloads its page under long-running sessions and
  Puppeteer frames detach. The service detects the signature error and
  transparently reinitializes the client.

## Commands

| Command | Description |
| --- | --- |
| `wa login` | Link device / show QR; skips if already ready |
| `wa status` | Daemon + session state |
| `wa chats [--limit N]` | Recent chats |
| `wa contacts [--name ...]` | Contacts, optionally filtered by name |
| `wa history <contact> [--limit N]` | Message history |
| `wa send <number\|group> <message>` | Send a message (spaced words join) |
| `wa send-image <contact> <file> [caption]` | Send an image/photo with optional caption |
| `wa send-file <contact> <file> [caption]` | Send a document/file with original filename |
| `wa receive` | Stream incoming messages |
| `wa logout` | Force logout / unlink the device |
| `wa tui` | Full-screen interactive UI |
| `wa mcp` | Launch MCP (Model Context Protocol) stdio server |
| `wa tray [--foreground]` | Launch Linux StatusNotifierItem / AppIndicator system tray manager |
| `wa reconnect` | Trigger controlled session recovery |
| `wa autostart [enable\|disable\|status]` | Manage systemd user unit autostart |
| `wa stop` | Stop background WhatsApp daemon |
| `wa restart` | Restart background WhatsApp daemon |

## FAQ / notes

- `/send` POST accepts `{ "to": "<jid>", "message": "hi" }`.
- `/send-media` POST accepts `{ "to": "<jid>", "filePath": "/path/to/file", "caption": "...", "sendMediaAsDocument": false }`.
- Contacts groups accepted as `1234...@g.us` (no number validation).
- File size limits: 16 MB for photos/images, 100 MB for documents.
- Personal use only — avoid automated bulk sends (rate limits).

## Model Context Protocol (MCP) Server & Reusable Agent Skill

`wa` includes a built-in MCP stdio server compatible with Antigravity, OpenBot, Cursor, and Claude Desktop, along with a portable agent skill package in [`skills/whatsapp/`](./skills/whatsapp/):

```sh
wa mcp
# or: node src/mcp/index.js
```

### Reusable Agent Skill (`skills/whatsapp/`)

The repository provides a complete, portable agent skill structured with:
- [`skills/whatsapp/SKILL.md`](./skills/whatsapp/SKILL.md): Comprehensive instructions, discovery rules, recipient formats, validation constraints, and workflows.
- [`skills/whatsapp/skill.json`](./skills/whatsapp/skill.json): Standard skill manifest with metadata, server command schemas, and limits.
- [`skills/whatsapp/references/mcp-tools.md`](./skills/whatsapp/references/mcp-tools.md): Full JSON schemas, input constraints, and return structures for all 9 tools.
- [`skills/whatsapp/examples/tool-usage.md`](./skills/whatsapp/examples/tool-usage.md): End-to-end agent workflow examples and MCP client configurations.

#### Adding the Skill to Compatible Agents

- **Antigravity / Project Workspace:**
  Link or copy the skill into your workspace's `.agents/skills/` directory:
  ```sh
  mkdir -p .agents/skills
  ln -sfn /path/to/whatsapp-cli/skills/whatsapp .agents/skills/whatsapp
  ```
  Or install globally:
  ```sh
  cp -r skills/whatsapp ~/.gemini/antigravity-cli/skills/
  ```
- **Claude Desktop / OpenBot / Cursor:**
  Add the server definition below to your configuration file (`claude_desktop_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "wa",
      "args": ["mcp"]
    }
  }
}
```

### Available MCP Tools

All 9 tools communicate locally with the background daemon over authenticated loopback HTTP:

1. `whatsapp_get_status`: Inspect daemon state (`ready`, `linking`, `recovering`) and account details.
2. `whatsapp_list_chats`: List recent chats with unread counts and snippets (limit: 1–200).
3. `whatsapp_list_contacts`: Search contacts by name query.
4. `whatsapp_get_chat_history`: Fetch message history for a contact, group JID, or `'me'` (limit: 1–200).
5. `whatsapp_send_message`: Send a text message to a contact, group, or `'me'` (up to 65k chars).
6. `whatsapp_send_image`: Send photos (JPEG, PNG, WebP, GIF, BMP, SVG, TIFF, ICO) up to 16 MB with optional caption.
7. `whatsapp_send_document`: Send files/documents (PDF, TXT, DOCX, etc.) up to 100 MB with original filenames.
8. `whatsapp_mark_seen`: Mark a chat as read.
9. `whatsapp_get_recent_messages`: Retrieve incoming messages from the in-memory ring buffer.

See [`skills/whatsapp/SKILL.md`](./skills/whatsapp/SKILL.md) for full instructions and troubleshooting.

## Linux System Tray Manager & Suspend/Resume Recovery

`wa` includes a native Linux system-tray indicator and automated suspend/resume recovery manager designed for Wayland (Hyprland, Quickshell, Waybar) and X11 (GNOME, KDE).

### 1. Tray Architecture & Icon States

The system tray manager (`src/tray/manager.py`) is a lightweight StatusNotifierItem (SNI) service using system `AyatanaAppIndicator3` and `Gtk 3.0` bindings (no Electron or heavy runtime required). It integrates natively into Quickshell (`end4-pC`), Waybar, or any FreeDesktop StatusNotifierWatcher host.

Real-time daemon synchronization is maintained via Server-Sent Events (`GET /receive`) with automated polling fallback.

#### Vector SVG Visual States (`assets/tray/`):

| State | Appearance | Meaning |
|---|---|---|
| **Ready** | Green (`#25D366`) with checkmark badge | Daemon is connected, authenticated, and verified operable |
| **Connecting** | Blue (`#0288D1`) with syncing dots badge | Establishing session, syncing messages, or resuming |
| **Recovering** | Amber (`#FF9800`) with circular sync arrow badge | Reconnecting session after network drop or frame detachment |
| **Error** | Red (`#E53935`) with exclamation warning badge | Recovery attempts exhausted or intervention needed |
| **Offline** | Grey (`#757575`) with slash badge | WhatsApp daemon stopped or unavailable |

### 2. Tray Menu Controls

Right-clicking or clicking the tray icon opens a native menu with:
- **Connection status**: Current status label with live updates.
- **Account details**: Linked phone number and pushname.
- **Last error / Last connected time**: Helpful contextual status.
- **View Chats**: Native dialog displaying active chats, unread badges, and contact details.
- **View Recent Messages**: Scrollable recent message history.
- **Reconnect**: Triggers real, controlled session recovery (`POST /reconnect`).
- **Daemon Lifecycle**: Start, Stop, and Restart controls.
- **Daemon Logs**: Open system logs in default editor (`~/.local/state/whatsapp-cli/daemon.log`).
- **Preferences & Autostart**: Configuration dialog for login autostart, auto-start daemon, notifications, and retry backoff.
- **Quit**: Exit the tray manager without killing the daemon.

### 3. Suspend / Resume Lifecycle & Recovery

#### The Problem:
When laptops sleep and resume, the network interface drops and Chromium in the background detaches or attempts to reload `web.whatsapp.com` before Wi-Fi and DNS stabilize. In standard clients, this leads to an infinite reconnect loop wedged in `CONNECTING` with `WhatsApp page reloaded — reconnecting…`.

#### The Fix:
1. **Sleep Detection**: The daemon listens to systemd-logind's `PrepareForSleep` DBus signal via `src/daemon/sleep.js`.
2. **Quiescence**: Upon impending sleep (`PrepareForSleep(true)`), incoming operations pause, active probe timers clear, and the daemon enters a suspended state rather than reporting stale readiness.
3. **Network Stabilization**: On wake (`PrepareForSleep(false)`), the daemon polls network and DNS reachability for `web.whatsapp.com` with exponential backoff before initiating reconnection.
4. **Safe Chrome Recovery**: Orphaned Chromium lock files bound to `.wwebjs_auth` are safely cleaned without affecting shared browser processes.
5. **Readiness Probe Verification**: Reconnection is verified with `isClientUsable()` before advertising `READY`.
6. **Bounded Backoff & Error Escalation**: Rather than looping infinitely, recovery retries with exponential backoff up to `maxRecoveryAttempts` (configurable, default 3–5). If recovery repeatedly fails, it transitions to a genuine `ERROR` state with user notification.

### 4. Autostart Configuration

Manage systemd user services (no root privileges required):

```bash
# Enable login autostart for both tray manager and daemon
wa autostart enable

# Check current autostart status
wa autostart status

# Disable autostart
wa autostart disable
```

Systemd unit files are provided in [`systemd/whatsapp-daemon.service`](./systemd/whatsapp-daemon.service) and [`systemd/whatsapp-tray.service`](./systemd/whatsapp-tray.service).

### 5. Launching the Tray Manager

```bash
# Launch in background (detached)
wa tray

# Launch in foreground with logs
wa tray --foreground

# Check running status
wa tray --status

# Stop tray manager
wa tray --stop
```

## The whatsapp-web.js v1.34.7 patch

Recent WhatsApp Web builds renamed the internal message-key field `_serialized`
to `$1`, breaking `getChats()` and `sendMessage()`. A pinned fork is avoided;
`scripts/wwebjs-patch.js` applies the upstream fix to `node_modules` and is
re-run by `postinstall` after each `npm install` (idempotent). See
`RELEASE.md` for details / re-apply with `npm run patch`.

## Development

```bash
npm test            # node:test unit suite (args, jid, probe, controller, daemon, client)
npm run fetch-web-build  # refresh pinned WhatsApp Web build into .wwebjs_cache
```

Files are generated data are kept under `.data/`, `.wwebjs_auth/`,
`.wwebjs_cache/` — all gitignored.

## License

ISC.