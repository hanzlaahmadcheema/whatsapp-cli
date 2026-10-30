# Security Policy

## Security Architecture & Data Privacy

WhatsApp CLI is designed from the ground up as a **strictly local-first, privacy-respecting tool**.

### 1. Loopback-Only IPC Binding
The background daemon listens exclusively on the loopback interface (`127.0.0.1`). It never binds to `0.0.0.0` or accepts inbound traffic from external network interfaces.

### 2. Ephemeral Daemon Authentication Tokens
Every time the WhatsApp daemon starts:
- A cryptographically random authentication token is generated using Node.js `crypto.randomBytes(24)`.
- The token is written to `.data/daemon.json` with restricted file permissions (`0600` on POSIX systems).
- All loopback HTTP endpoints (`/send`, `/chats`, `/contacts`, `/history`, `/send-media`, `/status`, `/reconnect`) require the `x-wa-token` header. Requests with missing or invalid tokens are rejected immediately with HTTP 401 Unauthorized.

### 3. Local Credential Storage
- Your WhatsApp Web authentication state, session keys, and encryption credentials are stored locally in `.wwebjs_auth/session/` using standard Chromium LocalAuth storage.
- Credentials and messages **never leave your local machine**. There is no cloud backend, telemetry server, or remote tracking.

### 4. Media & File Path Security
When sending photos (`whatsapp_send_image` / `wa send-image`) or files (`whatsapp_send_document` / `wa send-file`):
- All file paths are validated before access.
- Non-regular files (directories, FIFO named pipes, character devices, symlinks pointing to non-files) are strictly rejected.
- Size limits (16 MB for images, 100 MB for documents) are checked via `fs.statSync().size` prior to loading file buffers to prevent Out-Of-Memory (OOM) attacks.

### 5. Stdio Protocol Hygiene (MCP)
The Model Context Protocol (MCP) server communicates over standard input/output (`stdio`).
- Logging and debugging output is routed exclusively to `stderr` or structured protocol errors.
- Authentication tokens, PID details, and internal daemon secrets are filtered and never broadcast across the MCP tool interface.

---

## Reporting a Vulnerability

If you discover a security vulnerability or security-sensitive defect in WhatsApp CLI, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Send a report via [GitHub Security Advisories](https://github.com/hanzlaahmadcheema/whatsapp-cli/security/advisories) or email `hanzla.cheema@gmail.com` with:
   - Description of the vulnerability.
   - Steps to reproduce or proof-of-concept.
   - Potential impact.
3. We will acknowledge receipt within 48 hours and work with you to test and release a security patch.
