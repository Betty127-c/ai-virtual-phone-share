/* 仿纸飞机by哦，禁二传可二改 */
const ICONS = {
  smile: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14.5 7.5C14.5 11.366 11.366 14.5 7.5 14.5C3.63401 14.5 0.5 11.366 0.5 7.5C0.5 3.63401 3.63401 0.5 7.5 0.5C11.366 0.5 14.5 3.63401 14.5 7.5Z" stroke-linejoin="round" stroke="currentColor"/><circle cx="5" cy="5" r="1" fill="currentColor"/><circle cx="10" cy="5" r="1" fill="currentColor"/><path d="M4 9C5.70081 11.4297 9.29919 11.4297 11 9" stroke-linecap="round" stroke="currentColor"/></svg>`,
  sticker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V8.5L15.5 3Z"/><path d="M15 3v6h6M8 13h.01M16 13h.01M10 17c.6.4 1.3.6 2-.6"/></svg>`,
  file: `<svg width="13" height="14" viewBox="0 0 13 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.64354 9.78936L8.38856 6.49286C8.99857 5.9559 9.0578 5.0261 8.52084 4.41609C7.98389 3.80608 7.05409 3.74685 6.44408 4.28381L1.37369 8.74695C0.306169 9.68662 0.202526 11.3138 1.1422 12.3813C2.08187 13.4488 3.70902 13.5525 4.77654 12.6128L11.2211 6.94004C12.7461 5.59765 12.8942 3.27315 11.5518 1.74812C10.2094 0.223094 7.88492 0.0750355 6.35989 1.41742L1.24069 5.92353" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/></svg>`,
};

function menuButton(label, icon, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = `${icon}<span>${label}</span>`;
  button.addEventListener("click", action);
  return button;
}

