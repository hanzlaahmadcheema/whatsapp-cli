---
name: whatsapp
description: Control WhatsApp via the WhatsApp CLI Model Context Protocol (MCP) server. Use this skill whenever an agent needs to inspect WhatsApp connection and account status, list recent chats or contacts, read message history, stream recent incoming messages, mark messages as read, send text messages, send photos/documents to contacts and groups, list recently received incoming media, inspect attachment metadata, or download incoming photos and documents to disk.
---

# WhatsApp MCP Agent Skill

This skill guides autonomous agents and AI coding assistants in interacting with WhatsApp through the WhatsApp CLI Model Context Protocol (MCP) server.

The server exposes 12 specialized tools that interface with a long-running, token-authenticated local daemon backed by Puppeteer and `whatsapp-web.js`.

---

## 1. Discovery and Connection Prerequisites

Agents should not assume the WhatsApp MCP server is connected by default. Follow this discovery and initialization sequence:

### A. Detect Available Tools
Check your current agent environment for tools prefixed with `whatsapp_`:
- If `whatsapp_get_status` is available, the MCP server is connected.
- If not available, configure the MCP server using the stdio transport:

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
*(Or specify the direct Node.js path: `node /path/to/whatsapp-cli/src/mcp/index.js`)*.

### B. Verify Daemon Readiness
Always call `whatsapp_get_status` before performing read/write operations:
- **`state: "ready"`**: The daemon is linked and ready.
- **`state: "linking"`**: WhatsApp Web is displaying a QR code. Direct the user to run `wa login` in their terminal to scan the code. Never attempt to read or emit raw QR tokens.
- **`state: "initializing"` or `"recovering"`**: Wait a few seconds for the daemon to re-establish the WhatsApp Web session.
- **`error: "WhatsApp daemon is not reachable"`**: The background daemon is stopped. Instruct the user to run `wa status` or start it via CLI (`wa daemon`).

---

## 2. Available MCP Tools (Summary)

| Tool Name | Action | Key Parameters | Return Value |
| :--- | :--- | :--- | :--- |
| `whatsapp_get_status` | Check daemon connection & account | None | `{ ok, state, account: { number, name }, lastError }` |
| `whatsapp_list_chats` | List recent conversations | `limit` (default: 50, max: 200) | `{ ok, count, chats: [...] }` |
| `whatsapp_list_contacts` | Search contacts address book | `name` (optional filter) | `{ ok, count, contacts: [...] }` |
| `whatsapp_get_chat_history` | Retrieve messages for a chat | `target`, `limit` (default: 50) | `{ ok, target, count, messages: [...] }` |
| `whatsapp_send_message` | Send plain text message | `target`, `message` (up to 65k chars) | `{ ok, messageId, to, timestamp }` |
| `whatsapp_send_image` | Send photo with optional caption | `target`, `filePath`, `caption` | `{ ok, messageId, to, filename, mimetype, timestamp }` |
| `whatsapp_send_document` | Send file with original filename | `target`, `filePath`, `filename`, `caption` | `{ ok, messageId, to, filename, mimetype, timestamp }` |
| `whatsapp_get_recent_media` | List incoming images & documents | `chatId`, `type` (image/doc/all), `limit`, `sinceTimestamp` | `{ ok, count, media: [...] }` |
| `whatsapp_download_media` | Download attachment by message ID | `messageId`, `outputDir`, `filename` | `{ ok, messageId, filePath, filename, mimetype, size, caption, cached }` |
| `whatsapp_get_media_info` | Inspect media metadata | `messageId` | `{ ok, media: { messageId, type, mimetype, filename, filesize, caption, downloaded, filePath } }` |
| `whatsapp_mark_seen` | Mark a chat as read | `target` | `{ ok, chatId }` |
| `whatsapp_get_recent_messages` | Read incoming SSE ring buffer | `limit` (max 100), `sinceTimestamp`, `chatId` | `{ ok, bufferedTotal, count, messages: [...] }` |

For detailed JSON schemas, field types, and endpoint mappings, see [MCP Tools Reference](./references/mcp-tools.md).

---

## 3. Recipient Identifier (`target`) Resolution

All message, history, and media tools accept a flexible `target` string:

1. **`"me"` or `"self"`**: Automatically resolves to the authenticated user's own phone number. Ideal for personal notes, reminders, or agent alerts.
2. **Standard Phone Numbers**: International format without leading `+` or zeros (e.g. `15551234567` or `923001234567`). The client automatically appends `@c.us`.
3. **Contact JIDs**: Explicit format `15551234567@c.us`.
4. **Group JIDs**: Group conversations ending with `@g.us` (e.g. `123456789-987654@g.us`).

---

## 4. Media Rules and Constraints

