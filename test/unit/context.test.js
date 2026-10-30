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

test("SSE event pipeline: private incoming and outgoing message events receive enrichMessageSummary", async () => {
  const { EventEmitter } = require("events");
  const { setClientFactory } = require("../../src/whatsapp/client");
  const { WhatsAppService } = require("../../src/daemon/service");
  const { STATE } = require("../../src/ipc/protocol");

  const mock = new EventEmitter();
  mock.initialize = async () => {};
  mock.getContacts = async () => [
    {
      id: { _serialized: "15551234567@c.us" },
      name: "Alice Private",
      pushname: "Alice",
      number: "15551234567",
    },
  ];
  mock.getChats = async () => [
    { id: { _serialized: "15551234567@c.us" }, name: "Alice Private", isGroup: false },
  ];
  setClientFactory(() => mock);

  const service = new WhatsAppService({});
  await service.start();
  service.state = STATE.READY;
  await service.refreshContactsCache();

  const receivedEvents = [];
  const unsub = service.subscribe((event) => {
    if (event.event === "message") receivedEvents.push(event);
  });

  const client = service.controller.client;

  // 1. Incoming private message
  client.emit("message_create", {
    id: { _serialized: "in_priv_1", remote: "15551234567@c.us", fromMe: false },
    fromMe: false,
    from: "15551234567@c.us",
    to: "me",
    body: "Hello in private chat",
    timestamp: 1730001000,
  });

  assert.equal(receivedEvents.length, 1);
  const inEv = receivedEvents[0];
  assert.equal(inEv.event, "message");
  assert.equal(inEv.id, "in_priv_1");
  assert.equal(inEv.fromMe, false);
  assert.equal(inEv.from, "15551234567@c.us");
  assert.equal(inEv.chatId, "15551234567@c.us");
  assert.equal(inEv.chatName, "Alice Private");
  assert.equal(inEv.senderName, "Alice Private");
  assert.equal(inEv.isGroup, false);
  assert.equal(inEv.hasQuotedMsg, false);
  assert.equal(inEv.body, "Hello in private chat");

  // 2. Outgoing private message
  client.emit("message_create", {
    id: { _serialized: "out_priv_1", remote: "15551234567@c.us", fromMe: true },
    fromMe: true,
    from: "me",
    to: "15551234567@c.us",
    body: "Replying to Alice",
    timestamp: 1730001005,
  });

  assert.equal(receivedEvents.length, 2);
  const outEv = receivedEvents[1];
  assert.equal(outEv.id, "out_priv_1");
  assert.equal(outEv.fromMe, true);
  assert.equal(outEv.from, "me");
  assert.equal(outEv.senderName, "You");
  assert.equal(outEv.chatId, "15551234567@c.us");
  assert.equal(outEv.isGroup, false);

  unsub();
  service.stop();
});

test("SSE event pipeline: group message events receive participant attribution and quoted context", async () => {
  const { EventEmitter } = require("events");
  const { setClientFactory } = require("../../src/whatsapp/client");
  const { WhatsAppService } = require("../../src/daemon/service");
  const { STATE } = require("../../src/ipc/protocol");

  const mock = new EventEmitter();
  mock.initialize = async () => {};
  mock.getContacts = async () => [
    { id: { _serialized: "15558889999@c.us" }, name: "Elena Rostova" },
    { id: { _serialized: "15551112222@c.us" }, name: "John Connor" },
  ];
  mock.getChats = async () => [
    { id: { _serialized: "120363001234567@g.us" }, name: "Mission Impossible Team", isGroup: true },
  ];
  setClientFactory(() => mock);

  const service = new WhatsAppService({});
  await service.start();
  service.state = STATE.READY;
  await service.refreshContactsCache();

  const receivedEvents = [];
  const unsub = service.subscribe((event) => {
    if (event.event === "message") receivedEvents.push(event);
  });

  const client = service.controller.client;
  client.emit("message_create", {
    id: { _serialized: "grp_msg_1", remote: "120363001234567@g.us", fromMe: false },
    fromMe: false,
    from: "120363001234567@g.us",
    to: "me",
    author: "15558889999@c.us",
    body: "Acknowledged the update",
    timestamp: 1730002000,
    hasQuotedMsg: true,
    _data: {
      quotedMsg: {
        id: "orig_msg_0",
        participant: "15551112222@c.us",
        body: "Briefing is ready",
        type: "chat",
      },
    },
  });

  assert.equal(receivedEvents.length, 1);
  const grpEv = receivedEvents[0];
  assert.equal(grpEv.event, "message");
  assert.equal(grpEv.id, "grp_msg_1");
  assert.equal(grpEv.isGroup, true);
  assert.equal(grpEv.chatId, "120363001234567@g.us");
  assert.equal(grpEv.chatName, "Mission Impossible Team");
  assert.equal(grpEv.author, "15558889999@c.us");
  assert.equal(grpEv.senderName, "Elena Rostova");
  assert.equal(grpEv.hasQuotedMsg, true);
  assert.ok(grpEv.quotedMsg);
  assert.equal(grpEv.quotedMsg.senderName, "John Connor");
  assert.equal(grpEv.quotedMsg.body, "Briefing is ready");

  unsub();
  service.stop();
});

test("Identity resolution is refreshed and accurate after daemon reconnects", async () => {
  const { EventEmitter } = require("events");
  const { setClientFactory } = require("../../src/whatsapp/client");
  const { WhatsAppService } = require("../../src/daemon/service");
  const { STATE } = require("../../src/ipc/protocol");

  let contactsList = [];
  const mock = new EventEmitter();
  mock.initialize = async () => {};
  mock.getContacts = async () => contactsList;
  mock.getChats = async () => [];
  setClientFactory(() => mock);

  const service = new WhatsAppService({});
  await service.start();
  service.state = STATE.READY;

  const messages = [];
  service.subscribe((e) => {
    if (e.event === "message") messages.push(e);
  });

  const client = service.controller.client;

  // 1. Initial message before contact is synced
  client.emit("message_create", {
    id: { _serialized: "m_pre_sync" },
    fromMe: false,
    from: "15554443333@c.us",
    to: "me",
    body: "Before sync",
    timestamp: 1730003000,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderName, "15554443333");

  // 2. Simulate daemon reconnect with newly synced contacts
  contactsList = [
    {
      id: { _serialized: "15554443333@c.us" },
      name: "Professor Charles Xavier",
      number: "15554443333",
    },
  ];

  // Trigger reconnect contact cache refresh
  await service.refreshContactsCache();

  // 3. Subsequent message from same contact
  client.emit("message_create", {
    id: { _serialized: "m_post_sync" },
    fromMe: false,
    from: "15554443333@c.us",
    to: "me",
    body: "After reconnect sync",
    timestamp: 1730003010,
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[1].senderName, "Professor Charles Xavier");
  assert.equal(messages[1].chatName, "Professor Charles Xavier");

  service.stop();
});
