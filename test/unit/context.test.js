"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  ContactCache,
  extractQuotedMessage,
  enrichMessageSummary,
  messageSummary,
} = require("../../src/conversation");

test("ContactCache indexes contacts and resolves sender names accurately", () => {
  const cache = new ContactCache();

  cache.loadContacts([
    {
      id: { _serialized: "15551234567@c.us" },
      name: "Alice Smith",
      pushname: "Alice",
      number: "15551234567",
    },
    {
      id: "15559876543@c.us",
      pushname: "Bob Push",
      number: "15559876543",
    },
  ]);

  // Direct JID lookup
  assert.equal(cache.resolveSenderName("15551234567@c.us"), "Alice Smith");
  // Pushname fallback when name is absent
  assert.equal(cache.resolveSenderName("15559876543@c.us"), "Bob Push");
  // 'me' resolves to 'You'
  assert.equal(cache.resolveSenderName("me"), "You");
  // Unknown contact falls back to notifyName
  assert.equal(cache.resolveSenderName("15550001111@c.us", "Charlie"), "Charlie");
  // Unknown contact with no notifyName falls back to number / short JID
  assert.equal(cache.resolveSenderName("15550001111@c.us"), "15550001111");
});

test("ContactCache indexes chats and resolves chat titles", () => {
  const cache = new ContactCache();

  cache.loadChats([
    {
      id: { _serialized: "120363001234567@g.us" },
      name: "Dev Team Alpha",
      isGroup: true,
    },
  ]);

  assert.equal(cache.resolveChatName("120363001234567@g.us"), "Dev Team Alpha");
  assert.equal(cache.resolveChatName("120363999999999@g.us"), "Group Chat");
  assert.equal(cache.resolveChatName("15551112222@c.us"), "15551112222");
});

test("extractQuotedMessage extracts quoted message with sender attribution and media", () => {
  const cache = new ContactCache();
  cache.setContact({
    id: "15552223333@c.us",
    name: "Dr. Evelyn",
    number: "15552223333",
  });

  const msgWithQuotedText = {
    id: { _serialized: "m_reply_1" },
    hasQuotedMsg: true,
    _data: {
      quotedMsg: {
        id: { _serialized: "m_original_1" },
        from: "15552223333@c.us",
        participant: "15552223333@c.us",
        body: "Can you review this quarterly report?",
        type: "chat",
      },
    },
  };

  const quoted = extractQuotedMessage(msgWithQuotedText, cache);
  assert.ok(quoted);
  assert.equal(quoted.id, "m_original_1");
  assert.equal(quoted.from, "15552223333@c.us");
  assert.equal(quoted.senderName, "Dr. Evelyn");
  assert.equal(quoted.body, "Can you review this quarterly report?");
  assert.equal(quoted.type, "chat");
  assert.equal(quoted.fromMe, false);
  assert.equal(quoted.hasMedia, false);

  // Quoted media message
  const msgWithQuotedMedia = {
    hasQuotedMsg: true,
    _data: {
      quotedMsg: {
        id: "m_media_quote",
        fromMe: true,
        body: "Attached invoice",
        type: "document",
        mimetype: "application/pdf",
        filename: "invoice_2026.pdf",
      },
    },
  };

  const quotedMedia = extractQuotedMessage(msgWithQuotedMedia, cache);
  assert.ok(quotedMedia);
  assert.equal(quotedMedia.from, "me");
  assert.equal(quotedMedia.senderName, "You");
  assert.equal(quotedMedia.fromMe, true);
  assert.equal(quotedMedia.hasMedia, true);
  assert.equal(quotedMedia.type, "document");
  assert.equal(quotedMedia.filename, "invoice_2026.pdf");
  assert.equal(quotedMedia.mimetype, "application/pdf");
});

test("extractQuotedMessage handles partially hydrated messages and empty cases", () => {
  const cache = new ContactCache();

  // Message with no quote
  assert.equal(extractQuotedMessage({ body: "plain msg" }), null);
  assert.equal(extractQuotedMessage(null), null);

  // Partial hydration: hasQuotedMsg true but _data.quotedMsg missing
  const partial = {
    hasQuotedMsg: true,
    _data: {
      quotedStanzaID: "stanza_999",
      quotedParticipant: "15554445555@c.us",
    },
  };
  const extracted = extractQuotedMessage(partial, cache);
  assert.ok(extracted);
  assert.equal(extracted.id, "stanza_999");
  assert.equal(extracted.from, "15554445555@c.us");
  assert.equal(extracted.fromMe, false);
});

