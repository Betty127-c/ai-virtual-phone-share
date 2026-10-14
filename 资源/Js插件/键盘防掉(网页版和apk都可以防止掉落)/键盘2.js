export default {
  manifest: {
    id: "keep-keyboard-focus",
    name: "静默连发·键盘防掉",
    apiVersion: 1,
    version: "2.0.0",
    author: "小坊",
    description: "无感静默运行：发送消息时保持输入框焦点，键盘与底栏不掉落；收起直接按原生键盘收起键即可。",
    permissions: ["chat.read"],
  },

  setup(ctx) {
    let lastFocusedInput = null;

    // 1. 记录最后一次打字的输入框
    function onFocusIn(e) {
      const target = e.target;
      if (target && (target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && target.type === "text"))) {
        lastFocusedInput = target;
      }
    }

    window.addEventListener("focusin", onFocusIn, true);

    // 2. 核心拦截：当用户点击发送按钮时，阻止输入框失焦导致键盘掉下去
    function handlePointerDown(e) {
      const active = document.activeElement;
      const isInputFocused = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text"));
      if (!isInputFocused) return;

      // 判断点击的是否是发送按钮区域（svg、button、图标等）
      const hitSendBtn = e.target.closest('button, [role="button"], svg, path');
      if (!hitSendBtn) return;

      // 阻止浏览器默认失焦行为（这是键盘下落的根本原因）
      e.preventDefault();

      // 手动触发发送
      hitSendBtn.click();

      // 发送后即刻稳固焦点，保证光标和软键盘完全不闪烁
      requestAnimationFrame(() => {
        if (active && typeof active.focus === "function") {
          active.focus({ preventScroll: true });
        }
      });
    }

    window.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: false });

    // 3. 消息落库后再做一次焦点加固，确保长短句连击畅通无阻
    const unhookPersist = ctx.hooks.on("message.persisted", (payload) => {
      const msg = payload?.message;
      if (msg && msg.role === "user") {
        setTimeout(() => {
          if (lastFocusedInput && typeof lastFocusedInput.focus === "function") {
            lastFocusedInput.focus({ preventScroll: true });
          }
        }, 30);
      }
    });

    // 4. 插件禁用或卸载时的自清理
    return () => {
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      unhookPersist?.();
    };
  },
};