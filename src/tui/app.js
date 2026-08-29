"use strict";

const { Screen } = require("./screen");
const { TuiApi } = require("./api");
const { computeLayout, cycleFocus, isWide, isMedium } = require("./layout");
const { inboxRows, isMeFrom } = require("./model");
const { drawInbox } = require("./views/inbox");
const { drawConversation, maxScroll, layoutMessages } = require("./views/conversation");
const { drawContext } = require("./views/context");
const { drawPalette } = require("./views/palette");
const { drawCompose } = require("./views/compose");
const { drawHelp } = require("./views/help");
const { parseCommandLine } = require("./views/command");
const { T, ST } = require("./theme");
const { toJid, shortJid } = require("../ipc/jid");

const MODES = Object.freeze({
  INBOX: "inbox",
  CONVERSATION: "conversation",
  COMPOSE: "compose",
  PALETTE: "palette",
  COMMAND: "command",
  HELP: "help",
});

const FOCUS = Object.freeze({
  INBOX: "inbox",
  CONVERSATION: "conversation",
  CONTEXT: "context",
});

const STATE_STYLE = {
  ready: { fg: "green", label: "● CONNECTED" },
  connecting: { fg: "yellow", label: "◐ CONNECTING" },
  syncing: { fg: "yellow", label: "◐ SYNCING" },
  linking: { fg: "magenta", label: "◐ LINKING" },
  logged_out: { fg: "red", label: "✘ LOGGED_OUT" },
  unlinked: { fg: "gray", label: "○ UNLINKED" },
  error: { fg: "red", label: "✘ ERROR" },
  degraded: { fg: "yellow", label: "◐ DEGRADED" },
};

class TuiApp {
  constructor({ debug = false } = {}) {
    this.screen = new Screen();
    this.api = new TuiApi();
    this.debug = debug;

    this.connected = false;
    this.state = "unknown";
    this.account = null;
    this.lastError = null;

    this.chats = [];
    this.selectedChatId = null;
    this.filter = "";
    this.contextOpen = false;
    this.focus = FOCUS.INBOX;

    this.messages = [];
    this.msgScroll = 0;
    this.selectedMsgId = null;

    this.mode = MODES.INBOX;
    this.query = "";
    this.paletteSel = 0;
    this.commandLine = "";
    this.composeText = "";
    this.composeTarget = null;
    this.composeCursor = 0;

    this.notice = null;
    this._noticeTimer = null;
    this._refreshTimer = null;
    this._destroyed = false;
    this._busy = false;
    this._sseUnsub = null;
    this._openChatId = null;
  }

  async run() {
    this.screen.init();
    this.screen.onKey((str, key) => this.onKey(str, key));
    try {
      this.connected = this.api.connected();
      await this.refresh();
      this._sseUnsub = this.api.subscribe((evt) => this.onEvent(evt));
      this._refreshTimer = setInterval(() => {
        if (this._destroyed) return;
        if (this.connected && this.state === "ready") this.refreshChats().catch(() => {});
      }, 15000);
    } catch (err) {
      this.lastError = String(err && err.message ? err.message : err);
    }
  }

