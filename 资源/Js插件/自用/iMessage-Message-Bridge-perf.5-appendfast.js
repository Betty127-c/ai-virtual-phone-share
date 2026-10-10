/* Reimplemented from the room-local grouping idea in 初智齿's
 * 末尾气泡标记.js. No Float core patches or chat writes. */
export default {
  manifest: {
    id: "imessage-native-message-bridge",
    name: "iMessage · 分组与原生外观适配",
    apiVersion: 1,
    version: "1.1.0-alpha.7-music.2-perf.5-appendfast",
    author: "Auren · Chloe 自用适配",
    description: "只处理已导入 iMessage Native Day CSS 的聊天室；动态头像、独立消息分组、真实状态、语音外观。",
    permissions: ["chat.read", "ui"],
    settings: [{ key: "receiptStyle", label: "sent 状态显示方式", type: "select", default: "truthful", options: [
      { value: "truthful", label: "已发送（Float 实际语义）" },
      { value: "reference", label: "已送达（截图外观模拟）" },
      { value: "off", label: "不显示成功回执" }
    ], description: "Float 的 sent 是本地保存状态。外观模拟只更换显示文字，不代表真实设备送达；发送中和失败仍显示。" }]
  },
  setup(ctx) {
    const rooms = new Map();
    const off = [];
    let frame = 0, disposed = false;
    // ResizeObserver already delivers a batched post-layout callback before paint.
    // Update the absolutely-positioned SVG path in that delivery so translation /
    // transcription expansion cannot expose a one-frame stale contour.
    const resizeObserver = new ResizeObserver(entries => {
      for (const {target} of entries) {
        for (const state of rooms.values()) {
          if (!state.outlines.has(target)) continue;
          if (target.isConnected && target.getClientRects().length) outline(target,state,true);
          break;
        }
      }
    });
    // Exact SVG geometry is expensive in month-long rooms. Keep only near-viewport
    // bubbles upgraded; offscreen bubbles use the CSS fallback until they approach.
    const geometryOwners = new WeakMap();
    const geometryObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state=geometryOwners.get(entry.target);
        if (!state || !entry.target.isConnected || !state.geometry.has(entry.target)) continue;
        outline(entry.target,state,entry.isIntersecting);
      }
    },{root:null,rootMargin:'800px 0px',threshold:0}) : null;
    const bubbleSelector = '.chat-bubble-role-user, .chat-bubble-role-assistant';
    const flag = (el, name, enabled) => { if (el.classList.contains(name) !== !!enabled) el.classList.toggle(name, !!enabled); };
    const attr = (el, name, value) => {
      let changed = false;
      if (value == null) {
        if (el.hasAttribute(name)) { el.removeAttribute(name); changed = true; }
      } else if (el.getAttribute(name) !== String(value)) {
        el.setAttribute(name, String(value)); changed = true;
      }
      return changed;
    };
    const own = (el, state) => { el.dataset.imOwned = 'message'; state.nodes.add(el); return el; };
    const text = (el, value) => { if (el.textContent !== value) el.textContent = value; };
    const isEnabled = room => getComputedStyle(room).getPropertyValue('--im-theme').trim() === '1';
    const isVisible = room => !!room.getClientRects().length && getComputedStyle(room).visibility !== 'hidden';
    const getId = room => Array.from(room.classList).find(c => c.startsWith('session-'))?.slice(8);
    const listen = (state, el, event, fn) => {
      el.addEventListener(event, fn);
      if (!state.handlers.has(el)) state.handlers.set(el, []);
      state.handlers.get(el).push(() => el.removeEventListener(event, fn));
    };
    const touch = (state, el, name, value) => {
      let attrs = state.attrs.get(el);
      if (!attrs) { attrs = new Map(); state.attrs.set(el, attrs); }
      if (!attrs.has(name)) attrs.set(name, el.getAttribute(name));
      attr(el, name, value);
    };
    // Append-only rendering cache. DOM identity is the guard, not message count:
    // edits, older-history prepend, theme and session changes always use the
    // original full pass. No CSS, grouping, geometry or receipt rules change.
    const newState = () => ({ nodes: new Set(), attrs: new Map(), handlers: new Map(), off: [], header: null, outlines: new Map(), geometry: new Set(), marked: new Set(), records: new Map(), domIds: new Set(), session: null, revision: undefined, dirty: true, visible: false, syncedAt: 0,
      body:null, rawRows:[], entries:[], lastUserRow:null, fullPassNeeded:true });
    const messageClasses = ['im-message-block','im-follow','im-message-row','im-bubble','im-kind-text','im-kind-plain','im-kind-voice','im-kind-media','im-time-wrap','im-geometry-ready'];
    const messageAttrs = ['data-im-last','data-im-first','data-im-group','data-im-plain','data-im-text-gap','data-im-single-image'];
    function clearMessage(el) {
      messageClasses.forEach(c => flag(el,c,false));
      messageAttrs.forEach(a => attr(el,a,null));
      el.style.removeProperty('--im-music-outline');
    }
    // Only the background is drawn. React content, pointer handlers and plugin
    // attachments remain unwrapped/unclipped. One filled path avoids overlap seams.
    function outline(bubble, state, enabled) {
      let item = state.outlines.get(bubble);
      if (!enabled) {
        bubble.style.removeProperty('--im-music-outline');
        if (item) { resizeObserver.unobserve(bubble); item.svg.remove(); state.nodes.delete(item.svg); state.outlines.delete(bubble); }
        flag(bubble,'im-geometry-ready',false);
        return;
      }
      if (!item) {
        const svg = own(document.createElementNS('http://www.w3.org/2000/svg','svg'),state);
        svg.setAttribute('class','im-text-outline'); svg.setAttribute('aria-hidden','true'); svg.setAttribute('focusable','false');
        const path = document.createElementNS(svg.namespaceURI,'path'); svg.append(path); bubble.append(svg);
        item = {svg,path,key:null}; state.outlines.set(bubble,item);
        resizeObserver.observe(bubble);
      }
      const box = getComputedStyle(bubble), w = parseFloat(box.width), h = parseFloat(box.height);
      if (!w || !h) return;
      const key = `${w}/${h}/${bubble.hasAttribute('data-im-last')}/${bubble.classList.contains('chat-bubble-role-assistant')}`;
      if (item.key === key) { flag(bubble,'im-geometry-ready',true); return; }
      item.key = key;
      // P6 fit: multiline quarter corner r=23.9, control inset=8.4 CSS px.
      // Short 42.67px capsules fit a circular quarter. No text/font adjustment.
      const r = Math.min(24,h/2,w/2);
      const a = r < 24 ? r * .447715 : 8.4;
      const n = value => Math.round(value*1000)/1000;
      let d = `M${r} 0H${n(w-r)}C${n(w-a)} 0 ${n(w)} ${a} ${n(w)} ${r}V${n(h-r)}C${n(w)} ${n(h-a)} ${n(w-a)} ${n(h)} ${n(w-r)} ${n(h)}H${r}C${a} ${n(h)} 0 ${n(h-a)} 0 ${n(h-r)}V${r}C0 ${a} ${a} 0 ${r} 0Z`;
      if (bubble.hasAttribute('data-im-last')) {
        // Coordinates are measured from the body's right/bottom, not its bounds
        // plus an outward offset. Tip stays ~9px inset and descends ~7.3px.
        const x = offset => n(w-offset), y = offset => n(h+offset), root = Math.min(24,w/2);
        d += `M${x(3)} ${y(-13)}C${x(3.8)} ${y(-8.8)} ${x(5.8)} ${y(-7)} ${x(8.5)} ${y(-4.8)}C${x(12.4)} ${y(-1.8)} ${x(12)} ${y(1.5)} ${x(9.3)} ${y(5.5)}C${x(7.7)} ${y(8.6)} ${x(11.1)} ${y(7.1)} ${x(13.5)} ${y(5.8)}L${x(root-2.5)} ${y(.6)}Q${x(root-1.4)} ${y(0)} ${x(root)} ${y(0)}L${x(root)} ${y(-13)}Z`;
      }
      const incoming = bubble.classList.contains('chat-bubble-role-assistant');
      if (incoming && bubble.hasAttribute('data-im-last')) {
        // Incoming is a single exterior contour measured from the incoming
        // text in iMessage对比.png. No mirrored outgoing patch or overlap join.
        // Coordinates below are from the LEFT edge / body bottom; the base
        // returns at 24px, the rounded tip is ~9px inset and ~7.3px below.
        const y = offset => n(h+offset), root = Math.min(24,w/2);
        d = `M${r} 0H${n(w-r)}C${n(w-a)} 0 ${n(w)} ${a} ${n(w)} ${r}V${n(h-r)}C${n(w)} ${n(h-a)} ${n(w-a)} ${n(h)} ${n(w-r)} ${n(h)}H${root}`;
        d += `Q${n(root-1.2)} ${y(0)} ${n(root-2.4)} ${y(.7)}L13.2 ${y(6)}C10.5 ${y(7.6)} 7.5 ${y(8.3)} 9 ${y(5.5)}C11.7 ${y(1.7)} 12 ${y(-1.8)} 8 ${y(-5)}C2.2 ${y(-9.2)} 0 ${y(-12.5)} 0 ${n(h-r)}V${r}C0 ${a} ${a} 0 ${r} 0Z`;
      }
      attr(item.svg,'viewBox',`0 0 ${n(w)} ${n(h+8)}`);
      attr(item.svg,'height',n(h+8));
      attr(item.path,'d',d);
      attr(item.path,'transform',null);
      // Music reuses the exact frozen outline, but clips its OWN colored
      // background to it. Text stays unclipped; the cover uses its top edge.
      if (bubble.classList.contains('chat-bubble-music-share')) {
        bubble.style.setProperty('--im-music-outline', `path("${d}")`);
      }
      flag(bubble,'im-geometry-ready',true);
    }
    function setGeometry(bubble,state,enabled) {
      if (!enabled) {
        if (state.geometry.delete(bubble)) geometryObserver?.unobserve(bubble);
        geometryOwners.delete(bubble);
        outline(bubble,state,false);
        return;
      }
      if (!geometryObserver) { outline(bubble,state,true); return; }
      if (!state.geometry.has(bubble)) {
        state.geometry.add(bubble); geometryOwners.set(bubble,state); geometryObserver.observe(bubble);
      }
    }
    function suspend(room,state) {
      if (!state.visible) return;
      state.geometry.forEach(bubble=>{ geometryObserver?.unobserve(bubble); geometryOwners.delete(bubble); });
      state.geometry.clear();
      state.outlines.forEach((item,bubble)=>outline(bubble,state,false));
      state.outlines.clear();
      state.handlers.forEach(fns=>fns.forEach(fn=>fn())); state.handlers.clear();
      state.attrs.forEach((attrs,el)=>attrs.forEach((value,name)=>{ if(el.isConnected) attr(el,name,value); })); state.attrs.clear();
      state.off.forEach(fn=>fn()); state.off.length=0;
      state.nodes.forEach(n=>n.remove()); state.nodes.clear();
      room.querySelectorAll('.voice-msg-bars.im-wave-ready').forEach(el=>flag(el,'im-wave-ready',false));
      flag(room,'im-header-ready',false);
      state.header=null; state.marked.clear(); state.records.clear(); state.domIds.clear(); state.session=null;
      state.dirty=true; state.visible=false; state.revision=undefined; state.syncedAt=0;
      state.body=null; state.rawRows=[]; state.entries=[]; state.lastUserRow=null; state.fullPassNeeded=true;
    }
    function clean(room, state) {
      state.geometry.forEach(bubble=>{ geometryObserver?.unobserve(bubble); geometryOwners.delete(bubble); }); state.geometry.clear();
      state.outlines.forEach((item,bubble) => { resizeObserver.unobserve(bubble); }); state.outlines.clear();
      state.marked.forEach(clearMessage); state.marked.clear();
      state.off.forEach(fn => fn()); state.off.length=0;
      state.handlers.forEach(fns => fns.forEach(fn => fn())); state.handlers.clear();
      state.nodes.forEach(n => n.remove()); state.nodes.clear();
      state.attrs.forEach((attrs, el) => attrs.forEach((value, name) => attr(el, name, value))); state.attrs.clear();
      const classes = ['im-header-ready','im-single','im-group','im-wallpaper','im-plain-background','im-message-block','im-follow','im-message-row','im-bubble','im-kind-text','im-kind-plain','im-kind-voice','im-kind-media','im-time-wrap','im-wave-ready'];
      state.body=null; state.rawRows=[]; state.entries=[]; state.lastUserRow=null; state.fullPassNeeded=true;
      [room, ...room.querySelectorAll('*')].forEach(el => {
        classes.forEach(c => flag(el,c,false));
        ['data-im-last','data-im-first','data-im-group','data-im-plain','data-im-duration','data-im-single-image'].forEach(a => attr(el,a,null));
      });
    }
    function header(room, state, session) {
      const content = room.querySelector(':scope > .page-header .page-header-content');
      const title = content?.querySelector('.page-title');
      const more = content?.querySelector('.page-header-right button[aria-label="更多"]');
      if (!content || !title || !more) return;
      if (state.header?.content !== content) {
        const avatar = own(document.createElement('button'),state);
        avatar.type = 'button'; avatar.className = 'im-avatar';
        avatar.setAttribute('aria-label','联系人详情；双击拍一拍');
        avatar.title = '联系人详情；双击拍一拍';
        content.append(avatar);
        const nameLabel = own(document.createElement('span'),state);
        nameLabel.className = 'im-contact-name';
        nameLabel.setAttribute('aria-hidden','true');
        title.append(nameLabel);
        // Keep the original React-owned title node and its typing indicator intact.
        touch(state,title,'role','button'); touch(state,title,'tabindex','0');
        touch(state,title,'aria-label','打开聊天设置');
        const settings = () => { if (more.isConnected && !more.disabled) more.click(); };
        listen(state,title,'click',settings);
        listen(state,title,'keydown',e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings(); } });
        // Delay single click so a double click can still forward Float's original poke.
        let clickTimer = 0;
        listen(state,avatar,'click',() => { clearTimeout(clickTimer); clickTimer = setTimeout(settings,260); });
        listen(state,avatar,'dblclick',() => {
          clearTimeout(clickTimer);
          const targets = [...room.querySelectorAll('.im-message-row[data-role="assistant"] .chat-msg-avatar .cursor-pointer')];
          const target = targets.at(-1);
          if (!session.isGroup && target) target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
          else settings();
        });
        state.off.push(() => clearTimeout(clickTimer));
        state.header = { content, title, avatar, more, nameLabel, avatarKey: null };
      }
      const h = state.header;
      const char = session.isGroup ? null : ctx.data.characters.get(session.contactId);
      const nativeName = [...title.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
      const name = nativeName || session.alias || (session.isGroup ? session.groupName : char?.name) || '';
      const src = char?.avatar || '';
      text(h.nameLabel, name);
      touch(state,h.title,'aria-label',`${name}，打开聊天设置`);
      const key = `${name}\n${src}`;
      if (key !== h.avatarKey) {
        h.avatarKey = key;
        h.avatar.replaceChildren();
        if (src) {
          const img = document.createElement('img'); img.alt = ''; img.src = src;
          img.addEventListener('error',() => { h.avatar.textContent = Array.from(char?.name || name)[0] || '·'; },{once:true});
          h.avatar.append(img);
        } else text(h.avatar, session.isGroup ? '⋯' : Array.from(char?.name || name)[0] || '·');
      }
      flag(room,'im-header-ready',true);
    }
    function voice(bubble, state) {
      const node = bubble.querySelector('.voice-msg-bubble');
      if (!node) return;
      const bars = node.querySelector('.voice-msg-bars');
      if (bars && !bars.querySelector('.im-wave')) {
        const wave = own(document.createElement('span'),state);
        wave.className = 'im-wave'; wave.setAttribute('aria-hidden','true');
        // One SVG/path instead of 42 live DOM bars. Same deterministic envelope,
        // vastly smaller render tree in voice-heavy long conversations.
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 250 36'); svg.setAttribute('preserveAspectRatio','none');
        const path=document.createElementNS(svg.namespaceURI,'path');
        const segments=[];
        for(let i=0;i<42;i++){
          const envelope=Math.abs(Math.sin(i*.19))*(.55+.45*Math.abs(Math.cos(i*.37)));
          const h=Math.round(4+30*envelope),x=2+i*6,y=(36-h)/2;
          segments.push(`M${x} ${y+h/2}V${y+2}Q${x} ${y} ${x+2} ${y}Q${x+4} ${y} ${x+4} ${y+2}V${y+h-2}Q${x+4} ${y+h} ${x+2} ${y+h}Q${x} ${y+h} ${x} ${y+h-2}Z`);
        }
        path.setAttribute('d',segments.join('')); path.setAttribute('fill','currentColor'); svg.append(path); wave.append(svg);
        bars.append(wave); flag(bars,'im-wave-ready',true);
      }
      const dur = node.querySelector('.voice-msg-dur');
      if (dur) {
        const match = dur.textContent.trim().match(/^(\d+(?:\.\d+)?)"$/);
        const seconds = match ? Math.round(Number(match[1])) : null;
        attr(dur,'data-im-duration',seconds == null ? null : `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);
      }
      if (!state.attrs.has(node)) {
        touch(state,node,'role','button'); touch(state,node,'tabindex','0');
        touch(state,node,'aria-label','播放或暂停语音');
        listen(state,node,'keydown',e => { if (e.target===node && (e.key==='Enter' || e.key===' ')) { e.preventDefault(); node.click(); } });
      }
      const playing = bars?.hasAttribute('data-playing');
      touch(state,node,'aria-label',playing ? '暂停语音' : '播放语音');
    }
    function updateRoom(room, state, session) {
      flag(room,'im-single',!session.isGroup); flag(room,'im-group',!!session.isGroup);
      flag(room,'im-wallpaper',room.hasAttribute('data-has-bg-image'));
      flag(room,'im-plain-background',!room.hasAttribute('data-has-bg-image'));
      header(room,state,session);
      const body = room.querySelector(':scope > .page-body.chat-room-main-pane');
      if (!body) return;
      const records = state.records;
      // Only main flow rows. Nested call transcripts/plugin cards are not messages.
      // The raw selector is cheap compared with filtering/layout/geometry of old
      // bubbles. Its identity/order also detects prepends, React replacements and
      // removal; all those changes unconditionally fall back to the old full pass.
      const rawRows = [...body.querySelectorAll(':scope > .chat-msg-wrapper, :scope > div > .chat-msg-wrapper')];
      const oldRows=state.rawRows;
      const appendOnly = !state.fullPassNeeded && state.body===body && oldRows.length>0 &&
        rawRows.length>oldRows.length && oldRows.every((el,index)=>rawRows[index]===el);
      const eligible = row =>
        (row.id.startsWith('message-') || row.querySelector('.chat-stream-bubble')) &&
        !row.hasAttribute('data-reasoning-row') && row.parentElement.style.display !== 'none' &&
        !row.closest('.chat-offline-body') && getComputedStyle(row).display !== 'none';
      const rows = (appendOnly ? rawRows.slice(oldRows.length) : rawRows).filter(eligible);
      const newEntries = rows.map(row => {
        const wrap = row.querySelector(':scope > .chat-msg-content-wrap');
        const bubble = wrap && [...wrap.children].find(el => el.matches(bubbleSelector));
        const id = bubble?.getAttribute('data-msg-id') || row.id.replace(/^message-/,'');
        const msg = records.get(id);
        const block = row.parentElement === body ? row : row.parentElement;
        return { row, bubble, id, msg, block, role: row.dataset.role };
      });
      const oldEntryCount=appendOnly ? state.entries.length : 0;
      const entries=appendOnly ? [...state.entries,...newEntries] : newEntries;
      // A prior user receipt can be far above the tail (after assistant turns).
      // It must be updated when another user message becomes the new last user.
      const oldLastUserRow=appendOnly ? state.lastUserRow : null;
      const active = new Set();
      for(const e of entries){active.add(e.row);active.add(e.block);if(e.bubble)active.add(e.bubble);}
      state.marked.forEach(el => { if (!active.has(el)) clearMessage(el); });
      state.marked = active;
      state.geometry.forEach(bubble=>{ if(!active.has(bubble)) setGeometry(bubble,state,false); });
      state.outlines.forEach((item,bubble) => { if (!active.has(bubble) || !item.svg.isConnected) outline(bubble,state,false); });
      let lastUser=null;
      for(let i=entries.length-1;i>=0;i--){const e=entries[i];if(e.role==='user'&&e.bubble&&!e.msg?.isRetracted){lastUser=e;break;}}
      const timeCache=new WeakMap();
      const hasTime = entry => {
        if(!entry)return false;
        if(timeCache.has(entry.block))return timeCache.get(entry.block);
        const value=[...entry.block.children].some(n=>n!==entry.row&&n.querySelector?.(':scope > .chat-sys-msg'));
        timeCache.set(entry.block,value);return value;
      };
      // Host now mounts only the active room and begins from a bounded recent
      // message window. Register every eligible mounted bubble with the native
      // IntersectionObserver so old history regains the exact calibrated contour
      // before it reaches the viewport; offscreen bubbles still use CSS fallback.
      entries.forEach((e,index) => {
        // The previous tail can lose its tail/receipt status, and the previous
        // last-user row can lose its receipt even when assistant rows intervene.
        // All other old rows are provably unchanged in a guarded append pass.
        if (appendOnly && index<oldEntryCount-1 && e.row!==oldLastUserRow) return;
        const {row,bubble,msg,block} = e;
        const prev = entries[index-1];
        const next = entries[index+1];
        const continues = (a,b) => !!a?.bubble && !!b?.bubble && a.block!==b.block &&
          b.row.hasAttribute('data-consecutive') && a.role===b.role && !hasTime(b) &&
          (!session.isGroup || (!!a.msg && !!b.msg && a.msg.senderCharacterId===b.msg.senderCharacterId));
        const last = !continues(e,next);
        flag(row,'im-message-row',true); attr(row,'data-im-last',last ? '' : null);
        if (block.parentElement===body) { flag(block,'im-message-block',true); flag(block,'im-follow',continues(prev,e)); }
        [...block.children].forEach(n => { if (n!==row && n.querySelector?.(':scope > .chat-sys-msg')) flag(n,'im-time-wrap',true); });
        if (!bubble) { attr(row,'data-im-plain',null); attr(block,'data-im-text-gap',null); return; }
        flag(bubble,'im-bubble',true);
        const isVoice = !!bubble.querySelector('.voice-msg-bubble');
        const isMedia = !!bubble.querySelector('.chat-photo-card--image, .chat-sticker, .chat-media-file-video');
        const isText = !isVoice && !isMedia && !bubble.classList.contains('chat-bubble-media') && (!msg?.mediaType || msg.mediaType==='quote');
        flag(bubble,'im-kind-text',isText); flag(bubble,'im-kind-voice',isVoice); flag(bubble,'im-kind-media',isMedia);
        // A protocol image record owns exactly one ImageBubble/mediaUrl. Keep
        // this marker narrower than generic media so galleries, files, video,
        // stickers and future multi-image renderers cannot inherit its polish.
        attr(bubble,'data-im-single-image',msg?.mediaType==='image' && isMedia ? '' : null);
        // Phase-one calibration requires a mapped ordinary text record. Keep the
        // original special renderers, translation, quotes and plugin projections.
        const textRecord = isText && !!msg && !msg.mediaType && !msg.isRetracted &&
          !msg.mediaData?.readingQuote &&
          !bubble.querySelector('.chat-quote-message, iframe, .chat-html-frame');
        const bilingual = !!bubble.querySelector('.chat-bilingual-block');
        const plain = !room.hasAttribute('data-has-bg-image') && textRecord && !bilingual;
        flag(bubble,'im-kind-plain',plain);
        attr(row,'data-im-plain',plain ? '' : null);
        // Preserve timestamp spacing. Only a real adjacent plain-text boundary
        // gets measured group spacing; audio itself keeps its original renderer.
        attr(block,'data-im-text-gap',prev?.bubble && !hasTime(e) && (plain || prev.row.hasAttribute('data-im-plain')) ? (continues(prev,e) ? 'follow' : 'break') : null);
        attr(bubble,'data-im-first',!continues(prev,e) ? '' : null);
        const tailStateChanged = attr(bubble,'data-im-last',last ? '' : null);
        attr(bubble,'data-im-group',continues(prev,e) ? (last ? 'last' : 'middle') : (last ? 'single' : 'first'));
        // Geometry eligibility is independent of wallpaper and typography.
        // Incoming with the native translation toggle still uses a text shell;
        // only that shell changes, never its translation UI. Native audio and
        // reply records share this same OUTER shell; their children stay intact.
        // Keep ordinary text eligibility and all grouping decisions unchanged.
        const nativeSpecialShell = !!msg && !msg.isRetracted &&
          ((msg.mediaType==='audio' && isVoice) ||
           (msg.mediaType==='quote' && isText && !!bubble.querySelector(':scope > .chat-quote-message')));
        const musicShell = msg?.mediaType==='music_share' && !msg.isRetracted && !!bubble.querySelector('.chat-music-share-surface');
        const geometryEligible=(textRecord && (!bilingual || e.role==='assistant')) || nativeSpecialShell || musicShell;
        setGeometry(bubble,state,geometryEligible);
        // An already-visible exact SVG outline is keyed by data-im-last as well
        // as width/height. Grouping can settle after the first room pass without
        // changing bubble size, so ResizeObserver would never repaint the path.
        // Refresh only when the tail state itself changed; offscreen fallback
        // bubbles need no work because CSS reacts to the attribute immediately.
        if (tailStateChanged && state.outlines.has(bubble)) outline(bubble,state,true);
        if (isVoice) voice(bubble,state);
        const wrap = bubble.closest('.chat-msg-content-wrap');
        let receipt = wrap?.querySelector(':scope > .im-receipt');
        const mode = ctx.system.settings.get('receiptStyle') || 'truthful';
        const show = e.role==='user' && msg && !msg.isRetracted &&
          (msg.status==='failed' || msg.status==='sending' || (e===lastUser && last && mode!=='off'));
        const labels = { sent: mode==='reference' ? '已送达' : '已发送', read:'已读', sending:'发送中…', failed:'发送失败' };
        const label = show ? labels[msg.status] : null;
        if (label && wrap) {
          if (!receipt) { receipt=own(document.createElement('span'),state); receipt.className='im-receipt'; receipt.setAttribute('role','status'); wrap.append(receipt); }
          text(receipt,label); attr(receipt,'data-status',msg.status);
          attr(receipt,'title',mode==='reference' && msg.status==='sent' ? '外观模拟：Float sent 仅表示本地保存' : null);
        } else if (receipt) { receipt.remove(); state.nodes.delete(receipt); }
      });
      // Release detached decoration references after message deletion/virtualization.
      state.nodes.forEach(n => { if (!n.isConnected) state.nodes.delete(n); });
      state.handlers.forEach((fns,el) => { if (!el.isConnected) { fns.forEach(fn => fn()); state.handlers.delete(el); } });
      state.attrs.forEach((attrs,el) => { if (!el.isConnected) state.attrs.delete(el); });
      state.body=body; state.rawRows=rawRows; state.entries=entries;
      state.lastUserRow=lastUser?.row||null; state.fullPassNeeded=false;
    }
    function relevantMutation(m) {
      const el=m.target.nodeType===Node.ELEMENT_NODE ? m.target : m.target.parentElement;
      if (!el || el.closest('[data-im-owned]')) return false;
      // Session CSS injection/theme removal, ancestor visibility and room mounts.
      if (el.closest('head')) return true;
      const room=el.closest('.chat-room-wrapper');
      if (!room) {
        if (m.type==='attributes') return [...rooms.keys()].some(r=>el.contains(r));
        return [...m.addedNodes,...m.removedNodes].some(n=>n.nodeType===1 && (n.matches('.chat-room-wrapper') || n.querySelector('.chat-room-wrapper')));
      }
      if (el===room) {
        if(m.attributeName==='style') {
          const relevantStyle=s=>(s||'').split(';').map(p=>p.trim()).filter(p=>p&&!p.startsWith('--chat-bottom-reserve:')).join(';');
          return relevantStyle(m.oldValue)!==relevantStyle(room.getAttribute('style'));
        }
        return true;
      }
      if (el.closest('.chat-input-bar')) return false;
      // Content streaming inside an existing bubble changes geometry, not
      // grouping. Ignore ordinary markdown/plugin decoration churn; only a renderer
      // identity change (voice/media/bubble/message node) needs a full room pass.
      if (m.type==='childList' && el.closest(bubbleSelector)) {
        const structural='.voice-msg-bubble,.chat-photo-card--image,.chat-sticker,.chat-media-file-video,.chat-music-share-surface,.chat-quote-message,[data-msg-id],.chat-msg-wrapper';
        const changed=[...m.addedNodes,...m.removedNodes].some(n=>n.nodeType===Node.ELEMENT_NODE && (n.matches?.(structural)||n.querySelector?.(structural)));
        if(!changed) return false;
      }
      // ChatRoom adjusts the scroll pane's padding when the composer grows;
      // this does not alter sender boundaries or bubble widths.
      if (m.attributeName==='style' && el.matches('.page-body.chat-room-main-pane')) return false;
      const bars=el.closest('.voice-msg-bars');
      if (bars) {
        if (m.attributeName==='data-playing') {
          const bubble=bars.closest(bubbleSelector),state=rooms.get(room);
          if(bubble && state) voice(bubble,state);
        }
        return false; // Native waveform animation is neither grouping nor layout.
      }
      if (m.type==='attributes' && m.attributeName==='style' && el.closest(bubbleSelector)) return false; // ResizeObserver owns geometry.
      return !!el.closest('.page-body.chat-room-main-pane, .page-header.chat-room-main-pane');
    }
    // A full pass is required whenever an existing message/header/room changes.
    // Only direct append-only childList changes to the active message body may
    // retain the old rows; the prefix-identity check above is a second guard.
    function processMutations(records, requestRender=true) {
      let changed=false;
      for (const mutation of records) {
        if (!relevantMutation(mutation)) continue;
        changed=true;
        const target=mutation.target.nodeType===Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        const room=target?.closest('.chat-room-wrapper');
        const state=rooms.get(room);
        if (state) {
          const directAppend=mutation.type==='childList' && mutation.target===state.body &&
            mutation.removedNodes.length===0 && mutation.addedNodes.length>0;
          if (!directAppend) state.fullPassNeeded=true;
        } else {
          rooms.forEach(s=>{s.fullPassNeeded=true;});
        }
      }
      if (changed && requestRender) schedule();
    }
    const observer = new MutationObserver(records => processMutations(records));
    const observe = () => observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['id','data-msg-id','data-consecutive','data-role','data-playing','data-has-bg-image','class','style']});
    const textObserver = new MutationObserver(records => {
      const touched = new Set();
      for (const mutation of records) {
        const el = mutation.target.nodeType===Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        if (!el || el.closest('[data-im-owned]')) continue;
        const room=el.closest('.chat-room-wrapper'), state=rooms.get(room);
        if (!state?.session || !isVisible(room)) continue;
        const duration=el.closest('.voice-msg-dur');
        const target=duration?.closest(bubbleSelector) || room;
        if (touched.has(target)) continue;
        touched.add(target);
        if (duration && target!==room) voice(target,state);
        else if (el.closest('.page-title')) header(room,state,state.session);
      }
    });
    const observedTextTargets=new Set();
    function observeTextTargets() {
      const next=new Set();
      rooms.forEach((state,room) => {
        if (!state.visible) return;
        room.querySelectorAll('.page-header .page-title, .voice-msg-dur').forEach(el => {
          next.add(el);
          if (!observedTextTargets.has(el)) textObserver.observe(el,{subtree:true,childList:true,characterData:true});
        });
      });
      for(const el of observedTextTargets) if(!next.has(el)) textObserver.unobserve(el);
      observedTextTargets.clear();
      for(const el of next) observedTextTargets.add(el);
    }
    const revisionOf = id => ctx.data.messages.revision?.(id) ?? ctx.data.sessions.revision?.(id);
    function syncMetadata(room,state) {
      const id=getId(room);
      const session=ctx.data.sessions.get(id);
      if (!session) { state.session=null; state.records.clear(); return; }
      state.session=session;
      state.records=new Map(ctx.data.messages.list(id).map(msg=>[msg.id,msg]));
      state.revision=revisionOf(id);
      state.dirty=false;
      state.syncedAt=performance.now();
    }
    function refresh() {
      frame=0; if(disposed) return;
      // Do not discard queued mutations when disconnecting at the frame edge.
      // Otherwise an older-row change could be mistaken for a pure append.
      processMutations(observer.takeRecords(),false);
      observer.disconnect();
      try {
        rooms.forEach((state,room) => {
          if(!room.isConnected) { clean(room,state); rooms.delete(room); return; }
          if(!isVisible(room)) { suspend(room,state); return; }
          if(!isEnabled(room)) { clean(room,state); rooms.delete(room); }
        });
        document.querySelectorAll('.chat-room-wrapper').forEach(room => {
          if(!isVisible(room) || !isEnabled(room)) return;
          if(!rooms.has(room)) rooms.set(room,newState());
          const state=rooms.get(room);
          if (!state.visible || state.session?.id!==getId(room)) {state.dirty=true;state.fullPassNeeded=true;}
          state.visible=true;
          const revision=revisionOf(getId(room));
          if (revision!==undefined && revision!==state.revision) {state.dirty=true;state.fullPassNeeded=true;}
          // Old hosts have no revision token. A newly mounted stored message is
          // a precise fallback; unrelated appearance changes never reread data.
          if (revision===undefined && !state.dirty) {
            const ids=new Set([...room.querySelectorAll('.chat-msg-wrapper[id^="message-"] [data-msg-id]')].map(el=>el.getAttribute('data-msg-id')));
            state.dirty=[...ids].some(id=>!state.records.has(id) && !state.domIds.has(id));
            if (state.dirty) state.fullPassNeeded=true;
            state.domIds=ids;
          }
          if (state.dirty) syncMetadata(room,state);
          if (state.session) updateRoom(room,state,state.session);
        });
      } finally { if(!disposed) { observe(); observeTextTargets(); } }
    }
    function schedule() { if(!disposed && !frame) frame=requestAnimationFrame(refresh); }
    // Stream DOM changes already schedule the corresponding render. The hook
    // would also scan while a chunk has not yet produced any visible change.
    function dataChanged(payload={}) {
      const ids=payload.sessionIds || [payload.sessionId || payload.message?.sessionId].filter(Boolean);
      rooms.forEach((state,room)=>{
        if (ids.length ? ids.map(String).includes(String(getId(room))) : (!payload.id || state.records.has(payload.id) || state.records.has(String(payload.id)))) {
          state.dirty=true;state.fullPassNeeded=true;
        }
      });
      schedule();
    }
    function patchMessageEvent(payload={},kind='update',render=true) {
      const msg=payload.message;
      const sid=payload.sessionId || msg?.sessionId;
      const id=payload.id ?? msg?.id;
      let anyPatched=false;
      rooms.forEach((state,room)=>{
        if(!state.visible || !state.session || (sid && String(getId(room))!==String(sid))) return;
        let didPatch=false;
        if(kind==='delete' && id!=null) {
          const a=state.records.delete(id), b=state.records.delete(String(id));
          didPatch=a||b;
        } else if(msg && msg.id!=null) {
          state.records.set(msg.id,msg); didPatch=true;
        } else if(kind==='update' && id!=null && payload.patch) {
          const current=state.records.get(id) || state.records.get(String(id));
          if(current) { state.records.set(current.id,{...current,...payload.patch}); didPatch=true; }
        }
        if(didPatch) {
          // Any non-append update can change a previously mounted bubble or
          // its neighboring grouping/receipt. Never use the append fast path.
          if(kind!=='persist' || (msg && state.entries.some(e=>e.id===msg.id))) state.fullPassNeeded=true;
          anyPatched=true;
          const rev=revisionOf(getId(room));
          if(rev!==undefined) state.revision=rev;
          state.dirty=false; state.syncedAt=performance.now();
        }
      });
      if(!anyPatched) { if(render) dataChanged(payload); else rooms.forEach((state,room)=>{ if(!sid || String(getId(room))===String(sid)) state.dirty=true; }); }
      else if(render) schedule();
    }
    off.push(ctx.hooks.on('session.opened',dataChanged));
    off.push(ctx.hooks.on('message.persisted',payload=>patchMessageEvent(payload,'persist',true)));
    off.push(ctx.hooks.on('message.deleted',payload=>patchMessageEvent(payload,'delete',true)));
    off.push(ctx.hooks.on('message.updated',payload=>{
      const patch=payload?.patch;
      // Streaming text is already rendered by React. Patch only the in-memory record;
      // do not rescan the whole transcript for every token/chunk.
      if(patch && Object.keys(patch).every(key=>key==='content'||key==='updatedAt')) {
        patchMessageEvent(payload,'update',false);
        return;
      }
      patchMessageEvent(payload,'update',true);
    }));
    // Receipt-style changes can affect all existing user receipts.
    off.push(ctx.system.settings.onChange(()=>{rooms.forEach(state=>{state.fullPassNeeded=true;});schedule();}));
    const onData=e=>dataChanged(e.detail || {});
    const hasRevisionToken=typeof ctx.data.messages.revision==='function' || typeof ctx.data.sessions.revision==='function';
    if(!hasRevisionToken) ['chat-session-data-updated','chat-response-batch-replaced','chat-messages-updated','weixin-messages-updated'].forEach(event=>{
      window.addEventListener(event,onData); off.push(()=>window.removeEventListener(event,onData));
    });
    // Missing hooks on older hosts: bounded visible-room reconciliation, never
    // per DOM mutation. New hosts only read the O(1) revision token here.
    const reconcile=setInterval(()=>{
      if (document.hidden) return;
      let changed=false;
      rooms.forEach((state,room)=>{
        if (!isVisible(room)) return;
        const revision=revisionOf(getId(room));
        if (revision===undefined ? performance.now()-state.syncedAt>=2000 : revision!==state.revision) {
          state.dirty=true;state.fullPassNeeded=true; changed=true;
        }
      });
      if (changed) schedule();
    },2000);
    refresh();
    return () => {
      disposed=true; clearInterval(reconcile); textObserver.disconnect(); observedTextTargets.clear(); cancelAnimationFrame(frame); resizeObserver.disconnect(); geometryObserver?.disconnect(); observer.disconnect(); off.forEach(fn=>fn());
      rooms.forEach((state,room)=>clean(room,state)); rooms.clear();
    };
  }
};
