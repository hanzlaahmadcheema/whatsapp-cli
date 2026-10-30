# AI Agent Integration Guide for WhatsApp MCP Server

This guide explains how to connect autonomous AI agents, coding assistants, and LLM applications to the **WhatsApp CLI Model Context Protocol (MCP)** server and utilize the reusable **WhatsApp Agent Skill**.

---

## Architecture Overview

The WhatsApp CLI MCP server uses standard I/O (`stdio`) JSON-RPC communication as defined by the [Model Context Protocol](https://modelcontextprotocol.io/). It bridges your AI agent directly to the local, token-authenticated WhatsApp background daemon:

```
┌────────────────────────────────────────────────────────┐
│                      AI AGENT                          │
│   (OpenBot / Claude Desktop / Cursor / Antigravity)   │
└──────────────────────────┬─────────────────────────────┘
                           │ JSON-RPC (stdio transport)
                           ▼
┌────────────────────────────────────────────────────────┐
│           WhatsApp MCP Server (wa mcp)                 │
│        9 Standard Tools  •  Local Loopback HTTP        │
└──────────────────────────┬─────────────────────────────┘
                           │ x-wa-token authenticated REST / SSE
                           ▼
┌────────────────────────────────────────────────────────┐
│             WhatsApp Daemon (wa daemon)                │
│    Session Controller  •  Event Bus  •  LocalAuth      │
└──────────────────────────┬─────────────────────────────┘
                           │ Puppeteer CDP
                           ▼
┌────────────────────────────────────────────────────────┐
│                 Chromium Headless                      │
│                  WhatsApp Web                          │
└────────────────────────────────────────────────────────┘
```

---

## Agent Support Matrix

| Agent / IDE | Transport | Native Skill Support | Config Location | Setup Complexity |
| :--- | :--- | :--- | :--- | :--- |
| **OpenBot** | stdio | Yes (`skills/` directory) | `openbot.json` / workspace config | Simple (1 click / 1 JSON entry) |
| **Claude Desktop** | stdio | Manual (via system prompt) | `claude_desktop_config.json` | Simple |
| **Claude Code (CLI)** | stdio | Yes (`~/.claude/skills/` or prompt) | `~/.claude.json` / `settings.json` | Simple |
| **Cursor** | stdio | Manual (via `.cursorrules`) | `.cursor/mcp.json` | Simple |
| **VS Code / Copilot** | stdio | Manual (via instructions file) | `.vscode/mcp.json` / workspace settings | Simple |
| **Google Antigravity / Gemini** | stdio | Yes (native `.agents/skills/`) | `mcp_config.json` | Simple |
| **Codex / Custom Clients** | stdio | Configurable | Custom client config / SDK | Simple |

---

## Autonomous Setup Prompt for AI Agents

If you are pairing with an AI agent (Cursor, Claude Code, OpenBot, Google Antigravity, Windsurf, Roo Code), you can give it the following prompt to autonomously configure WhatsApp CLI and its MCP tools:

```text
Please set up the WhatsApp CLI and Model Context Protocol (MCP) server for our environment:
1. Clone https://github.com/hanzlaahmadcheema/whatsapp-cli.git if not already present.
2. In the repository directory, run `npm install` (which automatically runs the wwebjs patch) and `npm link` so `wa` is globally available.
3. Add the WhatsApp MCP server to our agent MCP configuration:
   - command: "wa" (or "node <path-to-whatsapp-cli>/src/mcp/index.js")
   - args: ["mcp"]
4. If this agent supports skills, copy `skills/whatsapp/` to our skills directory (or import `skills/whatsapp/SKILL.md` into workspace instructions).
5. Guide me to run `wa login` in a visible terminal so I can scan the QR code with WhatsApp on my phone.
6. Once I confirm linking, verify the connection safely by calling the `whatsapp_get_status` tool (confirm state is "ready"). Do NOT send any test messages.
7. Confirm that all 9 WhatsApp tools are registered and ready for use.
```

---

## Pre-flight Checklist

Before configuring your agent:
1. Complete first-time WhatsApp login in your terminal:
   ```bash
   wa login
   ```
2. Verify the daemon is running and healthy:
   ```bash
   wa status
   ```
   Output should show `State: ready` and your account details.
3. Ensure `wa` is globally available (`npm link` or in your system `PATH`), or note the absolute path to your cloned repository.

---

## Agent Configuration Guides

### 1. OpenBot

OpenBot natively discovers both MCP servers and reusable agent skills.

#### Stdio Server Configuration
Add the WhatsApp server to your OpenBot settings or workspace `openbot.json`:

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

*Or with an explicit node path if not linked globally:*
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-cli/src/mcp/index.js"]
    }
  }
}
```

#### Installing the Reusable Skill
Copy or symlink the skill package into OpenBot's skills directory:
```bash
# Workspace level:
mkdir -p .openbot/skills
cp -r /path/to/whatsapp-cli/skills/whatsapp .openbot/skills/

