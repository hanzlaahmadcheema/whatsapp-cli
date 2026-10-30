"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.resolve(__dirname, "../../skills/whatsapp");

test("skill manifest (skill.json) is valid and lists all 12 MCP tools", () => {
  const manifestPath = path.join(SKILL_DIR, "skill.json");
  assert.ok(fs.existsSync(manifestPath), "skill.json must exist");

  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  assert.equal(manifest.name, "whatsapp");
  assert.equal(typeof manifest.version, "string");
  assert.ok(manifest.description && manifest.description.length > 20);
  assert.equal(manifest.mcp.transport, "stdio");
  assert.equal(manifest.mcp.serverName, "whatsapp");

  const expectedTools = [
    "whatsapp_get_status",
    "whatsapp_list_chats",
    "whatsapp_list_contacts",
    "whatsapp_get_chat_history",
    "whatsapp_send_message",
    "whatsapp_mark_seen",
    "whatsapp_get_recent_messages",
    "whatsapp_send_image",
    "whatsapp_send_document",
    "whatsapp_get_recent_media",
    "whatsapp_download_media",
    "whatsapp_get_media_info",
  ];

  assert.deepEqual(manifest.tools.slice().sort(), expectedTools.slice().sort());
  assert.equal(manifest.limits.maxImageSizeBytes, 16 * 1024 * 1024);
  assert.equal(manifest.limits.maxDocumentSizeBytes, 100 * 1024 * 1024);
});

test("SKILL.md has valid YAML frontmatter and documents key sections", () => {
  const skillMdPath = path.join(SKILL_DIR, "SKILL.md");
  assert.ok(fs.existsSync(skillMdPath), "SKILL.md must exist");

  const content = fs.readFileSync(skillMdPath, "utf8");
  assert.ok(content.startsWith("---\n"), "SKILL.md must start with YAML frontmatter");

  const endOfFrontmatter = content.indexOf("\n---\n", 4);
  assert.ok(endOfFrontmatter > 0, "SKILL.md must close YAML frontmatter");

  const frontmatter = content.slice(4, endOfFrontmatter);
  assert.ok(frontmatter.includes("name: whatsapp"));
  assert.ok(frontmatter.includes("description:"));

  // Verify all 12 tools are mentioned
  const tools = [
    "whatsapp_get_status",
    "whatsapp_list_chats",
    "whatsapp_list_contacts",
    "whatsapp_get_chat_history",
    "whatsapp_send_message",
    "whatsapp_mark_seen",
    "whatsapp_get_recent_messages",
    "whatsapp_send_image",
    "whatsapp_send_document",
    "whatsapp_get_recent_media",
    "whatsapp_download_media",
    "whatsapp_get_media_info",
  ];

  for (const tool of tools) {
    assert.ok(content.includes(tool), `SKILL.md must document tool ${tool}`);
  }

  // Verify limits and workflows are documented
  assert.ok(content.includes("16 MB"));
  assert.ok(content.includes("100 MB"));
  assert.ok(content.includes("Discovery and Connection Prerequisites"));
  assert.ok(content.includes("Recipient Identifier"));
  assert.ok(content.includes("Troubleshooting & Recovery"));
});

test("reference documentation and examples exist and cover all tools", () => {
  const refPath = path.join(SKILL_DIR, "references/mcp-tools.md");
  const exPath = path.join(SKILL_DIR, "examples/tool-usage.md");

  assert.ok(fs.existsSync(refPath), "references/mcp-tools.md must exist");
  assert.ok(fs.existsSync(exPath), "examples/tool-usage.md must exist");

  const refContent = fs.readFileSync(refPath, "utf8");
  const exContent = fs.readFileSync(exPath, "utf8");

  const tools = [
    "whatsapp_get_status",
    "whatsapp_list_chats",
    "whatsapp_list_contacts",
    "whatsapp_get_chat_history",
    "whatsapp_send_message",
    "whatsapp_mark_seen",
    "whatsapp_get_recent_messages",
    "whatsapp_send_image",
    "whatsapp_send_document",
    "whatsapp_get_recent_media",
    "whatsapp_download_media",
    "whatsapp_get_media_info",
  ];

  for (const tool of tools) {
    assert.ok(refContent.includes(tool), `mcp-tools.md must include schema for ${tool}`);
  }

  assert.ok(exContent.includes("mcpServers"), "tool-usage.md must include client configurations");
  assert.ok(exContent.includes("whatsapp_send_image"));
  assert.ok(exContent.includes("whatsapp_send_document"));
  assert.ok(exContent.includes("whatsapp_send_message"));
  assert.ok(exContent.includes("whatsapp_get_status"));
});

test("skills directory contains no hardcoded user or development machine paths", () => {
  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) {
        const text = fs.readFileSync(fullPath, "utf8");
        assert.ok(!text.includes("/home/"), `File ${entry.name} should not contain hardcoded /home/ paths`);
        assert.ok(!text.includes("/Users/"), `File ${entry.name} should not contain hardcoded /Users/ paths`);
      }
    }
  }
  scanDir(SKILL_DIR);
});
