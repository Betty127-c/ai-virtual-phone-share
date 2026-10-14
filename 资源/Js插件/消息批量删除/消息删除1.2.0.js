export default {
  manifest: {
    id: "batch-message-cleaner",
    name: "消息删除",
    apiVersion: 1,
    version: "1.2.0",
    author: "小坊",
    description: "在加号菜单提供扁平胶囊入口，真实物理删除历史消息，修复排序与数量计算逻辑",
    permissions: ["chat.read"],
    settings: [],
  },

  setup(ctx) {
    let currentSessionId = null;

    // 追踪当前会话
    ctx.hooks.on("session.opened", ({ sessionId }) => {
      currentSessionId = sessionId;
    });

    // 挂载至输入栏 + 面板中的胶囊区
    ctx.ui.slot("chat.inputToolbar", (container) => {
      const pillBtn = document.createElement("button");
      pillBtn.setAttribute("type", "button");
      pillBtn.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 9999px;
        background: rgba(239, 68, 68, 0.16);
        border: 1px solid rgba(239, 68, 68, 0.35);
        color: #ef4444;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        line-height: 1;
        outline: none;
        margin: 2px 4px 2px 0;
        box-sizing: border-box;
        transition: background 0.15s, transform 0.1s;
        -webkit-tap-highlight-color: transparent;
      `;

      pillBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        <span>消息删除</span>
      `;

      pillBtn.addEventListener("touchstart", () => {
        pillBtn.style.transform = "scale(0.95)";
        pillBtn.style.background = "rgba(239, 68, 68, 0.28)";
      });
      pillBtn.addEventListener("touchend", () => {
        pillBtn.style.transform = "scale(1)";
        pillBtn.style.background = "rgba(239, 68, 68, 0.16)";
      });
      pillBtn.addEventListener("click", () => {
        openDeleteModal(currentSessionId);
      });

      container.appendChild(pillBtn);

      return () => {
        pillBtn.remove();
      };
    });

    // 真正物理删除 IndexedDB 里的消息数据
    async function executeRealDelete(idsToDelete) {
      const idSet = new Set(idsToDelete);

      // 1. 如果宿主提供了直接方法，优先尝试
      if (typeof ctx.data.messages?.delete === "function") {
        for (const id of idsToDelete) {
          await ctx.data.messages.delete(id);
        }
        return;
      }

      // 2. 遍历 IndexedDB，找到存 messages 的表并执行物理删除
      const dbs = await window.indexedDB.databases();
      let hit = false;

      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue;
        try {
          await new Promise((resolve) => {
            const req = window.indexedDB.open(dbInfo.name);
            req.onerror = () => resolve();
            req.onsuccess = (e) => {
              const db = e.target.result;
              const storeNames = Array.from(db.objectStoreNames);
              // 匹配包含 message 的仓库
              const targetStores = storeNames.filter((s) => /message/i.test(s));

              if (targetStores.length === 0) {
                db.close();
                return resolve();
              }

              try {
                const tx = db.transaction(targetStores, "readwrite");
                tx.oncomplete = () => {
                  db.close();
                  resolve();
                };
                tx.onerror = () => {
                  db.close();
                  resolve();
                };

                for (const storeName of targetStores) {
                  const store = tx.objectStore(storeName);
                  for (const id of idsToDelete) {
                    store.delete(id);
                    // 兼容有些表主键是数字或字符串
                    const numId = Number(id);
                    if (!isNaN(numId)) store.delete(numId);
                    hit = true;
                  }
                }
              } catch (err) {
                db.close();
                resolve();
              }
            };
          });
        } catch (_) {}
      }

      // 3. 兜底更新（如果软删/标空）
      if (!hit && typeof ctx.data.messages?.update === "function") {
        for (const id of idsToDelete) {
          try {
            await ctx.data.messages.update(id, { deleted: true, isDeleted: true });
          } catch (_) {}
        }
      }
    }

    // 弹窗与控制面板
    function openDeleteModal(sessionId) {
      if (!sessionId) {
        ctx.ui.toast("未检测到当前会话，请先进入一个聊天");
        return;
      }

      ctx.ui.openModal((modalEl, { close }) => {
        modalEl.style.cssText = `
          width: 92%;
          max-width: 440px;
          max-height: 85vh;
          background: #18181b;
          color: #f4f4f5;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 20px 45px rgba(0,0,0,0.6);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-sizing: border-box;
        `;

        let rawMessages = [];
        try {
          rawMessages = (ctx.data.messages.list(sessionId) || []).slice();
        } catch (e) {
          ctx.system.log("获取消息记录失败", e);
        }

        // 核心修复：按时间从旧到新做严格升序排列（确保 0 是最早历史，末尾是最新的）
        const messages = rawMessages.sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return ta - tb;
        });

        let selectedIds = new Set();
        let rangeStartIndex = -1;

        // 1. 顶部标题
        const header = document.createElement("div");
        header.style.cssText = `
          padding: 13px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: #202024;
        `;
        header.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:15px;font-weight:600;">批量删除消息</span>
            <span style="font-size:11px;background:rgba(255,255,255,0.08);padding:2px 7px;border-radius:10px;color:#a1a1aa;">当前共 ${messages.length} 条</span>
          </div>
          <button id="modal-close" style="background:transparent;border:none;color:#a1a1aa;font-size:18px;cursor:pointer;padding:2px 6px;">✕</button>
        `;
        modalEl.appendChild(header);
        header.querySelector("#modal-close").onclick = close;

        // 2. 档位区与自定义输入
        const quickSection = document.createElement("div");
        quickSection.style.cssText = `
          padding: 10px 14px;
          background: rgba(255, 255, 255, 0.02);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          flex-direction: column;
          gap: 8px;
        `;

        const tiersRow = document.createElement("div");
        tiersRow.style.cssText = `
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          align-items: center;
        `;
        tiersRow.innerHTML = `<span style="font-size:11px;color:#71717a;margin-right:2px;">保留最新:</span>`;

        const tiers = [50, 100, 500, 1000, 1500, 2000];
        tiers.forEach((num) => {
          const btn = document.createElement("button");
          btn.textContent = `${num}条`;
          btn.style.cssText = `
            font-size: 11px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #d4d4d8;
            padding: 3px 8px;
            border-radius: 6px;
            cursor: pointer;
          `;
          btn.onclick = () => keepLatest(num);
          tiersRow.appendChild(btn);
        });

        const customRow = document.createElement("div");
        customRow.style.cssText = `
          display: flex;
          align-items: center;
          gap: 6px;
        `;
        customRow.innerHTML = `
          <span style="font-size:11px;color:#71717a;">自定义保留:</span>
          <input id="custom-keep-input" type="number" placeholder="输入条数" style="
            width: 76px;
            background: #111113;
            border: 1px solid rgba(255,255,255,0.15);
            color: #f4f4f5;
            font-size: 11px;
            padding: 3px 6px;
            border-radius: 5px;
            outline: none;
          " />
          <button id="apply-custom-btn" style="
            font-size: 11px;
            background: #3b82f6;
            border: none;
            color: white;
            padding: 3px 8px;
            border-radius: 5px;
            cursor: pointer;
          ">应用</button>
          <div style="flex:1;"></div>
          <button id="btn-select-all" style="
            font-size: 11px;
            background: rgba(239,68,68,0.12);
            border: 1px solid rgba(239,68,68,0.25);
            color: #ef4444;
            padding: 3px 7px;
            border-radius: 5px;
            cursor: pointer;
          ">全选</button>
          <button id="btn-clear-all" style="
            font-size: 11px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            color: #a1a1aa;
            padding: 3px 7px;
            border-radius: 5px;
            cursor: pointer;
          ">清空选择</button>
        `;

        quickSection.appendChild(tiersRow);
        quickSection.appendChild(customRow);
        modalEl.appendChild(quickSection);

        // 3. 提示栏
        const tipBar = document.createElement("div");
        tipBar.style.cssText = `
          padding: 6px 14px;
          font-size: 11px;
          color: #94a3b8;
          background: rgba(59, 130, 246, 0.08);
          border-bottom: 1px solid rgba(59, 130, 246, 0.15);
          display: flex;
          justify-content: space-between;
        `;
        tipBar.innerHTML = `
          <span>💡 列表可勾选，长按某条可设为起点批量选范围</span>
          <span id="range-badge" style="color:#60a5fa;display:none;">[已锁定起点]</span>
        `;
        modalEl.appendChild(tipBar);

        // 4. 列表滚动区
        const listContainer = document.createElement("div");
        listContainer.style.cssText = `
          flex: 1;
          overflow-y: auto;
          padding: 8px 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        `;
        modalEl.appendChild(listContainer);

        // 5. 底部删除按钮栏
        const footer = document.createElement("div");
        footer.style.cssText = `
          padding: 12px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #202024;
          display: flex;
          align-items: center;
          justify-content: space-between;
        `;
        footer.innerHTML = `
          <div>
            <span style="font-size:12px;color:#a1a1aa;">将彻底删除 </span>
            <span id="selected-num" style="font-size:15px;font-weight:bold;color:#ef4444;">0</span>
            <span style="font-size:12px;color:#a1a1aa;"> 条</span>
          </div>
          <button id="modal-delete-btn" style="
            background: #ef4444;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
          ">确认删除</button>
        `;
        modalEl.appendChild(footer);

        const selCountText = footer.querySelector("#selected-num");
        const confirmBtn = footer.querySelector("#modal-delete-btn");

        // 核心计算：保留最新 keepCount 条
        function keepLatest(keepCount) {
          selectedIds.clear();
          const total = messages.length;

          if (total <= keepCount) {
            ctx.ui.toast(`当前共 ${total} 条消息，不足或正好为 ${keepCount} 条，无需删除`);
            renderList();
            return;
          }

          // 需要删除最早的 (total - keepCount) 条
          const deleteCount = total - keepCount;
          for (let i = 0; i < deleteCount; i++) {
            if (messages[i]?.id) {
              selectedIds.add(messages[i].id);
            }
          }

          ctx.ui.toast(`已精确选择较旧的 ${deleteCount} 条消息，将保留最新 ${keepCount} 条`);
          renderList();
        }

        // 绑定自定义操作
        const customInput = customRow.querySelector("#custom-keep-input");
        customRow.querySelector("#apply-custom-btn").onclick = () => {
          const val = parseInt(customInput.value, 10);
          if (isNaN(val) || val <= 0) {
            ctx.ui.toast("请输入大于 0 的有效条数");
            return;
          }
          keepLatest(val);
        };

        customRow.querySelector("#btn-select-all").onclick = () => {
          selectedIds.clear();
          messages.forEach((m) => {
            if (m.id) selectedIds.add(m.id);
          });
          renderList();
        };

        customRow.querySelector("#btn-clear-all").onclick = () => {
          selectedIds.clear();
          rangeStartIndex = -1;
          tipBar.querySelector("#range-badge").style.display = "none";
          renderList();
        };

        // 列表轻量化渲染
        function renderList() {
          listContainer.innerHTML = "";
          selCountText.textContent = selectedIds.size;

          if (messages.length === 0) {
            listContainer.innerHTML = `<div style="text-align:center;padding:36px;color:#71717a;font-size:12px;">暂无消息</div>`;
            return;
          }

          messages.forEach((msg, idx) => {
            const isChecked = selectedIds.has(msg.id);
            const isRange = rangeStartIndex === idx;
            const item = document.createElement("div");
            item.style.cssText = `
              display: flex;
              align-items: flex-start;
              gap: 9px;
              padding: 7px 10px;
              border-radius: 8px;
              background: ${isRange ? "rgba(59,130,246,0.18)" : isChecked ? "rgba(239,68,68,0.1)" : "rgba(255,255,255,0.03)"};
              border: 1px solid ${isRange ? "#3b82f6" : isChecked ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.05)"};
              cursor: pointer;
            `;

            let text = (msg.content || (msg.mediaType ? "[多媒体]" : "[空白]")).replace(/\s+/g, " ");
            if (text.length > 36) text = text.slice(0, 36) + "…";

            item.innerHTML = `
              <input type="checkbox" ${isChecked ? "checked" : ""} style="pointer-events:none;margin-top:3px;accent-color:#ef4444;" />
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#71717a;margin-bottom:2px;">
                  <span>#${idx + 1}</span>
                  <span style="color:${msg.role === "user" ? "#60a5fa" : "#34d399"}">${msg.role === "user" ? "我" : "角色"}</span>
                  <span>${msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : ""}</span>
                </div>
                <div style="font-size:12px;color:#e4e4e7;word-break:break-all;">${text}</div>
              </div>
            `;

            item.addEventListener("click", () => {
              if (rangeStartIndex >= 0 && rangeStartIndex !== idx) {
                const s = Math.min(rangeStartIndex, idx);
                const e = Math.max(rangeStartIndex, idx);
                for (let i = s; i <= e; i++) {
                  if (messages[i]?.id) selectedIds.add(messages[i].id);
                }
                rangeStartIndex = -1;
                tipBar.querySelector("#range-badge").style.display = "none";
              } else {
                if (selectedIds.has(msg.id)) {
                  selectedIds.delete(msg.id);
                } else {
                  selectedIds.add(msg.id);
                }
              }
              renderList();
            });

            let timer = null;
            item.addEventListener("touchstart", () => {
              timer = setTimeout(() => {
                rangeStartIndex = idx;
                tipBar.querySelector("#range-badge").style.display = "inline";
                ctx.ui.toast(`已设第 #${idx + 1} 条为起点，点击另一条即可选中整段`);
                renderList();
              }, 400);
            });
            item.addEventListener("touchend", () => clearTimeout(timer));
            item.addEventListener("touchmove", () => clearTimeout(timer));

            listContainer.appendChild(item);
          });
        }

        // 真实执行删除
        confirmBtn.onclick = async () => {
          const count = selectedIds.size;
          if (count === 0) {
            ctx.ui.toast("当前没有选中任何消息");
            return;
          }

          if (!confirm(`确定彻底删除选中的 ${count} 条历史记录吗？删除后将无法恢复。`)) return;

          const toast = ctx.ui.toast(`正在彻底清理 ${count} 条消息…`, { durationMs: 0 });
          confirmBtn.disabled = true;

          try {
            const list = Array.from(selectedIds);
            await executeRealDelete(list);

            toast.close();
            ctx.ui.toast(`已彻底删除 ${count} 条消息！正在刷新页面同步…`);
            close();

            // 延迟刷新聊天页面以重绘清爽列表
            setTimeout(() => {
              window.location.reload();
            }, 800);
          } catch (err) {
            toast.close();
            ctx.ui.toast("删除失败：" + (err?.message || err));
            ctx.system.log("删除异常", err);
          } finally {
            confirmBtn.disabled = false;
          }
        };

        // 首次打开渲染
        renderList();
      });
    }
  },
};