# Or global level:
mkdir -p ~/.openbot/skills
cp -r /path/to/whatsapp-cli/skills/whatsapp ~/.openbot/skills/
```

---

### 2. Claude Desktop & Claude Code

Anthropic's Claude Desktop communicates with local MCP servers via standard I/O.

#### Configuration File Locations

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

#### Configuration Snippet

**macOS / Linux:**
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

**Windows (PowerShell):**
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "cmd.exe",
      "args": ["/c", "wa", "mcp"]
    }
  }
}
```
*(If `wa` is not in global PATH on Windows, specify `node.exe` and the full path to `src\\mcp\\index.js`)*:
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node.exe",
      "args": ["C:\\Users\\Username\\Projects\\whatsapp-cli\\src\\mcp\\index.js"]
    }
  }
}
```

#### Verification in Claude Desktop
1. Completely quit Claude Desktop (Cmd+Q on macOS, or right-click tray icon and Exit on Windows).
2. Start Claude Desktop.
3. Look for the hammer / tool icon in the bottom-right corner of the prompt box. You should see `whatsapp` with all 9 tools listed:
   - `whatsapp_get_status`
   - `whatsapp_list_chats`
   - `whatsapp_list_contacts`
   - `whatsapp_get_chat_history`
   - `whatsapp_send_message`
   - `whatsapp_mark_seen`
   - `whatsapp_get_recent_messages`
   - `whatsapp_send_image`
   - `whatsapp_send_document`

---

### 3. Cursor

Cursor supports MCP servers in `.cursor/mcp.json` or through Cursor Settings > Features > MCP.

#### Configuration File Location
Create or edit `.cursor/mcp.json` in your project root or user config:
- **macOS / Linux:** `~/.cursor/mcp.json` or `<workspace>/.cursor/mcp.json`
- **Windows:** `%USERPROFILE%\.cursor\mcp.json` or `<workspace>\.cursor\mcp.json`

#### Configuration Snippet
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

#### Adding Agent Skill Guidelines to Cursor
To ensure Cursor adheres to media size limits, recipient formatting, and safe verification, add the following to `.cursorrules` or `.cursor/rules/whatsapp.mdc`:

```markdown
# WhatsApp MCP Tool Guidelines
- When interacting with WhatsApp via MCP, always call `whatsapp_get_status` first.
- Recipient targets can be "me", an international phone number without "+" (e.g. 15551234567), or a group JID ending in @g.us.
- Maximum image size for `whatsapp_send_image` is 16 MB.
- Maximum document size for `whatsapp_send_document` is 100 MB.
- Files must be existing regular files on the local disk.
- Never loop sends or perform bulk messaging.
```

---

### 4. VS Code / GitHub Copilot

VS Code supports MCP servers natively through the MCP extension or Copilot settings.

#### Configuration File Location
Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "whatsapp": {
      "type": "stdio",
      "command": "wa",
      "args": ["mcp"]
    }
  }
}
```

#### Adding Copilot Agent Instructions
Add to `.github/copilot-instructions.md`:
```markdown
## WhatsApp Integration
Use the `whatsapp_*` MCP tools to inspect status, retrieve chats, and send text/media. Always verify connection with `whatsapp_get_status` before sending. Format phone numbers as digits only (e.g. `923001234567`), or use `"me"` for personal notes.
```

---

### 5. Google Antigravity & Gemini CLI

Antigravity natively manages tools and skills.

#### MCP Configuration
Edit `~/.gemini/antigravity-cli/mcp_config.json`:
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

