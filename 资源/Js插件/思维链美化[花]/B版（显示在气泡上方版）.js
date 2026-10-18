export default {
  manifest: {
    id: "inline-reasoning-v21",
    name: "内联美化思维链(显示在气泡上方)",
    apiVersion: 1,
    version: "2.1.0",
    author: "deepseek",
    description: "完美与头像齐平，展开往下推气泡，且英文为默认字体",
    permissions: ["chat.read"],
    settings: [
      { key: "defaultExpanded", label: "默认展开思维链", type: "boolean", default: false },
      { key: "headerText", label: "标题文字", type: "text", default: "💭思考过程" },
      { key: "headerColor", label: "标题颜色", type: "text", default: "#888888" },
      { key: "headerSize", label: "标题字号(px)", type: "number", default: 14 },
      { key: "lineColor", label: "左侧竖线颜色", type: "text", default: "#dddddd" },
      { key: "contentColor", label: "思考内容颜色", type: "text", default: "#666666" },
      { key: "contentSize", label: "思考内容字号(px)", type: "number", default: 13 }
    ]
  },

  setup(ctx) {
    const applySettings = () => {
      const root = document.documentElement;
      root.style.setProperty("--my-think-h-color", ctx.system.settings.get("headerColor") || "#888888");
      root.style.setProperty("--my-think-h-size", (Number(ctx.system.settings.get("headerSize")) || 14) + "px");
      root.style.setProperty("--my-think-line-color", ctx.system.settings.get("lineColor") || "#dddddd");
      root.style.setProperty("--my-think-c-color", ctx.system.settings.get("contentColor") || "#666666");
      root.style.setProperty("--my-think-c-size", (Number(ctx.system.settings.get("contentSize")) || 13) + "px");

      const newText = String(ctx.system.settings.get("headerText") || "思考过程");
      document.querySelectorAll('.my-inline-thought-head span').forEach(span => {
        span.textContent = newText;
      });
    };
    
    applySettings();
    try { ctx.system.settings.onChange(applySettings); } catch(e) {}

    ctx.ui.injectCSS(`
      /* 隐藏原生按钮 */
      .chat-reasoning-trigger {
        display: none !important;
      }

      /* 
       * ⭐ 核心魔法：强行把气泡的宽度改为 fit-content（只包裹文字本身）
       * 这样即使上方的思维链再宽，气泡也不会跟着横向拉伸了！
       */
      .chat-bubble-role-user:not(.chat-bubble-media):not(.voice-msg-bubble),
      .chat-bubble-role-assistant:not(.chat-bubble-media):not(.voice-msg-bubble) {
        width: fit-content !important;
        max-width: 100% !important;
        display: inline-block !important;
      }

      /* 我们的思维链面板 */
      .my-inline-thought {
        margin: 0 0 8px 0 !important;
        background: transparent !important;
        border: none !important;
        width: 100% !important; 
        box-sizing: border-box !important;
      }

      /* 折叠栏 */
      .my-inline-thought-head {
        padding: 4px 0;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 4px;
        color: var(--my-think-h-color);
        font-size: var(--my-think-h-size);
        font-weight: normal;
      }

      /* 箭头 */
      .my-thought-arrow {
        transition: transform 0.3s ease;
        transform: rotate(-90deg); 
      }
      .my-thought-arrow.open {
        transform: rotate(0deg);
      }

      /* 内容区：去掉了打字机字体，采用默认紧凑字体 */
      .my-inline-thought-content {
        padding: 4px 0 4px 12px;
        margin-top: 4px;
        border-left: 2px solid var(--my-think-line-color);
        color: var(--my-think-c-color);
        font-size: var(--my-think-c-size);
        white-space: pre-wrap !important;
        word-break: break-word !important; 
        line-height: 1.5;
      }
      
      .my-inline-thought-content.hide {
        display: none;
      }
    `);

    ctx.ui.slot("message.footer", (el, props) => {
      const msg = props.message;
      if (!msg || msg.role !== 'assistant') return;

      const thinkText = msg.reasoningText || msg.reasoning_content || msg.reasoning || msg.thought;
      if (!thinkText) return;

      const wrapper = el.closest('.chat-msg-wrapper');
      if (!wrapper) return;

      const reasoningRow = wrapper.previousElementSibling;
      if (!reasoningRow || !reasoningRow.hasAttribute('data-reasoning-row')) return;

      if (wrapper.querySelector('.my-inline-thought')) return;

      const contentWrap = wrapper.querySelector('.chat-msg-content-wrap');
      if (!contentWrap) return;

      // 隐藏原生那个没用的触发条
      reasoningRow.style.display = 'none';

      const isExpanded = ctx.system.settings.get("defaultExpanded") || false;
      const headerText = String(ctx.system.settings.get("headerText") || "思考过程");

      const box = document.createElement('div');
      box.className = 'my-inline-thought';
      
      box.innerHTML = `
        <div class="my-inline-thought-head">
          <span>${headerText}</span>
          <svg class="my-thought-arrow ${isExpanded ? 'open' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="my-inline-thought-content ${isExpanded ? '' : 'hide'}">${thinkText}</div>
      `;

      box.querySelector('.my-inline-thought-head').onclick = () => {
        const content = box.querySelector('.my-inline-thought-content');
        const arrow = box.querySelector('.my-thought-arrow');
        content.classList.toggle('hide');
        arrow.classList.toggle('open');
      };

      // 塞进气泡容器的最顶部（完美实现向下推气泡）
      contentWrap.insertBefore(box, contentWrap.firstChild);
    });
  }
};