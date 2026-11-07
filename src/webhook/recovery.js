"use strict";

const { enrichMessageSummary } = require("../conversation");
const { CheckpointStore } = require("./checkpoint-store");

function getIngestion() {
  return require("./ingestion");
}

class MessageRecoveryCoordinator {
  constructor(options = {}) {
    this.bridge = options.bridge || null;
    this.service = options.service || this.bridge?.service || null;
    this.client = options.client || null;
    this.checkpointStore =
      options.checkpointStore ||
      new CheckpointStore({ dataDir: options.dataDir || this.bridge?.dataDir });
    this.options = {
      batchSize: options.batchSize || 50,
      maxCycleMessages: options.maxCycleMessages || 500,
      sweepIntervalMs:
        options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : 30000,
      autoSweep: options.autoSweep !== false,
      activeChatSweepCount:
        options.activeChatSweepCount !== undefined ? options.activeChatSweepCount : 10,
      ...options,
    };

    this._isReconciling = false;
    this._reconcilingPromise = null;
    this._stopped = false;
    this._unsubService = null;
    this._readyDebounceTimer = null;
    this._sweepInterval = null;
    this._attachedClients = new WeakSet();
  }

  _getClient() {
    return (
      this.client ||
      this.service?.client ||
      this.service?.controller?.client?.client ||
      this.service?.controller?.client ||
      this.bridge?.service?.client ||
      null
    );
  }

  _attachClientListeners(triggerReconcile) {
    const client = this._getClient();
    if (!client || typeof client.on !== "function") return;
    if (this._attachedClients.has(client)) return;
    this._attachedClients.add(client);

    const onReconcile = () => triggerReconcile();

    // Hook client reconnection and lifecycle events
    client.on("change_state", (state) => {
      if (state === "CONNECTED" || state === "RESUMING") {
        triggerReconcile();
      }
    });
    client.on("loading_screen", (percent) => {
      if (percent === 100) {
        triggerReconcile();
      }
    });
    client.on("ready", onReconcile);
  }

  start() {
    if (this._stopped) return;
    this.checkpointStore.load();

    // Hook into service/controller readiness, recovery, and resume events
    const triggerReconcile = () => {
      if (this._stopped) return;
      this._attachClientListeners(triggerReconcile);
      if (this._readyDebounceTimer) clearTimeout(this._readyDebounceTimer);
      this._readyDebounceTimer = setTimeout(() => {
        this.reconcile().catch(() => {});
      }, 250);
    };

    if (this.service) {
      if (typeof this.service.on === "function") {
        this.service.on("ready", triggerReconcile);
        this.service.on("recovery_success", triggerReconcile);
        this.service.on("resume", triggerReconcile);
      }
      if (this.service.controller && typeof this.service.controller.on === "function") {
        this.service.controller.on("ready", triggerReconcile);
        this.service.controller.on("recovery_success", triggerReconcile);
        this.service.controller.on("resumed", triggerReconcile);
      }
      if (this.service.sleepNotifier && typeof this.service.sleepNotifier.on === "function") {
        this.service.sleepNotifier.on("resume", triggerReconcile);
      }
      if (typeof this.service.subscribe === "function") {
        this._unsubService = this.service.subscribe((rawEvent) => {
          if (!rawEvent) return;
          if (
            rawEvent.event === "resume" ||
            (rawEvent.event === "state" && rawEvent.state === "ready")
          ) {
            triggerReconcile();
          }
        });
      }
    }

    // Attach to client if already instantiated
    this._attachClientListeners(triggerReconcile);

    // Setup recurring background sweep interval (e.g. every 30s)
    if (this.options.autoSweep && this.options.sweepIntervalMs > 0) {
      if (this._sweepInterval) clearInterval(this._sweepInterval);
      this._sweepInterval = setInterval(() => {
        if (!this._stopped) {
          this.reconcile().catch(() => {});
        }
      }, this.options.sweepIntervalMs);
      if (typeof this._sweepInterval.unref === "function") {
        this._sweepInterval.unref();
      }
    }
  }

  stop() {
    this._stopped = true;
    if (this._readyDebounceTimer) {
      clearTimeout(this._readyDebounceTimer);
      this._readyDebounceTimer = null;
    }
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
    if (this._unsubService) {
      this._unsubService();
      this._unsubService = null;
    }
  }