#### Installing the Native Skill
Install the WhatsApp skill into your active Antigravity workspace or global skills directory:
```bash
# Global installation:
mkdir -p ~/.gemini/antigravity-cli/skills/
cp -r skills/whatsapp ~/.gemini/antigravity-cli/skills/

# Workspace installation:
mkdir -p .agents/skills/
cp -r skills/whatsapp .agents/skills/
```

Antigravity will automatically index `SKILL.md` and `skill.json` to guide the model when WhatsApp tasks are requested.

---

### 6. Codex & Custom Stdio Clients

You can connect any custom agent or Python/TypeScript SDK using standard subprocess piping:

#### Python Example (`mcp` SDK)
```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_params = StdioServerParameters(
    command="wa",
    args=["mcp"]
)

async def main():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            
            # List available tools
            tools = await session.list_tools()
            print("Connected tools:", [t.name for t in tools.tools])
            
            # Check daemon status
            status = await session.call_tool("whatsapp_get_status", arguments={})
            print("Daemon status:", status.content)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

---

## Safe Verification Step

When your agent connects to the WhatsApp MCP server, have it execute a **zero-risk pre-flight verification** before attempting any message sends:

### Verification Tool Call:
```json
{
  "name": "whatsapp_get_status",
  "arguments": {}
}
```

### Expected Successful Response:
```json
{
  "ok": true,
  "state": "ready",
  "account": {
    "number": "15551234567",
    "name": "User Name"
  },
  "lastError": null,
  "nodeVersion": "v20.18.0",
  "appVersion": "1.0.0"
}
```

If `state` is `"ready"`, the agent is verified and ready for interaction.

---

## Agent Skill Integration Modes

The repository package in [`skills/whatsapp/`](../skills/whatsapp/) provides structured agent instructions:

### Mode 1: Native Agent Skill System
*For OpenBot, Antigravity, and Claude Code:*
- Copy `skills/whatsapp/` to your agent's skills directory.
- The agent reads `skill.json` for capabilities and `SKILL.md` for conversational rules, parameter validation, and workflows.

### Mode 2: Instruction / Rule System
*For Cursor, GitHub Copilot, and Windsurf:*
- Reference or copy `skills/whatsapp/SKILL.md` into your project's rules file (`.cursorrules`, `.github/copilot-instructions.md`).
- This primes the LLM with recipient resolution rules (`"me"`, digits-only formatting, group JIDs), file size boundaries (16 MB / 100 MB), and error recovery flows.

### Mode 3: Direct MCP Tool Use (Zero-Skill Minimalist)
*For basic LLMs with tool calling:*
- The MCP tool definitions in `src/mcp/tools.js` include comprehensive parameter schemas, field types, and inline docstrings.
- The LLM can operate successfully from tool descriptions alone without an external skill file.

---

## Common Pitfalls & Troubleshooting

### 1. `Daemon is not reachable`
- **Cause:** The background daemon is stopped or the auth token file (`.data/daemon.json`) is missing.
- **Fix:** In your terminal, run `wa daemon` or `wa status`. Once started, the daemon persists across agent sessions.

### 2. `Daemon is not ready. Current state: linking`
- **Cause:** The WhatsApp Web session has not been authenticated yet.
- **Fix:** Run `wa login` in an interactive terminal to scan the QR code. Once scanned, `wa status` will report `State: ready`.

### 3. `Image file size ... exceeds maximum allowed size of 16 MB`
- **Cause:** `whatsapp_send_image` strictly enforces WhatsApp's 16 MB photo limit.
- **Fix:** Use `whatsapp_send_document` instead, which supports files up to 100 MB.

### 4. `File does not exist or is not a regular file`
- **Cause:** The agent passed a directory, named pipe, or nonexistent path.
- **Fix:** Ensure the file exists and provide an absolute path on disk (e.g. `/path/to/report.pdf` or `C:\Users\Username\file.pdf`).

### 5. `Data passed to getter must include an id property`
- **Cause:** Unpatched `whatsapp-web.js` version.
- **Fix:** Run `npm run patch` inside the `whatsapp-cli` directory. This applies the idempotent patch for WhatsApp Web's 2026 memoized getter changes.
