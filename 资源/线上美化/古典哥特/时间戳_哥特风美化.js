export default {
  manifest: {
    id: "gothic-timestamp",
    name: "哥特风美化时间戳",
    apiVersion: 1,
    version: "2.3.1",
    author: "deepseek",
    description: "在网名下方、虚线上方用哥特字体显示 12 小时制真实时间戳，可按聊天室勾选生效范围",
    permissions: ["chat.read"],
    settings: [
      { key: "enabled", label: "启用时间戳", type: "boolean", default: true },
      { key: "timeColor", label: "时间戳颜色", type: "text", default: "#f0f0f4" },
      { key: "timeSize", label: "时间戳大小(px)", type: "number", default: 12 }
    ]
  },

  setup(ctx) {
    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@400;500;600&display=swap";
      document.head.appendChild(link);
    } catch (e) {}

    // ⭐ 第一部分：时间戳全权接管样式
    ctx.ui.injectCSS(`
      .chat-msg-wrapper[data-role="assistant"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap,
      .chat-msg-wrapper[data-role="user"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap {
        position: relative !important;
      }

      .chat-msg-wrapper[data-role="assistant"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap::before,
      .chat-msg-wrapper[data-role="user"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap::before {
        content: var(--gts-time, "") !important;
        position: absolute !important;
        top: -20px !important;
        font-family: 'Grenze Gotisch', serif !important;
        font-weight: 600 !important;
        font-size: var(--gts-size, 12px) !important;
        line-height: 1 !important;
        letter-spacing: 0.08em !important;
        text-transform: uppercase !important;
        color: var(--gts-color, #f0f0f4) !important;
        opacity: 0.8 !important;
        text-shadow: 0 0 8px rgba(255, 255, 255, 0.20) !important;
        pointer-events: none !important;
        z-index: 6 !important;
        white-space: nowrap !important;
        font-variant-numeric: tabular-nums !important;
      }

      .chat-msg-wrapper[data-role="assistant"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap::before {
        left: calc(var(--side-pad, 8px) + var(--avatar-size, 38px) + 4px) !important;
        right: auto !important;
      }

      .chat-msg-wrapper[data-role="user"]:has(.chat-msg-avatar):not([data-consecutive]) .chat-msg-content-wrap::before {
        right: calc(var(--side-pad, 8px) + var(--avatar-size, 38px) + 4px) !important;
        left: auto !important;
      }
    `);

    // ⭐ 第二部分：面板 UI 样式
    ctx.ui.injectCSS(`
      .gts-panel {
        margin-top: 16px; padding: 14px; border-radius: 14px;
        border: 1px dashed rgba(128,128,128,.35); background: rgba(128,128,128,.06);
        font-family: inherit; display: flex; flex-direction: column; gap: 10px;
      }
      .gts-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .gts-title { font-size: 14px; font-weight: 700; opacity: .9; }
      .gts-mini {
        background: none; border: none; font-size: 12px; opacity: .6;
        cursor: pointer; padding: 2px 6px; border-radius: 6px; color: inherit;
      }
      .gts-mini:hover { opacity: 1; background: rgba(128,128,128,.15); }
      .gts-list { display: flex; flex-direction: column; gap: 6px; max-height: 230px; overflow-y: auto; }
      .gts-item {
        display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        border-radius: 10px; border: 1px solid rgba(128,128,128,.25);
        background: rgba(128,128,128,.05); cursor: pointer;
      }
      .gts-item:hover { border-color: rgba(128,128,128,.5); }
      .gts-box {
        width: 18px; height: 18px; border-radius: 50%;
        border: 2px solid rgba(128,128,128,.5);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; font-size: 11px; line-height: 1;
      }
      .gts-box.on { background: rgba(128,128,128,.45); border-color: rgba(128,128,128,.6); }
      .gts-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gts-type {
        font-size: 11px; opacity: .55; border: 1px solid rgba(128,128,128,.3);
        border-radius: 999px; padding: 1px 8px;
      }
      .gts-toggle { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: rgba(128,128,128,.15); }
      .gts-tg {
        flex: 1; padding: 7px 0; border: none; border-radius: 999px;
        background: transparent; font-size: 12px; cursor: pointer; color: inherit; opacity: .6;
      }
      .gts-tg.on { background: rgba(128,128,128,.35); opacity: 1; font-weight: 700; }
      .gts-empty { text-align: center; font-size: 12px; opacity: .5; padding: 16px 0; }
    `);

    const applyVars = () => {
      const color = String(ctx.system.settings.get("timeColor") || "#f0f0f4");
      let size = Number(ctx.system.settings.get("timeSize"));
      if (isNaN(size) || size <= 0) size = 12;
      document.documentElement.style.setProperty("--gts-color", color);
      document.documentElement.style.setProperty("--gts-size", size + "px");
    };
    applyVars();
    try { ctx.system.settings.onChange(applyVars); } catch (e) {}

    const pad2 = (n) => (n < 10 ? "0" + n : "" + n);

    const to12h = (date) => {
      if (!date || isNaN(date.getTime())) return "";
      const h = date.getHours();
      const m = pad2(date.getMinutes());
      const ampm = h >= 12 ? "PM" : "AM";
      let hh = h % 12;
      if (hh === 0) hh = 12;
      return hh + ":" + m + " " + ampm;
    };

    const parseFromText = (txt) => {
      if (!txt) return "";
      const tm = txt.match(/(\d{1,2}):(\d{2})/);
      if (!tm) return "";
      let h = parseInt(tm[1], 10);
      const m = tm[2];
      let ampm;
      if (/pm/i.test(txt)) ampm = "PM";
      else if (/am/i.test(txt)) ampm = "AM";
      else ampm = h >= 12 ? "PM" : "AM";
      let hh = h % 12;
      if (hh === 0) hh = 12;
      return hh + ":" + m + " " + ampm;
    };

    const SCOPE_KEY = "time_apply_scope";
    const TARGET_KEY = "time_target_sessions";

    const getScope = () => ctx.system.storage.get(SCOPE_KEY) || "all";

    const getTargets = () => {
      const v = ctx.system.storage.get(TARGET_KEY);
      if (v == null) {
        try { return (ctx.data.sessions.list() || []).map(x => x.id); } catch (e) { return []; }
      }
      return Array.isArray(v) ? v : [];
    };

    const isSessionActive = (sessionId) => {
      if (getScope() === "all") return true;
      if (!sessionId) return false;
      return getTargets().some(id => String(id) === String(sessionId));
    };

    const MARK = "data-gts-done";
    const SEL = '.chat-msg-wrapper[data-role="user"], .chat-msg-wrapper[data-role="assistant"]';

    function processWrapper(wrapper) {
      try {
        if (!wrapper || wrapper.getAttribute(MARK)) return;
        if (ctx.system.settings.get("enabled") === false) return;
        if (!wrapper.querySelector(".chat-msg-avatar")) return;
        if (wrapper.hasAttribute("data-consecutive")) return;

        const room = wrapper.closest(".chat-room-wrapper");
        if (!room) return;
        const mm = String(room.className).match(/\bsession-([^\s]+)\b/);
        const sessionId = mm ? mm[1] : null;

        if (!isSessionActive(sessionId)) {
          wrapper.style.removeProperty("--gts-time");
          return;
        }

        let timeStr = "";

        const grab = (c) => {
          if (!c) return "";
          const el = c.querySelector(".justify-center .chat-sys-msg")
            || c.querySelector(".chat-offline-time")
            || c.querySelector(".chat-sys-msg");
          return el ? (el.textContent || "").trim() : "";
        };

        const parent = wrapper.parentElement;
        let raw = grab(parent);
        if (!raw && parent) {
          let sib = parent.previousElementSibling;
          while (sib && !raw) {
            raw = grab(sib);
            sib = sib.previousElementSibling;
          }
        }

        if (raw) timeStr = parseFromText(raw);
        if (!timeStr) timeStr = to12h(new Date());
        if (!timeStr) return;

        wrapper.style.setProperty("--gts-time", '"' + timeStr + '"');
        wrapper.setAttribute(MARK, "1");
      } catch (e) {}
    }

    let raf = 0;
    function scan() {
      try { document.querySelectorAll(SEL).forEach(processWrapper); } catch (e) {}
    }
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; scan(); });
    }
    function rescanAll() {
      try {
        document.querySelectorAll("[" + MARK + "]").forEach(n => {
          n.removeAttribute(MARK);
          n.style.removeProperty("--gts-time");
        });
      } catch (e) {}
      scan();
    }

    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });

    const fire = () => {
      scan();
      let i = 0;
      const t = setInterval(() => { scan(); if (++i >= 10) clearInterval(t); }, 200);
    };
    try { ctx.hooks.on("session.opened", fire); } catch (e) {}
    try { ctx.hooks.on("message.persisted", fire); } catch (e) {}
    try { ctx.hooks.on("app.ready", fire); } catch (e) {}
    fire();

    // 面板逻辑
    ctx.ui.slot("settings.section", (el) => {
      const render = () => {
        el.innerHTML = "";
        const box = document.createElement("div");
        box.className = "gts-panel";

        const scope = getScope();
        const selected = getTargets();
        const sessions = ctx.data.sessions.list() || [];

        const head = document.createElement("div");
        head.className = "gts-head";
        const title = document.createElement("div");
        title.className = "gts-title";
        title.textContent = "⏱️ 时间戳生效范围";
        const acts = document.createElement("div");

        const bAll = document.createElement("button");
        bAll.type = "button"; bAll.className = "gts-mini"; bAll.textContent = "全选";
        bAll.onclick = () => { ctx.system.storage.set(TARGET_KEY, sessions.map(x => x.id)); render(); rescanAll(); };

        const bNone = document.createElement("button");
        bNone.type = "button"; bNone.className = "gts-mini"; bNone.textContent = "清空";
        bNone.onclick = () => { ctx.system.storage.set(TARGET_KEY, []); render(); rescanAll(); };

        acts.appendChild(bAll); acts.appendChild(bNone);
        head.appendChild(title); head.appendChild(acts);
        box.appendChild(head);

        if (scope !== "all") {
          const list = document.createElement("div");
          list.className = "gts-list";

          if (!sessions.length) {
            const e = document.createElement("div");
            e.className = "gts-empty"; e.textContent = "暂无聊天会话";
            list.appendChild(e);
          } else {
            sessions.forEach(sess => {
              let name = sess.alias || "";
              let typeLabel = "单聊";
              if (sess.isGroup) { name = sess.groupName || "群聊"; typeLabel = "群聊"; }
              else {
                let ch = null;
                try { ch = ctx.data.characters.get(sess.contactId); } catch (e) {}
                name = name || (ch && ch.name) || ("联系人 " + String(sess.contactId).slice(-4));
              }
              const on = selected.some(id => String(id) === String(sess.id));
              const item = document.createElement("div");
              item.className = "gts-item";
              const boxc = document.createElement("div");
              boxc.className = "gts-box" + (on ? " on" : "");
              boxc.textContent = on ? "✓" : "";
              const nm = document.createElement("span");
              nm.className = "gts-name"; nm.textContent = name;
              const tp = document.createElement("span");
              tp.className = "gts-type"; tp.textContent = typeLabel;
              item.appendChild(boxc); item.appendChild(nm); item.appendChild(tp);
              item.onclick = () => {
                const cur = new Set(getTargets().map(id => String(id)));
                if (cur.has(String(sess.id))) cur.delete(String(sess.id));
                else cur.add(String(sess.id));
                ctx.system.storage.set(TARGET_KEY, Array.from(cur));
                render(); rescanAll();
              };
              list.appendChild(item);
            });
          }
          box.appendChild(list);
        }

        const tg = document.createElement("div");
        tg.className = "gts-toggle";
        const bSel = document.createElement("button");
        bSel.type = "button"; bSel.className = "gts-tg" + (scope !== "all" ? " on" : "");
        bSel.textContent = "仅选中的聊天室";
        bSel.onclick = () => { ctx.system.storage.set(SCOPE_KEY, "selected"); render(); rescanAll(); };
        const bAllT = document.createElement("button");
        bAllT.type = "button"; bAllT.className = "gts-tg" + (scope === "all" ? " on" : "");
        bAllT.textContent = "全部聊天室";
        bAllT.onclick = () => { ctx.system.storage.set(SCOPE_KEY, "all"); render(); rescanAll(); };
        tg.appendChild(bSel); tg.appendChild(bAllT);
        box.appendChild(tg);

        el.appendChild(box);
      };
      render();
    });

    return () => {
      try { obs.disconnect(); } catch (e) {}
      try {
        document.querySelectorAll("[" + MARK + "]").forEach(n => {
          n.removeAttribute(MARK);
          n.style.removeProperty("--gts-time");
        });
        document.documentElement.style.removeProperty("--gts-color");
        document.documentElement.style.removeProperty("--gts-size");
      } catch (e) {}
    };
  }
};