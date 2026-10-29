"use strict";

// In-place, idempotent patch for whatsapp-web.js@1.34.7 (mirrors upstream PR #201850).
// WhatsApp minified the message-key `_serialized` field to `$1`, so `Msg.get(undefined)`
// runs inside the injected utils, crashing getChats()/sendMessage() with `r: r` / `t: t`.
// Safe to run repeatedly and on fresh `npm install` (wired as `postinstall`).

const fs = require("fs");
const path = require("path");

const FILE = path.join(
  __dirname,
  "..",
  "node_modules",
  "whatsapp-web.js",
  "src",
  "util",
  "Injected",
  "Utils.js",
);

const REPLACEMENTS = [
  // sendMessage: resolve the message key through the tolerant helper
  [
    "            .Msg.get(newMsgKey._serialized);",
    "            .Msg.get(window.WWebJS.getMsgKeyId(newMsgKey));",
  ],
  // editMessage: same fix
  [
    "        return window.require('WAWebCollections').Msg.get(msg.id._serialized);",
    "        return window\n" +
      "            .require('WAWebCollections')\n" +
      "            .Msg.get(window.WWebJS.getMsgKeyId(msg.id));",
  ],
  // lastReceivedKey lookups in getChatModel
  [
    ".Msg.get(chat.lastReceivedKey._serialized)",
    ".Msg.get(window.WWebJS.getMsgKeyId(chat.lastReceivedKey))",
  ],
  [
    "chat.lastReceivedKey._serialized,",
    "window.WWebJS.getMsgKeyId(chat.lastReceivedKey),",
  ],
];

const INSERTIONS = [
  {
    // Rebuild _serialized on serialized message keys so the whole downstream surface
    // (Message model, anything keyed on message id) keeps working without knowing about `$1`.
    after: `            });
        }

        delete msg.pendingAckUpdate;`,
    text: `
        if (typeof msg.id === 'object' && msg.id._serialized == null) {
            const serializedId = window.WWebJS.getMsgKeyId(msg.id);
            if (serializedId) {
                msg.id = Object.assign({}, msg.id, {
                    _serialized: serializedId,
                });
            }
        }
`,
  },
  {
    // Add the tolerant key resolver right after window.WWebJS = {};
    after: `    window.WWebJS = {};`,
    text: `
    window.WWebJS.getMsgKeyId = (key) =>
        key?._serialized ?? key?.$1 ?? undefined;
`,
  },
];

const BLOCKS = [
  {
    // getChats: process chats individually so one failure doesn't discard the list
    from: `    window.WWebJS.getChats = async () => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        const chatPromises = chats.map((chat) =>
            window.WWebJS.getChatModel(chat),
        );
        return await Promise.all(chatPromises);
    };`,
    to: `    window.WWebJS.getChats = async () => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();

        // Process each chat individually — one failure should not discard every chat
        const results = [];
        for (const chat of chats) {
            try {
                const model = await window.WWebJS.getChatModel(chat);
                if (model) results.push(model);
            } catch {
                // skip chats that fail serialization (e.g. LID-based group metadata issues)
            }
        }
        return results;
    };`,
    marker: "Process each chat individually",
  },
  {
    // groupMetadata.update: LID-based chat ids may be missing from IndexedDB
    from: `            await groupMetadata.update(chatWid);`,
    to: `            try {
                await groupMetadata.update(chatWid);
            } catch {
                model.groupMetadata = null;
            }`,
    marker: "model.groupMetadata = null;",
  },
];

function apply() {
  if (!fs.existsSync(FILE)) {
    console.warn("[wwebjs-patch] file not found:", FILE);
    process.exit(1);
  }

  let src = fs.readFileSync(FILE, "utf8");
  const applied = [];

  const legacyInsideGetChats = /window\.WWebJS\.getChats = async \(\) => \{\s+window\.WWebJS\.getMsgKeyId = \(key\) =>\s+key\?\._serialized \?\? key\?\.\$1 \?\? undefined;\s+/g;
  if (legacyInsideGetChats.test(src)) {
    src = src.replace(legacyInsideGetChats, "window.WWebJS.getChats = async () => {\n");
    applied.push("cleaned up legacy getMsgKeyId inside getChats");
  }

  for (const [from, to] of REPLACEMENTS) {
    if (src.includes(from) && !src.includes(to)) {
      src = src.split(from).join(to);
      applied.push("replacement: " + from.trim().slice(0, 60));
    }
  }

  for (const block of BLOCKS) {
    if (src.includes(block.from) && !src.includes(block.marker)) {
      src = src.split(block.from).join(block.to);
      applied.push("block: " + block.from.trim().slice(0, 40));
    }
  }

  for (const ins of INSERTIONS) {
    if (src.includes(ins.text.trim()) || !src.includes(ins.after)) continue;
    src = src.split(ins.after).join(ins.after + "\n" + ins.text);
    applied.push("insert: " + ins.after.trim().slice(0, 40));
  }

  fs.writeFileSync(FILE, src, "utf8");

  if (applied.length) {
    console.log("[wwebjs-patch] applied:\n  - " + applied.join("\n  - "));
  } else {
    console.log(
      "[wwebjs-patch] nothing to do (already patched or version mismatch).",
    );
  }
}

apply();