export default {
  manifest: {
    id: "float-paperplane-combined",
    name: "Float 纸飞机聊天组合脚本",
    apiVersion: 1,
    version: "1.55.0",
    author: "Float chat skin",
    description: "合并纸飞机输入栏、表情/贴纸面板、时间戳、发送状态和连续消息分组功能。",
    permissions: ["ui", "chat.read", "chat.write"]
  },

  setup(ctx) {
    const cleanups = new Map();
    let inputObserver;

    function isOfflineView(wrapper) {
      return !!wrapper?.querySelector(".chat-offline-body");
    }

    function syncChatChrome() {
      document.querySelectorAll(".chat-room-wrapper").forEach(wrapper => {
        const header = wrapper.querySelector(":scope > .page-header[data-ui='header']");
        const scroll = wrapper.querySelector(":scope > .chat-scroll-anchored");
        if (isOfflineView(wrapper)) {
          header?.removeAttribute("data-float-paperplane-header");
          scroll?.removeAttribute("data-float-paperplane-chat");
          wrapper.style.removeProperty("--page-header-content-height");
          wrapper.style.removeProperty("position");
          return;
        }
        header?.setAttribute("data-float-paperplane-header", "1");
        scroll?.setAttribute("data-float-paperplane-chat", "1");
        wrapper.style.setProperty("--page-header-content-height", "64px");
        wrapper.style.setProperty("position", "relative", "important");
      });
    }

    function closePanel(bar) {
      bar.querySelector(".float-paperplane-choice-menu")?.remove();
    }

    function openSmilePanel(bar, runEmoji, runSticker) {
      const old = bar.querySelector(".float-paperplane-choice-menu");
      if (old) {
        old.remove();
        return;
      }
      const panel = document.createElement("div");
      panel.className = "float-paperplane-choice-menu float-paperplane-smile-menu";
      for (const [label, icon, action] of [
        ["表情", ICONS.smile, runEmoji],
        ["贴纸", ICONS.sticker, runSticker],
      ]) {
        const item = menuButton(label, icon, () => {
          panel.remove();
          action?.();
        });
        panel.appendChild(item);
      }
      bar.appendChild(panel);
    }

    function appendOfflineToPlusMenu(bar, offline) {
      const menu = bar.querySelector(".chat-plus-menu");
      if (!(menu instanceof HTMLElement) || menu.querySelector(".float-paperplane-offline-item")) return;
      const item = document.createElement("div");
      item.className = "chat-plus-menu-item flex flex-col items-center gap-1.5 cursor-pointer float-paperplane-offline-item";
      item.setAttribute("role", "button");
      item.innerHTML = `<div class="chat-plus-icon-box" aria-hidden="true"></div><span class="ts-11 text-[var(--c-text)]">线下</span>`;
      item.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        offline?.click();
      });
      menu.appendChild(item);
    }

    function enhance(bar) {
      if (!(bar instanceof HTMLElement) || bar.dataset.floatPaperplaneBottom === "1") return;
      const wrapper = bar.closest(".chat-room-wrapper");
      if (isOfflineView(wrapper) || bar.querySelector('[aria-label="返回线上模式"]')) return;
      const actions = bar.querySelector(".chat-input-actions");
      if (!actions) return;
      bar.dataset.floatPaperplaneBottom = "1";
      let allowNative = false;
      actions.querySelectorAll(":scope > .float-paperplane-bottom-button").forEach(button => button.remove());

      const isStopState = button => /停止|stop/i.test(
        `${button?.getAttribute("aria-label") || ""} ${button?.getAttribute("title") || ""}`
      );

      const resolveButtons = () => {
        const current = [...actions.querySelectorAll(":scope > button")]
          .filter(button => !button.classList.contains("float-paperplane-bottom-button"));
        const named = name => actions.querySelector(`:scope > .float-paperplane-native-${name}`);
        const ordered = current.length >= 6 ? current : [];
        const buttons = {
          offline: named("offline") || ordered[0],
          emoji: named("emoji") || ordered[1],
          sticker: named("sticker") || ordered[2],
          plus: named("plus") || ordered[3],
          send: named("send") || ordered[4],
          reply: named("reply") || ordered[5],
        };
        buttons.offline?.classList.add("float-paperplane-native-offline");
        buttons.emoji?.classList.add("float-paperplane-native-emoji");
        buttons.sticker?.classList.add("float-paperplane-native-sticker");
        buttons.plus?.classList.add("float-paperplane-native-plus");
        buttons.send?.classList.add("float-paperplane-native-send");
        buttons.reply?.classList.add("float-paperplane-native-reply");
        buttons.offline?.style.setProperty("display", "none", "important");
        buttons.sticker?.style.setProperty("display", "none", "important");
        buttons.reply?.style.setProperty("display", "none", "important");
        if (buttons.send && !isStopState(buttons.send)) {
          buttons.send.disabled = false;
          buttons.send.removeAttribute("aria-disabled");
        }
        return buttons;
      };
      const initialButtons = resolveButtons();
      initialButtons.sticker?.style.setProperty("display", "none", "important");

      const textarea = bar.querySelector(".chat-input-textarea");
      if (textarea && !textarea.disabled && !textarea.getAttribute("placeholder")) {
        textarea.setAttribute("placeholder", "输入消息");
      }

      const onCapture = event => {
        if (allowNative) return;
        const target = event.target instanceof Element ? event.target.closest("button") : null;
        if (!(target instanceof HTMLButtonElement) || !actions.contains(target)) return;
        const { offline, emoji, sticker, plus, send, reply } = resolveButtons();
        if (target === emoji) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (bar.querySelector(".chat-plus-menu")) plus?.click();
          openSmilePanel(
            bar,
            () => { allowNative = true; emoji?.click(); queueMicrotask(() => { allowNative = false; }); },
            () => { allowNative = true; sticker?.click(); queueMicrotask(() => { allowNative = false; }); },
          );
          return;
        }
        if (target === plus) return;
        if (target === send && isStopState(send)) return;
        if (target === send && !textarea?.value?.trim()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          allowNative = true;
          reply?.click();
          queueMicrotask(() => { allowNative = false; });
        }
      };

      const onBarMutation = () => {
        const { offline } = resolveButtons();
        appendOfflineToPlusMenu(bar, offline);
      };
      const menuObserver = new MutationObserver(onBarMutation);
      menuObserver.observe(bar, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled"],
      });
      onBarMutation();

      const onOutside = event => {
        if (event.target instanceof Node && !bar.contains(event.target)) closePanel(bar);
      };
      bar.addEventListener("click", onCapture, true);
      document.addEventListener("pointerdown", onOutside, true);

      const cleanup = () => {
        bar.removeEventListener("click", onCapture, true);
        document.removeEventListener("pointerdown", onOutside, true);
        menuObserver.disconnect();
        closePanel(bar);
        actions.querySelectorAll(".float-paperplane-native-offline, .float-paperplane-native-emoji, .float-paperplane-native-sticker, .float-paperplane-native-plus, .float-paperplane-native-send, .float-paperplane-native-reply").forEach(button => {
          button.style.removeProperty("display");
          button?.classList.remove(
            "float-paperplane-native-offline",
            "float-paperplane-native-emoji",
            "float-paperplane-native-sticker",
            "float-paperplane-native-plus",
            "float-paperplane-native-send",
            "float-paperplane-native-reply"
          );
        });
        delete bar.dataset.floatPaperplaneBottom;
        cleanups.delete(bar);
      };
      cleanups.set(bar, cleanup);
    }

    const scan = () => {
      syncChatChrome();
      document.querySelectorAll(".chat-input-bar").forEach(bar => {
        const wrapper = bar.closest(".chat-room-wrapper");
        if (isOfflineView(wrapper) || bar.querySelector('[aria-label="返回线上模式"]')) {
          cleanups.get(bar)?.();
          return;
        }
        enhance(bar);
      });
    };
    scan();
    inputObserver = new MutationObserver(scan);
    inputObserver.observe(document.body, { childList: true, subtree: true });

    const cleanupInput = () => {
      inputObserver?.disconnect();
      cleanups.forEach(cleanup => cleanup());
      cleanups.clear();
      document.querySelectorAll(".chat-room-wrapper").forEach(wrapper => {
        wrapper.querySelector(":scope > .page-header[data-float-paperplane-header]")
          ?.removeAttribute("data-float-paperplane-header");
        wrapper.querySelector(":scope > .chat-scroll-anchored[data-float-paperplane-chat]")
          ?.removeAttribute("data-float-paperplane-chat");
        wrapper.style.removeProperty("--page-header-content-height");
        wrapper.style.removeProperty("position");
      });
    };

    const messageMap = new Map();
    const processedIds = new Set();
    const pendingBySession = new Map();
    let frame = 0;
    let stopped = false;
    let userScrolling = false;
    const startupTimers = [];
    let chatObserver = null;
    let observedChatRoot = null;
    let observerRetryTimer = 0;
    const singleCheckSvg = `<svg width="13" height="11" viewBox="0 0 13 11" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0.750003 7.05749L3.64474 9.75001L11.75 0.750006" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="#2FA102"/></svg>`;
    const doubleCheckSvg = `<svg width="19" height="11" viewBox="0 0 19 11" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0.750003 7.05749L3.64474 9.75001L11.75 0.75001" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="#2FA102"/><path d="M8.75 8.40001L9.86177 9.75001L17.75 0.75001" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="#2FA102"/></svg>`;
    const singleCheckUrl = `data:image/svg+xml,${encodeURIComponent(singleCheckSvg)}`;
    const doubleCheckUrl = `data:image/svg+xml,${encodeURIComponent(doubleCheckSvg)}`;

    function isOrdinaryUserMessage(message) {
      return message?.role === "user"
        && !message.mediaType
        && typeof message.content === "string"
        && !!message.content.trim();
    }

    function rebuildMessageMap() {
      messageMap.clear();
      pendingBySession.clear();
      for (const session of ctx.data.sessions.list()) {
        const pending = new Set();
        for (const message of ctx.data.messages.list(session.id)) {
          messageMap.set(message.id, message);
          if (isOrdinaryUserMessage(message)) {
            pending.add(message.id);
          } else if (message.role === "assistant" && pending.size) {
            pending.forEach(id => processedIds.add(id));
            pending.clear();
          }
        }
        pendingBySession.set(session.id, pending);
      }
    }

    function acknowledgePending(sessionId) {
      const pending = pendingBySession.get(sessionId);
      if (!pending?.size) return;
      pending.forEach(id => processedIds.add(id));
      pending.clear();
      schedule();
    }

    function trackPersistedMessage(message) {
      if (!message?.id || !message.sessionId) return;
      if (isOrdinaryUserMessage(message)) {
        let pending = pendingBySession.get(message.sessionId);
        if (!pending) {
          pending = new Set();
          pendingBySession.set(message.sessionId, pending);
        }
        pending.add(message.id);
      } else if (message.role === "assistant") {
        acknowledgePending(message.sessionId);
      }
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    }

    function isOrdinaryTextBubble(bubble) {
      if (!bubble.matches(".chat-bubble-role-user, .chat-bubble-role-assistant")) return false;
      if (bubble.matches(".chat-bubble-media, .chat-bubble-html-preview, .chat-bubble-music-share")) return false;
      if (bubble.querySelector(
        ".chat-sticker, [class*='sticker'], .chat-quote-message, [class*='quote'], " +
        "[class*='red-packet'], [class*='transfer-card'], [class*='image-bubble'], " +
        "[class*='voice-msg'], [class*='music-share']"
      )) return false;
      return !!bubble.querySelector(".chat-bilingual-block, .chat-markdown");
    }

    function getTextRoot(bubble) {
      return bubble.querySelector(".chat-bilingual-block, .chat-markdown") || bubble;
    }

    function getMetaHost(bubble) {
      const root = getTextRoot(bubble);
      const blocks = [...root.querySelectorAll(
        "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, div"
      )].filter(block => block.textContent?.trim());
      return blocks[blocks.length - 1] || root;
    }

    function ensureMeta(bubble, message) {
      const wrap = bubble.parentElement;
      if (!wrap?.classList.contains("chat-msg-content-wrap")) return;

      
      wrap.querySelectorAll(
        ":scope > .float-paperplane-body, :scope > .float-paperplane-tail"
      ).forEach(layer => layer.remove());

      const metaHost = getMetaHost(bubble);
      let meta = bubble.querySelector(":scope .float-paperplane-meta");
      const legacyMeta = wrap.querySelector(":scope > .float-paperplane-meta");
      if (!meta && legacyMeta) meta = legacyMeta;
      if (!meta) {
        meta = document.createElement("span");
        meta.className = "float-paperplane-meta";
        const time = document.createElement("span");
        time.className = "float-paperplane-time";
        meta.appendChild(time);
        if (bubble.classList.contains("chat-bubble-role-user")) {
          const checks = document.createElement("img");
          checks.className = "float-paperplane-checks";
          checks.alt = "";
          checks.setAttribute("aria-hidden", "true");
          meta.appendChild(checks);
        }
      }
      if (meta.parentElement !== metaHost) metaHost.appendChild(meta);

      meta.dataset.floatRole = bubble.classList.contains("chat-bubble-role-user")
        ? "user"
        : "assistant";
      const isUserMessage = meta.dataset.floatRole === "user";
      if (isUserMessage && !meta.querySelector(".float-paperplane-checks")) {
        const checks = document.createElement("img");
        checks.className = "float-paperplane-checks";
        checks.alt = "";
        checks.setAttribute("aria-hidden", "true");
        meta.appendChild(checks);
      }
      const isProcessed = isUserMessage && processedIds.has(message.id);
      if (isUserMessage) {
        meta.dataset.floatStatus = isProcessed ? "double" : "single";
        const checks = meta.querySelector(".float-paperplane-checks");
        if (checks) checks.src = isProcessed ? doubleCheckUrl : singleCheckUrl;
      } else {
        delete meta.dataset.floatStatus;
        meta.querySelector(".float-paperplane-checks")?.remove();
      }
      const time = meta.querySelector(".float-paperplane-time");
      const formattedTime = formatTime(message.createdAt);
      if (time && time.textContent !== formattedTime) {
        time.textContent = formattedTime;
      }
    }

    function removeMeta(bubble) {
      bubble.parentElement?.querySelector(":scope > .float-paperplane-meta")?.remove();
      bubble.querySelectorAll(":scope .float-paperplane-meta").forEach(meta => meta.remove());
    }

    
    const MESSAGE_GROUP_GAP_MS = 121000;

    function messageDayKey(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function messageSpeakerKey(message) {
      return [
        message?.role || "",
        message?.senderCharacterId || message?.senderId || message?.senderName || ""
      ].join(":");
    }

    function canJoinMessageGroup(previous, current) {
      if (!previous || !current) return false;
      if (previous.message.sessionId !== current.message.sessionId) return false;
      if (messageSpeakerKey(previous.message) !== messageSpeakerKey(current.message)) return false;
      if (messageDayKey(previous.message.createdAt) !== messageDayKey(current.message.createdAt)) return false;

      const previousTime = new Date(previous.message.createdAt).getTime();
      const currentTime = new Date(current.message.createdAt).getTime();
      return Number.isFinite(previousTime)
        && Number.isFinite(currentTime)
        && Math.abs(currentTime - previousTime) <= MESSAGE_GROUP_GAP_MS;
    }

    function applyMessageGrouping() {
      const container = document.querySelector(".chat-room-wrapper .chat-scroll-anchored");
      if (!container) return;

      const rows = [...container.querySelectorAll(".chat-msg-wrapper")];
      const groupedRows = new Set();

      let group = [];
      let previous = null;

      function finishGroup() {
        if (!group.length) return;
        const size = group.length;
        group.forEach((item, index) => {
          const position = size === 1
            ? "single"
            : index === 0
              ? "first"
              : index === size - 1
                ? "last"
                : "middle";
          groupedRows.add(item.row);
          if (item.row.dataset.floatGroup !== position) {
            item.row.dataset.floatGroup = position;
          }
          if (item.row.dataset.floatGroupSize !== String(size)) {
            item.row.dataset.floatGroupSize = String(size);
          }
        });
        group = [];
      }

      
      for (const item of container.children) {
        const itemRows = [...item.querySelectorAll(":scope > .chat-msg-wrapper")];
        if (!itemRows.length) {
          finishGroup();
          previous = null;
          continue;
        }

        for (const row of itemRows) {
          const bubble = row.querySelector(
            ":scope > .chat-msg-content-wrap > .chat-bubble-role-user, " +
            ":scope > .chat-msg-content-wrap > .chat-bubble-role-assistant"
          );
          const messageId = bubble?.dataset.msgId;
          const message = messageId ? messageMap.get(messageId) : null;

          if (!bubble || !message || !isOrdinaryTextBubble(bubble)) {
            finishGroup();
            previous = null;
            continue;
          }

          const current = { row, message };
          if (!canJoinMessageGroup(previous, current)) finishGroup();
          group.push(current);
          previous = current;
        }
      }

      finishGroup();

      
      rows.forEach(row => {
        if (groupedRows.has(row)) return;
        delete row.dataset.floatGroup;
        delete row.dataset.floatGroupSize;
      });
    }

    function update() {
      frame = 0;
      if (stopped || userScrolling) return;

      applyMessageGrouping();

      const bubbles = document.querySelectorAll(
        ".chat-room-wrapper .chat-bubble-role-user, .chat-room-wrapper .chat-bubble-role-assistant"
      );

      for (const bubble of bubbles) {
        const messageId = bubble.dataset.msgId;
        const message = messageId ? messageMap.get(messageId) : null;
        if (!message || !isOrdinaryTextBubble(bubble)) {
          removeMeta(bubble);
          continue;
        }
        ensureMeta(bubble, message);
      }

    }

    function schedule() {
      if (stopped || userScrolling || frame) return;
      frame = requestAnimationFrame(update);
    }

    function bindChatObserver() {
      const root = document.querySelector(".chat-room-wrapper");
      if (!root) {
        chatObserver?.disconnect();
        chatObserver = null;
        observedChatRoot = null;
        if (!observerRetryTimer) {
          observerRetryTimer = window.setTimeout(() => {
            observerRetryTimer = 0;
            bindChatObserver();
          }, 250);
        }
        return;
      }
      if (observerRetryTimer) {
        window.clearTimeout(observerRetryTimer);
        observerRetryTimer = 0;
      }
      if (root === observedChatRoot) return;

      chatObserver?.disconnect();
      chatObserver = new MutationObserver(mutations => {
        if (stopped || !mutations.length) return;
        const relevant = mutations.some(mutation => {
          const target = mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
          return !target?.closest(".float-paperplane-meta");
        });
        if (relevant) schedule();
      });
      chatObserver.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "data-msg-id"]
      });
      observedChatRoot = root;
    }

    function onPointerDown(event) {
      if (event.target instanceof Element && event.target.closest(".chat-scroll-anchored")) {
        userScrolling = true;
      }
    }

    function onPointerEnd() {
      if (!userScrolling) return;
      userScrolling = false;
      schedule();
    }

    rebuildMessageMap();
    bindChatObserver();
    schedule();
    
    for (const delay of [50, 150, 350, 700]) {
      startupTimers.push(window.setTimeout(() => {
        bindChatObserver();
        schedule();
      }, delay));
    }

    
    
    const onResize = schedule;
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerEnd, { passive: true });
    document.addEventListener("pointercancel", onPointerEnd, { passive: true });
    document.addEventListener("touchend", onPointerEnd, { passive: true });
    const offPersisted = ctx.hooks.on("message.persisted", ({ message }) => {
      rebuildMessageMap();
      trackPersistedMessage(message);
      schedule();
    });
    const offUpdated = ctx.hooks.on("message.updated", () => {
      rebuildMessageMap();
      schedule();
    });
    const offOpened = ctx.hooks.on("session.opened", () => {
      rebuildMessageMap();
      observedChatRoot = null;
      bindChatObserver();
      schedule();
    });
    const offRequest = ctx.hooks.transform("llm.request", payload => {
      if (payload.purpose === "chat" && payload.sessionId) {
        acknowledgePending(payload.sessionId);
      }
      return payload;
    });

    return () => {
      cleanupInput();
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      startupTimers.forEach(timer => window.clearTimeout(timer));
      if (observerRetryTimer) window.clearTimeout(observerRetryTimer);
      chatObserver?.disconnect();
      chatObserver = null;
      observedChatRoot = null;
      observerRetryTimer = 0;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
      document.removeEventListener("touchend", onPointerEnd);
      offPersisted();
      offUpdated();
      offOpened();
      offRequest();

      document.querySelectorAll(".float-paperplane-meta").forEach(meta => meta.remove());
      document.querySelectorAll(".chat-msg-wrapper").forEach(row => {
        delete row.dataset.floatGroup;
        delete row.dataset.floatGroupSize;
      });
      document.querySelectorAll(
        ".float-paperplane-body, .float-paperplane-tail"
      ).forEach(layer => layer.remove());
    };
  }
};
