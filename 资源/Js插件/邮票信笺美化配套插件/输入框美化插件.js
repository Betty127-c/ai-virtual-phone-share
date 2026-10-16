export default {
  manifest: {
    id: "custom-input-placeholder",
    name: "花体输入框提示",
    apiVersion: 1,
    version: "1.0.1",
    author: "deepseek",
    description: "只在指定聊天室美化输入栏注入优雅的花体英文提示(可自定义文字内容、样式<即最高显示来源于你输入字体的样式，输入普通字体，默认渲染为原本统一格式>、大小、颜色)，打字即消失",
    permissions: ["chat.read"],
    settings: [
      { key: "placeholderText", label: "提示文字", type: "text", default: "Write a letter..." },
      { key: "fontSize", label: "文字大小(px)", type: "number", default: 22 },
      { key: "placeholderColor", label: "提示文字颜色", type: "text", default: "#a4b8c8" }
    ]
  },

  setup(ctx) {
    // 1. 注入设计样式
    ctx.ui.injectCSS(`
      .letter-panel {
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
      .letter-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 8px;
        border-bottom: 1px dashed #dbe8f5;
      }
      .letter-title {
        font-size: 15px;
        font-weight: 700;
        color: #4A5D73;
        letter-spacing: 0.5px;
      }
      .letter-header-actions {
        display: flex;
        gap: 8px;
      }
      .letter-text-btn {
        background: none;
        border: none;
        font-size: 12px;
        color: #8fa3b0;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        transition: all 0.15s ease;
      }
      .letter-text-btn:hover {
        color: #4A5D73;
        background-color: #eef5fa;
      }
      .letter-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 220px;
        overflow-y: auto;
        padding: 2px;
      }
      .letter-item {
        display: flex;
        align-items: center;
        padding: 12px 14px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid #eef5fa;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .letter-item:hover {
        border-color: #dbe8f5;
        box-shadow: 0 2px 8px rgba(45, 75, 105, 0.04);
      }
      /* 自定义的圆形勾选邮戳 */
      .letter-checkbox {
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
      .letter-checkbox.checked {
        background-color: #4A5D73;
        border-color: #4A5D73;
      }
      .letter-checkbox.checked::after {
        content: "✓";
        color: #ffffff;
        font-size: 12px;
        font-weight: bold;
        line-height: 1;
      }
      .letter-item-name {
        font-size: 14px;
        font-weight: 500;
        color: #4A5D73;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .letter-item-type {
        font-size: 11px;
        color: #8fa3b0;
        background: #f4f9fd;
        padding: 2px 8px;
        border-radius: 20px;
        margin-left: 8px;
        border: 1px solid #eef5fa;
      }
      .letter-footer {
        display: flex;
        justify-content: center;
        padding-top: 8px;
        border-top: 1px dashed #dbe8f5;
      }
      .letter-toggle-group {
        display: flex;
        background: #eef5fa;
        border-radius: 20px;
        padding: 3px;
        width: 100%;
      }
      .letter-toggle-btn {
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
      .letter-toggle-btn.active {
        background: #ffffff;
        color: #4A5D73;
        font-weight: 600;
        box-shadow: 0 2px 6px rgba(45, 75, 105, 0.08);
      }
      .letter-empty {
        text-align: center;
        color: #8fa3b0;
        font-size: 13px;
        padding: 24px 0;
      }
    `);

    // ==========================================
    // 以下为绝对不允许修改的核心逻辑区
    // ==========================================
    let placeholderEl = null;

    const getApplyScope = () => ctx.system.storage.get("placeholder_apply_scope") || "selected";
    const getTargetSessions = () => ctx.system.storage.get("placeholder_target_sessions") || [];

    const isSessionActive = (sessionId) => {
      if (getApplyScope() === "all") return true;
      if (!sessionId) return false;
      const targets = getTargetSessions();
      return Array.isArray(targets) && targets.some(id => String(id) === String(sessionId));
    };

    const getSessionIdFromElement = (el) => {
      const roomWrapper = el.closest(".chat-room-wrapper");
      if (!roomWrapper) return null;
      const match = roomWrapper.className.match(/\bsession-([^\s]+)\b/);
      return match ? match[1] : null;
    };

    // 3. 设置页渲染
    ctx.ui.slot("settings.section", (el) => {
      const render = () => {
        el.innerHTML = "";
        const container = document.createElement("div");
        container.className = "letter-panel";

        const currentScope = getApplyScope();
        const selectedList = getTargetSessions();

        // --- 顶部标题与操作 ---
        const header = document.createElement("div");
        header.className = "letter-header";

        const title = document.createElement("div");
        title.className = "letter-title";
        title.textContent = "📬 邮局生效范围";

        const headerActions = document.createElement("div");
        headerActions.className = "letter-header-actions";

        const btnSelectAll = document.createElement("button");
        btnSelectAll.type = "button";
        btnSelectAll.className = "letter-text-btn";
        btnSelectAll.textContent = "全选";
        btnSelectAll.onclick = () => {
          ctx.system.storage.set("placeholder_target_sessions", sessions.map(s => s.id));
          render();
          applyPlaceholder();
        };

        const btnClear = document.createElement("button");
        btnClear.type = "button";
        btnClear.className = "letter-text-btn";
        btnClear.textContent = "清空";
        btnClear.onclick = () => {
          ctx.system.storage.set("placeholder_target_sessions", []);
          render();
          applyPlaceholder();
        };

        headerActions.appendChild(btnSelectAll);
        headerActions.appendChild(btnClear);
        header.appendChild(title);
        header.appendChild(headerActions);
        container.appendChild(header);

        // --- 中间列表 ---
        if (currentScope === "selected") {
          const sessions = ctx.data.sessions.list() || [];
          
          const listEl = document.createElement("div");
          listEl.className = "letter-list";

          if (sessions.length === 0) {
            listEl.innerHTML = `<div class="letter-empty">暂无聊天会话</div>`;
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
              item.className = "letter-item";

              // 自定义圆形勾选器
              const checkbox = document.createElement("div");
              checkbox.className = `letter-checkbox ${isChecked ? "checked" : ""}`;
              
              // 真实的 checkbox 隐藏起来，只负责逻辑
              const realCheckbox = document.createElement("input");
              realCheckbox.type = "checkbox";
              realCheckbox.checked = isChecked;
              realCheckbox.style.display = "none";
              
              realCheckbox.onchange = (e) => {
                const current = new Set(getTargetSessions().map(id => String(id)));
                if (e.target.checked) current.add(String(sess.id));
                else current.delete(String(sess.id));
                ctx.system.storage.set("placeholder_target_sessions", Array.from(current));
                render();
                applyPlaceholder();
              };

              checkbox.appendChild(realCheckbox);
              
              // 整个 label 的点击事件，用来驱动隐藏的 checkbox
              item.onclick = (e) => {
                e.preventDefault();
                realCheckbox.checked = !realCheckbox.checked;
                realCheckbox.dispatchEvent(new Event("change"));
              };

              const nameSpan = document.createElement("span");
              nameSpan.className = "letter-item-name";
              nameSpan.textContent = name;

              const typeSpan = document.createElement("span");
              typeSpan.className = "letter-item-type";
              typeSpan.textContent = typeLabel;

              item.appendChild(checkbox);
              item.appendChild(nameSpan);
              item.appendChild(typeSpan);
              listEl.appendChild(item);
            });
          }

          container.appendChild(listEl);
        }

        // --- 底部切换区域 ---
        const footer = document.createElement("div");
        footer.className = "letter-footer";

        const toggleGroup = document.createElement("div");
        toggleGroup.className = "letter-toggle-group";

        const btnSelected = document.createElement("button");
        btnSelected.type = "button";
        btnSelected.className = `letter-toggle-btn ${currentScope === "selected" ? "active" : ""}`;
        btnSelected.textContent = "仅选中的聊天室";
        btnSelected.onclick = () => {
          ctx.system.storage.set("placeholder_apply_scope", "selected");
          render();
          applyPlaceholder();
        };

        const btnAll = document.createElement("button");
        btnAll.type = "button";
        btnAll.className = `letter-toggle-btn ${currentScope === "all" ? "active" : ""}`;
        btnAll.textContent = "全部聊天室";
        btnAll.onclick = () => {
          ctx.system.storage.set("placeholder_apply_scope", "all");
          render();
          applyPlaceholder();
        };

        toggleGroup.appendChild(btnSelected);
        toggleGroup.appendChild(btnAll);
        footer.appendChild(toggleGroup);
        container.appendChild(footer);

        el.appendChild(container);
      };

      render();
    });

    // 4. 输入栏注入逻辑（完全保留的核心）
    const applyPlaceholder = () => {
      const inputBars = document.querySelectorAll(".chat-input-bar");
      
      inputBars.forEach((inputBar) => {
        const sessionId = getSessionIdFromElement(inputBar);
        const isTarget = isSessionActive(sessionId);

        if (!isTarget) {
          const existing = inputBar.querySelector(".plugin-custom-placeholder");
          if (existing) existing.remove();
          const textarea = inputBar.querySelector("textarea");
          if (textarea && textarea.getAttribute("data-custom-ph") === "true") {
            textarea.setAttribute("placeholder", "");
            textarea.removeAttribute("data-custom-ph");
          }
          return;
        }

        const text = String(ctx.system.settings.get("placeholderText") || "Write a letter...");
        const color = String(ctx.system.settings.get("placeholderColor") || "#a4b8c8");
        const size = Number(ctx.system.settings.get("fontSize") || 22);

        const target = inputBar.querySelector("textarea") || inputBar.querySelector("[contenteditable='true']") || inputBar.querySelector(".chat-input-textarea");
        if (!target) return;

        if (target.tagName === "TEXTAREA") {
          const existing = inputBar.querySelector(".plugin-custom-placeholder");
          if (existing) existing.remove();
          
          if (target.getAttribute("placeholder") !== text) {
            target.setAttribute("placeholder", text);
            target.setAttribute("data-custom-ph", "true");
          }
          return;
        }

        let phEl = inputBar.querySelector(".plugin-custom-placeholder");
        if (!phEl) {
          phEl = document.createElement("div");
          phEl.className = "plugin-custom-placeholder";
          if (window.getComputedStyle(inputBar).position === "static") {
            inputBar.style.position = "relative";
          }
          inputBar.appendChild(phEl);
          
          const updateState = () => {
            const hasContent = target.textContent.trim().length > 0 || target.innerHTML.trim() !== "" && target.innerHTML !== "<br>";
            const isFocused = document.activeElement === target;
            phEl.style.opacity = (hasContent || isFocused) ? "0" : "1";
          };
          
          target.addEventListener("input", updateState);
          target.addEventListener("focus", updateState);
          target.addEventListener("blur", updateState);
          phEl._updateState = updateState;
        }
        
        phEl.textContent = text;
        phEl.style.cssText = `
          position: absolute !important;
          pointer-events: none !important;
          font-family: 'Great Vibes', 'Italianno', cursive, serif !important;
          font-style: italic !important;
          left: 16px !important;
          top: 50% !important;
          transform: translateY(-50%) !important;
          z-index: 99 !important;
          transition: opacity 0.15s ease !important;
          white-space: nowrap !important;
          color: ${color} !important;
          font-size: ${size}px !important;
        `;
        
        if (phEl._updateState) phEl._updateState();
      });
    };

    const injectPlaceholderStyle = () => {
      let styleEl = document.getElementById("plugin-placeholder-style");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "plugin-placeholder-style";
        document.head.appendChild(styleEl);
      }
      const color = String(ctx.system.settings.get("placeholderColor") || "#a4b8c8");
      const size = Number(ctx.system.settings.get("fontSize") || 22);
      styleEl.textContent = `
        .chat-input-bar textarea::placeholder,
        .chat-input-textarea::placeholder {
          font-family: 'Great Vibes', 'Italianno', cursive, serif !important;
          font-style: italic !important;
          font-size: ${size}px !important;
          color: ${color} !important;
          opacity: 1 !important;
        }
        .chat-input-bar textarea:focus::placeholder,
        .chat-input-textarea:focus::placeholder {
          color: transparent !important;
          opacity: 0 !important;
        }
      `;
    };

    injectPlaceholderStyle();

    // 5. 监听器
    try {
      document.fonts.ready.then(() => {
        applyPlaceholder();
      });
    } catch (e) {}

    const observer = new MutationObserver(() => {
      clearTimeout(window._placeholderTimer);
      window._placeholderTimer = setTimeout(() => {
        applyPlaceholder();
      }, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    ctx.system.settings.onChange(async () => {
      injectPlaceholderStyle();
      applyPlaceholder();
    });

    applyPlaceholder();

    return () => {
      try { observer.disconnect(); } catch (e) {}
      try { document.getElementById("plugin-placeholder-style")?.remove(); } catch (e) {}
      try {
        document.querySelectorAll(".plugin-custom-placeholder").forEach(el => el.remove());
        document.querySelectorAll("textarea[data-custom-ph='true']").forEach(el => {
          el.setAttribute("placeholder", "");
          el.removeAttribute("data-custom-ph");
        });
      } catch (e) {}
    };
  }
};