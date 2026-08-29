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
| `wa receive` | Stream incoming messages |
| `wa logout` | Force logout / unlink the device |
| `wa tui` | Full-screen interactive UI |

## FAQ / notes

- `/send` POST accepts `{ "to": "<jid>", "message": "hi" }`.
- Contacts groups accepted as `1234...@g.us` (no number validation).
- Personal use only — avoid automated bulk sends (rate limits).

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