  getStatus() {
    return {
      bootstrapped: this.checkpointStore.isBootstrapped(),
      lastReconciledAt:
        typeof this.checkpointStore.getLastReconciledAt === "function"
          ? this.checkpointStore.getLastReconciledAt()
          : this.checkpointStore.data?.lastReconciledAt || null,
      isReconciling: this._isReconciling,
      chatCount: Object.keys(this.checkpointStore.data?.chats || {}).length,
      processedMessagesCount: Object.keys(
        this.checkpointStore.data?.processedMessageIds ||
          this.checkpointStore.data?.processedMessages ||
          {}
      ).length,
      autoSweep: this.options.autoSweep,
      sweepIntervalMs: this.options.sweepIntervalMs,
    };
  }

  /**
   * Bootstraps the initial baseline for all existing chats when recovery is first enabled.
   * Records current chat timestamps and last message IDs without dispatching past historical messages.
   *
   * @param {Array<object>} chats - Array of chat models from getChats()
   * @returns {Promise<object>} Bootstrap summary
   */
  async bootstrap(chats = []) {
    const chatList = Array.isArray(chats) ? chats : [];
    for (const chat of chatList) {
      if (!chat) continue;
      const chatId = chat.id?._serialized || chat.id;
      if (!chatId) continue;

      const lastTimestamp = chat.timestamp || Math.floor(Date.now() / 1000);
      const lastMessageId =
        (chat.lastMessage && (chat.lastMessage.id?._serialized || chat.lastMessage.id)) ||
        null;

      this.checkpointStore.updateChatCheckpoint(chatId, {
        lastMessageId,
        lastTimestamp,
      });

      if (lastMessageId) {
        this.checkpointStore.markMessageProcessed(lastMessageId, lastTimestamp);
      }
    }

    this.checkpointStore.setBootstrapped(true);
    this.checkpointStore.save();
    return { bootstrapped: true, chatCount: chatList.length };
  }

  /**
   * Reconciles missed messages across all candidate chats.
   * Runs sequentially and yields to event loop between chats to prevent blocking normal operations.
   */
  async reconcile(options = {}) {
    if (this._stopped) return { status: "stopped" };
    if (this._isReconciling) {
      return this._reconcilingPromise;
    }

    this._isReconciling = true;
    this._reconcilingPromise = (async () => {
      try {
        const client = this._getClient();
        if (!client || typeof client.getChats !== "function") {
          return { status: "skipped", reason: "client_not_available" };
        }

        let chats = [];
        try {
          chats = await client.getChats();
        } catch (err) {
          return { status: "error", error: err.message };
        }

        if (!Array.isArray(chats)) chats = [];

        // 1. Initial bootstrap behavior: define baseline on first enable
        if (!this.checkpointStore.isBootstrapped()) {
          const res = await this.bootstrap(chats);
          return { status: "bootstrapped", ...res };
        }

        const accountInfo = getIngestion().resolveAccountInfo(this.bridge, options);

        // 2. Identify candidate chats that may contain un-reconciled messages
        const candidateChats = [];
        const activeSweepCount = this.options.activeChatSweepCount || 10;
        let checkedCount = 0;

        for (const chat of chats) {
          if (!chat) continue;
          const chatId = chat.id?._serialized || chat.id;
          if (!chatId) continue;

          // Exclude channels and broadcasts per strict filtering rules
          if (
            chatId.includes("@newsletter") ||
            chat.isNewsletter ||
            getIngestion().isChannelOrBroadcast({ chatId, isNewsletter: chat.isNewsletter })
          ) {
            continue;
          }
          if (
            chatId === "status@broadcast" ||
            chatId.endsWith("@broadcast") ||
            chat.broadcast
          ) {
            continue;
          }

          const cp = this.checkpointStore.getChatCheckpoint(chatId);
          if (!cp) {
            // New chat discovered since last session
            candidateChats.push(chat);
          } else {
            const chatTs = Number(chat.timestamp) || 0;
            const cpTs = Number(cp.lastTimestamp) || 0;
            const unread = Number(chat.unreadCount) || 0;
            const lastMsg = chat.lastMessage;
            const lastMsgId =
              lastMsg && (lastMsg.id?._serialized || lastMsg.id);
            const isLastMsgProcessed = lastMsgId
              ? this.checkpointStore.isMessageProcessed(lastMsgId)
              : true;

            if (
              chatTs > cpTs ||
              unread > 0 ||
              (lastMsgId && lastMsgId !== cp.lastMessageId) ||
              !isLastMsgProcessed ||
              checkedCount < activeSweepCount
            ) {
              candidateChats.push(chat);
            }
          }
          checkedCount++;
        }

        // Sort candidate chats by timestamp descending (most recently active first)
        candidateChats.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

        let totalProcessed = 0;
        let chatsReconciled = 0;
        const errors = [];

        // 3. Process candidate chats sequentially with non-blocking yields
        for (const chat of candidateChats) {
          if (this._stopped) break;

          const result = await this.reconcileChat(chat, accountInfo);
          if (result.error) {
            errors.push(result);
          } else {
            chatsReconciled++;
            totalProcessed += result.processed || 0;
          }

          // Micro-yield between chats to allow event loop to breathe
          await new Promise((resolve) => setImmediate(resolve));
        }

        this.checkpointStore.setLastReconciledAt();
        return {
          status: "completed",
          totalProcessed,
          chatsReconciled,
          errors,
        };
      } finally {
        this._isReconciling = false;
        this._reconcilingPromise = null;
      }
    })();

    return this._reconcilingPromise;
  }

