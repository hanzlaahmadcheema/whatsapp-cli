# Changelog

All notable changes to **WhatsApp CLI** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-10-30

### Added
- **Linux System Tray Manager (`wa tray`)**:
  - Lightweight StatusNotifierItem (SNI) app indicator for Hyprland, Quickshell, Waybar, GNOME, and KDE.
  - 5 vector SVG tray icons representing real-time daemon states: Ready (green), Connecting (blue), Recovering (amber), Error (red), and Offline (grey).
  - Native contextual GTK menu with connection details, recent chats viewer, recent messages viewer, reconnect trigger, daemon lifecycle controls, and autostart preferences.
- **Laptop Suspend / Resume Recovery**:
  - DBus `PrepareForSleep` signal monitoring via systemd-logind (`src/daemon/sleep.js`).
  - Quiesces daemon operations upon sleep and halts active timers to prevent detached frame errors.
  - Automated post-wake network stabilization with exponential backoff DNS verification for `web.whatsapp.com`.
  - Bounded recovery escalation: transitions to explicit error state instead of looping indefinitely if connection cannot be re-established.
- **End-to-End Media Sending**:
  - Send photos and images up to 16 MB with optional captions (`wa send-image <target> <file> [caption]`).
  - Send documents and files up to 100 MB with original filenames (`wa send-file <target> <file> [caption]`).
  - Dedicated daemon endpoint `POST /send-media` with multipart-safe payload handling.
  - MCP tools: `whatsapp_send_image` and `whatsapp_send_document`.
  - Strict security validation: path existence, regular file check (`isFile()`), non-empty check, and MIME resolution.
- **Model Context Protocol (MCP) Server**:
  - Built-in stdio server (`wa mcp`) exposing 9 specialized tools for AI coding assistants and autonomous agents.
  - Zero stdout logging pollution to preserve JSON-RPC message framing.
- **Reusable Agent Skill (`skills/whatsapp/`)**:
  - Portable skill package containing `skill.json` manifest, comprehensive `SKILL.md` instructions, detailed tool schemas (`references/mcp-tools.md`), and end-to-end integration workflows (`examples/tool-usage.md`).
- **Autostart User Services**:
  - `wa autostart [enable|disable|status]` command managing systemd user units (`whatsapp-daemon.service` and `whatsapp-tray.service`) without root privileges.
- **Agent Integration Guide (`docs/agent-integration.md`)**:
  - Complete configuration and verification guides for OpenBot, Claude Desktop, Claude Code, Cursor, VS Code / Copilot, Google Antigravity, and Codex.
- **Cross-Platform Guide (`docs/cross-platform.md`)**:
  - Installation, dependency setup, and lifecycle instructions for Windows 10/11, macOS, and Linux.

### Fixed
- **WhatsApp Web 2026 Getter Memoization Crash**:
  - Resolved `Data passed to getter must include an id property` crash when constructing media objects in WhatsApp Web by stripping `__x_id` and preserving `newMsgKey` in `scripts/wwebjs-patch.js`.
- **Premature Readiness Race Condition**:
  - Prevented daemon from signaling `READY` until `isClientUsable()` verifies active WhatsApp Web chat models.
- **Daemon Cross-Killing on Reload**:
  - Added PID verification to ensure running daemons never kill concurrent or freshly spawned instances.
  - Cleaned up orphaned Chromium singleton locks (`.wwebjs_auth/SingletonLock`) synchronously before browser launch.
- **Unawaited Child Process Cleanup**:
  - Replaced fire-and-forget `pkill` with synchronous process tree inspection to avoid zombie browser instances.

---

## [1.0.0] - 2026-08-08

### Added
- **Two-Process Architecture**:
  - Long-lived background daemon communicating with WhatsApp Web via `whatsapp-web.js` and Puppeteer.
  - Lightweight CLI frontend (`wa`) communicating with daemon over loopback HTTP with ephemeral random bearer tokens (`x-wa-token`).
- **Core CLI Commands**:
  - `wa login`: Interactive QR linking with automatic terminal ASCII rendering.
  - `wa status`: Detailed daemon and session diagnostics.
  - `wa chats`: List recent chats with unread badges.
  - `wa contacts`: Address book search with name filtering.
  - `wa history`: Recent message history for any contact or group.
  - `wa send`: Text message delivery to international numbers and group JIDs.
  - `wa receive`: Server-Sent Events (SSE) stream for incoming messages.
  - `wa logout`: Unlink active device session.
- **Terminal UI (`wa tui`)**:
  - Zero-dependency full-screen ANSI terminal dashboard featuring chat list, conversation view, and message composer.
- **In-Place Upstream Patch (`scripts/wwebjs-patch.js`)**:
  - Automated patching of `whatsapp-web.js@1.34.7` to tolerate minified message keys (`$1`) in WhatsApp Web.
- **Offline Unit Test Suite**:
  - 100% mocked, deterministic test suite running under Node.js native test runner (`node:test`).
