# WhatsApp MCP Tool Usage Examples

This guide provides concrete examples of configuring the WhatsApp MCP server and calling its 9 tools in agentic workflows.

---

## 1. Connecting the MCP Server to Your Agent

The MCP server runs over standard I/O (`stdio`). You can launch it using the `wa` binary or directly with `node`.

### Antigravity (`~/.gemini/antigravity-cli/mcp_config.json`)
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
*Or using direct node path:*
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["<path-to-whatsapp-cli>/src/mcp/index.js"]
    }
  }
}
```

### Claude Desktop / OpenBot (`claude_desktop_config.json`)
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

### Cursor (`.cursor/mcp.json`)
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

---

## 2. Agent Usage Workflows

### Scenario A: Checking Connection Health Before Performing Actions
Before sending any message or querying private data, agents should inspect connection state:

**Tool Call:**
```json
{
  "name": "whatsapp_get_status",
  "arguments": {}
}
```

**Successful Response:**
```json
{
  "ok": true,
  "state": "ready",
  "account": {
    "number": "923124706501",
    "name": "Tapu"
  },
  "lastError": null,
  "nodeVersion": "v20.18.0",
  "appVersion": "1.0.0"
}
```
*Agent Decision:* The state is `"ready"`, so proceed. If the state was `"linking"`, instruct the user to run `wa login` in their terminal to scan the QR code.

---

### Scenario B: Searching for a Contact and Fetching Conversation History

**Step 1: Search contact by name**
```json
{
  "name": "whatsapp_list_contacts",
  "arguments": {
    "name": "Farhan"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "count": 1,
  "contacts": [
    {
      "id": "923001234567@c.us",
      "name": "Farhan Ali",
      "pushname": "Farhan",
      "number": "923001234567",
      "isMyContact": true,
      "isUser": true,
      "isGroup": false
    }
  ]
}
```

**Step 2: Fetch last 5 messages from Farhan**
```json
{
  "name": "whatsapp_get_chat_history",
  "arguments": {
    "target": "923001234567@c.us",
    "limit": 5
  }
}
```

---

### Scenario C: Sending a Plain Text Message

Send a confirmation message to a client or to self (`"me"`):

**Tool Call:**
```json
{
  "name": "whatsapp_send_message",
  "arguments": {
    "target": "923001234567",
    "message": "Hello Farhan, the deployment was completed successfully at 21:00 UTC."
  }
}
```

**Response:**
```json
{
  "ok": true,
  "messageId": "true_923001234567@c.us_3EB077123A45B6C",
  "to": "923001234567@c.us",
  "timestamp": 1729000100
}
```

---

### Scenario D: Sending a Photo or Screenshot with Caption

Send an architecture diagram or photo (max 16 MB):

**Tool Call:**
```json
{
  "name": "whatsapp_send_image",
  "arguments": {
    "target": "923001234567",
    "filePath": "/path/to/diagram.png",
    "caption": "Updated system architecture diagram for review"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "messageId": "true_923001234567@c.us_3EB088234B56C7D",
  "to": "923001234567@c.us",
  "filename": "architecture.png",
  "mimetype": "image/png",
  "timestamp": 1729000120
}
```

---

### Scenario E: Sending a Document with Custom Filename and Caption

Send a PDF report or archive file (max 100 MB):

**Tool Call:**
```json
{
  "name": "whatsapp_send_document",
  "arguments": {
    "target": "923001234567",
    "filePath": "/tmp/generated_export_20261029.pdf",
    "filename": "October_Monthly_Performance.pdf",
    "caption": "Attached is the monthly performance summary."
  }
}
```

**Response:**
```json
{
  "ok": true,
  "messageId": "true_923001234567@c.us_3EB099345C67D8E",
  "to": "923001234567@c.us",
  "filename": "October_Monthly_Performance.pdf",
  "mimetype": "application/pdf",
  "timestamp": 1729000140
}
```

---

### Scenario F: Reading Incoming Messages and Marking Them as Read

**Step 1: Check in-memory ring buffer for incoming messages received after timestamp 1729000000**
```json
{
  "name": "whatsapp_get_recent_messages",
  "arguments": {
    "limit": 10,
    "sinceTimestamp": 1729000000
  }
}
```

**Response:**
```json
{
  "ok": true,
  "bufferedTotal": 12,
  "count": 1,
  "messages": [
    {
      "id": "false_923001234567@c.us_3EB0012A",
      "chatId": "923001234567@c.us",
      "from": "923001234567@c.us",
      "to": "923124706501@c.us",
      "fromMe": false,
      "author": null,
      "body": "Can you check the latest release build?",
      "timestamp": 1729000150
    }
  ]
}
```

**Step 2: Acknowledge and mark the conversation as read**
```json
{
  "name": "whatsapp_mark_seen",
  "arguments": {
    "target": "923001234567@c.us"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "chatId": "923001234567@c.us"
}
```