  /**
   * Reconciles messages for a single chat in chronological order (oldest to newest).
   * Supports multi-batch incremental processing to handle backlogs beyond a single batch size.
   *
   * @param {object} chat - WhatsApp Web.js Chat model
   * @param {object} accountInfo - Authenticated account info
   * @returns {Promise<object>} Reconciliation outcome
   */
  async reconcileChat(chat, accountInfo) {
    if (!chat || typeof chat.fetchMessages !== "function") {
      return { status: "skipped", reason: "fetch_not_supported" };
    }

    const chatId = chat.id?._serialized || chat.id;
    let chatProcessed = 0;
    let hasMore = true;
    let fetchLimit = this.options.batchSize || 50;
    const maxCycle = this.options.maxCycleMessages || 500;

    while (hasMore && !this._stopped && chatProcessed < maxCycle) {
      const cp = this.checkpointStore.getChatCheckpoint(chatId);
      const lastTimestamp = Number(cp?.lastTimestamp) || 0;
      const lastMessageId = cp?.lastMessageId || null;

      let rawMessages = [];
      try {
        rawMessages = await chat.fetchMessages({ limit: fetchLimit });
      } catch (err) {
        // Record limitation honestly without advancing checkpoint!
        this.checkpointStore.recordChatError(chatId, err);
        return {
          chatId,
          processed: chatProcessed,
          error: err.message || String(err),
          status: "inaccessible_history",
        };
      }

      if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
        break;
      }

      // Check if earliest message is still newer than checkpoint and more can be loaded
      const earliest = rawMessages[0];
      const earliestTs = Number(earliest?.timestamp) || 0;
      if (
        lastTimestamp > 0 &&
        earliestTs > lastTimestamp &&
        rawMessages.length >= fetchLimit &&
        fetchLimit < maxCycle
      ) {
        fetchLimit = Math.min(fetchLimit * 2, maxCycle);
        continue;
      }

      // Filter unhandled messages strictly newer than checkpoint
      const candidates = rawMessages.filter((m) => {
        if (!m) return false;
        const mId = (m.id && (m.id._serialized || m.id)) || null;
        if (!mId) return false;
        if (this.checkpointStore.isMessageProcessed(mId)) {
          return false;
        }

        const mTs = Number(m.timestamp) || 0;
        if (lastTimestamp > 0) {
          if (mTs < lastTimestamp) return false;
          if (mTs === lastTimestamp && mId === lastMessageId) return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        // All messages in chat up to current point are reconciled
        break;
      }

      // Sort strictly chronologically (oldest to newest)
      candidates.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));

      const batch = candidates.slice(0, this.options.batchSize || 50);

      for (const m of batch) {
        if (this._stopped) break;

        const mId = m.id?._serialized || m.id;
        const mTs = Number(m.timestamp) || Math.floor(Date.now() / 1000);

        if (this.checkpointStore.isMessageProcessed(mId)) {
          continue;
        }

        // Enrich summary using existing context logic
        const summary = enrichMessageSummary(m, {
          contactCache: this.bridge?.service?._contactCache || null,
          chat,
          myNumber: accountInfo?.number,
        });

        // Use the centralized bridge ingestion pipeline (single source of truth)
        if (this.bridge && typeof this.bridge.ingestMessage === "function") {
          this.bridge.ingestMessage(summary, { account: accountInfo });
        } else {
          // Fallback if bridge is not directly attached
          const isEligible = getIngestion().isIncomingMessageEligible(summary, accountInfo);
          this.checkpointStore.markMessageProcessed(mId, mTs);
          this.checkpointStore.updateChatCheckpoint(chatId, {
            lastMessageId: mId,
            lastTimestamp: mTs,
          });
        }

        chatProcessed++;
        // Non-blocking yield
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (candidates.length <= batch.length) {
        hasMore = false;
      }
    }

    return {
      chatId,
      processed: chatProcessed,
      status: "reconciled",
    };
  }
}

module.exports = {
  MessageRecoveryCoordinator,
};
