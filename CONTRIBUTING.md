# Contributing to WhatsApp CLI & MCP Server

Thank you for your interest in improving WhatsApp CLI! We welcome contributions that make terminal and agentic WhatsApp automation faster, safer, and more reliable.

---

## Core Project Principles

1. **Local-First & Private:** Authentication tokens, session databases, and media never leave the user's local machine. We do not support third-party telemetry, remote session sync, or cloud proxies.
2. **Personal Automation Only:** This tool is designed for personal productivity, notifications, and paired AI agent workflows. We strictly oppose bulk messaging, unsolicited spam, or scraping.
3. **Robust IPC & Self-Healing:** The background daemon must remain stable through network drops, laptop sleep cycles, and WhatsApp Web page refreshes without crashing or wedging.
4. **Clean MCP Standards:** The Model Context Protocol (MCP) server must strictly conform to the official JSON-RPC stdio protocol. Never write non-protocol logs or warnings to `stdout` in MCP mode.

---

## Development Setup

### 1. Fork & Clone
```bash
git clone https://github.com/<your-username>/whatsapp-cli.git
cd whatsapp-cli
```

### 2. Install Dependencies
```bash
npm install
```
*Note: `npm install` automatically triggers `postinstall` which applies `scripts/wwebjs-patch.js`.*

### 3. Running Unit Tests
All unit tests run offline using Node.js built-in test runner (`node:test`) and mock implementations:
```bash
npm test
# Or target a specific test:
node --test test/unit/mcp.test.js
```
No live WhatsApp connection or credentials are required to run the test suite.

### 4. Running Daemon in Foreground (Debugging)
To trace real-time events, IPC requests, and Puppeteer logs:
```bash
node src/daemon/index.js --foreground
```

---

## Code Structure & Conventions

```text
bin/
  └── wa.js                   # CLI entry point
src/
  ├── cli/                    # CLI argument parser and commands
  ├── config/                 # Paths, settings, and constants
  ├── daemon/                 # HTTP loopback server, sleep monitor, and controller
  ├── format/                 # Output tables, relative timestamps, and emoji
  ├── mcp/                    # Model Context Protocol stdio server and 9 tools
  ├── media/                  # Image/document validation and MIME resolution
  ├── tray/                   # Linux StatusNotifierItem system tray manager
  ├── tui/                    # Terminal ANSI full-screen dashboard
  └── whatsapp/               # whatsapp-web.js client, probe, and ring buffer
skills/
  └── whatsapp/               # Portable agent skill package (manifest, SKILL.md, docs)
test/
  └── unit/                   # Comprehensive offline unit test suite
```

### Rules for Contributions
- **No stdout pollution in MCP mode:** In `src/mcp/`, all errors and debug info must go through `console.error` (which writes to `stderr`) or MCP protocol result objects. Never call `console.log` on stdout inside MCP paths.
- **Strict File & Media Validation:** All file paths must be validated with `fs.statSync` to ensure they are regular files, readable, and within maximum size bounds (16 MB image, 100 MB document).
- **Graceful Error Handling:** IPC endpoints and MCP tools must catch internal errors and return structured error payloads (`{ ok: false, error: ... }`) instead of unhandled promise rejections.

---

## Submitting Pull Requests

1. Create a feature branch:
   ```bash
   git checkout -b feat/my-improvement
   ```
2. Verify all unit tests pass:
   ```bash
   npm test
   ```
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat(...)`: New capability or tool
   - `fix(...)`: Bug fix or recovery improvement
   - `docs(...)`: Documentation updates
   - `test(...)`: Unit test additions
4. Push your branch and open a Pull Request against `main`.

Thank you for helping build high-quality developer tooling for WhatsApp!
