/* 角色卡 PNG / 世界书 JSON 解析器 */
export default {
  manifest: {
    id: "card-lore-parser",
    name: "角色卡/世界书解析器",
    apiVersion: 1,
    version: "1.0.0",
    author: "assistant",
    description: "解析酒馆导出的角色卡 PNG 与世界书 JSON，提取文字并一键复制",
  },
  setup(ctx) {
    ctx.ui.injectCSS(`
.pcp-root{display:flex;flex-direction:column;gap:12px;min-width:280px;max-width:460px;box-sizing:border-box;padding:4px;}
.pcp-title{font-size:16px;font-weight:600;}
.pcp-sub{font-size:12px;opacity:.6;}
.pcp-btns{display:flex;gap:8px;flex-wrap:wrap;}
.pcp-btn{flex:1;min-width:0;padding:10px 8px;border-radius:10px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-size:14px;cursor:pointer;}
.pcp-btn:active{opacity:.6;}
.pcp-btn-primary{background:rgba(90,140,255,.15);border-color:rgba(90,140,255,.5);}
.pcp-tabs{display:flex;gap:6px;}
.pcp-tab{flex:1;padding:7px;border-radius:8px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font-size:13px;cursor:pointer;}
.pcp-tab.active{background:rgba(90,140,255,.2);border-color:rgba(90,140,255,.6);}
.pcp-out{width:100%;height:200px;resize:vertical;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid rgba(128,128,128,.35);background:rgba(0,0,0,.12);color:inherit;font-size:12px;line-height:1.5;font-family:inherit;}
.pcp-actions{display:flex;gap:8px;}
.pcp-entry{padding:6px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer;margin:4px;}
`);

    // ================= 解析工具 =================
    function decodeB64(b64) {
      let s = String(b64).replace(/\s+/g, "");
      while (s.length % 4) s += "=";
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }

    function parsePngTextChunks(buf) {
      const bytes = new Uint8Array(buf);
      const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (bytes.length < 8) throw new Error("文件太小，不是 PNG");
      for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error("不是有效的 PNG 文件");
      const view = new DataView(buf);
      const chunks = {};
      let off = 8;
      while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const dStart = off + 8;
        const dEnd = dStart + len;
        if (dEnd > bytes.length) break;
        if (type === "tEXt") {
          const data = bytes.subarray(dStart, dEnd);
          let nul = -1;
          for (let i = 0; i < data.length; i++) if (data[i] === 0) { nul = i; break; }
          if (nul >= 0) {
            let key = "", val = "";
            for (let i = 0; i < nul; i++) key += String.fromCharCode(data[i]);
            for (let i = nul + 1; i < data.length; i++) val += String.fromCharCode(data[i]);
            chunks[key] = val;
          }
        }
        off = dEnd + 4;
      }
      return chunks;
    }

    function extractCharacter(chunks) {
      let raw = null;
      if (chunks["ccv3"]) raw = decodeB64(chunks["ccv3"]);
      else if (chunks["chara"]) raw = decodeB64(chunks["chara"]);
      if (!raw) throw new Error("PNG 里没有角色卡数据（缺少 chara/ccv3 文本块）");
      let json;
      try { json = JSON.parse(raw); }
      catch (e) { throw new Error("角色卡 JSON 解析失败，可能不是角色卡 PNG"); }
      const card = json && typeof json === "object" && "data" in json ? json.data : json;
      if (!card || typeof card !== "object") throw new Error("角色卡数据为空");
      return card;
    }

    function charToText(card) {
      const out = [];
      const add = (label, val) => {
        if (val != null && String(val).trim()) out.push("【" + label + "】\n" + String(val).trim());
      };
      add("名字", card.name);
      add("描述", card.description);
      add("性格", card.personality);
      add("情景", card.scenario);
      add("开场白/第一条消息", card.first_mes);
      add("对话示例", card.mes_example);
      add("系统提示", card.system_prompt);
      add("备注", card.creator_notes);
      add("后置指令", card.post_history_instructions);
      const cb = card.character_book;
      if (cb && cb.entries && Array.isArray(cb.entries)) {
        const parts = [];
        for (const e of cb.entries) {
          if (e && e.enabled === false) continue;
          const keys = Array.isArray(e.keys) ? e.keys.join(", ") : (e.keys || "");
          const title = e.comment || e.name || e.id || "条目";
          parts.push("[" + title + "] " + (keys ? "关键词：" + keys + "\n" : "") + (e.content || ""));
        }
        if (parts.length) add("世界书（卡内嵌入）", parts.join("\n\n"));
      }
      return out.join("\n\n") || "（未提取到文字内容）";
    }

    function parseLorebook(json) {
      let entries = [];
      if (Array.isArray(json)) entries = json;
      else if (json && typeof json === "object" && json.entries) {
        entries = Array.isArray(json.entries) ? json.entries : Object.values(json.entries);
      } else if (json && typeof json === "object" && Array.isArray(json.data)) {
        entries = json.data;
      }
      if (!entries.length) throw new Error("没找到世界书条目（entries 为空）");
      return entries;
    }

    function lorebookToText(entries) {
      return entries.map((e, i) => {
        const keys = Array.isArray(e.keys) ? e.keys.join(", ") : (e.keys || "");
        const title = e.comment || e.name || e.id || ("条目" + (i + 1));
        const tags = [];
        if (e.constant) tags.push("恒定");
        if (e.enabled === false) tags.push("停用");
        let head = "【" + title + "】" + (tags.length ? "（" + tags.join("/") + "）" : "");
        if (keys) head += "\n关键词：" + keys;
        return head + "\n" + (e.content || "");
      }).join("\n\n");
    }

    function readAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(file);
      });
    }
    function readAsText(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsText(file);
      });
    }
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (_) {}
        document.body.removeChild(ta);
        return ok;
      }
    }

    // ================= 解析器浮层 =================
    let lastOpen = 0;
    function openParser() {
      const now = Date.now();
      if (now - lastOpen < 500) return;
      lastOpen = now;

      ctx.ui.openModal((el, { close }) => {
        el.innerHTML = `
<div class="pcp-root">
  <div>
    <div class="pcp-title">📇 角色卡 / 世界书 解析器</div>
    <div class="pcp-sub">选文件 → 自动解析 → 一键复制</div>
  </div>
  <div class="pcp-btns">
    <button class="pcp-btn pcp-btn-primary pcp-btn-char">🖼 选角色卡 PNG</button>
    <button class="pcp-btn pcp-btn-primary pcp-btn-book">📚 选世界书 JSON</button>
  </div>
  <input type="file" class="pcp-file-char" accept=".png,image/png" hidden>
  <input type="file" class="pcp-file-book" accept=".json,application/json" hidden>
  <div class="pcp-tabs">
    <button class="pcp-tab active" data-fmt="text">文本</button>
    <button class="pcp-tab" data-fmt="json">JSON</button>
  </div>
  <textarea class="pcp-out" readonly placeholder="选择文件后，解析结果会显示在这里…"></textarea>
  <div class="pcp-actions">
    <button class="pcp-btn pcp-btn-copy">📋 复制</button>
    <button class="pcp-btn pcp-btn-clear">🗑 清空</button>
    <button class="pcp-btn pcp-btn-close">✕ 关闭</button>
  </div>
</div>`;

        let result = null;   // { text, json }
        let fmt = "text";
        const out = el.querySelector(".pcp-out");
        const charInput = el.querySelector(".pcp-file-char");
        const bookInput = el.querySelector(".pcp-file-book");
        const tabs = Array.from(el.querySelectorAll(".pcp-tab"));

        function render() {
          if (!result) { out.value = ""; return; }
          out.value = fmt === "json" ? JSON.stringify(result.json, null, 2) : result.text;
        }
        function setActiveTab() {
          tabs.forEach((b) => b.classList.toggle("active", b.dataset.fmt === fmt));
        }

        el.querySelector(".pcp-btn-char").onclick = () => charInput.click();
        el.querySelector(".pcp-btn-book").onclick = () => bookInput.click();
        el.querySelector(".pcp-btn-close").onclick = () => close();
        el.querySelector(".pcp-btn-clear").onclick = () => {
          result = null; fmt = "text"; setActiveTab(); render();
          ctx.ui.toast("已清空");
        };
        el.querySelector(".pcp-btn-copy").onclick = async () => {
          if (!out.value) { ctx.ui.toast("没有可复制的内容"); return; }
          const ok = await copyText(out.value);
          ctx.ui.toast(ok ? "已复制 ✅" : "复制失败，请手动全选复制");
        };
        tabs.forEach((b) => {
          b.onclick = () => { fmt = b.dataset.fmt; setActiveTab(); render(); };
        });

        charInput.onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const t = ctx.ui.toast("解析角色卡中…", { durationMs: 0 });
          try {
            const buf = await readAsArrayBuffer(file);
            const card = extractCharacter(parsePngTextChunks(buf));
            result = { text: charToText(card), json: card };
            fmt = "text"; setActiveTab(); render();
            ctx.ui.toast("解析成功 ✅");
          } catch (err) {
            ctx.ui.toast("解析失败：" + (err && err.message ? err.message : err));
          } finally {
            t.close();
          }
          e.target.value = "";
        };

        bookInput.onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          const t = ctx.ui.toast("解析世界书中…", { durationMs: 0 });
          try {
            const text = await readAsText(file);
            const json = JSON.parse(text);
            const entries = parseLorebook(json);
            result = { text: lorebookToText(entries), json: entries };
            fmt = "text"; setActiveTab(); render();
            ctx.ui.toast("解析成功 ✅");
          } catch (err) {
            ctx.ui.toast("解析失败：" + (err && err.message ? err.message : err));
          } finally {
            t.close();
          }
          e.target.value = "";
        };
      });
    }

    // ================= 入口 =================
    ctx.ui.slot("chat.header", (el) => {
      const b = document.createElement("button");
      b.textContent = "📇 解析卡片";
      b.className = "pcp-entry";
      b.onclick = openParser;
      el.appendChild(b);
    });

    ctx.ui.slot("settings.section", (el) => {
      const b = document.createElement("button");
      b.textContent = "📇 打开角色卡/世界书解析器";
      b.className = "pcp-entry";
      b.onclick = openParser;
      el.appendChild(b);
    });
  },
};
