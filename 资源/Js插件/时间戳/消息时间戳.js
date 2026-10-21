export default {
  manifest: {
    id: "chat-message-timestamp",
    name: "消息时间戳",
    apiVersion: 1,
    version: "2.0.0",
    author: "小坊",
    description: "独立渲染消息时间，支持气泡内外显示及自定义格式。",
    permissions: ["chat.read"],
    settings: [
      {
        key: "position",
        label: "显示位置",
        type: "select",
        default: "outside",
        options: [
          { value: "outside", label: "气泡外部下方" },
          { value: "inside", label: "气泡内部底部" },
          { value: "off", label: "关闭" },
        ],
      },
      {
        key: "format",
        label: "时间格式",
        type: "select",
        default: "HH:mm",
        options: [
          { value: "HH:mm", label: "时:分" },
          { value: "HH:mm:ss", label: "时:分:秒" },
          { value: "MM-DD HH:mm", label: "月-日 时:分" },
          {
            value: "YYYY-MM-DD HH:mm:ss",
            label: "年-月-日 时:分:秒",
          },
          { value: "custom", label: "自定义" },
        ],
      },
      {
        key: "customFormat",
        label: "自定义格式",
        type: "text",
        default: "YYYY/MM/DD ddd HH:mm:ss",
      },
      {
        key: "hour12",
        label: "12 小时制",
        type: "boolean",
        default: false,
      },
      {
        key: "showUser",
        label: "显示用户消息时间",
        type: "boolean",
        default: true,
      },
      {
        key: "showAssistant",
        label: "显示角色消息时间",
        type: "boolean",
        default: true,
      },
      {
        key: "alignment",
        label: "时间对齐",
        type: "select",
        default: "right",
        options: [
          { value: "left", label: "左对齐" },
          { value: "center", label: "居中" },
          { value: "right", label: "右对齐" },
        ],
      },
      {
        key: "fontSize",
        label: "字号（8～20 像素）",
        type: "number",
        default: 10,
      },
      {
        key: "color",
        label: "颜色（留空跟随主题）",
        type: "text",
        default: "",
      },
      {
        key: "opacity",
        label: "透明度（0.1～1）",
        type: "number",
        default: 0.55,
      },
      {
        key: "bubbleSelector",
        label: "气泡 CSS 选择器（留空自动识别）",
        type: "text",
        default: "",
      },
    ],
  },

  setup(ctx) {
    const PREFIX = "message-time:";
    const LEGACY = /\n\n〔发送时间：([^\n〕]{1,160})〕$/u;
    const views = new Set();
    const cache = new Map();
    const pending = new Map();

    let disposed = false;
    let warned = false;

    // 外部标签放在独立 DOM 层，避免被气泡背景包住。
    const layer = document.createElement("div");
    layer.setAttribute("data-message-timestamp-layer", "");
    Object.assign(layer.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "100",
      overflow: "hidden",
    });
    document.body.appendChild(layer);

    function get(key, fallback) {
      return ctx.system.settings.get(key) ?? fallback;
    }

    function clamp(value, min, max, fallback) {
      const n = Number(value);
      return Number.isFinite(n)
        ? Math.max(min, Math.min(max, n))
        : fallback;
    }

    function log(error) {
      if (!disposed) ctx.system.log("消息时间戳：", String(error));
    }

    function allowed(message) {
      return (
        (message?.role === "user" && get("showUser", true)) ||
        (message?.role === "assistant" && get("showAssistant", true))
      );
    }

    function keyFor(message) {
      return message?.id == null
        ? null
        : PREFIX + String(message.id);
    }

    function formatTime(timestamp) {
      const d = new Date(timestamp);
      if (!Number.isFinite(d.getTime())) return "";

      const pad = (n) => String(n).padStart(2, "0");
      const use12 = get("hour12", false);
      const hour = d.getHours();

      let pattern = get("format", "HH:mm");
      if (pattern === "custom") {
        pattern = get("customFormat", "YYYY/MM/DD HH:mm:ss");
      }

      pattern = String(pattern)
        .replace(/[\r\n]/g, " ")
        .slice(0, 120);

      const tokens = {
        YYYY: String(d.getFullYear()),
        MM: pad(d.getMonth() + 1),
        DD: pad(d.getDate()),
        HH: pad(use12 ? hour % 12 || 12 : hour),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
        ddd: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
          d.getDay()
        ],
        A: hour < 12 ? "上午" : "下午",
      };

      let result = pattern.replace(
        /YYYY|MM|DD|HH|mm|ss|ddd|A/g,
        (token) => tokens[token]
      );

      if (use12 && pattern.includes("HH") && !pattern.includes("A")) {
        result = tokens.A + " " + result;
      }

      return result.trim();
    }

    async function loadTime(key) {
      if (cache.has(key)) return cache.get(key);
      if (pending.has(key)) return pending.get(key);

      const task = (async () => {
        try {
          const value = await ctx.system.storage.get(key);
          if (disposed) return null;
          if (cache.has(key)) return cache.get(key);

          const time =
            typeof value === "number" && Number.isFinite(value)
              ? value
              : null;

          cache.set(key, time);
          return time;
        } catch (error) {
          log(error);
          return null;
        }
      })();

      pending.set(key, task);
      try {
        return await task;
      } finally {
        pending.delete(key);
      }
    }

    function hasBackground(style) {
      const color = style.backgroundColor;
      const transparent =
        color === "transparent" ||
        /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(color) ||
        /\/\s*0(?:\.0+)?\s*\)/.test(color);

      return (
        style.backgroundImage !== "none" ||
        (!!color && !transparent)
      );
    }

    // 仅依据 footer 周围的可见 DOM 做兼容识别。
    // 不读取宿主 React 状态或其他内部对象。
    function findBubble(el) {
      const selector = String(get("bubbleSelector", "")).trim();

      if (selector) {
        try {
          return el.parentElement?.closest(selector) || null;
        } catch {
          return null;
        }
      }

      let node = el.parentElement;

      for (let depth = 0; node && depth < 7; depth++) {
        if (node === document.body || node === document.documentElement) {
          break;
        }

        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const radius = Math.max(
          parseFloat(style.borderTopLeftRadius) || 0,
          parseFloat(style.borderTopRightRadius) || 0,
          parseFloat(style.borderBottomLeftRadius) || 0,
          parseFloat(style.borderBottomRightRadius) || 0
        );

        if (
          radius > 0 &&
          hasBackground(style) &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return node;
        }

        node = node.parentElement;
      }

      return null;
    }

    function visibleRect(node) {
      let rect = node.getBoundingClientRect();
      let left = 0;
      let top = 0;
      let right = window.innerWidth;
      let bottom = window.innerHeight;
      let parent = node.parentElement;

      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();

        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, box.left);
          right = Math.min(right, box.right);
        }

        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        }

        parent = parent.parentElement;
      }

      if (
        rect.right <= left ||
        rect.left >= right ||
        rect.bottom <= top ||
        rect.top >= bottom
      ) {
        return null;
      }

      return { rect, left, top, right, bottom };
    }

    function refresh() {
      if (disposed) return;
      for (const view of views) view.render();
    }

    ctx.hooks.on("message.persisted", async ({ message }) => {
      if (
        disposed ||
        !message ||
        !["user", "assistant"].includes(message.role)
      ) {
        return;
      }

      const key = keyFor(message);
      if (!key) return;

      // 在异步读取前捕获时间，避免存储延迟改变发送时间。
      const observedAt = Date.now();

      try {
        const existing = await loadTime(key);
        if (disposed) return;

        if (existing === null) {
          cache.set(key, observedAt);
          refresh();
          await ctx.system.storage.set(key, observedAt);
        } else {
          refresh();
        }
      } catch (error) {
        log(error);
      }
    });

    ctx.ui.slot("message.footer", (el, props) => {
      const message = props.message;
      const key = keyFor(message);

      const label = document.createElement("span");
      const originalStyle = el.getAttribute("style");

      let active = true;
      let bubble = null;
      let marginState = null;

      function restoreMargin() {
        if (!marginState) return;

        const { node, original, priority, applied } = marginState;

        // 不覆盖宿主或其他插件在此期间写入的新样式。
        if (node.style.getPropertyValue("margin-bottom") === applied) {
          if (original) {
            node.style.setProperty("margin-bottom", original, priority);
          } else {
            node.style.removeProperty("margin-bottom");
          }
        }

        marginState = null;
      }

      function reserveSpace(node, height) {
        if (marginState?.node === node) {
          const extra = height + 5;
          const applied = marginState.base + extra + "px";

          if (marginState.applied !== applied) {
            node.style.setProperty("margin-bottom", applied);
            marginState.applied = applied;
          }
          return;
        }

        restoreMargin();

        const base = parseFloat(getComputedStyle(node).marginBottom) || 0;
        const original = node.style.getPropertyValue("margin-bottom");
        const priority = node.style.getPropertyPriority("margin-bottom");
        const applied = base + height + 5 + "px";

        node.style.setProperty("margin-bottom", applied);
        marginState = { node, base, original, priority, applied };
      }

      function hide() {
        label.hidden = true;
        restoreMargin();
      }

      function styleLabel() {
        const align = get("alignment", "right");
        const color = String(get("color", "")).trim();

        label.style.cssText = "";
        Object.assign(label.style, {
          display: "block",
          boxSizing: "border-box",
          fontSize: clamp(get("fontSize", 10), 8, 20, 10) + "px",
          lineHeight: "1.4",
          fontWeight: "400",
          fontStyle: "normal",
          letterSpacing: "0",
          fontVariantNumeric: "tabular-nums",
          opacity: String(clamp(get("opacity", 0.55), 0.1, 1, 0.55)),
          textAlign: ["left", "center", "right"].includes(align)
            ? align
            : "right",
          whiteSpace: "normal",
          overflowWrap: "anywhere",
          pointerEvents: "none",
        });

        // hidden 不能被 display:block 覆盖。
        label.hidden = false;
        return color;
      }

      function layout() {
        if (
          !active ||
          disposed ||
          get("position", "outside") !== "outside" ||
          label.parentElement !== layer ||
          label.hidden
        ) {
          return;
        }

        if (!bubble?.isConnected) {
          hide();
          return;
        }

        const visible = visibleRect(bubble);

        if (!visible) {
          label.style.visibility = "hidden";
          return;
        }

        const { rect, left, top, right, bottom } = visible;
        const width = Math.min(rect.width, right - left);
        const x = Math.max(left, Math.min(rect.left, right - width));

        label.style.width = Math.max(0, width) + "px";
        label.style.left = x + "px";
        label.style.top = rect.bottom + 3 + "px";

        const height = label.getBoundingClientRect().height;
        reserveSpace(bubble, height);

        label.style.visibility =
          rect.bottom + 3 >= top &&
          rect.bottom + 3 + height <= bottom
            ? "visible"
            : "hidden";
      }

      function render() {
        if (!active || disposed) return;

        const mode = get("position", "outside");
        const timestamp = key ? cache.get(key) : null;

        hide();

        if (
          mode === "off" ||
          !allowed(message) ||
          typeof timestamp !== "number"
        ) {
          return;
        }

        const text = formatTime(timestamp);
        if (!text) return;

        label.textContent = text;
        label.setAttribute("aria-label", "消息时间：" + text);

        const color = styleLabel();

        if (mode === "inside") {
          bubble = null;
          el.style.display = "block";
          el.style.width = "100%";
          el.style.boxSizing = "border-box";
          el.style.marginTop = "3px";

          label.style.color = color || "inherit";
          el.replaceChildren(label);
          return;
        }

        // footer 不再承担外部标签的显示，只作为定位锚点。
        el.replaceChildren();
        el.style.marginTop = "0";
        bubble = findBubble(el);

        if (!bubble) {
          hide();

          if (!warned) {
            warned = true;
            ctx.ui.toast(
              "时间戳：未识别到气泡边界，请在插件设置中填写气泡 CSS 选择器。"
            );
          }
          return;
        }

        const bubbleStyle = getComputedStyle(bubble);
        const outerStyle = getComputedStyle(bubble.parentElement || bubble);

        label.style.position = "fixed";
        label.style.fontFamily = bubbleStyle.fontFamily;
        label.style.color = color || outerStyle.color;
        label.style.padding = "0 2px";

        layer.appendChild(label);
        layout();
      }

      const view = { render, layout };
      views.add(view);
      render();

      if (key && !cache.has(key)) {
        loadTime(key).then(() => {
          if (active && !disposed) render();
        }).catch(log);
      }

      return () => {
        active = false;
        views.delete(view);
        restoreMargin();
        label.remove();
        el.replaceChildren();

        if (originalStyle === null) {
          el.removeAttribute("style");
        } else {
          el.setAttribute("style", originalStyle);
        }
      };
    });

    // 用单个刷新循环跟随滚动、布局变化和流式回复。
    let frame = 0;

    function tick() {
      if (disposed) return;

      for (const view of views) {
        view.layout();
      }

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);

    ctx.system.settings.onChange(() => {
      warned = false;
      refresh();
    });

    // 旧版曾把时间写进正文；由用户逐条明确选择清理。
    ctx.ui.messageAction({
      id: "timestamp-remove-legacy",
      label: "清理旧版正文时间戳",
      filter(message) {
        return (
          typeof message?.content === "string" &&
          LEGACY.test(message.content)
        );
      },
      async onSelect(message) {
        if (
          message?.id == null ||
          typeof message.content !== "string" ||
          !LEGACY.test(message.content)
        ) {
          return;
        }

        try {
          await ctx.data.messages.update(message.id, {
            content: message.content.replace(LEGACY, ""),
          });
          ctx.ui.toast("已清理这条消息的旧版时间戳");
        } catch (error) {
          log(error);
          ctx.ui.toast("清理失败，请查看插件日志");
        }
      },
    });

    // 兼容还未清理的旧版消息，不把旧时间标记送给模型。
    ctx.hooks.transform("llm.request", (payload) => {
      if (!Array.isArray(payload.messages)) return payload;

      payload.messages = payload.messages.map((message) => {
        if (!message || !["user", "assistant"].includes(message.role)) {
          return message;
        }

        if (typeof message.content === "string") {
          return {
            ...message,
            content: message.content.replace(LEGACY, ""),
          };
        }

        if (Array.isArray(message.content)) {
          return {
            ...message,
            content: message.content.map((part) => {
              if (part?.type !== "text" || typeof part.text !== "string") {
                return part;
              }

              return {
                ...part,
                text: part.text.replace(LEGACY, ""),
              };
            }),
          };
        }

        return message;
      });

      return payload;
    });

    ctx.hooks.on("message.deleted", async ({ id }) => {
      if (id == null) return;
      const key = PREFIX + String(id);
      cache.delete(key);

      try {
        await ctx.system.storage.remove(key);
      } catch (error) {
        log(error);
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      layer.remove();
      views.clear();
      cache.clear();
    };
  },
};