export default {
  manifest: {
    id: "keep-keyboard-focus",
    name: "连发·会话精确定位版",
    apiVersion: 1,
    version: "6.0.0",
    author: "小坊",
    description: "！！！！使用工坊时一定要把这个插件关掉，否则会停止生成！！！。",
    permissions: ["chat.read"],
  },

  setup(ctx) {
    let currentSessionId = null;
    let lastChatInput = null;

    // 1. 核心闸门：使用官方会话事件，只有进入了角色会话才激活功能！
    const unhookSession = ctx.hooks.on("session.opened", (payload) => {
      // 捕获真实的角色聊天会话
      currentSessionId = payload?.sessionId || null;
    });

    // 辅助检查：当前是否在角色聊天室（且绝对不在工坊等系统内置功能里）
    function isInTargetChat() {
      // 只要工坊输入框存在，或者页面有工坊相关特征，坚决判定为工坊，一律不工作
      const inWorkshop = (
        document.querySelector('.workshop-page, [data-app="workshop"]') ||
        document.body.innerText.includes("我是小坊") ||
        window.location.href.includes("workshop")
      );
      if (inWorkshop) return false;

      // 必须有激活的会话 ID
      return Boolean(currentSessionId);
    }

    // 2. 监听输入框焦点
    function onFocusIn(e) {
      if (!isInTargetChat()) return;
      const t = e.target;
      if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && t.type === "text"))) {
        lastChatInput = t;
      }
    }
    window.addEventListener("focusin", onFocusIn, true);

    // 3. 辅助判断：是否是发送小飞机
    function isSendButton(target) {
      if (!target) return false;
      const btn = target.closest('button, [role="button"], div[class*="cursor-pointer"]');
      if (!btn) return false;

      // 特征排除：如果是加号、表情包、定位、语音图标，坚决不是发送键！
      const html = btn.outerHTML || "";
      if (
        html.includes("plus") || html.includes("Plus") ||
        html.includes("smile") || html.includes("Smile") ||
        html.includes("map-pin") || html.includes("mic") ||
        html.includes("sparkles")
      ) {
        return false;
      }

      // 发送特征：包含 send、小飞机路径或者中文发送
      return (
        btn.getAttribute("aria-label")?.includes("发送") ||
        btn.title?.includes("发送") ||
        html.includes("send") || html.includes("Send") ||
        html.includes("M22 2") || html.includes("m22 2")
      );
    }

    // 4. 精准触摸事件拦截
    function handlePointerDown(e) {
      // 第一道铁律：如果不是在角色聊天室（比如在工坊跟我说话），100% 放行，不执行任何代码！
      if (!isInTargetChat()) return;

      const target = e.target;

      // 如果点的是输入框本体，正常放行
      if (target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && target.type === "text")) {
        return;
      }

      // 如果点在表情包或者已展开的菜单面板内部：放行让宿主处理，同时不要让面板缩回去
      const insidePanel = target.closest(
        '[class*="emoji"], [class*="picker"], [class*="panel"], [role="tablist"], .grid'
      );
      if (insidePanel) {
        // 允许连点表情，阻止多余失焦
        e.stopPropagation();
        return;
      }

      // 【核心解决加号/表情切换】：
      // 如果点击的是加号（+）或者表情按钮：
      // 我们【绝对不主动调用 blur()】，让浏览器和宿主原生事件平稳交接！
      // 宿主会自动把键盘替换成加号面板，一步到位，绝不再来回下落！
      const isSwitchPanelBtn = target.closest(
        '[aria-label*="表情"], [title*="表情"], [aria-label*="更多"], [title*="更多"], [aria-label*="添加"]'
      ) || (target.closest("button") && (
        target.closest("button").innerHTML.includes("plus") ||
        target.closest("button").innerHTML.includes("smile")
      ));

      if (isSwitchPanelBtn) {
        // 直接放行给宿主，完美切换
        return;
      }

      // 【核心保留连发】：只有点击发送小飞机时，才阻止键盘下落！
      if (isSendButton(target)) {
        const active = document.activeElement;
        const isEditing = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text"));

        if (isEditing) {
          e.preventDefault(); // 阻止失焦掉键盘

          // 触发发送
          const sendBtn = target.closest('button, [role="button"]') || target;
          sendBtn.click();

          // 锁住焦点不闪烁
          requestAnimationFrame(() => {
            if (active && typeof active.focus === "function") {
              active.focus({ preventScroll: true });
            }
          });
        }
      }
    }

    window.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: false });

    // 5. 消息完成落库后的安全保障
    const unhookPersist = ctx.hooks.on("message.persisted", (payload) => {
      if (!isInTargetChat()) return;
      const msg = payload?.message;
      if (msg && msg.role === "user") {
        setTimeout(() => {
          if (lastChatInput && document.activeElement === lastChatInput) {
            lastChatInput.focus({ preventScroll: true });
          }
        }, 30);
      }
    });

    // 6. 卸载清理
    return () => {
      unhookSession?.();
      unhookPersist?.();
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    };
  },
};