test("enrichMessageSummary produces enriched context for group messages with replies", () => {
  const cache = new ContactCache();
  cache.loadContacts([
    { id: "15551111111@c.us", name: "David Chen" },
    { id: "15552222222@c.us", name: "Sarah Connor" },
  ]);
  cache.loadChats([
    { id: "120363000000000@g.us", name: "Project SkyNet" },
  ]);

  const rawGroupMsg = {
    id: { _serialized: "msg_group_100" },
    from: "120363000000000@g.us",
    to: "me",
    author: "15552222222@c.us",
    body: "Agreed, let's proceed.",
    timestamp: 1730000000,
    hasQuotedMsg: true,
    _data: {
      quotedMsg: {
        id: "msg_group_99",
        participant: "15551111111@c.us",
        body: "Should we push to main?",
        type: "chat",
      },
    },
  };

  const enriched = enrichMessageSummary(rawGroupMsg, {
    contactCache: cache,
    chat: { id: "120363000000000@g.us", name: "Project SkyNet", isGroup: true },
  });

  assert.equal(enriched.id, "msg_group_100");
  assert.equal(enriched.chatId, "120363000000000@g.us");
  assert.equal(enriched.chatName, "Project SkyNet");
  assert.equal(enriched.isGroup, true);
  assert.equal(enriched.fromMe, false);
  assert.equal(enriched.from, "120363000000000@g.us");
  assert.equal(enriched.author, "15552222222@c.us");
  assert.equal(enriched.senderName, "Sarah Connor");
  assert.equal(enriched.hasQuotedMsg, true);
  assert.ok(enriched.quotedMsg);
  assert.equal(enriched.quotedMsg.senderName, "David Chen");
  assert.equal(enriched.quotedMsg.body, "Should we push to main?");
});

test("enrichMessageSummary maintains 100% backward compatibility for 1:1 messages", () => {
  const cache = new ContactCache();
  cache.setContact({ id: "15553334444@c.us", name: "Marcus Wright" });

  const raw1on1 = {
    id: { _serialized: "msg_1on1" },
    from: "15553334444@c.us",
    to: "me",
    body: "Hello world",
    timestamp: 1730000500,
    ack: 2,
    hasMedia: false,
    type: "chat",
    isForwarded: false,
  };

  const enriched = enrichMessageSummary(raw1on1, { contactCache: cache });

  // Check all legacy fields
  assert.equal(enriched.id, "msg_1on1");
  assert.equal(enriched.from, "15553334444@c.us");
  assert.equal(enriched.to, "me");
  assert.equal(enriched.body, "Hello world");
  assert.equal(enriched.timestamp, 1730000500);
  assert.equal(enriched.ack, 2);
  assert.equal(enriched.hasMedia, false);
  assert.equal(enriched.type, "chat");
  assert.equal(enriched.isForwarded, false);
  assert.equal(enriched.mimetype, null);
  assert.equal(enriched.filename, null);
  assert.equal(enriched.filesize, null);
  assert.equal(enriched.caption, "");

  // Check enriched fields
  assert.equal(enriched.chatId, "15553334444@c.us");
  assert.equal(enriched.chatName, "Marcus Wright");
  assert.equal(enriched.senderName, "Marcus Wright");
  assert.equal(enriched.isGroup, false);
  assert.equal(enriched.fromMe, false);
  assert.equal(enriched.hasQuotedMsg, false);
  assert.equal(enriched.quotedMsg, null);
});

test("enrichMessageSummary handles outgoing messages from me", () => {
  const rawOutgoing = {
    id: { _serialized: "msg_out", fromMe: true, remote: "15557778888@c.us" },
    from: "me",
    to: "15557778888@c.us",
    body: "On my way",
    timestamp: 1730000800,
  };

  const enriched = enrichMessageSummary(rawOutgoing);
  assert.equal(enriched.fromMe, true);
  assert.equal(enriched.from, "me");
  assert.equal(enriched.senderName, "You");
  assert.equal(enriched.chatId, "15557778888@c.us");
  assert.equal(enriched.isGroup, false);
});

test("messageSummary alias is identical to enrichMessageSummary", () => {
  const raw = {
    id: "m_test",
    from: "15559990000@c.us",
    body: "test alias",
  };
  const res1 = enrichMessageSummary(raw);
  const res2 = messageSummary(raw);
  assert.deepEqual(res1, res2);
});