### Image Sending (`whatsapp_send_image`)
- **Max File Size:** **16 MB** (`16,777,216` bytes).
- **Supported Formats:** JPEG (`.jpg`, `.jpeg`), PNG (`.png`), WebP (`.webp`), GIF (`.gif`), BMP (`.bmp`), SVG (`.svg`), TIFF (`.tiff`), Icon (`.ico`).
- **Display:** Appears in WhatsApp as a native photo card with an optional caption.
- **Enforcement:** Non-image files or files exceeding 16 MB are rejected with explicit errors.

### Document Sending (`whatsapp_send_document`)
- **Max File Size:** **100 MB** (`104,857,600` bytes).
- **Supported Formats:** Any document or binary file (PDF, TXT, DOCX, XLSX, ZIP, CSV, TAR, etc.).
- **Filename Handling:** Defaults to the file's original basename on disk. Pass `filename` to override what the recipient sees.
- **MIME Detection:** Automatically detects MIME types via extension; defaults to `application/octet-stream`.

### Receiving & Downloading Media (`whatsapp_get_recent_media`, `whatsapp_download_media`)
- **Discovery:** Use `whatsapp_get_recent_media({ type, chatId, limit })` to list incoming photos and documents across conversations or from a specific chat.
- **Downloading:** Pass the `messageId` to `whatsapp_download_media({ messageId })` to download and save the file to local disk.
- **Local File Paths:** The tool returns an absolute `filePath` (stored by default in `.data/media/`) which agents can directly inspect, read, or process.
- **Caching:** If the media was already downloaded, the existing file is returned immediately with `cached: true` without re-downloading.
- **Path Traversal Protection:** All filenames are sanitized to prevent directory traversal; custom output directories are strictly validated.

### Common File Validation Requirements
Before calling `whatsapp_send_image` or `whatsapp_send_document`:
1. The path must point to an **existing regular file** (`fs.statSync().isFile()`). Directories, FIFO pipes, and sockets are rejected.
2. The file must **not be empty** (0-byte files are rejected).
3. The process must have **read permissions** (`R_OK`).

---

## 5. Agent Interaction Workflows

### Workflow 1: Status Inspection & Pre-flight Check
Always check status first. If `state !== "ready"`, abort sending and inform the user.
```json
// Tool Call
whatsapp_get_status()
```

### Workflow 2: Sending Messages & Verifying Delivery
1. Resolve the recipient's phone number or JID (use `whatsapp_list_contacts` if uncertain).
2. Send message with `whatsapp_send_message` or media with `whatsapp_send_image` / `whatsapp_send_document`.
3. Verify that `ok: true` and a valid `messageId` is returned.

### Workflow 3: Monitoring Incoming Messages
The daemon maintains an in-memory ring buffer of the last 100 incoming messages received via Server-Sent Events (SSE).
1. Query messages: `whatsapp_get_recent_messages({ limit: 20, sinceTimestamp: <last_checked_time> })`.
2. Filter by `chatId` if following a specific conversation.
3. Mark acknowledged messages as read: `whatsapp_mark_seen({ target: "<chatId>" })`.

### Workflow 4: Finding and Downloading Incoming Photos & Documents
1. Find recent media: `whatsapp_get_recent_media({ type: "all" })` or filter by contact `whatsapp_get_recent_media({ chatId: "15551234567" })`.
2. Inspect attachment metadata: `whatsapp_get_media_info({ messageId: "<messageId>" })`.
3. Download the attachment: `whatsapp_download_media({ messageId: "<messageId>" })`.
4. The response provides the absolute `filePath`, `mimetype`, `size`, and `filename` for immediate agent processing.

For complete request and response payloads across scenarios, see [Tool Usage Examples](./examples/tool-usage.md).

---

## 6. Security and Privacy Guidelines

- **Token Protection:** The daemon requires an `x-wa-token` header generated on launch. The MCP server automatically handles token authentication and sanitizes tokens from error messages. Agents must never output or request raw tokens.
- **Standard I/O Integrity:** The MCP server strictly isolates protocol frames on `stdout` and logs diagnostic info exclusively to `stderr`. Never write non-protocol output to `stdout`.
- **Recipient Confirmation:** Before sending messages or files to external phone numbers or groups, ensure you have explicit user intent.

---

## 7. Troubleshooting & Recovery

| Issue | Resolution |
| :--- | :--- |
| **Tool error:** `WhatsApp daemon is not reachable` | The daemon is offline. Prompt the user to run `wa status` in a terminal to spawn it. |
| **Tool error:** `WhatsApp daemon is not ready yet` | Daemon is unlinked (`state: linking`). Ask the user to run `wa login` and scan the QR code. |
| **Tool error:** `File not found` or `Path is not a regular file` | Check the file path. Use absolute paths where possible. |
| **Tool error:** `File size exceeds the maximum allowed limit` | Files larger than 16 MB (images) or 100 MB (documents) cannot be sent. Compress or reduce file size. |
| **Tool error:** `not a supported image format` | For uncommon or proprietary image formats, send them using `whatsapp_send_document` instead. |
| **Detached Puppeteer frame / page crash** | The daemon automatically recovers from detached frames. Retry the call after 5 seconds. |
