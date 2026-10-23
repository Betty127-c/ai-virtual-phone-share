export default {
  manifest: {
    id: "emoji-reaction",
    name: "emoji reaction",
    apiVersion: 1,
    version: "1.4.4",
    author: "小坊",
    description: "消息表情与表情包小图回应、气泡外毛玻璃胶囊、群聊同表情头像镂空切割合并、外置引用自动避让、短气泡不被拉长、最近N条动态注入提示词（删消息同步清理）、严格区分Emoji与表情包格式",
    permissions: ["chat.read"],
    settings: [
      { key: "presetEmojis", label: "长按菜单预设 Emoji（空格或逗号分隔）", type: "text", default: "👍 ❤️ 😂 😮 😢 🙏 🔥 🎉 🥰 🤔 😭 ✨" },
      { key: "promptHistoryLimit", label: "注入提示词的最近回应条数上限", type: "number", default: 5 },
      { key: "showStickersInMenu", label: "在长按菜单顶部滑动栏中也展示表情包", type: "boolean", default: true },
      { key: "enableAiReact", label: "允许角色主动给消息设置 / 取消 Emoji 与表情包回应", type: "boolean", default: true },
      { key: "debugLog", label: "输出调试日志到插件日志面板", type: "boolean", default: false },
    ],
  },

  setup(ctx) {
    const STORAGE_KEY = "emoji_reactions_store_v2";
    const LEGACY_STORAGE_KEY = "emoji_reactions_store_v1";
    const ACTION_LABEL = "表情回应";
    const MAX_THEME_ASSET_CACHE = 64;
    const MAX_STORED_MESSAGES = 800;
    const TARGET_ROWS = 8;
    const MAX_REACTS_PER_REPLY = 4;
    const QUOTE_GAP = 6;
    const ROW_SELECTOR = ".chat-msg-wrapper";
    const WRAP_SELECTOR = ".chat-msg-content-wrap";
    const QUOTE_SELECTORS = [
      ".chat-quote-preview",
      '[class*="quote-preview"]',
      '[class*="reply-preview"]',
      '[class*="quoted-preview"]',
    ];

    let currentSessionId = null;
    let currentIsGroup = false;
    let lastContextMsg = null;
    let store = loadStore();
    let reflowObserver = null;
    let reflowRafPending = false;

    const kvMemCache = new Map();
    const kvParsedCache = new Map();
    const themeAssetCache = new Map();
    // key: realId -> { slotEl, outEl, sessionId, message, domMsgId }
    const footerSlotMap = new Map();
    const patchedBubbleAlign = new WeakMap();
    const pendingAiReactBySession = new Map();
    const groupFlagCache = new Map();
    const observedReflowTargets = new WeakSet();
    const pendingReflowIds = new Set();
    const retryTimers = new Map();

    function dbg(...args) {
      try {
        if (ctx.system.settings.get("debugLog") !== true) return;
        ctx.system.log("[emoji-reaction]", ...args);
      } catch (e) {}
    }

    // ── 1. 宿主 IndexedDB 只读取用与 URL 安全校验 ──
    function isSafeImageUrl(url) {
      if (!url || typeof url !== "string") return false;
      const clean = url.trim().toLowerCase();
      return (
        clean.startsWith("http://") ||
        clean.startsWith("https://") ||
        clean.startsWith("data:image/") ||
        clean.startsWith("blob:") ||
        (clean.startsWith("/") && !clean.startsWith("//"))
      );
    }

    function setThemeAssetCache(assetId, dataUrl) {
      if (!assetId || !dataUrl) return;
      if (themeAssetCache.has(assetId)) themeAssetCache.delete(assetId);
      else if (themeAssetCache.size >= MAX_THEME_ASSET_CACHE) {
        const oldestKey = themeAssetCache.keys().next().value;
        if (oldestKey !== undefined) themeAssetCache.delete(oldestKey);
      }
      themeAssetCache.set(assetId, dataUrl);
    }

    function openExistingIndexedDB(dbName, onSuccess, onFail) {
      if (typeof indexedDB === "undefined") { if (onFail) onFail(); return; }
      try {
        const req = indexedDB.open(dbName);
        let abortedNewDb = false;
        req.onupgradeneeded = () => {
          // 宿主尚未建库时绝不抢先建空库，避免破坏宿主后续迁移
          if (req.result && req.result.objectStoreNames.length === 0) {
            abortedNewDb = true;
            try { req.transaction.abort(); } catch (e) {}
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          if (abortedNewDb) { try { db.close(); } catch (e) {} if (onFail) onFail(); return; }
          db.onversionchange = () => { try { db.close(); } catch (e) {} };
          onSuccess(db);
        };
        req.onerror = () => { if (onFail) onFail(); };
        req.onblocked = () => { if (onFail) onFail(); };
      } catch (e) { if (onFail) onFail(); }
    }

    function syncKvFromIndexedDB(onDone) {
      openExistingIndexedDB("AiPhoneKvDB", (db) => {
        if (!db.objectStoreNames.contains("entries")) { db.close(); if (onDone) onDone(); return; }
        try {
          const storeObj = db.transaction("entries", "readonly").objectStore("entries");
          const keys = [
            "ai_phone_user_identities_v1",
            "ai_phone_bindings_v1",
            "ai_phone_sticker_packs_v1",
            "ai_phone_sticker_assign_v1",
          ];
          let pending = keys.length;
          let changed = false;
          keys.forEach((k) => {
            const g = storeObj.get(k);
            g.onsuccess = () => {
              if (g.result && typeof g.result.value === "string") {
                if (kvMemCache.get(k) !== g.result.value) {
                  kvMemCache.set(k, g.result.value);
                  try { kvParsedCache.set(k, JSON.parse(g.result.value)); }
                  catch (e) { kvParsedCache.delete(k); }
                  changed = true;
                }
              }
              if (--pending === 0) { db.close(); if (onDone) onDone(); if (changed) refreshAllFooters(); }
            };
            g.onerror = () => { if (--pending === 0) { db.close(); if (onDone) onDone(); } };
          });
        } catch (e) { db.close(); if (onDone) onDone(); }
      }, onDone);
    }

    function readHostKvJson(key) {
      if (kvParsedCache.has(key)) return kvParsedCache.get(key);
      try {
        const raw = kvMemCache.get(key) || (typeof localStorage !== "undefined" ? localStorage.getItem(key) : null);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        kvMemCache.set(key, raw);
        kvParsedCache.set(key, parsed);
        return parsed;
      } catch (e) { return null; }
    }

    function resolveThemeAssetId(assetId, onResolved) {
      if (!assetId || typeof assetId !== "string") return null;
      if (isSafeImageUrl(assetId)) return assetId;
      if (themeAssetCache.has(assetId)) {
        const cached = themeAssetCache.get(assetId);
        setThemeAssetCache(assetId, cached);
        if (onResolved) onResolved(cached);
        return cached;
      }
      openExistingIndexedDB("ai_phone_theme_db_v1", (db) => {
        if (!db.objectStoreNames.contains("assets")) { db.close(); return; }
        try {
          const getReq = db.transaction("assets", "readonly").objectStore("assets").get(assetId);
          getReq.onsuccess = () => {
            const rec = getReq.result;
            db.close();
            if (rec && typeof rec.dataUrl === "string" && isSafeImageUrl(rec.dataUrl)) {
              setThemeAssetCache(assetId, rec.dataUrl);
              if (onResolved) onResolved(rec.dataUrl);
            }
          };
          getReq.onerror = () => db.close();
        } catch (e) { db.close(); }
      });
      return null;
    }

    function getHostStickerPacks(sessionId) {
      const allPacks = readHostKvJson("ai_phone_sticker_packs_v1");
      if (!Array.isArray(allPacks)) return [];
      const validPacks = allPacks.filter((p) => p && Array.isArray(p.stickers) && p.stickers.length > 0);
      if (!validPacks.length) return [];

      const assignMap = readHostKvJson("ai_phone_sticker_assign_v1") || {};
      const sid = sessionId || currentSessionId;
      let charIds = [];
      try {
        const sess = sid ? ctx.data.sessions.get(sid) : null;
        if (sess) charIds = sess.isGroup ? sess.participantIds || [] : sess.contactId ? [sess.contactId] : [];
      } catch (e) {}

      const charSet = new Set(charIds.filter(Boolean));
      if (!charSet.size) return validPacks;

      const assigned = [];
      const others = [];
      validPacks.forEach((pack) => {
        const bound = Array.isArray(assignMap[pack.id]) ? assignMap[pack.id] : [];
        if (bound.some((id) => charSet.has(id))) assigned.push(pack);
        else others.push(pack);
      });
      return [...assigned, ...others];
    }

    function findStickerItem(nameOrId, sessionId) {
      const clean = String(nameOrId || "").trim();
      if (!clean) return null;
      for (const pack of getHostStickerPacks(sessionId)) {
        for (const s of pack.stickers || []) {
          if (s.id === clean || s.name === clean) return s;
        }
      }
      return null;
    }

    function getStickerImageUrl(sticker, onAsyncLoaded) {
      if (!sticker) return "";
      if (sticker.externalUrl && isSafeImageUrl(sticker.externalUrl)) return sticker.externalUrl;
      if (sticker.assetId) return resolveThemeAssetId(sticker.assetId, onAsyncLoaded) || "";
      return "";
    }

    function getHostUserIdentity(session) {
      const identities = readHostKvJson("ai_phone_user_identities_v1");
      if (!Array.isArray(identities) || !identities.length) return null;
      const bindings = readHostKvJson("ai_phone_bindings_v1");
      const characterId = session && !session.isGroup ? session.contactId : undefined;
      let uid = bindings?.globalDefaults?.userIdentityId;

      if (characterId && Array.isArray(bindings?.characterBindings)) {
        const cb = bindings.characterBindings.find((b) => b.characterId === characterId);
        if (cb?.defaults?.userIdentityId) uid = cb.defaults.userIdentityId;
        if (bindings?.appDefaults?.chat?.userIdentityId) uid = bindings.appDefaults.chat.userIdentityId;
        if (cb?.appOverrides?.chat?.userIdentityId) uid = cb.appOverrides.chat.userIdentityId;
      } else if (bindings?.appDefaults?.chat?.userIdentityId) {
        uid = bindings.appDefaults.chat.userIdentityId;
      }
      return (uid && identities.find((i) => i.id === uid)) || identities[0];
    }

    function scrapeUserAvatarFromDom() {
      if (typeof document === "undefined") return "";
      let img = null;
      try { img = document.querySelector('.chat-msg-wrapper[data-role="user"] .chat-msg-avatar img'); } catch (e) { img = null; }
      const src = img && img.src ? img.src : "";
      return isSafeImageUrl(src) ? src : "";
    }

    function resolveActorInfo(actorId, isUser, fallbackName, sessionId) {
      const sid = sessionId || currentSessionId;
      let session = null;
      try { if (sid) session = ctx.data.sessions.get(sid); } catch (e) {}

      if (isUser || actorId === "user") {
        let avatarUrl = "";
        const selfRef = session?.avatarOverrides?.self;
        if (selfRef) avatarUrl = resolveThemeAssetId(selfRef, () => refreshAllFooters()) || "";
        const identity = getHostUserIdentity(session);
        if (!avatarUrl && identity?.avatarUrl && isSafeImageUrl(identity.avatarUrl)) avatarUrl = identity.avatarUrl;
        if (!avatarUrl) avatarUrl = scrapeUserAvatarFromDom();
        return {
          actorId: "user",
          actorName: identity?.name || fallbackName || "我",
          actorAvatar: avatarUrl || "",
          isUser: true,
        };
      }

      try {
        let char = actorId && actorId !== "character" ? ctx.data.characters.get(actorId) : null;
        if (!char) {
          const chars = ctx.data.characters.list() || [];
          if (actorId && actorId !== "character") char = chars.find((c) => c.id === actorId || c.name === actorId) || null;
          if (!char && fallbackName && fallbackName !== "角色") {
            char = chars.find((c) => c.name === fallbackName || c.nickname === fallbackName) || null;
          }
          if (!char && session && !session.isGroup && session.contactId) {
            char = chars.find((c) => c.id === session.contactId) || null;
          }
        }
        const cid = char?.id || (actorId && actorId !== "character" ? actorId : "") || (session && !session.isGroup ? session.contactId : "character");
        let avatarUrl = "";
        const charRef = cid && session?.avatarOverrides?.[cid];
        if (charRef) avatarUrl = resolveThemeAssetId(charRef, () => refreshAllFooters()) || "";
        if (!avatarUrl && char?.avatar && isSafeImageUrl(char.avatar)) avatarUrl = char.avatar;
        return {
          actorId: cid || "character",
          actorName: char?.name || fallbackName || "角色",
          actorAvatar: avatarUrl || "",
          isUser: false,
        };
      } catch (e) {
        return { actorId: actorId || "character", actorName: fallbackName || "角色", actorAvatar: "", isUser: false };
      }
    }

    function resolveMessageOwnerName(msg, sessionId) {
      if (!msg) return "某人";
      const sid = sessionId || msg.sessionId || currentSessionId;
      if (msg.role === "user") return resolveActorInfo("user", true, "用户", sid).actorName;
      if (msg.senderName) return msg.senderName;
      if (msg.senderCharacterId) return resolveActorInfo(msg.senderCharacterId, false, "角色", sid).actorName;
      try {
        const sess = sid ? ctx.data.sessions.get(sid) : null;
        if (sess && sess.contactId) return resolveActorInfo(sess.contactId, false, "角色", sid).actorName;
      } catch (e) {}
      return "角色";
    }

    // ── 2. 插件私有存储与删除同步清理 ──
    function loadStore() {
      try {
        const raw = ctx.system.storage.get(STORAGE_KEY);
        if (raw && typeof raw === "object" && raw.byMsgId) {
          if (!Array.isArray(raw.historyLog)) raw.historyLog = [];
          for (const [k, v] of Object.entries(raw.byMsgId)) {
            if (!v || !Array.isArray(v.items) || v.items.length === 0) delete raw.byMsgId[k];
            else if (v.orphanedAt) delete v.orphanedAt;
          }
          return raw;
        }
        const legacy = ctx.system.storage.get(LEGACY_STORAGE_KEY);
        if (legacy && typeof legacy === "object" && legacy.byMsgId) {
          for (const [k, rec] of Object.entries(legacy.byMsgId)) {
            if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) { delete legacy.byMsgId[k]; continue; }
            rec.items.forEach((it) => {
              if (!it.kind) it.kind = "emoji";
              if (!it.key) it.key = `emoji:${it.emoji}`;
            });
          }
          return { byMsgId: legacy.byMsgId, historyLog: [] };
        }
      } catch (e) {}
      return { byMsgId: {}, historyLog: [] };
    }

    function purgeMessageReactionData(msgId) {
      if (!msgId) return false;
      let changed = false;
      if (store.byMsgId[msgId]) {
        delete store.byMsgId[msgId];
        changed = true;
      }
      if (Array.isArray(store.historyLog) && store.historyLog.length > 0) {
        const beforeLen = store.historyLog.length;
        store.historyLog = store.historyLog.filter((h) => h && h.targetMsgId !== msgId);
        if (store.historyLog.length !== beforeLen) changed = true;
      }
      return changed;
    }

    function pruneStoreCapacity() {
      try {
        const allEntries = Object.entries(store.byMsgId);
        if (allEntries.length > MAX_STORED_MESSAGES) {
          allEntries.sort((a, b) => (a[1]?.updatedAt || a[1]?.createdAt || 0) - (b[1]?.updatedAt || b[1]?.createdAt || 0));
          const toDelete = allEntries.length - MAX_STORED_MESSAGES;
          const removedIds = new Set();
          for (let i = 0; i < toDelete; i++) {
            const id = allEntries[i][0];
            delete store.byMsgId[id];
            removedIds.add(id);
          }
          if (Array.isArray(store.historyLog) && removedIds.size > 0) {
            store.historyLog = store.historyLog.filter((h) => h && !removedIds.has(h.targetMsgId));
          }
          saveStore();
        }
      } catch (e) {}
    }

    function saveStore() {
      try { ctx.system.storage.set(STORAGE_KEY, store); } catch (e) {}
    }

    function getPresets() {
      const raw = ctx.system.settings.get("presetEmojis") || "👍 ❤️ 😂 😮 😢 🙏 🔥 🎉 🥰 🤔 😭 ✨";
      const list = String(raw).split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
      return list.length ? list : ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
    }

    syncKvFromIndexedDB();

    // ── 3. 样式 ──
    ctx.ui.injectCSS(`
.chat-plugin-message-footer > [data-chat-plugin="emoji-reaction"] { display: none !important; }
.chat-plugin-message-footer:not(:has(> :not([data-chat-plugin="emoji-reaction"]))) { display: none !important; }
.er-outside-container { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; width: 100%; max-width: 100%; box-sizing: border-box; margin-top: 5px; margin-bottom: 2px; align-self: stretch; position: relative; z-index: 2; user-select: none; -webkit-user-select: none; }
.er-outside-container:empty { display: none !important; margin: 0 !important; }
.er-outside-container.er-align-left { justify-content: flex-start; }
.er-outside-container.er-align-right { justify-content: flex-end; }
.chat-msg-content-wrap:has(> .er-outside-container) > [data-msg-id] { align-self: flex-start; }
.chat-msg-wrapper[data-role="user"] .chat-msg-content-wrap:has(> .er-outside-container) > [data-msg-id] { align-self: flex-end; }
.er-pill { display: inline-flex; align-items: center; justify-content: center; height: 24px; min-width: 28px; padding: 0 7px; border-radius: 6px; background: rgba(185, 185, 193, 0.20); backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%); border: none; box-shadow: none; cursor: pointer; transition: transform 0.12s ease, background 0.15s ease; box-sizing: border-box; }
.er-pill:active { transform: scale(0.93); }
.er-pill.er-pill-mine { background: rgba(170, 170, 180, 0.30); }
.er-pill-emoji { font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; text-align: center; }
.er-pill-sticker-img { width: 16px; height: 16px; object-fit: contain; display: block; flex-shrink: 0; pointer-events: none; }
.er-avatar-stack { display: inline-flex; align-items: center; margin-right: 4px; }
.er-avatar-item { width: 16px; height: 16px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: rgba(160, 160, 170, 0.35); color: var(--c-text-title, #333); font-size: 9px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
.er-avatar-item + .er-avatar-item { margin-left: -6px; }
.er-avatar-item:has(+ .er-avatar-item), .er-avatar-item.er-avatar-cut-right { -webkit-mask-image: radial-gradient(circle at 18px 8px, transparent 9.5px, #000 10px); mask-image: radial-gradient(circle at 18px 8px, transparent 9.5px, #000 10px); }
.er-avatar-item img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.er-add-btn { width: 24px; height: 24px; border-radius: 6px; background: rgba(185, 185, 193, 0.20); backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%); border: none; box-shadow: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; color: var(--c-text, #444); flex-shrink: 0; transition: transform 0.12s ease, background 0.15s ease; }
.er-add-btn:active { transform: scale(0.92); }
.er-add-btn svg { width: 14px; height: 14px; display: block; opacity: 0.78; }
er-menu-bar.er-menu-preset-bar, .er-menu-preset-bar { display: flex; align-items: center; gap: 2px; width: 0; min-width: 100%; max-width: 100%; padding: 4px 6px 6px; margin-bottom: 2px; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; scrollbar-width: none; border-bottom: 1px solid rgba(255, 255, 255, 0.1); box-sizing: border-box; touch-action: pan-x; }
.er-menu-preset-bar::-webkit-scrollbar { display: none; }
.er-menu-emoji-item { width: 28px; height: 26px; padding: 0; border-radius: 6px; background: transparent !important; border: none; box-shadow: none; display: inline-flex; align-items: center; justify-content: center; font-size: 17px; line-height: 1; cursor: pointer; flex-shrink: 0; transition: transform 0.12s ease; }
.er-menu-emoji-item:active { transform: scale(1.22); }
.er-menu-emoji-item img { width: 18px; height: 18px; object-fit: contain; display: block; pointer-events: none; }
.er-modal-box { padding: 16px 18px 18px; width: 100%; box-sizing: border-box; }
.er-modal-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; margin-bottom: 14px; }
.er-modal-tab { width: 100%; padding: 6px 0; border-radius: 6px; border: none; background: transparent; color: var(--c-text, #666); font-size: 13px; font-weight: 600; cursor: pointer; opacity: 0.65; text-align: center; }
.er-modal-tab.er-tab-active { opacity: 1; background: rgba(185, 185, 193, 0.22); color: var(--c-text-title, #111); }
.er-modal-input-row { display: flex; width: 100%; gap: 8px; margin-bottom: 12px; }
.er-modal-input { flex: 1; min-width: 0; height: 36px; padding: 0 12px; border-radius: 6px; border: none; outline: none; background: rgba(185, 185, 193, 0.18); font-size: 14px; color: inherit; box-sizing: border-box; }
.er-modal-submit { height: 36px; padding: 0 16px; border-radius: 6px; border: none; background: rgba(185, 185, 193, 0.25); font-size: 13px; font-weight: 600; color: inherit; cursor: pointer; flex-shrink: 0; }
.er-modal-grid { display: grid; width: 100%; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: 6px; justify-items: center; align-items: center; max-height: 230px; overflow-y: auto; scrollbar-width: none; }
.er-modal-grid::-webkit-scrollbar { display: none; }
.er-modal-grid-btn { width: 100%; height: 38px; border-radius: 6px; border: none; background: transparent !important; box-shadow: none; font-size: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; transition: transform 0.12s ease; }
.er-modal-grid-btn:active { transform: scale(1.22); }
.er-pack-bar { display: flex; width: 100%; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 8px; scrollbar-width: none; }
.er-pack-bar::-webkit-scrollbar { display: none; }
.er-pack-pill { padding: 4px 10px; border-radius: 6px; border: none; background: transparent; font-size: 12px; color: inherit; opacity: 0.6; white-space: nowrap; cursor: pointer; flex-shrink: 0; }
.er-pack-pill.er-active { opacity: 1; font-weight: 600; background: rgba(185, 185, 193, 0.18); }
.er-sticker-grid { display: grid; width: 100%; grid-template-columns: repeat(auto-fill, minmax(56px, 1fr)); gap: 8px; justify-items: center; max-height: 230px; overflow-y: auto; scrollbar-width: none; }
.er-sticker-grid::-webkit-scrollbar { display: none; }
.er-sticker-btn { width: 100%; border: none; background: transparent !important; box-shadow: none; padding: 4px 2px; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; cursor: pointer; min-width: 0; transition: transform 0.12s ease; }
.er-sticker-btn:active { transform: scale(1.14); }
.er-sticker-btn img { width: 32px; height: 32px; object-fit: contain; display: block; }
.er-sticker-btn span { font-size: 10px; opacity: 0.72; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-sticker-empty { grid-column: 1 / -1; text-align: center; font-size: 12px; opacity: 0.6; padding: 28px 8px; }
`);

    // ── 4. 通用工具与安全校验 ──
    function normalizeText(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function sanitizePromptField(text, maxLen = 32) {
      return String(text || "")
        .replace(/[\r\n\[\]【】`]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen);
    }

    function isEmojiOnly(text) {
      const s = String(text || "").trim();
      if (!s) return false;
      return !/[\p{L}\p{N}]/u.test(s);
    }

    function sanitizeEmojiToken(raw) {
      let clean = String(raw || "").replace(/[\r\n\[\]【】`]/g, "").trim();
      // 若模型误加了 emoji: 前缀，自动剥除
      clean = clean.replace(/^emoji[:：]\s*/i, "").trim();
      if (!clean) return "";
      const codePoints = Array.from(clean);
      if (codePoints.length > 8 || clean.length > 24) return "";
      return clean;
    }

    function parseStickerTokenName(token) {
      const s = String(token || "").trim();
      const m1 = s.match(/^表情包[:：]\s*(.+)$/);
      if (m1) return m1[1].trim();
      const m2 = s.match(/^sticker[:：]\s*(.+)$/i);
      if (m2) return m2[1].trim();
      return null;
    }

    function isAllToken(token) {
      const t = String(token || "").trim();
      const lower = t.toLowerCase();
      return lower === "all" || t === "全部" || t === "所有" || t === "*";
    }

    function getRealMsgId(msg) {
      return msg ? msg.displaySourceId || msg.id || "" : "";
    }

    function getDomMsgIds(msg, fallbackId) {
      const ids = [];
      if (msg && msg.id) ids.push(msg.id);
      if (msg && msg.displaySourceId && !ids.includes(msg.displaySourceId)) ids.push(msg.displaySourceId);
      if (fallbackId && !ids.includes(fallbackId)) ids.push(fallbackId);
      return ids;
    }

    function getSessionMessageList(sid) {
      if (!sid) return [];
      try { return ctx.data.messages.list(sid) || []; } catch (e) { return []; }
    }

    function messageText(m) {
      if (!m) return "";
      return String(m.content || m.mediaData?.label || "");
    }

    function messageTs(m, fallbackIndex) {
      if (!m) return fallbackIndex || 0;
      const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      return Number.isFinite(t) && t > 0 ? t : fallbackIndex || 0;
    }

    function canonText(text) {
      return String(text || "").replace(/[^\p{L}\p{N}]/gu, "");
    }

    function latestUserMessage(msgList) {
      const list = msgList || [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].role === "user") return list[i];
      }
      return null;
    }

    function longestCommonSubstrLen(a, b) {
      const s1 = Array.from(a || "");
      const s2 = Array.from(b || "");
      const n = s1.length;
      const m = s2.length;
      if (!n || !m) return 0;
      let prev = new Uint16Array(m + 1);
      let cur = new Uint16Array(m + 1);
      let best = 0;
      for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
          if (s1[i - 1] === s2[j - 1]) {
            const v = prev[j - 1] + 1;
            cur[j] = v;
            if (v > best) best = v;
          } else {
            cur[j] = 0;
          }
        }
        const tmp = prev;
        prev = cur;
        cur = tmp;
        cur.fill(0);
      }
      return best;
    }

    function inferGroupFromMessages(sessionId) {
      try {
        const list = getSessionMessageList(sessionId) || [];
        const senders = new Set();
        for (let i = list.length - 1; i >= 0 && i >= list.length - 60; i--) {
          const m = list[i];
          if (!m || m.role !== "assistant") continue;
          const key = m.senderCharacterId || m.senderName || "";
          if (key) senders.add(key);
          if (senders.size >= 2) return true;
        }
      } catch (e) {}
      return false;
    }

    function checkIsGroupSession(sessionId) {
      if (!sessionId) return false;
      if (groupFlagCache.has(sessionId)) return groupFlagCache.get(sessionId) === true;

      let result = null;
      try {
        const s = ctx.data.sessions.get(sessionId);
        if (s) {
          if (s.isGroup === true) result = true;
          else if (s.isGroup === false) result = false;
          else if (Array.isArray(s.participantIds) && s.participantIds.length > 1) result = true;
          else result = false;
        }
      } catch (e) { result = null; }

      if (result === null) {
        try { result = inferGroupFromMessages(sessionId); } catch (e) { result = false; }
      }
      const finalFlag = result === true;
      try { groupFlagCache.set(sessionId, finalFlag); } catch (e) {}
      return finalFlag;
    }

    function getSmileSvg() {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2"></path><circle cx="9" cy="9.5" r="1" fill="currentColor" stroke="none"></circle><circle cx="15" cy="9.5" r="1" fill="currentColor" stroke="none"></circle></svg>`;
    }

    // ── 5. 行 / 气泡定位（优先从 slotEl 向上找，兼顾投影 ID __display_ 与媒体气泡） ──
    function findRowBySingleId(id) {
      if (!id || typeof document === "undefined") return null;
      try {
        const escId = CSS.escape(id);
        let row = document.getElementById(`message-${id}`);
        if (row && !row.classList.contains(ROW_SELECTOR.slice(1))) {
          const up = row.closest(ROW_SELECTOR);
          if (up) row = up;
        }
        if (!row) row = document.querySelector(`${ROW_SELECTOR}[data-msg-id="${escId}"]`);
        if (!row) {
          const bubble =
            document.querySelector(`[data-msg-id="${escId}"]`) ||
            document.querySelector(`[data-msg-id^="${escId}__display_"]`) ||
            document.querySelector(`[id^="message-${escId}__display_"]`);
          if (bubble) {
            row = bubble.classList.contains(ROW_SELECTOR.slice(1))
              ? bubble
              : bubble.closest(ROW_SELECTOR) || (bubble.closest(WRAP_SELECTOR) ? bubble.closest(WRAP_SELECTOR).parentElement : null);
          }
        }
        return row || null;
      } catch (e) { return null; }
    }

    function findRowByIds(candidateIds) {
      for (let i = 0; i < candidateIds.length; i++) {
        const r = findRowBySingleId(candidateIds[i]);
        if (r) return r;
      }
      return null;
    }

    function findWrapInRow(rowEl, candidateIds) {
      if (!rowEl) return null;
      try {
        const wraps = rowEl.querySelectorAll(WRAP_SELECTOR);
        if (!wraps.length) return null;
        if (wraps.length === 1) return wraps[0];
        for (let k = 0; k < candidateIds.length; k++) {
          const id = candidateIds[k];
          if (!id) continue;
          const escId = CSS.escape(id);
          for (let i = 0; i < wraps.length; i++) {
            if (
              wraps[i].querySelector(`[data-msg-id="${escId}"]`) ||
              wraps[i].querySelector(`[data-msg-id^="${escId}__display_"]`)
            ) {
              return wraps[i];
            }
          }
        }
        return wraps[0];
      } catch (e) { return null; }
    }

    function findBubbleEl(wrapEl, candidateIds) {
      if (!wrapEl) return null;
      try {
        for (let k = 0; k < candidateIds.length; k++) {
          const id = candidateIds[k];
          if (!id) continue;
          const escId = CSS.escape(id);
          const own =
            wrapEl.querySelector(`:scope > [data-msg-id="${escId}"]`) ||
            wrapEl.querySelector(`:scope > [data-msg-id^="${escId}__display_"]`);
          if (own) return own;
        }
        const any = wrapEl.querySelector(":scope > [data-msg-id]");
        if (any) return any;
        return wrapEl.querySelector(".chat-bubble-role-user, .chat-bubble-role-assistant");
      } catch (e) { return null; }
    }

    function resolveMessageNodes(realId, slotEl, message) {
      const candidateIds = getDomMsgIds(message, realId);
      if (slotEl && slotEl.isConnected) {
        const wrapEl = slotEl.closest(WRAP_SELECTOR);
        if (wrapEl) {
          const rowEl = wrapEl.closest(ROW_SELECTOR) || wrapEl.parentElement || wrapEl;
          const bubbleEl = slotEl.closest("[data-msg-id]") || findBubbleEl(wrapEl, candidateIds);
          return { rowEl, wrapEl, bubbleEl };
        }
      }
      const entry = footerSlotMap.get(realId);
      if (entry && entry.slotEl && entry.slotEl.isConnected) {
        const wrapEl = entry.slotEl.closest(WRAP_SELECTOR);
        if (wrapEl) {
          const rowEl = wrapEl.closest(ROW_SELECTOR) || wrapEl.parentElement || wrapEl;
          const bubbleEl = entry.slotEl.closest("[data-msg-id]") || findBubbleEl(wrapEl, candidateIds);
          return { rowEl, wrapEl, bubbleEl };
        }
      }
      if (entry && entry.domMsgId && !candidateIds.includes(entry.domMsgId)) {
        candidateIds.unshift(entry.domMsgId);
      }
      const rowEl = findRowByIds(candidateIds);
      if (!rowEl) return null;
      const wrapEl = findWrapInRow(rowEl, candidateIds);
      if (!wrapEl) return null;
      return { rowEl, wrapEl, bubbleEl: findBubbleEl(wrapEl, candidateIds) };
    }

    // ── 6. 引用块避让 ──
    function collectQuoteEls(rootEl, excludeEl) {
      const out = [];
      if (!rootEl || !rootEl.querySelectorAll) return out;
      QUOTE_SELECTORS.forEach((sel) => {
        let list = [];
        try { list = rootEl.querySelectorAll(sel); } catch (e) { list = []; }
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          if (!el || el === excludeEl) continue;
          if (out.indexOf(el) < 0) out.push(el);
        }
      });
      return out;
    }

    function reflowOutsideContainer(nodes, outEl) {
      if (!outEl || !outEl.isConnected || !nodes) return;
      const { rowEl, bubbleEl } = nodes;
      const root = (rowEl && rowEl.isConnected) ? rowEl : null;
      if (!root) return;

      const curMargin = parseFloat(outEl.style.marginTop) || 0;
      const outRect = outEl.getBoundingClientRect();

      let bubbleBottom = null;
      if (bubbleEl && bubbleEl.isConnected && root.contains(bubbleEl)) {
        const br = bubbleEl.getBoundingClientRect();
        if (br.height > 0 && br.width > 0) bubbleBottom = br.bottom;
      }

      let quoteBottom = null;
      const quotes = collectQuoteEls(root, outEl);
      for (let i = 0; i < quotes.length; i++) {
        const q = quotes[i];
        if (!q.isConnected) continue;
        if (bubbleEl && bubbleEl.contains(q)) continue;
        const qr = q.getBoundingClientRect();
        if (qr.height <= 0 || qr.width <= 0) continue;
        quoteBottom = quoteBottom === null ? qr.bottom : Math.max(quoteBottom, qr.bottom);
      }

      if (quoteBottom === null) {
        if (curMargin !== 0) outEl.style.marginTop = "";
        return;
      }

      const targetBottom = bubbleBottom === null ? quoteBottom : Math.max(bubbleBottom, quoteBottom);

      let naturalTop = null;
      if (outRect.height > 0) naturalTop = outRect.top - curMargin;
      else if (bubbleBottom !== null) naturalTop = bubbleBottom;
      if (naturalTop === null) return;

      const need = Math.ceil(targetBottom - naturalTop + QUOTE_GAP);
      const next = need > 0 ? need : 0;
      if (Math.abs(curMargin - next) > 0.5) {
        outEl.style.marginTop = next > 0 ? `${next}px` : "";
      }
    }

    function reflowForMsg(msgId) {
      if (!msgId) return;
      let outEl = null;
      try {
        outEl = document.querySelector(`.er-outside-container[data-er-msg-id="${CSS.escape(msgId)}"]`);
      } catch (e) { outEl = null; }
      if (!outEl || !outEl.isConnected || !outEl.firstChild) return;
      const nodes = resolveMessageNodes(msgId);
      try { reflowOutsideContainer(nodes, outEl); } catch (e) {}
    }

    function getReflowObserver() {
      if (typeof ResizeObserver === "undefined") return null;
      if (reflowObserver) return reflowObserver;
      reflowObserver = new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const el = entries[i].target;
          if (!el || !el.isConnected) continue;
          const ids = el.dataset ? Array.from(el.querySelectorAll(".er-outside-container")) : [];
          for (let j = 0; j < ids.length; j++) {
            const id = ids[j] && ids[j].dataset ? ids[j].dataset.erMsgId : "";
            if (id) pendingReflowIds.add(id);
          }
          if (el.classList && el.classList.contains("er-outside-container")) {
            const id = el.dataset ? el.dataset.erMsgId : "";
            if (id) pendingReflowIds.add(id);
          }
        }
        if (!pendingReflowIds.size || reflowRafPending) return;
        reflowRafPending = true;
        const flush = () => {
          reflowRafPending = false;
          const ids = Array.from(pendingReflowIds);
          pendingReflowIds.clear();
          ids.forEach(reflowForMsg);
        };
        if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(flush);
        else flush();
      });
      return reflowObserver;
    }

    function observeReflow(nodes) {
      const ro = getReflowObserver();
      if (!ro || !nodes) return;
      [nodes.rowEl, nodes.wrapEl].forEach((el) => {
        if (!el || !el.isConnected || observedReflowTargets.has(el)) return;
        observedReflowTargets.add(el);
        try { ro.observe(el); } catch (e) {}
      });
    }

    function scheduleReflow(nodes, outEl) {
      const run = () => {
        if (!outEl || !outEl.isConnected || !outEl.firstChild) return;
        try { reflowOutsideContainer(resolveMessageNodes(outEl.dataset.erMsgId) || nodes, outEl); } catch (e) {}
      };
      run();
      if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(run);
      ctx.system.timers.setTimeout(run, 140);
    }

    // ── 7. 记录读写与同批次安全迁移 ──
    function getExistingRecord(msg, sessionId) {
      const realId = getRealMsgId(msg);
      if (!realId) return null;
      const rec = store.byMsgId[realId];
      if (!rec) return null;
      const sid = msg?.sessionId || sessionId || currentSessionId || "";
      if (sid && rec.sessionId !== sid) {
        rec.sessionId = sid;
      }
      const clean = normalizeText(messageText(msg));
      if (clean && rec.textSnap !== clean) rec.textSnap = clean;
      if (rec.orphanedAt) delete rec.orphanedAt;
      return rec;
    }

    function ensureRecordForWrite(msg, sessionId) {
      const realId = getRealMsgId(msg);
      if (!realId) return null;
      const sid = msg?.sessionId || sessionId || currentSessionId || "";

      if (!store.byMsgId[realId]) tryMigrateOrphanReactions(msg, sid);

      const now = Date.now();
      if (!store.byMsgId[realId]) {
        store.byMsgId[realId] = {
          sessionId: sid,
          role: msg.role || "assistant",
          senderCharacterId: msg.senderCharacterId || "",
          senderName: msg.senderName || "",
          responseBatchId: msg.responseBatchId || "",
          responseRoundId: msg.responseRoundId || "",
          textSnap: normalizeText(messageText(msg)),
          createdAt: msg.createdAt || now,
          updatedAt: now,
          items: [],
        };
      } else {
        const rec = store.byMsgId[realId];
        if (sid) rec.sessionId = sid;
        if (msg.role) rec.role = msg.role;
        if (msg.senderCharacterId) rec.senderCharacterId = msg.senderCharacterId;
        if (msg.senderName) rec.senderName = msg.senderName;
        const clean = normalizeText(messageText(msg));
        if (clean) rec.textSnap = clean;
        rec.updatedAt = now;
        if (rec.orphanedAt) delete rec.orphanedAt;
      }
      return store.byMsgId[realId];
    }

    function cleanupEmptyRecord(msgId) {
      const rec = store.byMsgId[msgId];
      if (rec && (!Array.isArray(rec.items) || rec.items.length === 0)) delete store.byMsgId[msgId];
    }

    function tryMigrateOrphanReactions(targetMsg, sessionId) {
      if (!targetMsg) return;
      const targetId = getRealMsgId(targetMsg);
      const sid = targetMsg.sessionId || sessionId || currentSessionId;
      if (!targetId || !sid || store.byMsgId[targetId]) return;
      if (!targetMsg.responseBatchId && !targetMsg.responseRoundId) return;

      const currentMsgs = getSessionMessageList(sid);
      if (!currentMsgs.length) return;
      const aliveIds = new Set(currentMsgs.map((m) => getRealMsgId(m)).filter(Boolean));
      const targetText = normalizeText(messageText(targetMsg));

      const orphans = [];
      for (const [oldId, rec] of Object.entries(store.byMsgId)) {
        if (!rec || !Array.isArray(rec.items) || !rec.items.length) continue;
        if (rec.sessionId !== sid || aliveIds.has(oldId)) continue;
        if (rec.role && targetMsg.role && rec.role !== targetMsg.role) continue;
        const sameBatch =
          (targetMsg.responseBatchId && rec.responseBatchId === targetMsg.responseBatchId) ||
          (targetMsg.responseRoundId && rec.responseRoundId === targetMsg.responseRoundId);
        if (sameBatch) orphans.push({ oldId, rec });
      }
      if (!orphans.length) return;

      let matched = null;
      for (const item of orphans) {
        const oldSnap = item.rec.textSnap || "";
        if (oldSnap && targetText && oldSnap === targetText) { matched = item; break; }
        if (!oldSnap || !targetText || oldSnap.includes(targetText) || targetText.includes(oldSnap)) {
          matched = item;
          break;
        }
      }

      if (matched) {
        store.byMsgId[targetId] = {
          sessionId: sid,
          role: targetMsg.role || matched.rec.role,
          senderCharacterId: targetMsg.senderCharacterId || matched.rec.senderCharacterId || "",
          senderName: targetMsg.senderName || matched.rec.senderName || "",
          responseBatchId: targetMsg.responseBatchId || matched.rec.responseBatchId || "",
          responseRoundId: targetMsg.responseRoundId || matched.rec.responseRoundId || "",
          textSnap: targetText || matched.rec.textSnap,
          createdAt: targetMsg.createdAt || matched.rec.createdAt,
          updatedAt: Date.now(),
          items: [...matched.rec.items],
        };
        delete store.byMsgId[matched.oldId];
        if (Array.isArray(store.historyLog)) {
          store.historyLog.forEach((h) => {
            if (h && h.targetMsgId === matched.oldId) {
              h.targetMsgId = targetId;
              if (targetText) h.targetTextSnap = targetText;
            }
          });
        }
        saveStore();
      }
    }

    // ── 8. 回应增删（注意：Emoji 的 label 直接用符号本身，绝不带 `emoji:` 前缀以免误导模型） ──
    function normalizeReactionPayload(input) {
      if (typeof input === "string") {
        const clean = sanitizeEmojiToken(input);
        return { kind: "emoji", key: `emoji:${clean}`, emoji: clean, label: clean };
      }
      if (input && input.kind === "sticker") {
        const cleanName = sanitizePromptField(input.stickerName || "表情包", 32) || "表情包";
        return {
          kind: "sticker",
          key: input.stickerId ? `sticker:${input.stickerId}` : `stickerName:${cleanName}`,
          emoji: cleanName,
          stickerId: input.stickerId || "",
          stickerName: cleanName,
          assetId: input.assetId || "",
          externalUrl: input.externalUrl || "",
          label: `表情包:${cleanName}`,
        };
      }
      const clean = sanitizeEmojiToken(input?.emoji || "");
      return { kind: "emoji", key: `emoji:${clean}`, emoji: clean, label: clean };
    }

    function appendHistoryLog(entry) {
      if (!Array.isArray(store.historyLog)) store.historyLog = [];
      store.historyLog.push(entry);
      if (store.historyLog.length > 500) store.historyLog = store.historyLog.slice(-500);
    }

    function toggleReaction(msg, sessionId, rawPayload, actorInfo) {
      const payload = normalizeReactionPayload(rawPayload);
      const realId = getRealMsgId(msg);
      if (!payload.emoji || !realId) return;

      const sid = msg?.sessionId || sessionId || currentSessionId;
      const rec = ensureRecordForWrite(msg, sid);
      if (!rec) return;

      const actor = actorInfo || resolveActorInfo("user", true, "我", sid);
      const targetOwnerName = resolveMessageOwnerName(msg, sid);
      const targetSnap = rec.textSnap || normalizeText(messageText(msg)) || "[媒体消息]";
      const existingIdx = rec.items.findIndex(
        (it) => (it.key || `emoji:${it.emoji}`) === payload.key && it.actorId === actor.actorId
      );

      const now = Date.now();
      rec.updatedAt = now;
      if (existingIdx >= 0) {
        rec.items.splice(existingIdx, 1);
        appendHistoryLog({
          sessionId: sid, action: "unset",
          actorId: actor.actorId, actorName: actor.actorName, isUser: !!actor.isUser,
          targetMsgId: realId, targetOwnerName, targetTextSnap: targetSnap,
          kind: payload.kind, label: payload.label, key: payload.key, ts: now,
        });
        cleanupEmptyRecord(realId);
      } else {
        rec.items.push({
          key: payload.key, kind: payload.kind, emoji: payload.emoji,
          stickerId: payload.stickerId || "", stickerName: payload.stickerName || "",
          assetId: payload.assetId || "", externalUrl: payload.externalUrl || "",
          actorId: actor.actorId, actorName: actor.actorName, actorAvatar: actor.actorAvatar,
          isUser: !!actor.isUser, ts: now,
        });
        appendHistoryLog({
          sessionId: sid, action: "set",
          actorId: actor.actorId, actorName: actor.actorName, isUser: !!actor.isUser,
          targetMsgId: realId, targetOwnerName, targetTextSnap: targetSnap,
          kind: payload.kind, label: payload.label, key: payload.key, ts: now,
        });
      }

      saveStore();
      refreshMessageFooter(realId, msg, sid);
    }

    function addReactionIfNotExist(msg, sessionId, rawPayload, actorInfo) {
      const payload = normalizeReactionPayload(rawPayload);
      const realId = getRealMsgId(msg);
      if (!payload.emoji || !realId) return;

      const sid = msg?.sessionId || sessionId || currentSessionId;
      const rec = ensureRecordForWrite(msg, sid);
      if (!rec) return;

      const actor = actorInfo || resolveActorInfo("character", false, "角色", sid);
      const targetOwnerName = resolveMessageOwnerName(msg, sid);
      const targetSnap = rec.textSnap || normalizeText(messageText(msg)) || "[媒体消息]";
      const existingIdx = rec.items.findIndex(
        (it) => (it.key || `emoji:${it.emoji}`) === payload.key && it.actorId === actor.actorId
      );

      const now = Date.now();
      rec.updatedAt = now;
      if (existingIdx >= 0) {
        const item = rec.items.splice(existingIdx, 1)[0];
        item.ts = now;
        if (actor.actorAvatar) item.actorAvatar = actor.actorAvatar;
        if (actor.actorName) item.actorName = actor.actorName;
        rec.items.push(item);
      } else {
        rec.items.push({
          key: payload.key, kind: payload.kind, emoji: payload.emoji,
          stickerId: payload.stickerId || "", stickerName: payload.stickerName || "",
          assetId: payload.assetId || "", externalUrl: payload.externalUrl || "",
          actorId: actor.actorId, actorName: actor.actorName, actorAvatar: actor.actorAvatar,
          isUser: !!actor.isUser, ts: now,
        });
        appendHistoryLog({
          sessionId: sid, action: "set",
          actorId: actor.actorId, actorName: actor.actorName, isUser: !!actor.isUser,
          targetMsgId: realId, targetOwnerName, targetTextSnap: targetSnap,
          kind: payload.kind, label: payload.label, key: payload.key, ts: now,
        });
      }

      saveStore();
      refreshMessageFooter(realId, msg, sid);
    }

    function removeActorReactionInSession(sessionId, rawTargetToken, actorInfo, targetMsgId) {
      const sid = sessionId || currentSessionId;
      if (!sid || !actorInfo) return;
      let token = String(rawTargetToken || "").trim();
      token = token.replace(/^emoji[:：]\s*/i, "").trim();
      if (!token) return;

      const isAll = isAllToken(token);
      const parsedStickerName = parseStickerTokenName(token);
      const targetName = parsedStickerName !== null ? parsedStickerName : token;

      const candidates = [];
      for (const [msgId, rec] of Object.entries(store.byMsgId)) {
        if (!rec || rec.sessionId !== sid || !Array.isArray(rec.items)) continue;
        if (targetMsgId && msgId !== targetMsgId) continue;
        rec.items.forEach((it) => {
          const isSameActor = it.actorId === actorInfo.actorId || (!it.isUser && it.actorName === actorInfo.actorName);
          if (!isSameActor) return;
          const matched =
            isAll ||
            it.emoji === targetName ||
            it.stickerName === targetName ||
            it.key === `emoji:${targetName}` ||
            it.key === `stickerName:${targetName}`;
          if (matched) candidates.push({ msgId, rec, it, ts: it.ts || 0 });
        });
      }

      if (!candidates.length) return;
      candidates.sort((a, b) => b.ts - a.ts);
      const toRemove = isAll ? candidates : [candidates[0]];
      const affectedMsgIds = new Set();
      const now = Date.now();

      toRemove.forEach(({ msgId, rec, it }) => {
        const currentIdx = rec.items.indexOf(it);
        if (currentIdx < 0) return;
        rec.items.splice(currentIdx, 1);
        rec.updatedAt = now;
        affectedMsgIds.add(msgId);

        const targetOwnerName =
          rec.role === "user"
            ? resolveActorInfo("user", true, "用户", sid).actorName
            : rec.senderName ||
              (rec.senderCharacterId ? resolveActorInfo(rec.senderCharacterId, false, "角色", sid).actorName : "角色");
        const label = it.kind === "sticker" ? `表情包:${it.stickerName || it.emoji}` : `${it.emoji}`;

        appendHistoryLog({
          sessionId: sid, action: "unset",
          actorId: actorInfo.actorId, actorName: actorInfo.actorName, isUser: false,
          targetMsgId: msgId, targetOwnerName, targetTextSnap: rec.textSnap || "[消息]",
          kind: it.kind || "emoji", label, key: it.key || `emoji:${it.emoji}`, ts: now,
        });

        cleanupEmptyRecord(msgId);
      });

      if (affectedMsgIds.size > 0) {
        saveStore();
        affectedMsgIds.forEach((id) => refreshMessageFooter(id));
      }
    }

    // ── 9. 选表情弹窗 ──
    function openCustomEmojiModal(msg, sessionId) {
      const sid = msg?.sessionId || sessionId || currentSessionId;
      const presets = getPresets();
      const extraEmojis = [
        "😊", "🥰", "😘", "🤔", "😭", "😡", "🥳", "🤩", "🙄", "😴", "👻", "✨",
        "🤍", "💔", "💯", "👏", "🙌", "🤝", "🥹", "🤭", "😶", "😏", "😅", "😮‍💨",
      ];
      const mergedList = Array.from(new Set([...presets, ...extraEmojis]));

      ctx.ui.openModal((el, { close }) => {
        el.style.width = "min(380px, 92vw)";
        el.style.borderRadius = "12px";

        const box = document.createElement("div");
        box.className = "er-modal-box";
        box.innerHTML = `
          <div class="er-modal-tabs">
            <button type="button" class="er-modal-tab er-tab-active" data-tab="emoji">Emoji 表情</button>
            <button type="button" class="er-modal-tab" data-tab="sticker">我的表情包</button>
          </div>
          <div class="er-tab-pane-emoji">
            <div class="er-modal-input-row">
              <input class="er-modal-input" type="text" placeholder="输入任意 Emoji，如 🙂" maxlength="16" />
              <button class="er-modal-submit" type="button">确定</button>
            </div>
            <div class="er-modal-grid"></div>
          </div>
          <div class="er-tab-pane-sticker" style="display:none;">
            <div class="er-pack-bar"></div>
            <div class="er-sticker-grid"></div>
          </div>
        `;

        const tabBtns = box.querySelectorAll(".er-modal-tab");
        const emojiPane = box.querySelector(".er-tab-pane-emoji");
        const stickerPane = box.querySelector(".er-tab-pane-sticker");
        const input = box.querySelector(".er-modal-input");
        const submitBtn = box.querySelector(".er-modal-submit");
        const emojiGrid = box.querySelector(".er-modal-grid");
        const packBar = box.querySelector(".er-pack-bar");
        const stickerGrid = box.querySelector(".er-sticker-grid");

        const handlePickEmoji = (val) => {
          const clean = sanitizeEmojiToken(val);
          if (!clean || !isEmojiOnly(clean)) return;
          toggleReaction(msg, sid, { kind: "emoji", emoji: clean }, resolveActorInfo("user", true, "我", sid));
          close();
        };

        const handlePickSticker = (sticker) => {
          if (!sticker) return;
          toggleReaction(msg, sid, {
            kind: "sticker",
            stickerId: sticker.id,
            stickerName: sticker.name,
            assetId: sticker.assetId || "",
            externalUrl: sticker.externalUrl || "",
          }, resolveActorInfo("user", true, "我", sid));
          close();
        };

        submitBtn.addEventListener("click", () => handlePickEmoji(input.value));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); handlePickEmoji(input.value); }
        });

        mergedList.forEach((emo) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "er-modal-grid-btn";
          btn.textContent = emo;
          btn.addEventListener("click", () => handlePickEmoji(emo));
          emojiGrid.appendChild(btn);
        });

        let activePackId = null;
        function renderStickerTab() {
          const packs = getHostStickerPacks(sid);
          packBar.innerHTML = "";
          stickerGrid.innerHTML = "";

          if (!packs.length) {
            stickerGrid.innerHTML = `<div class="er-sticker-empty">暂无上传的表情包，可在聊天设置 → 表情包管理中上传</div>`;
            return;
          }

          if (!activePackId || !packs.some((p) => p.id === activePackId)) activePackId = packs[0].id;

          packs.forEach((pack) => {
            const pBtn = document.createElement("button");
            pBtn.type = "button";
            pBtn.className = `er-pack-pill${pack.id === activePackId ? " er-active" : ""}`;
            pBtn.textContent = pack.name || "图集";
            pBtn.addEventListener("click", () => { activePackId = pack.id; renderStickerTab(); });
            packBar.appendChild(pBtn);
          });

          const curPack = packs.find((p) => p.id === activePackId) || packs[0];
          (curPack.stickers || []).forEach((sticker) => {
            const sBtn = document.createElement("button");
            sBtn.type = "button";
            sBtn.className = "er-sticker-btn";
            sBtn.title = sticker.name || "";

            const img = document.createElement("img");
            img.alt = sticker.name || "sticker";
            const initialUrl = getStickerImageUrl(sticker, (resolvedUrl) => {
              if (img.isConnected) img.src = resolvedUrl;
            });
            if (initialUrl) img.src = initialUrl;

            const label = document.createElement("span");
            label.textContent = sticker.name || "";

            sBtn.appendChild(img);
            sBtn.appendChild(label);
            sBtn.addEventListener("click", () => handlePickSticker(sticker));
            stickerGrid.appendChild(sBtn);
          });
        }

        tabBtns.forEach((btn) => {
          btn.addEventListener("click", () => {
            const tab = btn.dataset.tab;
            tabBtns.forEach((b) => b.classList.toggle("er-tab-active", b.dataset.tab === tab));
            if (tab === "sticker") {
              emojiPane.style.display = "none";
              stickerPane.style.display = "block";
              syncKvFromIndexedDB(() => renderStickerTab());
              renderStickerTab();
            } else {
              stickerPane.style.display = "none";
              emojiPane.style.display = "block";
            }
          });
        });

        el.appendChild(box);
      });
    }

    // ── 10. 气泡外挂载 / 防拉长 ──
    function patchBubbleAlign(bubbleEl, isUserMsg) {
      if (!bubbleEl || !bubbleEl.style) return;
      if (!patchedBubbleAlign.has(bubbleEl)) patchedBubbleAlign.set(bubbleEl, bubbleEl.style.alignSelf || "");
      bubbleEl.style.alignSelf = isUserMsg ? "flex-end" : "flex-start";
    }

    function restoreBubbleAlign(bubbleEl) {
      if (!bubbleEl || !patchedBubbleAlign.has(bubbleEl)) return;
      try { bubbleEl.style.alignSelf = patchedBubbleAlign.get(bubbleEl) || ""; } catch (e) {}
      patchedBubbleAlign.delete(bubbleEl);
    }

    function removeOutsideContainer(msgId) {
      if (!msgId) return;
      const entry = footerSlotMap.get(msgId);
      if (entry && entry.outEl && entry.outEl.isConnected) entry.outEl.remove();
      if (typeof document !== "undefined") {
        try {
          document.querySelectorAll(`.er-outside-container[data-er-msg-id="${CSS.escape(msgId)}"]`).forEach((el) => el.remove());
        } catch (e) {}
      }
    }

    function ensureOutsideContainer(realId, isUserMsg, slotEl, message) {
      const nodes = resolveMessageNodes(realId, slotEl, message);
      if (!nodes) return null;
      const { wrapEl, bubbleEl } = nodes;

      if (bubbleEl && bubbleEl.parentElement === wrapEl) patchBubbleAlign(bubbleEl, isUserMsg);

      let outEl = null;
      try {
        outEl = wrapEl.querySelector(`:scope > .er-outside-container[data-er-msg-id="${CSS.escape(realId)}"]`);
      } catch (e) { outEl = null; }
      if (!outEl) {
        outEl = document.createElement("div");
        outEl.className = "er-outside-container";
        outEl.dataset.erMsgId = realId;
        outEl.addEventListener("pointerdown", (e) => e.stopPropagation());
        const footerContainer = wrapEl.querySelector(":scope > .chat-plugin-message-footer");
        if (footerContainer && footerContainer.parentElement === wrapEl) {
          wrapEl.insertBefore(outEl, footerContainer);
        } else {
          wrapEl.appendChild(outEl);
        }
      }
      outEl.className = `er-outside-container ${isUserMsg ? "er-align-right" : "er-align-left"}`;
      return outEl;
    }

    function cancelRetryTimer(msgId) {
      const cancel = retryTimers.get(msgId);
      if (cancel) {
        try { if (typeof cancel === "function") cancel(); } catch (e) {}
        retryTimers.delete(msgId);
      }
    }

    function scheduleRetry(msgId, sessionId, message, delay, attempt = 1) {
      if (!msgId || retryTimers.has(msgId) || attempt > 4) return;
      const cancel = ctx.system.timers.setTimeout(() => {
        retryTimers.delete(msgId);
        const rec = store.byMsgId[msgId];
        if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) return;
        const outEl = document.querySelector(`.er-outside-container[data-er-msg-id="${CSS.escape(msgId)}"]`);
        if (outEl && outEl.isConnected && outEl.firstChild) return;
        const entry = footerSlotMap.get(msgId);
        renderReactionDOM(entry?.slotEl || null, sessionId, message || entry?.message || { id: msgId, role: rec.role, sessionId }, attempt);
      }, delay || 100);
      retryTimers.set(msgId, cancel);
    }

    function renderReactionDOM(slotEl, sessionId, message, attempt = 0) {
      try {
        return renderReactionDOMInner(slotEl, sessionId, message, attempt);
      } catch (e) {
        dbg("render fail: " + (e && e.message));
        return undefined;
      }
    }

    function renderReactionDOMInner(slotEl, sessionId, message, attempt = 0) {
      const realId = getRealMsgId(message);
      if (!realId) return;

      const sid = message?.sessionId || sessionId || currentSessionId;
      const rec = getExistingRecord(message, sid);
      const items = rec && Array.isArray(rec.items) ? rec.items : [];

      if (!items.length || message?.isRetracted) {
        cancelRetryTimer(realId);
        const entry = footerSlotMap.get(realId);
        if (entry) entry.outEl = null;
        removeOutsideContainer(realId);
        const nodes = resolveMessageNodes(realId, slotEl, message);
        if (nodes && nodes.bubbleEl) restoreBubbleAlign(nodes.bubbleEl);
        return;
      }

      const isUserMsg = (message?.role || rec?.role) === "user";
      const outEl = ensureOutsideContainer(realId, isUserMsg, slotEl, message);
      if (!outEl) {
        const entry = footerSlotMap.get(realId);
        if (entry) entry.outEl = null;
        scheduleRetry(realId, sid, message, 120 * (attempt + 1), attempt + 1);
        return;
      }

      cancelRetryTimer(realId);
      const entry = footerSlotMap.get(realId);
      if (entry) {
        if (slotEl && slotEl.isConnected) entry.slotEl = slotEl;
        entry.outEl = outEl;
        if (sid) entry.sessionId = sid;
        if (message) {
          entry.message = message;
          if (message.id) entry.domMsgId = message.id;
        }
      } else {
        footerSlotMap.set(realId, {
          slotEl: (slotEl && slotEl.isConnected) ? slotEl : null,
          outEl,
          sessionId: sid,
          message,
          domMsgId: message?.id || realId,
        });
      }

      outEl.innerHTML = "";

      const isGroup = checkIsGroupSession(sid);
      const groupMap = new Map();
      for (const item of items) {
        if (!item || !item.emoji) continue;
        const k = item.key || `emoji:${item.emoji}`;
        if (!groupMap.has(k)) groupMap.set(k, []);
        groupMap.get(k).push(item);
      }

      for (const [, actors] of groupMap.entries()) {
        actors.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const sample = actors[0];

        const pill = document.createElement("button");
        pill.type = "button";
        const hasMine = actors.some((a) => a.isUser || a.actorId === "user");
        pill.className = `er-pill${hasMine ? " er-pill-mine" : ""}`;

        if (isGroup) {
          const stack = document.createElement("span");
          stack.className = "er-avatar-stack";
          actors.forEach((actor, idx) => {
            const resolved = resolveActorInfo(actor.actorId, actor.isUser, actor.actorName, sid);
            const avUrl = resolved.actorAvatar || (isSafeImageUrl(actor.actorAvatar) ? actor.actorAvatar : "");
            const avName = resolved.actorName || actor.actorName || "友";

            const avSpan = document.createElement("span");
            const hasNext = idx < actors.length - 1;
            avSpan.className = `er-avatar-item${hasNext ? " er-avatar-cut-right" : ""}`;
            avSpan.style.zIndex = String(idx + 1);

            if (avUrl) {
              const img = document.createElement("img");
              img.src = avUrl;
              img.alt = avName;
              img.onerror = () => {
                avSpan.innerHTML = "";
                avSpan.textContent = String(avName).slice(0, 1);
              };
              avSpan.appendChild(img);
            } else {
              avSpan.textContent = String(avName).slice(0, 1);
            }
            stack.appendChild(avSpan);
          });
          pill.appendChild(stack);
        }

        if (sample.kind === "sticker") {
          const stickerObj = sample.assetId || sample.externalUrl
            ? { id: sample.stickerId, name: sample.stickerName || sample.emoji, assetId: sample.assetId, externalUrl: sample.externalUrl }
            : findStickerItem(sample.stickerId || sample.stickerName || sample.emoji, sid);

          const img = document.createElement("img");
          img.className = "er-pill-sticker-img";
          img.alt = sample.stickerName || sample.emoji || "表情包";
          const url = getStickerImageUrl(stickerObj, (resolvedUrl) => {
            if (img.isConnected) img.src = resolvedUrl;
          });
          if (url) {
            img.src = url;
            pill.appendChild(img);
          } else {
            const fallbackSpan = document.createElement("span");
            fallbackSpan.className = "er-pill-emoji";
            fallbackSpan.style.fontSize = "11px";
            fallbackSpan.textContent = `[${sample.stickerName || sample.emoji}]`;
            pill.appendChild(fallbackSpan);
          }
        } else {
          const emojiSpan = document.createElement("span");
          emojiSpan.className = "er-pill-emoji";
          emojiSpan.textContent = sample.emoji;
          pill.appendChild(emojiSpan);
        }

        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleReaction(
            message, sid,
            sample.kind === "sticker"
              ? { kind: "sticker", stickerId: sample.stickerId, stickerName: sample.stickerName || sample.emoji, assetId: sample.assetId, externalUrl: sample.externalUrl }
              : { kind: "emoji", emoji: sample.emoji },
            resolveActorInfo("user", true, "我", sid)
          );
        });

        outEl.appendChild(pill);
      }

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "er-add-btn";
      addBtn.title = "选择 Emoji 或表情包回应";
      addBtn.innerHTML = getSmileSvg();
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCustomEmojiModal(message, sid);
      });
      outEl.appendChild(addBtn);

      const nodesAfter = resolveMessageNodes(realId, slotEl, message);
      if (nodesAfter) {
        if (nodesAfter.bubbleEl && nodesAfter.bubbleEl.parentElement === nodesAfter.wrapEl) {
          patchBubbleAlign(nodesAfter.bubbleEl, isUserMsg);
        }
        observeReflow(nodesAfter);
        scheduleReflow(nodesAfter, outEl);
      }
    }

    function refreshMessageFooter(msgId, fallbackMsg, fallbackSid) {
      const entry = footerSlotMap.get(msgId);
      const rec = store.byMsgId[msgId];
      const sid = fallbackMsg?.sessionId || fallbackSid || entry?.sessionId || rec?.sessionId || currentSessionId;
      let msg = fallbackMsg || entry?.message;
      if (!msg && sid) {
        const list = getSessionMessageList(sid);
        msg = list.find((m) => getRealMsgId(m) === msgId) || (rec ? { id: msgId, role: rec.role, sessionId: sid } : null);
      }
      if (msg) renderReactionDOM(entry?.slotEl || null, sid, msg);
    }

    function refreshAllFooters() {
      const renderedIds = new Set();
      for (const [msgId, entry] of Array.from(footerSlotMap.entries())) {
        if (!entry) { footerSlotMap.delete(msgId); continue; }
        const slotConnected = entry.slotEl && entry.slotEl.isConnected;
        const outConnected = entry.outEl && entry.outEl.isConnected;
        if (slotConnected) {
          const sid = entry.message?.sessionId || entry.sessionId || currentSessionId;
          entry.sessionId = sid;
          renderedIds.add(msgId);
          renderReactionDOM(entry.slotEl, sid, entry.message);
        } else if (!outConnected && entry.sessionId && currentSessionId && entry.sessionId !== currentSessionId) {
          removeOutsideContainer(msgId);
          footerSlotMap.delete(msgId);
        }
      }

      if (currentSessionId) {
        for (const [msgId, rec] of Object.entries(store.byMsgId)) {
          if (renderedIds.has(msgId)) continue;
          if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) continue;
          if (!rec.sessionId || rec.sessionId === currentSessionId) {
            refreshMessageFooter(msgId, null, currentSessionId);
          }
        }
      }
    }

    ctx.ui.slot("message.footer", (slotEl, props) => {
      if (!props || !props.message) return;
      slotEl.style.display = "none";
      const msg = props.message;
      const realId = getRealMsgId(msg);
      if (!realId) return;
      const sid = props.sessionId || msg.sessionId || currentSessionId;
      if (sid && currentSessionId !== sid) {
        currentSessionId = sid;
      }

      const prev = footerSlotMap.get(realId);
      footerSlotMap.set(realId, {
        slotEl,
        outEl: prev?.outEl || null,
        sessionId: sid,
        message: msg,
        domMsgId: msg.id || realId,
      });

      queueMicrotask(() => {
        if (!slotEl.isConnected) return;
        renderReactionDOM(slotEl, sid, msg);
      });

      return () => {
        const cur = footerSlotMap.get(realId);
        if (!cur || cur.slotEl === slotEl) {
          removeOutsideContainer(realId);
          footerSlotMap.delete(realId);
        }
      };
    });

    // ── 11. 长按菜单顶部滑动栏 ──
    ctx.ui.messageAction({
      id: "emoji-reaction-action",
      label: ACTION_LABEL,
      filter: (msg) => {
        if (msg && msg.id) lastContextMsg = msg;
        return true;
      },
      onSelect: (msg) => {
        const target = msg || lastContextMsg;
        if (target) openCustomEmojiModal(target, target.sessionId || currentSessionId);
      },
    });

    let menuObserver = null;
    let menuInjectPending = false;
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
      menuObserver = new MutationObserver((mutations) => {
        if (menuInjectPending || !lastContextMsg) return;
        let hasMenuAdded = false;
        for (let i = 0; i < mutations.length; i++) {
          const added = mutations[i].addedNodes;
          for (let j = 0; j < added.length; j++) {
            const node = added[j];
            if (node && node.nodeType === 1) {
              if (node.classList?.contains("ctx-menu") || (node.querySelector && node.querySelector(".ctx-menu"))) {
                hasMenuAdded = true;
                break;
              }
            }
          }
          if (hasMenuAdded) break;
        }
        if (!hasMenuAdded) return;
        menuInjectPending = true;
        queueMicrotask(() => {
          menuInjectPending = false;
          try { injectPresetBarIntoContextMenu(); } catch (e) {}
        });
      });
      menuObserver.observe(document.body, { childList: true, subtree: true });
    }

    function injectPresetBarIntoContextMenu() {
      if (!lastContextMsg) return;
      const menus = document.querySelectorAll(".ctx-menu.chat-floating-ctx-menu, .ctx-menu");
      for (let i = 0; i < menus.length; i++) {
        const menuEl = menus[i];
        if (!menuEl || menuEl.querySelector(".er-menu-preset-bar")) continue;

        const buttons = menuEl.querySelectorAll("button.ctx-menu-btn");
        let actionBtn = null;
        buttons.forEach((b) => {
          if ((b.textContent || "").trim() === ACTION_LABEL) actionBtn = b;
        });
        if (!actionBtn) continue;

        const pluginRow = actionBtn.parentElement;
        if (pluginRow && pluginRow.children.length === 1) {
          pluginRow.style.display = "none";
        } else {
          actionBtn.style.display = "none";
        }

        const bar = document.createElement("er-menu-bar");
        bar.className = "er-menu-preset-bar";
        bar.addEventListener("pointerdown", (e) => e.stopPropagation());

        const presets = getPresets();
        const targetMsg = lastContextMsg;
        const sid = targetMsg.sessionId || currentSessionId;

        presets.forEach((emo) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "er-menu-emoji-item";
          btn.textContent = emo;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            closeHostContextMenu();
            toggleReaction(targetMsg, sid, { kind: "emoji", emoji: emo }, resolveActorInfo("user", true, "我", sid));
          });
          bar.appendChild(btn);
        });

        if (ctx.system.settings.get("showStickersInMenu") !== false) {
          const packs = getHostStickerPacks(sid);
          const flatStickers = [];
          for (const p of packs) {
            for (const s of p.stickers || []) {
              flatStickers.push(s);
              if (flatStickers.length >= 12) break;
            }
            if (flatStickers.length >= 12) break;
          }
          flatStickers.forEach((sticker) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "er-menu-emoji-item";
            btn.title = sticker.name || "";
            const img = document.createElement("img");
            img.alt = sticker.name || "";
            const url = getStickerImageUrl(sticker, (resolvedUrl) => {
              if (img.isConnected) img.src = resolvedUrl;
            });
            if (url) img.src = url;
            btn.appendChild(img);
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              e.preventDefault();
              closeHostContextMenu();
              toggleReaction(
                targetMsg,
                sid,
                {
                  kind: "sticker",
                  stickerId: sticker.id,
                  stickerName: sticker.name,
                  assetId: sticker.assetId || "",
                  externalUrl: sticker.externalUrl || "",
                },
                resolveActorInfo("user", true, "我", sid)
              );
            });
            bar.appendChild(btn);
          });
        }

        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "er-menu-emoji-item";
        moreBtn.title = "更多 Emoji 与表情包";
        moreBtn.innerHTML = getSmileSvg();
        moreBtn.querySelector("svg").style.cssText = "width:16px;height:16px;color:#fff;opacity:0.85;";
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          closeHostContextMenu();
          openCustomEmojiModal(targetMsg, sid);
        });
        bar.appendChild(moreBtn);

        menuEl.insertBefore(bar, menuEl.firstChild);
        break;
      }
    }

    function closeHostContextMenu() {
      try {
        const bodyEl = document.querySelector(".chat-room-wrapper > .page-body");
        if (bodyEl) bodyEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      } catch (e) {}
    }

    // ── 12. 指令解析：支持 `:原句`，并智能纠正模型误写的 `emoji:表情包名` ──
    function unwrapOuterQuotes(str) {
      let s = String(str || "").trim();
      const pairs = [["「", "」"], ["『", "』"], ["“", "”"], ["《", "》"], ["【", "】"], ['"', '"'], ["'", "'"]];
      for (let k = 0; k < pairs.length; k++) {
        const [open, close] = pairs[k];
        if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
          return s.slice(open.length, s.length - close.length).trim();
        }
      }
      return s;
    }

    function splitThemeAndQuote(seg) {
      let s = String(seg || "").trim();
      if (!s) return { theme: "", quote: "" };

      // 0. 若模型误加了 `emoji:` 前缀（如 `emoji:❤️:原句` 或 `emoji:好耶！:原句`），先剥掉 `emoji:`
      if (/^emoji[:：]/i.test(s)) {
        s = s.replace(/^emoji[:：]\s*/i, "").trim();
      }

      // 1. 优先识别 `表情包:名称:原句` 或 `sticker:名称:原句`
      const stkColonMatch = s.match(/^(?:表情包|sticker)[:：]\s*([^:：]+?)[:：]\s*(.+)$/i);
      if (stkColonMatch) {
        const stkName = stkColonMatch[1].trim();
        const quote = unwrapOuterQuotes(stkColonMatch[2]);
        return { theme: `表情包:${stkName}`, quote };
      }

      // 2. 识别 `❤️:原句` 或 `表情包名:原句`（排除纯 `表情包:名称` 且没有第2个冒号的情况）
      const isStickerPrefixOnly = /^(?:表情包|sticker)[:：][^:：]+$/i.test(s);
      if (!isStickerPrefixOnly) {
        const colonIdx = s.search(/[:：]/);
        if (colonIdx > 0) {
          const head = s.slice(0, colonIdx).trim();
          const tail = unwrapOuterQuotes(s.slice(colonIdx + 1));
          if (head && tail) {
            return { theme: head, quote: tail };
          }
        }
      }

      // 3. 兼容括号/引号包裹写法
      const pairs = [["「", "」"], ["『", "』"], ["“", "”"], ["《", "》"], ["【", "】"], ['"', '"'], ["'", "'"]];
      for (let k = 0; k < pairs.length; k++) {
        const open = pairs[k][0];
        const close = pairs[k][1];
        const a = s.indexOf(open);
        if (a < 0) continue;
        const b = s.indexOf(close, a + 1);
        if (b <= a) continue;
        const quote = s.slice(a + 1, b).trim();
        if (!quote) continue;
        const theme = (s.slice(0, a) + " " + s.slice(b + 1)).replace(/\s+/g, " ").trim();
        return { theme, quote };
      }

      // 4. 兜底：空格分隔 `❤️ 原句`
      const m = s.match(/^(\S+)\s+([\s\S]+)$/);
      if (m) {
        const head = m[1];
        const tail = m[2].trim();
        const tailIsSticker = /^表情包[:：]/.test(tail) || /^sticker[:：]/i.test(tail);
        if (tail && !tailIsSticker && !isEmojiOnly(tail)) {
          return { theme: head, quote: unwrapOuterQuotes(tail) };
        }
      }
      return { theme: s, quote: "" };
    }

    function parseReactionItems(rawStr) {
      const clean = String(rawStr || "").trim();
      if (!clean) return [];
      const items = [];

      const pushThemes = (themePart, quote) => {
        let part = String(themePart || "").trim();
        const q = String(quote || "").trim();
        if (!part) return;
        if (/^emoji[:：]/i.test(part)) {
          part = part.replace(/^emoji[:：]\s*/i, "").trim();
        }
        if (/^表情包[:：]/.test(part) || /^sticker[:：]/i.test(part)) {
          items.push({ theme: part, quote: q });
          return;
        }
        const words = part.split(/\s+/).filter(Boolean);
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          const isPrefixOnly = /^表情包[:：]$/.test(w) || /^sticker[:：]$/i.test(w);
          if (isPrefixOnly && i + 1 < words.length) {
            items.push({ theme: `${w}${words[i + 1]}`, quote: q });
            i++;
          } else {
            items.push({ theme: w, quote: q });
          }
        }
      };

      const commaParts = clean.split(/[,，;；]+/).map((x) => x.trim()).filter(Boolean);
      commaParts.forEach((seg) => {
        const split = splitThemeAndQuote(seg);
        pushThemes(split.theme, split.quote);
      });
      return items;
    }

    // 把 theme 解析成回应 payload 数组：
    // - 显式写 `表情包:名称` -> 查表情包库
    // - 未写 `表情包:` 但内容包含文字（非纯 Emoji）-> 自动去表情包库匹配名称，绝不把汉字当纯文本 Emoji 贴上去！
    function buildReactionPayloads(theme, sid) {
      const out = [];
      let cleanedTheme = String(theme || "").trim();
      if (/^emoji[:：]/i.test(cleanedTheme)) {
        cleanedTheme = cleanedTheme.replace(/^emoji[:：]\s*/i, "").trim();
      }
      if (!cleanedTheme) return out;

      const stkName = parseStickerTokenName(cleanedTheme);
      if (stkName !== null) {
        const found = findStickerItem(stkName, sid);
        if (found) {
          out.push({
            kind: "sticker",
            stickerId: found.id,
            stickerName: found.name,
            assetId: found.assetId || "",
            externalUrl: found.externalUrl || "",
          });
          return out;
        }
        const parts = stkName.split(/\s+/).filter(Boolean);
        if (parts.length > 1) {
          const firstHit = findStickerItem(parts[0], sid);
          if (firstHit) {
            out.push({
              kind: "sticker",
              stickerId: firstHit.id,
              stickerName: firstHit.name,
              assetId: firstHit.assetId || "",
              externalUrl: firstHit.externalUrl || "",
            });
            parts.slice(1).forEach((p) => {
              const safe = sanitizeEmojiToken(p);
              if (safe && isEmojiOnly(safe)) out.push({ kind: "emoji", emoji: safe });
            });
          }
        }
        return out;
      }

      // 智能纠错：如果模型没写 `表情包:` 前缀（或写了 `emoji:好耶！`），先看它是不是表情包库里的名字
      const matchedSticker = findStickerItem(cleanedTheme, sid);
      if (matchedSticker) {
        out.push({
          kind: "sticker",
          stickerId: matchedSticker.id,
          stickerName: matchedSticker.name,
          assetId: matchedSticker.assetId || "",
          externalUrl: matchedSticker.externalUrl || "",
        });
        return out;
      }

      // 只有真正是纯符号/Emoji（不含汉字、假名、字母、数字）才允许作为普通 Emoji 贴出
      const safe = sanitizeEmojiToken(cleanedTheme);
      if (safe && isEmojiOnly(safe)) {
        out.push({ kind: "emoji", emoji: safe });
      }
      return out;
    }

    // ── 13. 按引用原话定位消息气泡；重复时优先时间戳最新的 ──
    function findMessageByQuote(sid, quote, msgList) {
      const list = (msgList && msgList.length ? msgList : getSessionMessageList(sid)).filter(
        (m) => m && m.role !== "system" && !m.isRetracted
      );
      if (!list.length) return null;

      let rawQuote = unwrapOuterQuotes(quote);
      const prefixed = rawQuote.match(/^([^\s:：]{1,16})[:：]\s*([\s\S]+)$/);
      if (prefixed && prefixed[2] && prefixed[2].trim()) {
        const head = prefixed[1].trim();
        const known = list.some((m) => {
          if (!m || m.role === "user") return false;
          if (m.senderName && (m.senderName === head || m.senderName.includes(head))) return true;
          if (m.senderCharacterId) {
            try {
              const c = ctx.data.characters.get(m.senderCharacterId);
              if (c && c.name && (c.name === head || c.name.includes(head))) return true;
            } catch (e) {}
          }
          return false;
        });
        if (known) rawQuote = unwrapOuterQuotes(prefixed[2]);
      }

      const want = canonText(rawQuote);
      const wantLen = Array.from(want).length;
      if (!wantLen) return null;

      const start = Math.max(0, list.length - 200);
      const pool = [];
      for (let i = start; i < list.length; i++) pool.push({ m: list[i], i, ts: messageTs(list[i], i) });

      const newestPick = (arr) => {
        let best = null;
        for (const c of arr) {
          if (!best || c.ts > best.ts || (c.ts === best.ts && c.i > best.i)) best = c;
        }
        return best ? best.m : null;
      };

      // ① 完全相同
      const exact = pool.filter((c) => canonText(messageText(c.m)) === want);
      if (exact.length) return newestPick(exact);

      // ② 片段包含
      if (wantLen >= 2) {
        const contains = [];
        for (const c of pool) {
          const t = canonText(messageText(c.m));
          if (!t) continue;
          const tLen = Array.from(t).length;
          if (t.includes(want) || (want.includes(t) && tLen >= 4)) contains.push(c);
        }
        if (contains.length) return newestPick(contains);
      }

      // ③ 近似匹配（仅在最近 40 条内计算）
      if (wantLen >= 6) {
        const tailStart = Math.max(0, list.length - 40);
        const shortWant = Array.from(want).slice(0, 120).join("");
        const fuzzy = [];
        for (let i = tailStart; i < list.length; i++) {
          const m = list[i];
          if (!m || m.role === "system") continue;
          const t = Array.from(canonText(messageText(m))).slice(0, 400).join("");
          if (!t) continue;
          const lcs = longestCommonSubstrLen(shortWant, t);
          if (lcs / wantLen >= 0.6) fuzzy.push({ m, i, ts: messageTs(m, i) });
        }
        if (fuzzy.length) return newestPick(fuzzy);
      }

      return null;
    }

    // ── 14. 提示词组装（不重复罗列表情包；严格区分 Emoji 符号与 `表情包:名称` 格式） ──
    function buildReactionPromptBlock(sessionId) {
      const rawLimit = Number(ctx.system.settings.get("promptHistoryLimit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, Math.floor(rawLimit)) : 5;

      const allSessionMsgs = getSessionMessageList(sessionId);
      const aliveMsgIds = new Set();
      for (let i = 0; i < allSessionMsgs.length; i++) {
        const m = allSessionMsgs[i];
        if (!m || m.isRetracted) continue;
        const rid = getRealMsgId(m);
        if (rid) aliveMsgIds.add(rid);
        if (m.id) aliveMsgIds.add(m.id);
      }

      let storeCleaned = false;
      for (const [msgId, rec] of Object.entries(store.byMsgId)) {
        if (!rec || rec.sessionId !== sessionId) continue;
        if (!aliveMsgIds.has(msgId)) {
          delete store.byMsgId[msgId];
          storeCleaned = true;
        }
      }
      if (Array.isArray(store.historyLog) && store.historyLog.length > 0) {
        const beforeLen = store.historyLog.length;
        store.historyLog = store.historyLog.filter((h) => {
          if (!h) return false;
          if (h.sessionId === sessionId && h.targetMsgId && !aliveMsgIds.has(h.targetMsgId)) {
            return false;
          }
          return true;
        });
        if (store.historyLog.length !== beforeLen) storeCleaned = true;
      }
      if (storeCleaned) saveStore();

      const sessionLogs = (store.historyLog || []).filter(
        (h) => h && h.sessionId === sessionId && (!h.targetMsgId || aliveMsgIds.has(h.targetMsgId))
      );
      const recentLogs = sessionLogs.slice(-limit);

      const activeItems = [];
      for (const [msgId, rec] of Object.entries(store.byMsgId)) {
        if (!rec || rec.sessionId !== sessionId || !Array.isArray(rec.items)) continue;
        if (!aliveMsgIds.has(msgId)) continue;
        const msgOwner =
          rec.role === "user"
            ? resolveActorInfo("user", true, "用户", sessionId).actorName
            : rec.senderName ||
              (rec.senderCharacterId
                ? resolveActorInfo(rec.senderCharacterId, false, "角色", sessionId).actorName
                : "角色");
        const snippet = sanitizePromptField(rec.textSnap || "[消息]", 28);
        for (const it of rec.items) {
          const safeSticker = sanitizePromptField(it.stickerName || it.emoji, 24);
          const safeEmoji = sanitizePromptField(it.emoji, 16);
          activeItems.push({
            actorName: sanitizePromptField(it.actorName || (it.isUser ? "用户" : "角色"), 20),
            targetOwnerName: sanitizePromptField(msgOwner, 20),
            snippet,
            // Emoji 直接展示符号（如 ❤️），表情包展示 `表情包:名称`，避免模型学出 `emoji:xxx`
            label: it.kind === "sticker" ? `表情包:${safeSticker}` : `${safeEmoji}`,
            ts: it.ts || 0,
          });
        }
      }
      activeItems.sort((a, b) => a.ts - b.ts);
      const recentActive = activeItems.slice(-limit);

      const lines = [];
      if (recentActive.length > 0) {
        lines.push(`【当前消息上的表情/表情包回应（最近${recentActive.length}条）】`);
        recentActive.forEach((item) => {
          lines.push(`- ${item.actorName} 对 ${item.targetOwnerName} 的消息:${item.snippet} 回应了 ${item.label}`);
        });
      }

      if (recentLogs.length > 0) {
        lines.push(`【最近的表情回应操作记录（含设置与取消，最近${recentLogs.length}条）】`);
        recentLogs.forEach((log) => {
          const actVerb = log.action === "unset" ? "取消了对" : "对";
          const rawLbl = String(log.label || "").replace(/^emoji[:：]\s*/i, "");
          const safeLabel = sanitizePromptField(rawLbl, 30);
          const actTail = log.action === "unset" ? `的 ${safeLabel} 回应` : `做出了 ${safeLabel} 回应`;
          const snippet = sanitizePromptField(log.targetTextSnap || "[消息]", 28);
          const actorName = sanitizePromptField(log.actorName || "某人", 20);
          const ownerName = sanitizePromptField(log.targetOwnerName || "某人", 20);
          lines.push(`- ${actorName} ${actVerb} ${ownerName} 的消息:${snippet} ${actTail}`);
        });
      }

      if (ctx.system.settings.get("enableAiReact") !== false) {
        let userName = "用户";
        try { userName = resolveActorInfo("user", true, "用户", sessionId).actorName; } catch (e) {}

        const rows = [];
        try {
          const list = allSessionMsgs.filter((m) => m && m.role !== "system" && !m.isRetracted);
          const start = Math.max(0, list.length - TARGET_ROWS);
          for (let i = start; i < list.length; i++) {
            const m = list[i];
            let text = normalizeText(messageText(m)) || "[媒体消息]";
            text = text.replace(/[\r\n\[\]【】`]/g, " ").trim();
            const chars = Array.from(text);
            if (chars.length > 160) text = chars.slice(0, 120).join("") + "…" + chars.slice(-30).join("");
            const who =
              m.role === "user"
                ? userName
                : sanitizePromptField(
                    m.senderName || resolveActorInfo(m.senderCharacterId || "", false, "角色", sessionId).actorName,
                    20
                  );
            rows.push(`- ${who}:${text}`);
          }
        } catch (e) {}

        if (rows.length) {
          lines.push(`【最近的聊天原文（要回应哪一句就从冒号后照抄，越靠下越新）】\n` + rows.join("\n"));
        }

        lines.push(
          `【表情回应指令与格式规范（严禁混淆 Emoji 与表情包）】\n` +
            `1. 严格区分两种回应格式：\n` +
            `   - 普通 Emoji 符号回应：\`[react:Emoji符号:要回应的原句]\`（例如 \`[react:❤️:今天好累啊]\`）。注意：冒号后直接写单个 Emoji 符号（如 ❤️、😂、👍），严禁写 \`emoji:\` 前缀，也严禁在这里填文字！\n` +
            `   - 表情包小图回应：\`[react:表情包:表情包名称:要回应的原句]\`（例如 \`[react:表情包:好耶！:今天好累啊]\`）。注意：使用你的表情包回应时，必须加上 \`表情包:\` 前缀，绝不能写成 \`[react:emoji:好耶！]\` 或漏掉 \`表情包:\`！\n` +
            `2. 原句定位规则：原句直接写在最后一个冒号后面（不要加「」等引号），必须从上面【最近的聊天原文】里逐字照抄（抄其中独特的 6~30 字即可，越长越准）；也可以回应群聊里任何角色说过的话。\n` +
            `3. 省略原句时（\`[react:❤️]\` 或 \`[react:表情包:好耶！]\`）默认回应用户最新一条消息；写了原句但找不到对应消息时，这次回应会被丢弃。\n` +
            `4. 多个回应用逗号分隔，例如 \`[react:❤️:A句, 表情包:贴贴:B句]\`；单次最多 2 个回应。\n` +
            `5. 取消回应：\`[unreact:❤️:原句]\` 或 \`[unreact:表情包:名称:原句]\` 撤掉某条消息上的回应，\`[unreact:all]\` 撤掉你最近贴过的全部回应。\n` +
            `6. 克制原则（重要）：绝大多数日常对话不需要贴表情回应，严禁每条回复都机械附带 [react:...]，严禁只输出 [react:...] 而不写正文；不要给自己这条回复贴回应。`
        );
      }

      return lines.length > 0 ? "\n" + lines.join("\n") : "";
    }

    // ── 15. 输出解析 ──
    const ADD_REACT_PATTERNS = [
      /\[react[:：]\s*([^\]]+?)\s*\]/gi,
      /\[回应[:：]\s*([^\]]+?)\s*\]/gi,
      /\[表情回应[:：]\s*([^\]]+?)\s*\]/gi,
      /【react[:：]\s*([^】]+?)\s*】/gi,
      /【回应[:：]\s*([^】]+?)\s*】/gi,
      /【表情回应[:：]\s*([^】]+?)\s*】/gi,
    ];

    const REMOVE_REACT_PATTERNS = [
      /\[unreact[:：]\s*([^\]]+?)\s*\]/gi,
      /\[取消回应[:：]\s*([^\]]+?)\s*\]/gi,
      /\[撤回回应[:：]\s*([^\]]+?)\s*\]/gi,
      /【unreact[:：]\s*([^】]+?)\s*】/gi,
      /【取消回应[:：]\s*([^】]+?)\s*】/gi,
      /【撤回回应[:：]\s*([^】]+?)\s*】/gi,
    ];

    function stripAllReactionTags(inputText) {
      let out = String(inputText || "");
      ADD_REACT_PATTERNS.forEach((rx) => {
        out = out.replace(new RegExp(rx.source, rx.flags), "");
      });
      REMOVE_REACT_PATTERNS.forEach((rx) => {
        out = out.replace(new RegExp(rx.source, rx.flags), "");
      });
      return out.trim();
    }

    function extractCharacterActionsFromResponse(text, fallbackCharId, sid) {
      const isGroup = checkIsGroupSession(sid);
      const actionsByActor = [];
      const collect = (segText) => {
        const addItems = [];
        const removeItems = [];
        ADD_REACT_PATTERNS.forEach((rx) => {
          const cloneRx = new RegExp(rx.source, rx.flags);
          let m;
          while ((m = cloneRx.exec(segText)) !== null) {
            if (m[1]) addItems.push(...parseReactionItems(m[1]));
          }
        });
        REMOVE_REACT_PATTERNS.forEach((rx) => {
          const cloneRx = new RegExp(rx.source, rx.flags);
          let m;
          while ((m = cloneRx.exec(segText)) !== null) {
            if (m[1]) removeItems.push(...parseReactionItems(m[1]));
          }
        });
        return { addItems, removeItems };
      };

      if (isGroup && /^\[[^\]\n]{1,32}\]:/m.test(text)) {
        const lines = text.split("\n");
        let curActorName = "";
        let curBuffer = [];
        const flushSegment = () => {
          if (!curBuffer.length) return;
          const segText = curBuffer.join("\n");
          const { addItems, removeItems } = collect(segText);
          if (addItems.length || removeItems.length) {
            actionsByActor.push({
              actorId: curActorName ? "" : fallbackCharId,
              actorName: curActorName || "角色",
              addItems,
              removeItems,
            });
          }
          curBuffer = [];
        };

        for (const line of lines) {
          const match = line.match(/^\[([^\]\n]{1,32})\]:\s*/);
          if (match) {
            flushSegment();
            curActorName = match[1].trim();
            curBuffer.push(line.slice(match[0].length));
          } else {
            curBuffer.push(line);
          }
        }
        flushSegment();
      } else {
        const { addItems, removeItems } = collect(text);
        if (addItems.length || removeItems.length) {
          actionsByActor.push({
            actorId: fallbackCharId,
            actorName: "角色",
            addItems,
            removeItems,
          });
        }
      }

      const cleanedText = stripAllReactionTags(text);
      return { cleanedText, actionsByActor };
    }

    // ── 16. 生命周期与钩子 ──
    ctx.hooks.on("session.opened", ({ sessionId, isGroup }) => {
      currentSessionId = sessionId;
      currentIsGroup = !!isGroup;
      if (sessionId) groupFlagCache.set(sessionId, !!isGroup);

      for (const [msgId, entry] of Array.from(footerSlotMap.entries())) {
        if (!entry) { footerSlotMap.delete(msgId); continue; }
        const slotConnected = entry.slotEl && entry.slotEl.isConnected;
        const outConnected = entry.outEl && entry.outEl.isConnected;
        if (!slotConnected && !outConnected && sessionId && entry.sessionId && entry.sessionId !== sessionId) {
          removeOutsideContainer(msgId);
          footerSlotMap.delete(msgId);
        } else if (slotConnected && sessionId) {
          entry.sessionId = sessionId;
        }
      }

      for (const [msgId, cancelTimer] of Array.from(retryTimers.entries())) {
        try { if (typeof cancelTimer === "function") cancelTimer(); } catch (e) {}
        retryTimers.delete(msgId);
      }

      syncKvFromIndexedDB();
      pruneStoreCapacity();

      refreshAllFooters();
      ctx.system.timers.setTimeout(() => refreshAllFooters(), 60);
      ctx.system.timers.setTimeout(() => refreshAllFooters(), 260);
    });

    ctx.hooks.on("message.updated", ({ id, patch }) => {
      if (!id) return;
      if (patch && patch.isRetracted) {
        cancelRetryTimer(id);
        if (purgeMessageReactionData(id)) saveStore();
        removeOutsideContainer(id);
        footerSlotMap.delete(id);
        return;
      }
      const rec = store.byMsgId[id];
      if (rec && patch && patch.content !== undefined) {
        const clean = normalizeText(patch.content);
        rec.textSnap = clean;
        rec.updatedAt = Date.now();
        if (Array.isArray(store.historyLog) && clean) {
          store.historyLog.forEach((h) => {
            if (h && h.targetMsgId === id) h.targetTextSnap = clean;
          });
        }
        saveStore();
      }
      const entry = footerSlotMap.get(id);
      if (entry) {
        if (patch && entry.message) entry.message = { ...entry.message, ...patch };
        renderReactionDOM(entry.slotEl, entry.sessionId, entry.message);
      }
    });

    ctx.hooks.on("message.persisted", ({ message }) => {
      if (!message || !message.id) return;
      const sid = message.sessionId || currentSessionId;
      tryMigrateOrphanReactions(message, sid);
      refreshMessageFooter(message.id, message, sid);
    });

    ctx.hooks.on("message.deleted", ({ id }) => {
      if (!id) return;
      cancelRetryTimer(id);
      if (purgeMessageReactionData(id)) saveStore();
      removeOutsideContainer(id);
      footerSlotMap.delete(id);
    });

    ctx.hooks.transform("prompt.system", (payload) => {
      const sid = payload.sessionId || currentSessionId;
      if (!sid) return payload;
      const block = buildReactionPromptBlock(sid);
      if (block) payload.hint = (payload.hint || "") + block;
      return payload;
    });

    ctx.hooks.transform("llm.request", (payload) => {
      if (
        payload &&
        payload.sessionId &&
        (!payload.purpose || payload.purpose === "chat" || payload.purpose === "group_chat")
      ) {
        pendingAiReactBySession.set(payload.sessionId, payload.characterId || "");
      }
      return payload;
    });

    ctx.hooks.transform("llm.response", (payload) => {
      if (!payload || typeof payload.text !== "string") return payload;
      if (payload.purpose && payload.purpose !== "chat" && payload.purpose !== "group_chat") {
        return payload;
      }

      if (ctx.system.settings.get("enableAiReact") === false) {
        return payload;
      }

      const sid = payload.sessionId || currentSessionId;
      const fallbackCharId = (sid && pendingAiReactBySession.get(sid)) || "";

      const { cleanedText, actionsByActor } = extractCharacterActionsFromResponse(
        payload.text,
        fallbackCharId,
        sid
      );

      if (!actionsByActor.length) return payload;

      payload.text = cleanedText || "…";

      if (sid) {
        try {
          const msgs = getSessionMessageList(sid);
          const usedKeys = new Set();

          actionsByActor.forEach(({ actorId, actorName, addItems, removeItems }) => {
            const actor = resolveActorInfo(actorId, false, actorName, sid);

            if (removeItems.length > 0) {
              removeItems.forEach(({ theme, quote }) => {
                const q = String(theme || "").trim();
                if (isAllToken(q)) {
                  removeActorReactionInSession(sid, "all", actor, "");
                  return;
                }
                let tgt = null;
                if (quote) {
                  tgt = findMessageByQuote(sid, quote, msgs);
                  if (!tgt) return;
                }
                removeActorReactionInSession(sid, q, actor, tgt ? getRealMsgId(tgt) : "");
              });
            }

            if (addItems.length > 0) {
              let applied = 0;
              for (const { theme, quote } of addItems) {
                if (applied >= MAX_REACTS_PER_REPLY) break;
                let tgt = null;
                if (quote) {
                  tgt = findMessageByQuote(sid, quote, msgs);
                  if (!tgt) continue;
                } else {
                  tgt = latestUserMessage(msgs);
                }
                if (!tgt) continue;
                if (tgt.role !== "user" && tgt.senderCharacterId && tgt.senderCharacterId === actor.actorId) continue;

                const tgtId = getRealMsgId(tgt);
                const payloads = buildReactionPayloads(theme, sid);
                for (const one of payloads) {
                  if (applied >= MAX_REACTS_PER_REPLY) break;
                  const uniq = `${tgtId}::${one.kind}::${one.stickerId || one.emoji}`;
                  if (usedKeys.has(uniq)) continue;
                  usedKeys.add(uniq);
                  addReactionIfNotExist(tgt, sid, one, actor);
                  applied++;
                }
              }
            }
          });
        } catch (e) {}
      }

      return payload;
    });

    ctx.system.settings.onChange(() => {
      groupFlagCache.clear();
      refreshAllFooters();
    });

    return () => {
      if (menuObserver) {
        menuObserver.disconnect();
        menuObserver = null;
      }
      for (const [, cancelTimer] of Array.from(retryTimers.entries())) {
        try { if (typeof cancelTimer === "function") cancelTimer(); } catch (e) {}
      }
      retryTimers.clear();
      for (const [msgId] of Array.from(footerSlotMap.entries())) removeOutsideContainer(msgId);
      footerSlotMap.clear();
      pendingAiReactBySession.clear();
      themeAssetCache.clear();
      groupFlagCache.clear();
      pendingReflowIds.clear();
      if (reflowObserver) {
        try { reflowObserver.disconnect(); } catch (e) {}
        reflowObserver = null;
      }
      if (typeof document !== "undefined") {
        document.querySelectorAll(".er-outside-container").forEach((el) => el.remove());
        document.querySelectorAll(".chat-msg-content-wrap > [data-msg-id]").forEach((el) => {
          if (el.style && (el.style.alignSelf === "flex-start" || el.style.alignSelf === "flex-end")) {
            el.style.alignSelf = "";
          }
        });
      }
    };
  },
};