  setNotice(msg, ttl = 4000) {
    this.notice = msg;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      this.notice = "";
      this.render();
    }, ttl);
    this.render();
  }

  // ---- live SSE events ----
  async onEvent(evt) {
    if (this._destroyed) return;
    if (evt.event === "message") {
      // incoming: refresh inbox (unread counts) and live-append to open chat
      if (this._openChatId && (evt.from === this._openChatId || evt.chatId === this._openChatId)) {
        const msg = { from: evt.from, body: evt.body, timestamp: evt.timestamp, ack: 1 };
        this.messages = [...this.messages, msg];
        this.msgScroll = this.maxMsgScroll();
      }
      this.refreshChats().catch(() => {});
    } else if (evt.event === "state") {
      this.state = evt.state;
      this.render();
    } else if (evt.event === "logged_out") {
      this.state = "logged_out";
      this.render();
    }
  }

  // ---- data ----
  async refresh() {
    const st = await this.api.status();
    if (st && st.ok) {
      this.connected = true;
      this.state = st.state;
      this.account = st.account || null;
      this.lastError = st.lastError || null;
    } else if (st && st.error && st.error.code === "NO_DAEMON") {
      this.connected = false;
      this.state = "error";
      this.lastError = "Daemon not reachable. Run `wa login` or `wa status`.";
    } else {
      this.connected = false;
      this.state = "error";
      this.lastError = (st && st.error && st.error.message) || "Unknown daemon error";
    }
    if (this.connected && this.state === "ready") {
      await this.refreshChats();
      if (this._openChatId) this.openChat(this._openChatId).catch(() => {});
    }
    this.render();
  }

  async refreshChats() {
    if (this._busy) return;
    this._busy = true;
    try {
      const res = await this.api.chats(200);
      if (res.ok && Array.isArray(res.chats)) {
        const prevSelected = this.selectedChat();
        this.chats = res.chats;
        // keep selection stable by id
        if (prevSelected && prevSelected.id) {
          const keep = this.rows().findIndex((r) => r.type === "chat" && r.chat.id === prevSelected.id);
          if (keep === -1) this.selectedChatId = null;
        } else if (!this.selectedChatId && this.chats.length) {
          this.selectedChatId = this.chats[0].id;
        }
      }
    } catch (err) {
      this.setNotice("refresh failed: " + String(err.message || err));
    } finally {
      this._busy = false;
    }
    this.render();
  }

  rows() {
    const chats = this.filteredChats();
    return inboxRows(chats);
  }

  filteredChats() {
    if (!this.filter) return this.chats;
    const q = this.filter.toLowerCase();
    return this.chats.filter((c) => {
      const name = (c.name || "").toLowerCase();
      const id = String(c.id || "").toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }

  selectedChat() {
    if (!this.selectedChatId) return null;
    return this.chats.find((c) => c.id === this.selectedChatId) || null;
  }

  async openChat(chatId) {
    if (!chatId) return;
    this._openChatId = chatId;
    this.msgScroll = 0;
    this.selectedMsgId = null;
    const res = await this.api.history(chatId, 50);
    if (res.ok && Array.isArray(res.messages)) {
      this.messages = res.messages;
    } else {
      this.messages = [];
      if (res.error) this.setNotice("history: " + (res.error.message || res.error.code));
    }
    this.msgScroll = this.maxMsgScroll();
    this.render();
  }

  async markSeen(chatId) {
    if (!chatId) return;
    const res = await this.api.markSeen(chatId);
    if (res && !res.ok) this.setNotice("mark seen: " + ((res.error && res.error.message) || "failed"), 3000);
    this.refreshChats().catch(() => {});
  }

  async archiveCurrent() {
    const chat = this.selectedChat();
    if (!chat) return;
    const res = await this.api.setArchived(chat.id, true);
    if (res && res.ok) this.setNotice("archived " + (chat.name || shortJid(chat.id)), 3000);
    else this.setNotice("archive failed", 3000);
    this.refreshChats().catch(() => {});
  }

  async sendMessage(toJidStr, text) {
    if (!toJidStr || !text) return;
    this.setNotice(`sending → ${shortJid(toJidStr)}…`, 60000);
    const res = await this.api.send(toJidStr, text);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    if (res.ok) {
      this.setNotice(`✓ sent messageId: ${res.messageId}`, 4000);
      if (this._openChatId === toJidStr) this.openChat(toJidStr).catch(() => {});
    } else {
      this.setNotice(`✗ send failed: ${res.error && (res.error.message || res.error.code)}`, 6000);
    }
  }

  // ---- derived ----
  maxMsgScroll() {
    if (!this.messages.length) return 0;
    const items = layoutMessages(this.messages, this.msgTextW());
    return maxScroll(items, this.maxMsgRows());
  }

  maxMsgRows() {
    // matches drawConversation: content starts below the 2-row section header
    // and the conversation region itself is bodyH = height - header - footer.
    return Math.max(3, this.height - 4);
  }

  msgTextW() {
    const layout = this.currentLayout();
    const w = layout.conversation ? layout.conversation.w : this.width;
    return Math.max(10, w - 8);
  }

  get height() {
    return this.screen.height;
  }

  get width() {
    return this.screen.width;
  }

  currentLayout() {
    return computeLayout({
      width: this.width,
      height: this.height,
      focus: this.focus,
      contextOpen: this.contextOpen,
    });
  }

  // ---- key handling ----
  onKey(str, key) {
    const name = key && key.name;
    const ctrl = key && key.ctrl;

    if (ctrl && name === "c") return this.quit();

    switch (this.mode) {
      case MODES.PALETTE: this.onPaletteKey(str, key); return;
      case MODES.COMMAND: this.onCommandKey(str, key); return;
      case MODES.COMPOSE: this.onComposeKey(str, key); return;
      case MODES.HELP: this.onHelpKey(str, key); return;
      default: this.onInboxKey(str, key);
    }
  }

  onHelpKey(str, key) {
    if ((key && key.name === "escape") || str === "q") {
      this.mode = MODES.INBOX;
      this.render();
    }
  }

  onPaletteKey(str, key) {
    const name = key && key.name;
    if (name === "escape") { this.mode = MODES.INBOX; this.render(); return; }
    if (name === "return") { this.runPaletteAction(this.paletteSel); return; }
    if (name === "up") { this.paletteSel = Math.max(0, this.paletteSel - 1); this.render(); return; }
    if (name === "down") { this.paletteSel++; this.render(); return; }
    if (str === "k") { this.paletteSel = Math.max(0, this.paletteSel - 1); this.render(); return; }
    if (str === "j") { this.paletteSel++; this.render(); return; }
    if (name === "backspace") { this.query = this.query.slice(0, -1); this.paletteSel = 0; this.render(); return; }
    if (str && !key.ctrl && !key.meta) { this.query += str; this.paletteSel = 0; this.render(); return; }
  }

  onCommandKey(str, key) {
    const name = key && key.name;
    if (name === "escape") { this.mode = MODES.INBOX; this.commandLine = ""; this.render(); return; }
    if (name === "return") { this.runCommand(this.commandLine); return; }
    if (name === "backspace") { this.commandLine = this.commandLine.slice(0, -1); this.render(); return; }
    if (str && !key.ctrl && !key.meta) { this.commandLine += str; this.render(); }
  }

  onComposeKey(str, key) {
    const name = key && key.name;
    const ctrl = key && key.ctrl;
    if (name === "escape") { this.mode = MODES.INBOX; this.composeText = ""; this.render(); return; }
    if (ctrl && name === "s") { this.sendCompose(); return; }
    if (name === "return") {
      const before = this.composeText.slice(0, this.composeCursor);
      const after = this.composeText.slice(this.composeCursor);
      this.composeText = before + "\n" + after;
      this.composeCursor++;
      this.render();
      return;
    }
    if (name === "backspace") {
      if (this.composeCursor > 0) {
        this.composeText = this.composeText.slice(0, this.composeCursor - 1) + this.composeText.slice(this.composeCursor);
        this.composeCursor--;
      }
      this.render();
      return;
    }
    if (name === "left") { this.composeCursor = Math.max(0, this.composeCursor - 1); this.render(); return; }
    if (name === "right") { this.composeCursor = Math.min(this.composeText.length, this.composeCursor + 1); this.render(); return; }
    if (name === "home") { this.composeCursor = 0; this.render(); return; }
    if (name === "end") { this.composeCursor = this.composeText.length; this.render(); return; }
    if (str && !key.ctrl && !key.meta) {
      this.composeText = this.composeText.slice(0, this.composeCursor) + str + this.composeText.slice(this.composeCursor);
      this.composeCursor += str.length;
      this.render();
    }
  }

  onInboxKey(str, key) {
    const name = key && key.name;
    const ctrl = key && key.ctrl;

    // navigation by focus: only movement keys switch to message navigation,
    // action keys (c, r, f, /, :, ?, a...) still work in conversation focus
    if (
      this.focus === FOCUS.CONVERSATION &&
      (name === "up" || name === "down" || str === "k" || str === "j" || name === "pageup" || name === "pagedown")
    ) {
      this.onConversationNav(str, key);
      return;
    }

    if (name === "up") this.move(-1);
    else if (name === "down") this.move(1);
    else if (str === "k") this.move(-1);
    else if (str === "j") this.move(1);
    else if (name === "pageup") this.move(-10);
    else if (name === "pagedown") this.move(10);
    else if (str === "?") { this.mode = MODES.HELP; this.render(); }
    else if (str === "/") { this.mode = MODES.PALETTE; this.query = ""; this.paletteSel = 0; this.render(); }
    else if (str === ":") { this.mode = MODES.COMMAND; this.commandLine = ""; this.render(); }
    else if (name === "escape") {
      if (this.focus === FOCUS.CONVERSATION) this.focus = FOCUS.INBOX;
      else if (this.focus === FOCUS.CONTEXT) this.focus = FOCUS.INBOX;
      else this.quit();
      this.render();
    }
    else if (str === "q") this.quit();
    else if (str === "c") this.startCompose();
    else if (str === "r") this.startReply();
    else if (str === "f") this.startForward();
    else if (str === "a") this.archiveCurrent();
    else if (str === "x") { this.contextOpen = !this.contextOpen; this.render(); }
    else if (str === "R") this.refresh().catch(() => {});
    else if (str === "[" ) this.scrollMsg(-1);
    else if (str === "]") this.scrollMsg(1);
    else if (str === "{") this.scrollMsg(-Math.floor(this.maxMsgRows()));
    else if (str === "}") this.scrollMsg(Math.floor(this.maxMsgRows()));
    else if (name === "tab") {
      if (isWide(this.width)) {
        this.focus = cycleFocus(this.focus);
      } else {
        this.focus = cycleFocus(this.focus);
      }
      this.render();
    }
    else if (name === "return") {
      if (this.focus === FOCUS.CONVERSATION) {
        this.focus = FOCUS.INBOX;
        this.render();
        return;
      }
      const chat = this.selectedChat();
      if (chat) {
        this.focus = FOCUS.CONVERSATION;
        this.openChat(chat.id).catch(() => {});
        this.markSeen(chat.id).catch(() => {});
      }
      this.render();
    }
  }

  onConversationNav(str, key) {
    const name = key && key.name;
    if (name === "up" || str === "k") this.moveMsg(-1);
    else if (name === "down" || str === "j") this.moveMsg(1);
    else if (name === "pageup" || str === "{") this.moveMsg(-5);
    else if (name === "pagedown" || str === "}") this.moveMsg(5);
    else if (name === "return") {
      this.focus = FOCUS.INBOX;
      this.render();
    }
  }

  move(delta) {
    const rows = this.rows();
    const chatRows = rows.filter((r) => r.type === "chat");
    if (!chatRows.length) return;
    const cur = this.selectedChatId;
    const curIdx = chatRows.findIndex((r) => r.chat.id === cur);
    let next = curIdx < 0 ? 0 : curIdx + delta;
    next = Math.max(0, Math.min(chatRows.length - 1, next));
    const target = chatRows[next];
    if (target) {
      this.selectedChatId = target.chat.id;
      // live preview: open the newly selected chat
      this.openChat(target.chat.id).catch(() => {});
    }
    this.render();
  }

  moveMsg(delta) {
    if (!this.messages.length) return;
    const cur = this.messages.findIndex((m) => m.id === this.selectedMsgId);
    let next = cur < 0 ? this.messages.length - 1 : cur + delta;
    next = Math.max(0, Math.min(this.messages.length - 1, next));
    this.selectedMsgId = this.messages[next].id;
    // keep the newly selected message on screen
    const { layoutMessages, scrollToMessage } = require("./views/conversation");
    const items = layoutMessages(this.messages, this.msgTextW());
    this.msgScroll = scrollToMessage(items, this.selectedMsgId, this.msgScroll, this.maxMsgRows());
    this.render();
  }

  scrollMsg(delta) {
    if (!this.messages.length) return;
    const max = this.maxMsgScroll();
    this.msgScroll = Math.max(0, Math.min(max, this.msgScroll + delta));
    this.render();
  }

  startCompose() {
    const chat = this.selectedChat();
    if (!chat) { this.setNotice("select a chat first", 3000); return; }
    this.composeTarget = chat;
    this.composeText = "";
    this.composeCursor = 0;
    this.mode = MODES.COMPOSE;
    this.render();
  }

  startReply() {
    const chat = this.selectedChat();
    if (!chat) return;
    this.composeTarget = chat;
    this.composeText = "";
    this.composeCursor = 0;
    this.mode = MODES.COMPOSE;
    this.render();
  }

  startForward() {
    const chat = this.selectedChat();
    if (!chat) return;
    this.composeTarget = chat;
    this.composeText = "";
    this.composeCursor = 0;
    this.mode = MODES.COMPOSE;
    this.render();
  }

  sendCompose() {
    if (!this.composeTarget) { this.setNotice("no compose target", 3000); return; }
    const text = this.composeText.trim();
    if (!text) { this.setNotice("message is empty", 3000); return; }
    const to = this.composeTarget.id;
    this.composeText = "";
    this.composeCursor = 0;
    this.mode = MODES.INBOX;
    this.render();
    this.sendMessage(to, text);
  }

  // ---- command mode execution ----
  runCommand(line) {
    const parsed = parseCommandLine(line);
    this.mode = MODES.INBOX;
    this.commandLine = "";
    this.render();
    if (!parsed) return;

    switch (parsed.verb) {
      case "send": {
        const target = parsed.args[0];
        const body = parsed.argStr.split(/\s+/).slice(1).join(" ") || parsed.argStr;
        if (!target) { this.setNotice("usage: :send <number> <message>", 4000); return; }
        try {
          const jid = toJid(target);
          this.sendMessage(jid, body);
        } catch (err) {
          this.setNotice(err.message, 4000);
        }
        return;
      }
      case "search": {
        this.mode = MODES.PALETTE;
        this.query = parsed.argStr || "";
        this.paletteSel = 0;
        this.render();
        return;
      }
      case "archive": this.archiveCurrent(); return;
      case "seen": {
        const chat = this.selectedChat();
        if (chat) this.markSeen(chat.id).catch(() => {});
        return;
      }
      case "contact": {
        const target = parsed.args[0];
        if (!target) { this.setNotice("usage: :contact <number>", 4000); return; }
        try {
          const jid = toJid(target);
          this.selectedChatId = jid;
          this.openChat(jid).catch(() => {});
        } catch (err) {
          this.setNotice(err.message, 4000);
        }
        return;
      }
      case "status": {
        this.refresh().catch(() => {});
        return;
      }
      case "help": this.mode = MODES.HELP; this.render(); return;
      case "quit": this.quit(); return;
      default:
        this.setNotice(`unknown command: :${parsed.verb}`, 4000);
    }
  }

  runPaletteAction(idx) {
    const { filterPalette } = require("./views/palette");
    const items = filterPalette(this.query);
    const item = items[idx];
    this.mode = MODES.INBOX;
    this.render();
    if (!item) return;
    switch (item.id) {
      case "send": this.startCompose(); return;
      case "search-chats": this.startInboxSearch(); return;
      case "search-contacts": this.mode = MODES.COMMAND; this.commandLine = "contact "; this.render(); return;
      case "seen": {
        const chat = this.selectedChat();
        if (chat) this.markSeen(chat.id).catch(() => {});
        return;
      }
      case "archive": this.archiveCurrent(); return;
      case "unarchive": {
        const chat = this.selectedChat();
        if (chat) this.api.setArchived(chat.id, false).then(() => this.refreshChats());
        return;
      }
      case "reply": this.startReply(); return;
      case "forward": this.startForward(); return;
      case "refresh": this.refresh().catch(() => {}); return;
      case "toggle-context": this.contextOpen = !this.contextOpen; this.render(); return;
      case "help": this.mode = MODES.HELP; this.render(); return;
      case "quit": this.quit(); return;
    }
  }

  startInboxSearch() {
    this.mode = MODES.PALETTE;
    this.query = "";
    this.paletteSel = 0;
    this.render();
  }

  quit() {
    this._destroyed = true;
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    if (this._sseUnsub) this._sseUnsub();
    this.screen.destroy();
    process.exit(0);
  }

  // ---- rendering ----
  render() {
    const s = this.screen;
    s.clear();
    if (!s.width || !s.height) return;
    this.drawHeader();
    this.drawBody();
    this.drawFooter();
    s.render();
  }

  drawHeader() {
    const s = this.screen;
    const W = this.width;
    const st = STATE_STYLE[this.state] || STATE_STYLE.error;
    s.fill(0, 0, W, 1, " ", ST.titleBarBg);
    s.text(1, 0, "WA", { ...ST.titleBar, fg: "cyan" });
    s.text(5, 0, "/ COMMAND CENTER", ST.titleBarMuted);
    s.text(21, 0, st.label, { ...ST.titleBarStatus, fg: st.fg });
    const account = this.account && (this.account.number || this.account.me)
      ? shortJid(this.account.number || this.account.me)
      : "";
    const right = ` ACCOUNT ${account ? "· " + account : ""} `;
    s.text(Math.max(1, W - right.length), 0, right, ST.titleBarMuted);
  }

  drawBody() {
    const s = this.screen;
    const layout = this.currentLayout();

    if (this.mode === MODES.HELP) {
      this.drawHelpOverlay(layout);
      return;
    }
    if (this.mode === MODES.PALETTE) {
      this.drawRegions(layout);
      this.drawPaletteOverlay(layout);
      return;
    }
    if (this.mode === MODES.COMPOSE) {
      this.drawRegions(layout);
      this.drawComposeOverlay(layout);
      return;
    }
    this.drawRegions(layout);
  }

  drawRegions(layout) {
    const s = this.screen;
    const selected = this.selectedChat();

    if (layout.inbox) this.drawInboxRegion(layout.inbox, selected);
    if (layout.conversation) this.drawConversationRegion(layout.conversation, selected);
    if (layout.context) this.drawContextRegion(layout.context, selected);

    // dividers
    if (layout.inbox && layout.conversation) {
      s.vline(layout.inbox.x + layout.inbox.w - 1, layout.inbox.y, layout.inbox.h, "│", T.border);
    }
    if (layout.conversation && layout.context) {
      s.vline(layout.conversation.x + layout.conversation.w - 1, layout.conversation.y, layout.conversation.h, "│", T.border);
    }
  }

  drawInboxRegion(region, selected) {
    const rows = this.rows();
    const selIdx = rows.findIndex((r) => r.type === "chat" && r.chat.id === this.selectedChatId);
    drawInbox(this.screen, region, rows, selIdx, this.filter, this.listScrollFor(rows, selIdx));
  }

  listScrollFor(rows, selIdx) {
    const avail = this.height - 4;
    if (selIdx < 0) return 0;
    const current = this._listScroll || 0;
    if (selIdx < current) return selIdx;
    if (selIdx >= current + avail) return selIdx - avail + 1;
    return current;
  }

  drawConversationRegion(region, selected) {
    const focus = this.focus === FOCUS.CONVERSATION;
    drawConversation(
      this.screen,
      region,
      this.messages,
      selected,
      this.selectedMsgId,
      this.msgScroll,
      focus,
    );
  }

  drawContextRegion(region, selected) {
    drawContext(this.screen, region, selected, this.messages, this.account && this.account.number);
  }

  drawPaletteOverlay(layout) {
    const { drawPalette } = require("./views/palette");
    drawPalette(this.screen, this.width, this.height, this.query, this.paletteSel);
  }

  drawComposeOverlay(layout) {
    const { drawCompose } = require("./views/compose");
    drawCompose(this.screen, layout.conversation || layout.inbox, {
      target: this.composeTarget,
      text: this.composeText,
      cursorRow: 0,
      cursorCol: this.composeCursor,
      quoting: null,
      isReply: false,
    });
  }

  drawHelpOverlay(layout) {
    const s = this.screen;
    s.fill(0, 1, this.width, this.height - 2, " ");
    drawHelp(s, { x: 0, y: 1, w: this.width, h: this.height - 2 }, this.mode === MODES.HELP ? "inbox" : "inbox");
  }

  drawFooter() {
    const s = this.screen;
    const W = this.width;
    const H = this.height;

    if (this.mode === MODES.COMMAND) {
      s.fill(0, H - 1, W, 1, " ");
      s.text(1, H - 1, ":" + this.commandLine, T.commandPrompt);
      s.text(W - 16, H - 1, "Enter run · Esc cancel", T.footer);
      return;
    }

    if (this.notice) {
      s.fill(0, H - 1, W, 1, " ", ST.titleBarBg);
      s.text(1, H - 1, " " + this.notice, T.notice);
      return;
    }

    s.fill(0, H - 1, W, 1, " ", ST.titleBarBg);
    const left = this.footerModeText();
    const right = this.footerKeysText();
    s.text(1, H - 1, " " + left, T.footer);
    s.text(Math.max(1, W - right.length - 1), H - 1, right, T.footer);
  }

  footerModeText() {
    switch (this.mode) {
      case MODES.PALETTE: return "palette — type to filter";
      case MODES.COMMAND: return "command";
      case MODES.COMPOSE: return "compose";
      case MODES.HELP: return "help";
      default:
        return this.focus === FOCUS.CONVERSATION ? "conversation" : this.focus === FOCUS.CONTEXT ? "context" : "inbox";
    }
  }

  footerKeysText() {
    if (this.mode === MODES.PALETTE) return "j/k · Enter run · Esc close";
    if (this.mode === MODES.COMMAND) return "Enter run · Esc cancel";
    if (this.mode === MODES.COMPOSE) return "Ctrl-S send · Enter newline · Esc cancel";
    if (this.mode === MODES.HELP) return "q / Esc return";
    if (this.focus === FOCUS.CONVERSATION) return "j/k msgs · Enter back · c compose · r reply · f fwd";
    return "j/k nav · Enter open · / palette · : cmd · c compose · a archive · ? help · q quit";
  }
}

module.exports = { TuiApp, MODES, FOCUS };
