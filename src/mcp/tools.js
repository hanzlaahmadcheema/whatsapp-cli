"use strict";

const { z } = require("zod");

function registerTools(server, client) {
  // 1. Status Tool
  server.tool(
    "whatsapp_get_status",
    "Get WhatsApp daemon connection state, linked account phone number/pushname, and readiness status.",
    {},
    async () => {
      try {
        const result = await client.getStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 2. List Chats Tool
  server.tool(
    "whatsapp_list_chats",
    "List recent WhatsApp chats with unread counts, pinned/archived status, and last message snippet.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of chats to return (default: 50)"),
    },
    async ({ limit }) => {
      try {
        const result = await client.listChats(limit);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 3. List Contacts Tool
  server.tool(
    "whatsapp_list_contacts",
    "List WhatsApp contacts, optionally filtered by name substring.",
    {
      name: z.string().optional().describe("Optional name filter substring to search contacts"),
    },
    async ({ name }) => {
      try {
        const result = await client.listContacts(name);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 4. Chat History Tool
  server.tool(
    "whatsapp_get_chat_history",
    "Retrieve message history for a specific contact phone number, contact JID, or group JID.",
    {
      target: z
        .string()
        .describe("Recipient phone number (e.g. '15551234567'), contact JID ('...123@c.us'), or group JID ('...@g.us')"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of messages to fetch (default: 50)"),
    },
    async ({ target, limit }) => {
      try {
        const result = await client.getChatHistory(target, limit);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 5. Send Message Tool
  server.tool(
    "whatsapp_send_message",
    "Send a WhatsApp text message to a contact phone number, contact JID, group JID, or 'me'.",
    {
      target: z
        .string()
        .describe("Recipient phone number (e.g. '15551234567'), contact JID, group JID, or 'me'"),
      message: z.string().describe("Message text to send"),
    },
    async ({ target, message }) => {
      try {
        const result = await client.sendMessage(target, message);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 6. Mark Seen Tool
  server.tool(
    "whatsapp_mark_seen",
    "Mark messages in a chat as read/seen.",
    {
      target: z
        .string()
        .describe("Contact phone number, contact JID, or group JID to mark as seen"),
    },
    async ({ target }) => {
      try {
        const result = await client.markSeen(target);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 7. Recent Messages Tool (from SSE in-memory ring buffer)
  server.tool(
    "whatsapp_get_recent_messages",
    "Get recent incoming WhatsApp messages received by the daemon during this session from the in-memory ring buffer.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum messages to return (default: 20)"),
      sinceTimestamp: z
        .number()
        .optional()
        .describe("Optional Unix timestamp to filter messages received after this timestamp"),
      chatId: z
        .string()
        .optional()
        .describe("Optional phone number or chat JID filter"),
    },
    async ({ limit, sinceTimestamp, chatId }) => {
      try {
        const result = client.getRecentMessages({ limit, sinceTimestamp, chatId });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 8. Send Image Tool
  server.tool(
    "whatsapp_send_image",
    "Send an image/photo (JPEG, PNG, WebP, GIF, BMP, SVG) to a WhatsApp contact, group, or 'me', with an optional caption.",
    {
      target: z
        .string()
        .describe("Recipient phone number (e.g. '15551234567'), contact JID, group JID, or 'me'"),
      filePath: z
        .string()
        .describe("Absolute or relative path to the image file on local filesystem"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption to accompany the photo"),
    },
    async ({ target, filePath, caption }) => {
      try {
        const result = await client.sendImage(target, filePath, caption);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 9. Send Document Tool
  server.tool(
    "whatsapp_send_document",
    "Send a document or file (PDF, TXT, DOCX, ZIP, etc.) with its original filename and MIME type to a WhatsApp contact, group, or 'me', with an optional caption.",
    {
      target: z
        .string()
        .describe("Recipient phone number (e.g. '15551234567'), contact JID, group JID, or 'me'"),
      filePath: z
        .string()
        .describe("Absolute or relative path to the document file on local filesystem"),
      filename: z
        .string()
        .optional()
        .describe("Optional custom display filename for the recipient (defaults to original filename)"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption to accompany the document"),
    },
    async ({ target, filePath, filename, caption }) => {
      try {
        const result = await client.sendDocument(target, filePath, { filename, caption });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: { message: err.message } }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

module.exports = { registerTools };
