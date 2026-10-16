export default {
  manifest: {
    id: "bubble-timestamp-top",
    name: "气泡上方时间戳",
    apiVersion: 1,
    version: "1.0.7",
    author: "deepseek",
    description: "在气泡正上方显示 AM/PM 时间戳，颜色、大小、生效聊天室可自定义",
    permissions: ["chat.read"],
    settings: [
      { key: "timeColor", label: "时间戳颜色", type: "text", default: "#4A5D73" },
      { key: "timeSize", label: "时间戳大小(px)", type: "number", default: 11 }
    ]
  },

  setup(ctx) {
    // 1. 注入样式
    ctx.ui.injectCSS(`
      /* --- 设置面板样式 --- */
      .time-config-panel {
        padding: 16px;
        background-color: #fcfdff;
        border-radius: 20px;
        border: 1px solid rgba(235, 245, 250, 0.8);
        box-shadow: 0 6px 24px rgba(45, 75, 105, 0.06);
        margin-top: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-family: system-ui, -apple-system, sans-serif;
      }
      .time-config-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 8px;
        border-bottom: 1px dashed #dbe8f5;
      }
      .time-config-title {
        font-size: 15px;
        font-weight: 700;
        color: #4A5D73;
        letter-spacing: 0.5px;
      }
      .time-config-header-actions {
        display: flex;
        gap: 8px;
      }
      .time-text-btn {
        background: none;
        border: none;
        font-size: 12px;
        color: #8fa3b0;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        transition: all 0.15s ease;
      }
      .time-text-btn:hover {
        color: #4A5D73;
        background-color: #eef5fa;
      }
      .time-session-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 220px;
        overflow-y: auto;
        padding: 2px;
      }
      .time-session-item {
        display: flex;
        align-items: center;
        padding: 12px 14px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid #eef5fa;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .time-session-item:hover {
        border-color: #dbe8f5;
        box-shadow: 0 2px 8px rgba(45, 75, 105, 0.04);
      }
      .time-session-checkbox {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid #dbe8f5;
        margin-right: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        flex-shrink: 0;
        position: relative;
      }
      .time-session-checkbox.checked {
        background-color: #4A5D73;
        border-color: #4A5D73;
      }
      .time-session-checkbox.checked::after {
        content: "✓";
        color: #ffffff;
        font-size: 12px;
        font-weight: bold;
        line-height: 1;
      }
      .time-session-name {
        font-size: 14px;
        font-weight: 500;
        color: #4A5D73;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .time-session-type {
        font-size: 11px;
        color: #8fa3b0;
        background: #f4f9fd;
        padding: 2px 8px;
        border-radius: 20px;
        margin-left: 8px;
        border: 1px solid #eef5fa;
      }
      .time-config-footer {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding-top: 8px;
        border-top: 1px dashed #dbe8f5;
      }
      .time-toggle-group {
        display: flex;
        background: #eef5fa;
        border-radius: 20px;
        padding: 3px;
        width: 100%;
      }
      .time-toggle-btn {
        flex: 1;
        padding: 8px 0;
        border-radius: 18px;
        font-size: 13px;
        cursor: pointer;
        border: none;
        background: transparent;
        color: #8fa3b0;
        transition: all 0.2s ease;
      }
      .time-toggle-btn.active {
        background: #ffffff;
        color: #4A5D73;
        font-weight: 600;
        box-shadow: 0 2px 6px rgba(45, 75, 105, 0.08);
      }
      .time-config-empty {
        text-align: center;
        color: #8fa3b0;
        font-size: 13px;
        padding: 24px 0;
      }

      /* --- 时间戳样式 --- */
      .bubble-time-badge {
        display: block !important;
        font-size: 11px;
        line-height: 1.05;
        color: #4A5D73;
        margin: 0 !important;
        margin-bottom: 3px !important; /* 紧贴气泡上方 */
        padding: 0 !important;
        letter-spacing: .02em;
        user-select: none;
        pointer-events: none;
        white-space: nowrap;
        box-sizing: border-box !important;
      }
      .bubble-time-badge--user {
        text-align: right !important; /* 我方靠右 */
        align-self: flex-end !important;
      }
      .bubble-time-badge--assistant {
        text-align: left !important; /* AI靠左 */
        align-self: flex-start !important;
      }
    `);

    // ==========================================
    // 核心逻辑区 1：4.0.1 完美多选控制面板
    // ==========================================
    const getApplyScope = () => ctx.system.storage.get("time_apply_scope") || "all";
    const getTargetSessions = () => ctx.system.storage.get("time_target_sessions") || [];

    const isSessionActive = (sessionId) => {
      const applyScope = getApplyScope();
      if (applyScope === "all") return true;
      if (!sessionId) return false;
      const targets = getTargetSessions();
      return Array.isArray(targets) && targets.some(id => String(id) === String(sessionId));
    };

    const formatTimestamp = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "";
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12;
      h = h ? h : 12;
      return `${h}:${m} ${ampm}`;
    };

    ctx.ui.slot("settings.section", (el) => {
      const render = () => {
        el.innerHTML = "";
        const container = document.createElement("div");
        container.className = "time-config-panel";

        const currentScope = getApplyScope();
        const selectedList = getTargetSessions();
        const sessions = ctx.data.sessions.list() || [];

        const header = document.createElement("div");
        header.className = "time-config-header";
        const title = document.createElement("div");
        title.className = "time-config-title";
        title.textContent = "⏱️ 时间戳生效范围";

        const headerActions = document.createElement("div");
        headerActions.className = "time-config-header-actions";

        const btnSelectAll = document.createElement("button");
        btnSelectAll.type = "button";
        btnSelectAll.className = "time-text-btn";
        btnSelectAll.textContent = "全选";
        btnSelectAll.onclick = () => {
          ctx.system.storage.set("time_target_sessions", sessions.map(s => s.id));
          render();
        };

        const btnClear = document.createElement("button");
        btnClear.type = "button";
        btnClear.className = "time-text-btn";
        btnClear.textContent = "清空";
        btnClear.onclick = () => {
          ctx.system.storage.set("time_target_sessions", []);
          render();
        };

        headerActions.appendChild(btnSelectAll);
        headerActions.appendChild(btnClear);
        header.appendChild(title);
        header.appendChild(headerActions);
        container.appendChild(header);

        if (currentScope === "selected") {
          const listEl = document.createElement("div");
          listEl.className = "time-session-list";

          if (sessions.length === 0) {
            listEl.innerHTML = `<div class="time-config-empty">暂无聊天会话</div>`;
          } else {
            sessions.forEach(sess => {
              let name = sess.alias || "";
              let typeLabel = "单聊";
              if (sess.isGroup) {
                name = sess.groupName || "群聊";
                typeLabel = "群聊";
              } else {
                const char = ctx.data.characters.get(sess.contactId);
                name = name || char?.name || `联系人 (${String(sess.contactId).slice(-4)})`;
              }

              const isChecked = selectedList.some(id => String(id) === String(sess.id));

              const item = document.createElement("label");
              item.className = "time-session-item";

              const checkbox = document.createElement("div");
              checkbox.className = `time-session-checkbox ${isChecked ? "checked" : ""}`;

              const realCheckbox = document.createElement("input");
              realCheckbox.type = "checkbox";
              realCheckbox.checked = isChecked;
              realCheckbox.style.display = "none";

              realCheckbox.onchange = (e) => {
                const current = new Set(getTargetSessions().map(id => String(id)));
                if (e.target.checked) current.add(String(sess.id));
                else current.delete(String(sess.id));
                ctx.system.storage.set("time_target_sessions", Array.from(current));
                render();
              };

              checkbox.appendChild(realCheckbox);

              item.onclick = (e) => {
                e.preventDefault();
                realCheckbox.checked = !realCheckbox.checked;
                realCheckbox.dispatchEvent(new Event("change"));
              };

              const nameSpan = document.createElement("span");
              nameSpan.className = "time-session-name";
              nameSpan.textContent = name;

              const typeSpan = document.createElement("span");
              typeSpan.className = "time-session-type";
              typeSpan.textContent = typeLabel;

              item.appendChild(checkbox);
              item.appendChild(nameSpan);
              item.appendChild(typeSpan);
              listEl.appendChild(item);
            });
          }
          container.appendChild(listEl);
        }

        const footer = document.createElement("div");
        footer.className = "time-config-footer";

        const toggleGroup = document.createElement("div");
        toggleGroup.className = "time-toggle-group";

        const btnSelected = document.createElement("button");
        btnSelected.type = "button";
        btnSelected.className = `time-toggle-btn ${currentScope === "selected" ? "active" : ""}`;
        btnSelected.textContent = "仅选中的聊天室";
        btnSelected.onclick = () => {
          ctx.system.storage.set("time_apply_scope", "selected");
          render();
        };

        const btnAll = document.createElement("button");
        btnAll.type = "button";
        btnAll.className = `time-toggle-btn ${currentScope === "all" ? "active" : ""}`;
        btnAll.textContent = "全部聊天室";
        btnAll.onclick = () => {
          ctx.system.storage.set("time_apply_scope", "all");
          ctx.ui.toast("已切换至全部聊天室");
          render();
        };

        toggleGroup.appendChild(btnSelected);
        toggleGroup.appendChild(btnAll);
        footer.appendChild(toggleGroup);

        // 🎯 按照你的指示，删除了底部重复的颜色/大小输入框！颜色和大小直接由宿主顶部的原生设置控制。

        container.appendChild(footer);
        el.appendChild(container);
      };

      render();
    });

    // ==========================================
    // 核心逻辑区 2：时间戳注入引擎（彻底修复会话识别问题）
    // ==========================================
    const MARK = "data-time-injected";
    let raf = 0;

    const SEL = '.chat-msg-wrapper[data-role]:not([data-role="system"]):not([data-reasoning-row]):not([data-consecutive])';

    function injectForWrapper(wrapper) {
      try {
        if (!wrapper || wrapper.getAttribute(MARK)) return;

        if (wrapper.querySelector(".chat-thought-card") || wrapper.querySelector(".voice-msg-text-bubble")) return;

        const role = wrapper.getAttribute("data-role");
        if (role !== "user" && role !== "assistant") return;

        // 🎯 核心修复：绝对不从全局找输入框，直接顺着当前气泡往上找聊天室！
        const roomWrapper = wrapper.closest(".chat-room-wrapper");
        if (!roomWrapper) return;
        
        const match = roomWrapper.className.match(/\bsession-([^\s]+)\b/);
        if (!match) return;
        const sessionId = match[1];

        // 严格匹配用户勾选的范围
        if (!isSessionActive(sessionId)) return;

        // 获取时间戳
        const container = wrapper.parentElement;
        let rawTime = "";
        const grabTime = (c) => {
          if (!c) return "";
          const el = c.querySelector(".justify-center .chat-sys-msg") || c.querySelector(".chat-offline-time");
          return el ? (el.textContent || "").trim() : "";
        };
        
        rawTime = grabTime(container);
        if (!rawTime) {
          let sib = container ? container.previousElementSibling : null;
          while (sib) {
            rawTime = grabTime(sib);
            if (rawTime) break;
            sib = sib.previousElementSibling;
          }
        }

        let timeStr = "";
        if (rawTime) {
          const tm = rawTime.match(/(\d{1,2}):(\d{2})/);
          if (tm) {
            let h = parseInt(tm[1], 10);
            const m = tm[2];
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12;
            h = h ? h : 12;
            timeStr = `${h}:${m} ${ampm}`;
          }
        }
        
        if (!timeStr) {
          timeStr = formatTimestamp(Date.now());
        }

        wrapper.setAttribute(MARK, "1");

        const el = document.createElement("div");
        el.className = "bubble-time-badge bubble-time-badge--" + (role === "user" ? "user" : "assistant");
        el.textContent = timeStr;

        // 🎯 颜色和大小直接读取宿主设置（因为顶部原生有）
        const color = String(ctx.system.settings.get("timeColor") || "#4A5D73");
        const size = Number(ctx.system.settings.get("timeSize") || 11);
        el.style.setProperty("color", color, "important");
        el.style.setProperty("font-size", size + "px", "important");

        const contentWrap = wrapper.querySelector(".chat-msg-content-wrap");
        const bubble = contentWrap && contentWrap.querySelector(".chat-bubble-role-user, .chat-bubble-role-assistant");
        
        if (bubble) {
          contentWrap.insertBefore(el, bubble);
          
          // 🎯 宽度精确卡死，保证边缘对齐
          const syncWidth = () => {
            try {
              const w = bubble.getBoundingClientRect().width;
              if (w > 0) el.style.width = w + "px";
            } catch (e) {}
          };
          requestAnimationFrame(syncWidth);
          setTimeout(syncWidth, 300);
        } else if (contentWrap) {
          contentWrap.insertBefore(el, contentWrap.firstChild);
        } else {
          wrapper.parentNode.insertBefore(el, wrapper);
        }
      } catch (e) {}
    }

    function scan() {
      try {
        document.querySelectorAll(SEL).forEach(injectForWrapper);
      } catch (e) {}
    }

    function scheduleScan() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; scan(); });
    }

    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true });

    const fire = () => { 
      scan(); 
      let i = 0; 
      const t = setInterval(() => { 
        scan(); 
        if (++i >= 10) clearInterval(t); 
      }, 200); 
    };
    
    try { ctx.hooks.on("session.opened", fire); } catch (e) {}
    try { ctx.hooks.on("message.received", fire); } catch (e) {}
    try { ctx.hooks.on("message.sent", fire); } catch (e) {}
    fire();

    try {
      window.addEventListener("resize", () => {
        document.querySelectorAll(".bubble-time-badge").forEach((ts) => {
          const cw = ts.parentElement;
          const b = cw && cw.querySelector(".chat-bubble-role-user, .chat-bubble-role-assistant");
          if (b) { 
            const w = b.getBoundingClientRect().width; 
            if (w > 0) ts.style.width = w + "px"; 
          }
        });
      });
    } catch (e) {}

    return () => {
      try { obs.disconnect(); } catch (e) {}
      try { document.querySelectorAll(".bubble-time-badge").forEach(el => el.remove()); } catch (e) {}
    };
  }
};