// Float 朋友圈多图
// Marketplace release v1.1.0
//
// 功能：
// - 用户朋友圈最多选择 9 张图片
// - 编辑页三列预览
// - 已发布朋友圈九宫格显示
// - Moments 模型请求接收当前朋友圈的全部图片
// - 不修改 Float 核心源码
// - v1.1.0: 新增多图朋友圈数据导入 / 导出，可用于 PWA → IPA 迁移
//
// 数据兼容：
// - 第一张图片继续使用 Float 原生 photoUrl
// - 第 2–9 张使用 Float 现有图片资产库，并由插件私有存储保存 postId -> assetIds 绑定
// - 禁用插件不会删除绑定；卸载插件会删除插件私有绑定数据
//
// 已验证环境：原版 Float / Chat Plugin API v1（upstream main，2026-10-07）
// 注意：本插件同时依赖当前朋友圈 DOM 与 IndexedDB 内部结构；未来 Float 大版本重构后可能需要更新。

const MAX_IMAGES = 9;
const STORE_KEY = "moment_multi_image_map_v1";
const THEME_DB = "ai_phone_theme_db_v1";
const THEME_STORE = "assets";
const MOMENTS_DB = "AiPhoneMomentsDB";
const MOMENTS_POSTS_STORE = "posts";

const BACKUP_FORMAT = "float-moments-multi-image-backup";
const BACKUP_SCHEMA_VERSION = 1;
const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
const MAX_BACKUP_POSTS = 5000;
const MAX_BACKUP_ASSETS = 40000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeIsoFileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseImageMimeFromDataUrl(dataUrl) {
  const match = typeof dataUrl === "string"
    ? dataUrl.match(/^data:(image\/[^;,]+)(?:;[^,]*)?,/i)
    : null;
  return match ? match[1] : "image/jpeg";
}

function isImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/[^;,]+(?:;[^,]*)?,/i.test(value);
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function triggerJsonDownload(data, filename) {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Safari 需要让 click 导航先拿到 blob URL。
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function normalizedComparableText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedComparableLocation(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateBackupPackage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("不是有效的朋友圈多图迁移包。");
  }
  if (raw.format !== BACKUP_FORMAT) {
    throw new Error("迁移包格式不匹配。");
  }
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`暂不支持迁移包 schema v${String(raw.schemaVersion ?? "?")}。`);
  }

  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const assets = raw.assets && typeof raw.assets === "object" && !Array.isArray(raw.assets)
    ? raw.assets
    : {};

  if (posts.length > MAX_BACKUP_POSTS) {
    throw new Error(`迁移包包含过多朋友圈（${posts.length} 条）。`);
  }
  if (Object.keys(assets).length > MAX_BACKUP_ASSETS) {
    throw new Error(`迁移包包含过多图片资产（${Object.keys(assets).length} 个）。`);
  }

  const cleanAssets = {};
  for (const [assetId, record] of Object.entries(assets)) {
    if (typeof assetId !== "string" || !assetId.trim()) continue;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (!isImageDataUrl(record.dataUrl)) continue;
    cleanAssets[assetId] = {
      mimeType: typeof record.mimeType === "string" && record.mimeType
        ? record.mimeType
        : parseImageMimeFromDataUrl(record.dataUrl),
      dataUrl: record.dataUrl,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    };
  }

  const cleanPosts = [];
  for (const item of posts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const extraAssetIds = Array.isArray(item.extraAssetIds)
      ? item.extraAssetIds
          .filter(id => typeof id === "string" && id.trim())
          .slice(0, MAX_IMAGES - 1)
      : [];
    if (!extraAssetIds.length) continue;

    cleanPosts.push({
      sourcePostId: typeof item.sourcePostId === "string" ? item.sourcePostId : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      content: typeof item.content === "string" ? item.content : "",
      location: typeof item.location === "string" ? item.location : "",
      firstPhotoAssetId: typeof item.firstPhotoAssetId === "string" ? item.firstPhotoAssetId : "",
      extraAssetIds,
    });
  }

  if (!cleanPosts.length) {
    throw new Error("迁移包中没有可导入的多图朋友圈。");
  }

  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    source: raw.source && typeof raw.source === "object" ? raw.source : {},
    posts: cleanPosts,
    assets: cleanAssets,
  };
}

function pickTargetPost(source, posts, usedTargetIds) {
  const candidates = posts.filter(post =>
    post
    && post.authorType === "user"
    && typeof post.id === "string"
    && !usedTargetIds.has(post.id)
  );

  if (source.sourcePostId) {
    const exactId = candidates.find(post => post.id === source.sourcePostId);
    const sourceContent = normalizedComparableText(source.content);
    if (
      exactId
      && (!sourceContent || normalizedComparableText(exactId.content) === sourceContent)
    ) {
      return { post: exactId, method: "postId" };
    }
  }

  const content = normalizedComparableText(source.content);
  if (!content) return null;

  let sameContent = candidates.filter(post =>
    normalizedComparableText(post.content) === content
  );
  if (!sameContent.length) return null;

  const sourceLocation = normalizedComparableLocation(source.location);
  if (sourceLocation) {
    const sameLocation = sameContent.filter(post =>
      normalizedComparableLocation(post.location) === sourceLocation
    );
    if (sameLocation.length) sameContent = sameLocation;
  }

  const sourceTime = Date.parse(source.createdAt || "");
  if (Number.isFinite(sourceTime)) {
    const ranked = sameContent
      .map(post => ({
        post,
        diff: Math.abs((Date.parse(post.createdAt || "") || 0) - sourceTime),
      }))
      .sort((a, b) => a.diff - b.diff);

    if (ranked.length && ranked[0].diff <= 5 * 60 * 1000) {
      // 两条同正文动态时间非常接近时，避免误绑。
      if (ranked.length > 1 && ranked[1].diff === ranked[0].diff) return null;
      return { post: ranked[0].post, method: ranked[0].diff === 0 ? "content+time" : "content+near-time" };
    }
  }

  if (sameContent.length === 1) {
    return { post: sameContent[0], method: "unique-content" };
  }

  return null;
}

const verifiedDbStores = new Set();

async function openDb(name, requiredStore) {
  if (!globalThis.indexedDB) {
    throw new Error("当前浏览器不支持 IndexedDB，无法使用朋友圈多图插件。");
  }

  const verifyKey = `${name}::${requiredStore || ""}`;

  // 新版 Chromium / Safari 支持 databases()；能安全判断数据库是否存在，
  // 避免在明显不兼容的 Float 版本里误创建同名空数据库。
  if (!verifiedDbStores.has(verifyKey) && typeof indexedDB.databases === "function") {
    try {
      const databases = await indexedDB.databases();
      const knownNames = new Set(databases.map(item => item?.name).filter(Boolean));
      if (!knownNames.has(name)) {
        throw new Error(`未找到 Float 数据库 ${name}；当前版本可能与朋友圈多图插件不兼容。`);
      }
    } catch (error) {
      // 兼容性错误要保留；浏览器自身禁止 databases() 枚举时则继续尝试正常打开。
      if (error instanceof Error && error.message.includes("当前版本可能与朋友圈多图插件不兼容")) {
        throw error;
      }
    }
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();

      if (requiredStore && !db.objectStoreNames.contains(requiredStore)) {
        db.close();
        reject(new Error(`数据库 ${name} 缺少 ${requiredStore}；当前 Float 版本可能与朋友圈多图插件不兼容。`));
        return;
      }

      verifiedDbStores.add(verifyKey);
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error(`无法打开 IndexedDB: ${name}`));
    request.onblocked = () => reject(new Error(`IndexedDB 被占用: ${name}`));
  });
}

async function idbGet(dbName, storeName, key) {
  const db = await openDb(dbName, storeName);
  try {
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, "readonly");
      } catch (error) {
        reject(error);
        return;
      }
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error(`读取 ${storeName} 失败`));
      tx.onabort = () => reject(tx.error || new Error(`读取 ${storeName} 事务中止`));
    });
  } finally {
    db.close();
  }
}

async function idbGetAll(dbName, storeName) {
  const db = await openDb(dbName, storeName);
  try {
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, "readonly");
      } catch (error) {
        reject(error);
        return;
      }
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error || new Error(`读取 ${storeName} 失败`));
      tx.onabort = () => reject(tx.error || new Error(`读取 ${storeName} 事务中止`));
    });
  } finally {
    db.close();
  }
}

async function idbPut(dbName, storeName, value) {
  const db = await openDb(dbName, storeName);
  try {
    await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`写入 ${storeName} 失败`));
      tx.onabort = () => reject(tx.error || new Error(`写入 ${storeName} 事务中止`));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(dbName, storeName, key) {
  const db = await openDb(dbName, storeName);
  try {
    await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error(`删除 ${storeName} 记录失败`));
      tx.onabort = () => reject(tx.error || new Error(`删除 ${storeName} 事务中止`));
    });
  } finally {
    db.close();
  }
}

function makeAssetId() {
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  return `chat_bg_${uuid}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

function fileToCompressedJpeg(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    const finish = () => {
      try { URL.revokeObjectURL(objectUrl); } catch {}
    };

    image.onerror = () => {
      finish();
      reject(new Error(`无法读取图片：${file.name || "未命名图片"}`));
    };

    image.onload = () => {
      try {
        const maxSize = 800;
        let width = image.naturalWidth || image.width;
        let height = image.naturalHeight || image.height;

        if (!width || !height) {
          finish();
          reject(new Error(`图片尺寸无效：${file.name || "未命名图片"}`));
          return;
        }

        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.max(1, Math.round(height * maxSize / width));
            width = maxSize;
          } else {
            width = Math.max(1, Math.round(width * maxSize / height));
            height = maxSize;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish();
          reject(new Error("浏览器无法创建图片画布"));
          return;
        }

        ctx.drawImage(image, 0, 0, width, height);
        canvas.toBlob(blob => {
          finish();
          if (!blob) {
            reject(new Error(`压缩图片失败：${file.name || "未命名图片"}`));
            return;
          }
          resolve(blob);
        }, "image/jpeg", 0.8);
      } catch (error) {
        finish();
        reject(error);
      }
    };

    image.src = objectUrl;
  });
}

async function saveExtraImage(file) {
  const blob = await fileToCompressedJpeg(file);
  const dataUrl = await blobToDataUrl(blob);
  const assetId = makeAssetId();
  await idbPut(THEME_DB, THEME_STORE, {
    id: assetId,
    type: "chat_bg",
    mimeType: blob.type || "image/jpeg",
    dataUrl,
    updatedAt: new Date().toISOString(),
  });
  return { assetId, dataUrl };
}

async function resolveAsset(assetId) {
  const record = await idbGet(THEME_DB, THEME_STORE, assetId);
  return record && typeof record.dataUrl === "string" ? record.dataUrl : null;
}

async function resolvePhotoReference(photoUrl) {
  const value = typeof photoUrl === "string" ? photoUrl.trim() : "";
  if (!value) return null;
  if (!value.startsWith("asset://")) return value;
  return resolveAsset(value.slice("asset://".length));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function decorateSnapshotText(text, count) {
  const label = `配图：见附图（共${count}张）`;
  if (/配图：见附图(?:（共\d+张）)?/.test(text)) {
    return text.replace(/配图：见附图(?:（共\d+张）)?/, label);
  }
  if (text.includes("\n\n评论区：")) {
    return text.replace("\n\n评论区：", `\n${label}\n\n评论区：`);
  }
  if (text.includes("</朋友圈界面快照>")) {
    return text.replace("</朋友圈界面快照>", `${label}\n</朋友圈界面快照>`);
  }
  return `${text}\n${label}`;
}

function buildCanonicalContent(originalContent, text, urls) {
  const decoratedText = decorateSnapshotText(text, urls.length);
  let parts;

  if (Array.isArray(originalContent)) {
    let replacedText = false;
    parts = originalContent
      .filter(part => !(part && typeof part === "object" && part.type === "image_url"))
      .map(part => {
        if (!replacedText && part && typeof part === "object" && part.type === "text") {
          replacedText = true;
          return { ...part, text: decoratedText };
        }
        return part;
      });

    if (!replacedText) {
      parts.unshift({ type: "text", text: decoratedText });
    }
  } else {
    parts = [{ type: "text", text: decoratedText }];
  }

  for (const url of urls) {
    parts.push({
      type: "image_url",
      image_url: { url, detail: "low" },
    });
  }
  return parts;
}

function normalizeMap(value) {
  const source = value && typeof value === "object" ? value : {};
  const posts = source.posts && typeof source.posts === "object" ? source.posts : {};
  const normalized = {};

  for (const [postId, item] of Object.entries(posts)) {
    if (!item || typeof item !== "object") continue;
    const assetIds = Array.isArray(item.assetIds)
      ? item.assetIds.filter(id => typeof id === "string" && id.trim()).slice(0, 8)
      : [];
    if (!assetIds.length) continue;
    normalized[postId] = {
      assetIds,
      boundAt: typeof item.boundAt === "string" ? item.boundAt : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      content: typeof item.content === "string" ? item.content : "",
    };
  }

  return { version: 1, posts: normalized };
}

export default {
  manifest: {
    // 保留旧测试版 ID，保证从 v0.1.x 更新到公开版时不会丢失既有多图绑定。
    id: "auren.moments-multi-image-temp",
    name: "朋友圈多图",
    version: "1.1.0",
    apiVersion: 1,
    author: "Auren&Chloe",
    description: "为 Float 朋友圈增加最多 9 张图片、三列编辑预览、九宫格展示，并将全部图片提交给支持视觉的 Moments 模型请求。",
    permissions: ["ui", "storage", "ai"],
  },

  async setup(ctx) {
    const missingCapabilities = [];
    if (typeof ctx?.hooks?.transform !== "function") missingCapabilities.push("hooks.transform");
    if (typeof ctx?.ui?.injectCSS !== "function") missingCapabilities.push("ui.injectCSS");
    if (typeof ctx?.ui?.slot !== "function") missingCapabilities.push("ui.slot");
    if (typeof ctx?.ui?.toast !== "function") missingCapabilities.push("ui.toast");
    if (typeof ctx?.system?.storage?.get !== "function" || typeof ctx?.system?.storage?.set !== "function") {
      missingCapabilities.push("system.storage");
    }
    if (!globalThis.indexedDB) missingCapabilities.push("IndexedDB");
    if (!globalThis.MutationObserver) missingCapabilities.push("MutationObserver");

    if (missingCapabilities.length) {
      throw new Error(
        `朋友圈多图：当前 Float/浏览器缺少必要能力：${missingCapabilities.join(", ")}。`
      );
    }

    let store = normalizeMap(ctx.system.storage.get(STORE_KEY));
    let activeCompose = null;
    let composeSession = 0;
    let pendingExtras = [];
    let processingCount = 0;
    let publishInFlight = false;
    let destroyed = false;
    let renderSeq = 0;
    let pruneTimer = null;
    let composeRenderTimer = null;
    let composeRenderKey = "";
    let feedRenderTimer = null;
    let overlay = null;
    let overlayCleanup = null;
    let compatibilityWarningShown = false;
    const assetCache = new Map();

    const notifyMapChanged = () => {
      window.dispatchEvent(new CustomEvent("fmmi-map-updated"));
    };

    const saveStore = () => {
      ctx.system.storage.set(STORE_KEY, store);
      notifyMapChanged();
    };

    const getBoundCount = () => Object.keys(store.posts).length;

    const warnCompatibilityOnce = reason => {
      if (compatibilityWarningShown) return;
      compatibilityWarningShown = true;
      const message = `朋友圈多图：检测到当前 Float 结构可能不兼容（${reason}）。插件已停止增强此页面，原生朋友圈仍可继续使用。`;
      try { ctx.ui.toast(message, { durationMs: 5200 }); } catch {}
      ctx.system.log(message);
    };

    const revokePreview = item => {
      if (item?.previewUrl?.startsWith("blob:")) {
        try { URL.revokeObjectURL(item.previewUrl); } catch {}
      }
    };

    const clearPendingVisuals = () => {
      pendingExtras.forEach(revokePreview);
      pendingExtras = [];
    };

    const deletePendingAssets = async () => {
      const items = pendingExtras.slice();
      clearPendingVisuals();
      await Promise.all(items.map(item =>
        idbDelete(THEME_DB, THEME_STORE, item.assetId).catch(() => undefined)
      ));
    };

    const removePendingExtra = async assetId => {
      const index = pendingExtras.findIndex(item => item.assetId === assetId);
      if (index < 0) return;
      const [item] = pendingExtras.splice(index, 1);
      revokePreview(item);
      assetCache.delete(assetId);
      await idbDelete(THEME_DB, THEME_STORE, assetId).catch(() => undefined);
      scheduleComposeRender();
    };

    const getComposeElements = compose => {
      if (!compose) return {};
      return {
        input: compose.querySelector('input[type="file"][accept*="image"]'),
        grid: compose.querySelector(".compose-media-grid"),
        nativePreview: compose.querySelector(".compose-photo-block-preview"),
        textarea: compose.querySelector(".compose-textarea"),
        publishButton: compose.querySelector(".compose-header-send"),
      };
    };

    const scheduleComposeRender = () => {
      if (destroyed) return;
      if (composeRenderTimer !== null) clearTimeout(composeRenderTimer);
      composeRenderKey = "";
      composeRenderTimer = setTimeout(() => {
        composeRenderTimer = null;
        renderCompose();
      }, 0);
    };

    const renderCompose = () => {
      const compose = activeCompose;
      if (!compose || !document.contains(compose)) return;
      const { input, grid, nativePreview } = getComposeElements(compose);
      if (!input || !grid) {
        warnCompatibilityOnce("朋友圈发布页 DOM 已变化");
        return;
      }

      // React 自己仍只读取 files[0]；multiple 只是允许系统选择器一次返回多张。
      if (!input.multiple) input.multiple = true;
      if (input.dataset.fmmiInput !== "1") input.dataset.fmmiInput = "1";

      const total = (nativePreview ? 1 : 0) + pendingExtras.length;
      const shouldShowAdd = Boolean(nativePreview) && total < MAX_IMAGES;
      const key = [
        nativePreview ? "native:1" : "native:0",
        pendingExtras.map(item => item.assetId).join(","),
        `processing:${processingCount}`,
        `add:${shouldShowAdd ? 1 : 0}`,
        `total:${total}`,
      ].join("|");

      const extraCount = grid.querySelectorAll(":scope > .fmmi-compose-extra").length;
      const hasCount = Boolean(grid.querySelector(":scope > .fmmi-compose-count"));
      const hasProcessing = Boolean(grid.querySelector(":scope > .fmmi-processing"));
      const hasAdd = Boolean(grid.querySelector(":scope > .fmmi-compose-add"));
      const domAlreadyMatches =
        extraCount === pendingExtras.length
        && hasCount === (total > 0)
        && hasProcessing === (processingCount > 0)
        && hasAdd === shouldShowAdd;

      // v0.1.0 的卡顿根因就在这里：
      // Observer -> renderCompose -> DOM mutation -> Observer -> renderCompose...
      // 只有状态或 React 原生图片区真实变化时才允许重画。
      if (composeRenderKey === key && domAlreadyMatches) return;
      composeRenderKey = key;

      grid.querySelectorAll(
        ":scope > .fmmi-compose-extra,:scope > .fmmi-compose-add,:scope > .fmmi-compose-count,:scope > .fmmi-processing"
      ).forEach(node => node.remove());

      for (const item of pendingExtras) {
        const tile = document.createElement("div");
        tile.className = "fmmi-compose-extra";
        tile.dataset.assetId = item.assetId;

        const img = document.createElement("img");
        img.src = item.previewUrl || item.dataUrl;
        img.alt = "";

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "fmmi-compose-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "删除图片");
        remove.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          void removePendingExtra(item.assetId);
        });

        tile.append(img, remove);
        grid.append(tile);
      }

      if (total > 0) {
        const count = document.createElement("span");
        count.className = "fmmi-compose-count";
        count.textContent = `${total}/${MAX_IMAGES}`;
        grid.append(count);
      }

      if (processingCount > 0) {
        const busy = document.createElement("div");
        busy.className = "fmmi-processing";
        busy.textContent = `处理中 ${processingCount}`;
        grid.append(busy);
      }

      // 原生没有第一张时，保留 Float 自己的“+”按钮；
      // 已有第一张后，用插件按钮继续选图，避免 React 覆盖原生第一张。
      if (shouldShowAdd) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "fmmi-compose-add";
        add.setAttribute("aria-label", "继续添加图片");
        add.innerHTML = '<span aria-hidden="true">＋</span>';
        add.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          input.click();
        });
        grid.append(add);
      }
    };
    const processExtraFiles = async (files, sessionToken) => {
      if (!files.length) return;
      processingCount += files.length;
      let accounted = 0;
      scheduleComposeRender();

      try {
        // 故意串行处理，避免手机一次解码 8 张造成内存尖峰。
        for (const file of files) {
          if (destroyed || sessionToken !== composeSession) break;
          try {
            const saved = await saveExtraImage(file);
            if (destroyed || sessionToken !== composeSession) {
              await idbDelete(THEME_DB, THEME_STORE, saved.assetId).catch(() => undefined);
              continue;
            }
            const previewUrl = saved.dataUrl;
            assetCache.set(saved.assetId, saved.dataUrl);
            pendingExtras.push({ ...saved, previewUrl });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("不兼容") || message.includes("未找到 Float 数据库")) {
              warnCompatibilityOnce("本地图片数据库结构已变化");
            } else {
              ctx.ui.toast(message);
            }
          } finally {
            accounted += 1;
            processingCount = Math.max(0, processingCount - 1);
            scheduleComposeRender();
          }
        }
      } finally {
        // 如果发布框在处理中被关闭/换页，未进入循环的文件也必须归还计数，
        // 否则下一次打开发布框会被永久误判为“图片还在处理中”。
        const unaccounted = Math.max(0, files.length - accounted);
        if (unaccounted) processingCount = Math.max(0, processingCount - unaccounted);
        scheduleComposeRender();
      }
    };

    const onFileChangeCapture = event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const compose = target.closest?.('[role="dialog"][aria-label="发朋友圈"]');
      if (!compose || target.type !== "file" || !target.accept?.includes("image")) return;

      const files = Array.from(target.files || []);
      if (!files.length) return;

      const { nativePreview } = getComposeElements(compose);
      const hasNativeFirst = Boolean(nativePreview);
      const currentTotal = (hasNativeFirst ? 1 : 0) + pendingExtras.length;
      const room = Math.max(0, MAX_IMAGES - currentTotal);

      if (room <= 0) {
        event.preventDefault();
        event.stopPropagation();
        ctx.ui.toast("朋友圈最多 9 张图片");
        setTimeout(() => { try { target.value = ""; } catch {} }, 0);
        return;
      }

      if (hasNativeFirst) {
        // 已有原生第一张：本次选择全部归插件，阻止 React 用新文件覆盖第一张。
        const extras = files.slice(0, room);
        if (files.length > room) ctx.ui.toast("朋友圈最多 9 张图片");
        event.preventDefault();
        event.stopPropagation();
        const token = composeSession;
        void processExtraFiles(extras, token);
        setTimeout(() => { try { target.value = ""; } catch {} }, 0);
        return;
      }

      // 没有原生第一张：让 Float 原生 onChange 正常吃 files[0]；
      // 插件只保存后面的文件。原生本来就只读取 files?.[0]。
      const selected = files.slice(0, room);
      const extras = selected.slice(1);
      if (files.length > room) ctx.ui.toast("朋友圈最多 9 张图片");
      if (extras.length) {
        const token = composeSession;
        void processExtraFiles(extras, token);
      }
    };

    const findPublishedPost = async snapshot => {
      for (let attempt = 0; attempt < 80 && !destroyed; attempt += 1) {
        const posts = await idbGetAll(MOMENTS_DB, MOMENTS_POSTS_STORE).catch(() => []);
        const candidates = posts
          .filter(post => {
            if (!post || post.authorType !== "user") return false;
            const created = Date.parse(post.createdAt || "");
            if (!Number.isFinite(created) || created < snapshot.startedAt - 2500) return false;
            if (snapshot.text && !String(post.content || "").startsWith(snapshot.text)) return false;
            return true;
          })
          .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));

        const unbound = candidates.find(post => !store.posts[post.id]);
        if (unbound) return unbound;
        if (candidates[0]) return candidates[0];
        await delay(100);
      }
      return null;
    };

    const bindPublishedPost = async snapshot => {
      try {
        const post = await findPublishedPost(snapshot);
        if (!post) throw new Error("没有找到刚发布的朋友圈");

        store.posts[post.id] = {
          assetIds: snapshot.assetIds.slice(0, 8),
          boundAt: new Date().toISOString(),
          createdAt: String(post.createdAt || new Date().toISOString()),
          content: String(post.content || snapshot.text || ""),
        };
        saveStore();
        ctx.system.log(`[朋友圈多图] 已绑定 ${post.id}：额外 ${snapshot.assetIds.length} 张`);
        window.dispatchEvent(new CustomEvent("moments-updated"));
        scheduleFeedRender();
      } catch (error) {
        ctx.system.log("[朋友圈多图] 发布绑定失败", error);
        ctx.ui.toast("多图绑定失败：这条动态会暂时只保留原生第一张");
        await Promise.all(snapshot.assetIds.map(id =>
          idbDelete(THEME_DB, THEME_STORE, id).catch(() => undefined)
        ));
      } finally {
        publishInFlight = false;
        clearPendingVisuals();
      }
    };

    const onClickCapture = event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(".compose-header-send");
      if (!(button instanceof HTMLButtonElement)) return;
      const compose = button.closest('[role="dialog"][aria-label="发朋友圈"]');
      if (!compose) return;

      if (processingCount > 0) {
        event.preventDefault();
        event.stopPropagation();
        ctx.ui.toast("图片还在处理中，处理完成后再发表");
        return;
      }

      if (button.disabled || pendingExtras.length === 0) return;

      const { textarea } = getComposeElements(compose);
      const text = textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : "";
      const snapshot = {
        startedAt: Date.now(),
        text,
        assetIds: pendingExtras.map(item => item.assetId),
      };

      publishInFlight = true;
      // 让原生 click 正常继续；等本轮事件结束后再去 IndexedDB 等新 post。
      setTimeout(() => void bindPublishedPost(snapshot), 0);
    };

    const openImageOverlay = (urls, startIndex) => {
      if (overlayCleanup) overlayCleanup();
      else if (overlay) overlay.remove();
      let index = Math.max(0, Math.min(startIndex, urls.length - 1));

      const root = document.createElement("div");
      root.className = "fmmi-overlay";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");

      const img = document.createElement("img");
      img.className = "fmmi-overlay-image";
      img.alt = "";

      const close = document.createElement("button");
      close.type = "button";
      close.className = "fmmi-overlay-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭");

      const counter = document.createElement("div");
      counter.className = "fmmi-overlay-counter";

      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "fmmi-overlay-nav fmmi-overlay-prev";
      prev.textContent = "‹";
      prev.setAttribute("aria-label", "上一张");

      const next = document.createElement("button");
      next.type = "button";
      next.className = "fmmi-overlay-nav fmmi-overlay-next";
      next.textContent = "›";
      next.setAttribute("aria-label", "下一张");

      const refresh = () => {
        img.src = urls[index];
        counter.textContent = `${index + 1} / ${urls.length}`;
        prev.hidden = urls.length <= 1;
        next.hidden = urls.length <= 1;
      };

      const remove = () => {
        document.removeEventListener("keydown", onKey);
        root.remove();
        if (overlay === root) overlay = null;
        if (overlayCleanup === remove) overlayCleanup = null;
      };

      const onKey = event => {
        if (event.key === "Escape") remove();
        if (event.key === "ArrowLeft" && urls.length > 1) {
          index = (index - 1 + urls.length) % urls.length;
          refresh();
        }
        if (event.key === "ArrowRight" && urls.length > 1) {
          index = (index + 1) % urls.length;
          refresh();
        }
      };

      root.addEventListener("click", event => {
        if (event.target === root) remove();
      });
      close.addEventListener("click", remove);
      prev.addEventListener("click", event => {
        event.stopPropagation();
        index = (index - 1 + urls.length) % urls.length;
        refresh();
      });
      next.addEventListener("click", event => {
        event.stopPropagation();
        index = (index + 1) % urls.length;
        refresh();
      });

      root.append(img, close, counter, prev, next);
      document.body.append(root);
      document.addEventListener("keydown", onKey);
      overlay = root;
      overlayCleanup = remove;
      refresh();
    };

    const canonicalUrlsForPost = async (post, entry) => {
      const urls = [];
      if (post?.photoUrl) {
        const first = await resolvePhotoReference(post.photoUrl).catch(() => null);
        if (first) urls.push(first);
      }

      for (const assetId of entry.assetIds) {
        let url = assetCache.get(assetId) || null;
        if (!url) {
          url = await resolveAsset(assetId).catch(() => null);
          if (url) assetCache.set(assetId, url);
        }
        if (url) urls.push(url);
      }
      return urls.slice(0, MAX_IMAGES);
    };

    const renderCard = async (card, postId, entry, seq) => {
      const post = await idbGet(MOMENTS_DB, MOMENTS_POSTS_STORE, postId).catch(() => null);
      if (destroyed || seq !== renderSeq || !document.contains(card) || !post) return;

      const key = [post.photoUrl || "", ...entry.assetIds].join("|");
      if (card.dataset.fmmiRenderKey === key && card.querySelector(".fmmi-grid")) return;

      const urls = await canonicalUrlsForPost(post, entry);
      if (destroyed || seq !== renderSeq || !document.contains(card) || urls.length === 0) return;

      card.dataset.fmmiRenderKey = key;
      card.dataset.fmmi = "1";

      let media = card.querySelector(".feed-post-media");
      if (!media) {
        media = document.createElement("div");
        media.className = "feed-post-media fmmi-plugin-media mb-3 w-full";
        const location = card.querySelector(".feed-post-location");
        const content = card.querySelector(".feed-post-content");
        (location || content)?.insertAdjacentElement("afterend", media);
      }

      media.classList.add("fmmi-has-grid");
      media.querySelectorAll(".fmmi-grid").forEach(node => node.remove());

      const grid = document.createElement("div");
      grid.className = `fmmi-grid fmmi-count-${urls.length}`;
      grid.setAttribute("data-count", String(urls.length));

      urls.forEach((url, index) => {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "fmmi-grid-cell";
        cell.setAttribute("aria-label", `查看图片 ${index + 1}`);

        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.loading = "lazy";

        cell.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          openImageOverlay(urls, index);
        });

        cell.append(img);
        grid.append(cell);
      });

      media.prepend(grid);
    };

    const scheduleFeedRender = () => {
      if (destroyed) return;
      if (feedRenderTimer !== null) clearTimeout(feedRenderTimer);
      feedRenderTimer = setTimeout(() => {
        feedRenderTimer = null;
        void renderFeeds();
      }, 60);
    };

    const renderFeeds = async () => {
      const seq = ++renderSeq;
      const cards = Array.from(document.querySelectorAll("[data-moment-post-id]"));
      const jobs = [];

      for (const card of cards) {
        if (!(card instanceof HTMLElement)) continue;
        const postId = card.dataset.momentPostId;
        if (!postId) continue;
        const entry = store.posts[postId];
        if (!entry) {
          card.querySelectorAll(".fmmi-grid").forEach(node => node.remove());
          card.querySelector(".feed-post-media")?.classList.remove("fmmi-has-grid");
          card.removeAttribute("data-fmmi");
          delete card.dataset.fmmiRenderKey;
          continue;
        }
        jobs.push(renderCard(card, postId, entry, seq));
      }

      await Promise.all(jobs);
    };

    const pruneMappings = async () => {
      const posts = await idbGetAll(MOMENTS_DB, MOMENTS_POSTS_STORE).catch(() => null);
      if (!posts) return;
      const liveIds = new Set(posts.map(post => post?.id).filter(Boolean));
      const stale = Object.entries(store.posts).filter(([postId]) => !liveIds.has(postId));
      if (!stale.length) return;

      for (const [postId, entry] of stale) {
        delete store.posts[postId];
        await Promise.all(entry.assetIds.map(assetId => {
          assetCache.delete(assetId);
          return idbDelete(THEME_DB, THEME_STORE, assetId).catch(() => undefined);
        }));
      }

      saveStore();
      ctx.system.log(`[朋友圈多图] 清理 ${stale.length} 条已删除动态的临时图片绑定`);
    };

    const schedulePrune = () => {
      if (pruneTimer !== null) clearTimeout(pruneTimer);
      pruneTimer = setTimeout(() => {
        pruneTimer = null;
        void pruneMappings();
      }, 700);
    };

    const backupAssetRecord = async (assetId, assets, stats) => {
      if (!assetId || assets[assetId]) return;
      const record = await idbGet(THEME_DB, THEME_STORE, assetId).catch(() => null);
      if (!record || !isImageDataUrl(record.dataUrl)) {
        stats.missingAssets += 1;
        return;
      }
      assets[assetId] = {
        mimeType: typeof record.mimeType === "string" && record.mimeType
          ? record.mimeType
          : parseImageMimeFromDataUrl(record.dataUrl),
        dataUrl: record.dataUrl,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
      };
      stats.exportedAssets += 1;
    };

    const exportMultiImageData = async () => {
      const busy = ctx.ui.toast("正在整理朋友圈多图迁移包…", { durationMs: 0 });
      try {
        const allPosts = await idbGetAll(MOMENTS_DB, MOMENTS_POSTS_STORE);
        const postMap = new Map(
          allPosts
            .filter(post => post && typeof post.id === "string")
            .map(post => [post.id, post])
        );

        const assets = {};
        const posts = [];
        const stats = {
          exportedPosts: 0,
          exportedAssets: 0,
          missingAssets: 0,
          missingPosts: 0,
        };

        // 串行读取，避免移动端同时复制大量 base64 字符串造成内存尖峰。
        for (const [postId, entry] of Object.entries(store.posts)) {
          const extraAssetIds = Array.isArray(entry?.assetIds)
            ? entry.assetIds.filter(Boolean).slice(0, MAX_IMAGES - 1)
            : [];
          if (!extraAssetIds.length) continue;

          const post = postMap.get(postId) || null;
          if (!post) stats.missingPosts += 1;

          let firstPhotoAssetId = "";
          const nativePhotoUrl = typeof post?.photoUrl === "string" ? post.photoUrl.trim() : "";
          if (nativePhotoUrl.startsWith("asset://")) {
            firstPhotoAssetId = nativePhotoUrl.slice("asset://".length);
            await backupAssetRecord(firstPhotoAssetId, assets, stats);
          }

          for (const assetId of extraAssetIds) {
            await backupAssetRecord(assetId, assets, stats);
          }

          posts.push({
            sourcePostId: postId,
            createdAt: String(post?.createdAt || entry?.createdAt || ""),
            content: String(post?.content || entry?.content || ""),
            location: String(post?.location || ""),
            firstPhotoAssetId,
            extraAssetIds,
          });
          stats.exportedPosts += 1;

          // 给 WebKit 一个调度机会，避免几十条动态时长期霸占主线程。
          if (stats.exportedPosts % 8 === 0) await delay(0);
        }

        if (!posts.length) {
          ctx.ui.toast("没有找到可导出的多图朋友圈。");
          return;
        }

        const payload = {
          format: BACKUP_FORMAT,
          schemaVersion: BACKUP_SCHEMA_VERSION,
          pluginId: "auren.moments-multi-image-temp",
          pluginVersion: "1.1.0",
          exportedAt: new Date().toISOString(),
          source: {
            app: "Float",
            note: "朋友圈多图插件迁移包；包含绑定关系和实际图片数据。",
          },
          stats,
          posts,
          assets,
        };

        const filename = `float-moments-multi-image-${safeIsoFileStamp()}.json`;
        triggerJsonDownload(payload, filename);

        const suffix = stats.missingAssets || stats.missingPosts
          ? `；另有 ${stats.missingAssets} 张图片 / ${stats.missingPosts} 条原帖未完整找到`
          : "";
        ctx.ui.toast(
          `已导出 ${stats.exportedPosts} 条多图朋友圈、${stats.exportedAssets} 个图片资产${suffix}`,
          { durationMs: 5200 }
        );
        ctx.system.log("[朋友圈多图] 导出完成", stats);
      } finally {
        busy.close();
      }
    };

    const getOrCreateImportedAsset = async (sourceAssetId, record, importCache, stats) => {
      if (importCache.has(sourceAssetId)) return importCache.get(sourceAssetId);
      if (!record || !isImageDataUrl(record.dataUrl)) {
        stats.missingAssets += 1;
        return null;
      }

      const exact = await idbGet(THEME_DB, THEME_STORE, sourceAssetId).catch(() => null);
      if (!exact) {
        await idbPut(THEME_DB, THEME_STORE, {
          id: sourceAssetId,
          type: "chat_bg",
          mimeType: record.mimeType || parseImageMimeFromDataUrl(record.dataUrl),
          dataUrl: record.dataUrl,
          updatedAt: record.updatedAt || new Date().toISOString(),
        });
        importCache.set(sourceAssetId, sourceAssetId);
        assetCache.set(sourceAssetId, record.dataUrl);
        stats.createdAssets += 1;
        return sourceAssetId;
      }

      if (exact.dataUrl === record.dataUrl) {
        importCache.set(sourceAssetId, sourceAssetId);
        assetCache.set(sourceAssetId, record.dataUrl);
        stats.reusedAssets += 1;
        return sourceAssetId;
      }

      // 同 ID、不同内容：绝不覆盖目标端已有图片。使用内容 hash 生成稳定的新 ID，
      // 这样重复导入同一个迁移包时也能复用，而不是无限制造副本。
      const base = `chat_bg_fmmi_${fnv1a32(record.dataUrl)}`;
      let candidate = base;
      let suffix = 0;
      while (true) {
        const existing = await idbGet(THEME_DB, THEME_STORE, candidate).catch(() => null);
        if (!existing) break;
        if (existing.dataUrl === record.dataUrl) {
          importCache.set(sourceAssetId, candidate);
          assetCache.set(candidate, record.dataUrl);
          stats.reusedAssets += 1;
          stats.remappedAssetIds += 1;
          return candidate;
        }
        suffix += 1;
        candidate = `${base}_${suffix}`;
      }

      await idbPut(THEME_DB, THEME_STORE, {
        id: candidate,
        type: "chat_bg",
        mimeType: record.mimeType || parseImageMimeFromDataUrl(record.dataUrl),
        dataUrl: record.dataUrl,
        updatedAt: record.updatedAt || new Date().toISOString(),
      });
      importCache.set(sourceAssetId, candidate);
      assetCache.set(candidate, record.dataUrl);
      stats.createdAssets += 1;
      stats.remappedAssetIds += 1;
      return candidate;
    };

    const importMultiImagePackage = async raw => {
      const pack = validateBackupPackage(raw);
      const allPosts = await idbGetAll(MOMENTS_DB, MOMENTS_POSTS_STORE);
      const usedTargetIds = new Set();
      const importCache = new Map();

      const stats = {
        sourcePosts: pack.posts.length,
        matchedPosts: 0,
        importedBindings: 0,
        unmatchedPosts: 0,
        ambiguousPosts: 0,
        restoredFirstImages: 0,
        createdAssets: 0,
        reusedAssets: 0,
        remappedAssetIds: 0,
        missingAssets: 0,
        matchedByPostId: 0,
        matchedByFallback: 0,
      };

      for (const source of pack.posts) {
        const match = pickTargetPost(source, allPosts, usedTargetIds);
        if (!match) {
          stats.unmatchedPosts += 1;
          continue;
        }

        const target = match.post;
        usedTargetIds.add(target.id);
        stats.matchedPosts += 1;
        if (match.method === "postId") stats.matchedByPostId += 1;
        else stats.matchedByFallback += 1;

        const importedExtraIds = [];
        for (const sourceAssetId of source.extraAssetIds.slice(0, MAX_IMAGES - 1)) {
          const targetAssetId = await getOrCreateImportedAsset(
            sourceAssetId,
            pack.assets[sourceAssetId],
            importCache,
            stats
          );
          if (targetAssetId) importedExtraIds.push(targetAssetId);
        }

        if (!importedExtraIds.length) {
          continue;
        }

        // 第一张通常已跟随 Float 主存档迁移；仅在目标端第一张不存在/失效时兜底恢复，
        // 不覆盖 IPA 里已有的正常原生第一张。
        if (source.firstPhotoAssetId && pack.assets[source.firstPhotoAssetId]) {
          let firstStillExists = false;
          if (typeof target.photoUrl === "string" && target.photoUrl.trim()) {
            firstStillExists = Boolean(
              await resolvePhotoReference(target.photoUrl).catch(() => null)
            );
          }

          if (!firstStillExists) {
            const restoredFirstId = await getOrCreateImportedAsset(
              source.firstPhotoAssetId,
              pack.assets[source.firstPhotoAssetId],
              importCache,
              stats
            );
            if (restoredFirstId) {
              target.photoUrl = `asset://${restoredFirstId}`;
              await idbPut(MOMENTS_DB, MOMENTS_POSTS_STORE, target);
              stats.restoredFirstImages += 1;
            }
          }
        }

        store.posts[target.id] = {
          assetIds: importedExtraIds.slice(0, MAX_IMAGES - 1),
          boundAt: new Date().toISOString(),
          createdAt: String(target.createdAt || source.createdAt || ""),
          content: String(target.content || source.content || ""),
        };
        stats.importedBindings += 1;

        if (stats.importedBindings % 8 === 0) await delay(0);
      }

      if (stats.importedBindings > 0) {
        saveStore();
        window.dispatchEvent(new CustomEvent("moments-updated"));
        scheduleFeedRender();
      }

      ctx.system.log("[朋友圈多图] 导入完成", stats);
      return stats;
    };

    const importMultiImageFile = async file => {
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        throw new Error(`迁移包过大（${Math.round(file.size / 1024 / 1024)} MB），已停止导入。`);
      }

      const busy = ctx.ui.toast("正在导入朋友圈多图数据…", { durationMs: 0 });
      try {
        const rawText = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          throw new Error("迁移包 JSON 无法解析。");
        }

        const stats = await importMultiImagePackage(parsed);
        if (!stats.importedBindings) {
          ctx.ui.toast(
            `没有接回任何多图朋友圈。目标端未找到对应帖子：${stats.unmatchedPosts} 条。`,
            { durationMs: 6000 }
          );
          return;
        }

        const detail = [
          `已恢复 ${stats.importedBindings}/${stats.sourcePosts} 条多图朋友圈`,
          `新写入图片 ${stats.createdAssets} 个`,
          `复用 ${stats.reusedAssets} 个`,
          stats.remappedAssetIds ? `冲突改名 ${stats.remappedAssetIds} 个` : "",
          stats.restoredFirstImages ? `补回第一张 ${stats.restoredFirstImages} 条` : "",
          stats.unmatchedPosts ? `未匹配 ${stats.unmatchedPosts} 条` : "",
        ].filter(Boolean).join("；");

        ctx.ui.toast(detail, { durationMs: 7000 });
      } finally {
        busy.close();
      }
    };

    const syncComposePresence = () => {
      const next = document.querySelector('[role="dialog"][aria-label="发朋友圈"]');

      if (next === activeCompose) return;

      if (activeCompose && !next && !publishInFlight && pendingExtras.length) {
        const toDelete = pendingExtras.slice();
        clearPendingVisuals();
        void Promise.all(toDelete.map(item =>
          idbDelete(THEME_DB, THEME_STORE, item.assetId).catch(() => undefined)
        ));
      }

      activeCompose = next;
      composeSession += 1;
      composeRenderKey = "";

      if (activeCompose) scheduleComposeRender();
    };

    const onMomentsUpdated = () => {
      scheduleFeedRender();
      schedulePrune();
    };

    // 真正发请求之前，把原生最多 1 张改造成“当前帖子全部图片”。
    ctx.hooks.transform("llm.request", async payload => {
      if (payload.purpose !== "moments") return payload;
      const entries = Object.entries(store.posts);
      if (!entries.length || !Array.isArray(payload.messages)) return payload;

      const posts = await idbGetAll(MOMENTS_DB, MOMENTS_POSTS_STORE).catch(() => []);
      const postMap = new Map(posts.filter(Boolean).map(post => [post.id, post]));

      // 新帖优先，降低两条正文恰好相同导致误配的概率。
      entries.sort((a, b) => {
        const aTime = Date.parse(postMap.get(a[0])?.createdAt || a[1].createdAt || "") || 0;
        const bTime = Date.parse(postMap.get(b[0])?.createdAt || b[1].createdAt || "") || 0;
        return bTime - aTime;
      });

      const nextMessages = payload.messages.slice();
      let changed = false;

      for (let messageIndex = 0; messageIndex < nextMessages.length; messageIndex += 1) {
        const message = nextMessages[messageIndex];
        const text = extractText(message?.content);
        if (!text.includes("<朋友圈界面快照>")) continue;

        let matched = null;
        for (const [postId, entry] of entries) {
          const post = postMap.get(postId);
          if (!post) continue;
          const content = String(post.content || "");
          if (!content) continue;
          if (!text.includes(`正文：${content}`)) continue;
          if (post.location && !text.includes(`地点：${post.location}`)) continue;
          matched = { postId, entry, post };
          break;
        }

        if (!matched) continue;
        const urls = await canonicalUrlsForPost(matched.post, matched.entry);
        if (!urls.length) continue;

        nextMessages[messageIndex] = {
          ...message,
          content: buildCanonicalContent(message.content, text, urls),
        };
        changed = true;
        ctx.system.log(`[朋友圈多图] 模型请求已注入 ${urls.length} 张图片：${matched.postId}`);
      }

      return changed ? { ...payload, messages: nextMessages } : payload;
    }, { priority: 50, timeoutMs: 15000 });

    ctx.ui.injectCSS(`
      /* 编辑页：只改 compose，不碰已发布朋友圈的 .fmmi-grid */
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid{
        position:relative;
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:8px;
        width:100%;
        padding-bottom:18px;
      }
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid > .compose-photo-block-preview,
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid > .compose-photo-block,
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid > .fmmi-compose-extra,
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid > .fmmi-compose-add{
        position:relative;
        width:100%!important;
        height:auto!important;
        aspect-ratio:1/1;
        min-width:0;
        overflow:hidden;
        border-radius:6px;
        box-sizing:border-box;
      }
      .compose-modal[aria-label="发朋友圈"] .compose-media-grid > .compose-photo-block-preview{
        flex-shrink:initial;
      }
      .compose-modal[aria-label="发朋友圈"] .compose-photo-block-preview > img,
      .compose-modal[aria-label="发朋友圈"] .fmmi-compose-extra img{
        width:100%;
        height:100%;
        display:block;
        object-fit:cover;
        border-radius:6px;
      }
      .compose-modal[aria-label="发朋友圈"] .compose-photo-block-preview .compose-photo-remove,
      .fmmi-compose-remove{
        position:absolute!important;
        top:3px!important;
        right:3px!important;
        z-index:3;
        width:22px!important;
        height:22px!important;
        min-width:22px;
        border:0!important;
        border-radius:50%!important;
        background:rgba(0,0,0,.58)!important;
        color:white!important;
        font:18px/20px system-ui!important;
        cursor:pointer;
        padding:0!important;
        display:flex;
        align-items:center;
        justify-content:center;
      }
      .fmmi-compose-extra,.fmmi-compose-add{
        background:var(--c-input,#f3f3f3);
        border:0;
        padding:0;
      }
      .fmmi-compose-add{
        display:flex;align-items:center;justify-content:center;cursor:pointer;
        color:var(--c-icon,#888);
        border:1px dashed color-mix(in srgb,var(--c-icon,#888) 35%,transparent)
      }
      .fmmi-compose-add span{font:30px/1 system-ui;font-weight:200}
      .fmmi-compose-count{
        position:absolute;
        right:0;
        bottom:-3px;
        margin:0;
        padding:2px 6px;
        border-radius:999px;
        background:color-mix(in srgb,var(--c-text,#222) 8%,transparent);
        color:var(--c-icon,#888);
        font-size:11px;
        line-height:1.5;
        pointer-events:none;
      }
      .fmmi-processing{
        position:absolute;
        left:0;
        bottom:-3px;
        margin:0;
        padding:2px 6px;
        border-radius:999px;
        background:color-mix(in srgb,var(--c-action-blue,#246bfd) 10%,transparent);
        color:var(--c-action-blue,#246bfd);
        font-size:11px;
        line-height:1.5;
        pointer-events:none;
      }

      .feed-post-media.fmmi-has-grid > :not(.fmmi-grid){display:none!important}
      .fmmi-grid{display:grid;gap:3px;width:min(100%,360px)}
      .fmmi-grid.fmmi-count-1{grid-template-columns:minmax(0,220px)}
      .fmmi-grid.fmmi-count-2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:300px}
      .fmmi-grid.fmmi-count-4{grid-template-columns:repeat(2,minmax(0,1fr));max-width:300px}
      .fmmi-grid:not(.fmmi-count-1):not(.fmmi-count-2):not(.fmmi-count-4){
        grid-template-columns:repeat(3,minmax(0,1fr))
      }
      .fmmi-grid-cell{
        position:relative;display:block;width:100%;aspect-ratio:1/1;overflow:hidden;
        border:0;padding:0;background:var(--c-input,#eee);cursor:pointer;border-radius:2px
      }
      .fmmi-count-1 .fmmi-grid-cell{aspect-ratio:auto;max-height:300px}
      .fmmi-count-1 .fmmi-grid-cell img{max-height:300px}
      .fmmi-grid-cell img{width:100%;height:100%;display:block;object-fit:cover}

      .fmmi-overlay{
        position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.94);
        display:flex;align-items:center;justify-content:center;padding:20px
      }
      .fmmi-overlay-image{max-width:100%;max-height:100%;object-fit:contain}
      .fmmi-overlay-close,.fmmi-overlay-nav{
        position:absolute;border:0;background:rgba(0,0,0,.35);color:white;cursor:pointer
      }
      .fmmi-overlay-close{
        top:max(16px,env(safe-area-inset-top));right:16px;width:42px;height:42px;
        border-radius:50%;font:30px/38px system-ui
      }
      .fmmi-overlay-nav{
        top:50%;transform:translateY(-50%);width:46px;height:58px;border-radius:12px;
        font:42px/50px system-ui
      }
      .fmmi-overlay-prev{left:12px}.fmmi-overlay-next{right:12px}
      .fmmi-overlay-counter{
        position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));
        transform:translateX(-50%);padding:5px 10px;border-radius:999px;
        background:rgba(0,0,0,.45);color:white;font:13px/1.4 system-ui
      }

      .fmmi-settings{padding:10px 0;font:13px/1.6 system-ui;color:var(--c-text,#222)}
      .fmmi-settings p{margin:5px 0}
      .fmmi-settings button{
        border:0;border-radius:9px;padding:7px 10px;background:var(--c-input,#eee);
        color:inherit;cursor:pointer
      }
      .fmmi-compat{font-weight:600}
      .fmmi-warning{
        margin:8px 0!important;
        padding:8px 10px;
        border-radius:8px;
        background:color-mix(in srgb,#d97706 12%,transparent);
        color:color-mix(in srgb,var(--c-text,#222) 82%,#9a5b00);
      }
      .fmmi-muted{opacity:.65;font-size:12px}
      .fmmi-migration{
        margin:12px 0 8px;
        padding:10px;
        border-radius:10px;
        background:color-mix(in srgb,var(--c-input,#eee) 65%,transparent);
      }
      .fmmi-migration-title{font-weight:700;margin:0 0 4px!important}
      .fmmi-migration-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}
      .fmmi-migration-actions button{font-weight:600}
      .fmmi-migration-actions .fmmi-primary{
        background:var(--c-icon-active,#07c160);
        color:white;
      }
      .fmmi-migration-note{opacity:.72;font-size:12px}
    `);

    ctx.ui.slot("settings.section", container => {
      const root = document.createElement("div");
      root.className = "fmmi-settings";

      const compatibility = document.createElement("p");
      compatibility.className = "fmmi-compat";
      compatibility.textContent = "兼容性：Chat Plugin API v1 已通过；朋友圈 DOM / 本地数据库将在实际使用时继续检测。";

      const status = document.createElement("p");

      const storageNote = document.createElement("p");
      storageNote.className = "fmmi-muted";
      storageNote.textContent = "数据方式：第一张沿用 Float 原生朋友圈图片；第 2–9 张保存在 Float 现有图片资产库，帖子与额外图片的对应关系保存在本插件私有存储。";

      const warning = document.createElement("p");
      warning.className = "fmmi-warning";
      warning.textContent = "重要：可以禁用插件；不要直接卸载。卸载会删除插件私有绑定，已发布多图朋友圈将只能按原生方式显示第一张。";

      const versionNote = document.createElement("p");
      versionNote.className = "fmmi-muted";
      versionNote.textContent = "已验证：原版 Float / Chat Plugin API v1。未来 Float 若重构朋友圈 DOM 或 IndexedDB，可能需要更新本插件。";

      const migration = document.createElement("div");
      migration.className = "fmmi-migration";

      const migrationTitle = document.createElement("p");
      migrationTitle.className = "fmmi-migration-title";
      migrationTitle.textContent = "多图数据迁移";

      const migrationNote = document.createElement("p");
      migrationNote.className = "fmmi-migration-note";
      migrationNote.textContent = "用于更换 Float 安装环境（例如 PWA → IPA）。迁移包会包含多图绑定和实际图片数据；导入不会覆盖目标端已有的不同图片。";

      const migrationActions = document.createElement("div");
      migrationActions.className = "fmmi-migration-actions";

      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "fmmi-primary";
      exportButton.textContent = "导出多图数据";
      exportButton.addEventListener("click", async () => {
        exportButton.disabled = true;
        importButton.disabled = true;
        try {
          await exportMultiImageData();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.system.log("[朋友圈多图] 导出失败", error);
          ctx.ui.toast(`导出失败：${message}`, { durationMs: 6000 });
        } finally {
          exportButton.disabled = false;
          importButton.disabled = false;
        }
      });

      const importInput = document.createElement("input");
      importInput.type = "file";
      importInput.accept = ".json,application/json";
      importInput.style.display = "none";

      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.textContent = "导入多图数据";
      importButton.addEventListener("click", () => {
        importInput.value = "";
        importInput.click();
      });

      importInput.addEventListener("change", async () => {
        const file = importInput.files?.[0] || null;
        if (!file) return;

        exportButton.disabled = true;
        importButton.disabled = true;
        try {
          await importMultiImageFile(file);
          status.textContent = `已绑定多图朋友圈：${getBoundCount()} 条`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.system.log("[朋友圈多图] 导入失败", error);
          ctx.ui.toast(`导入失败：${message}`, { durationMs: 6500 });
        } finally {
          exportButton.disabled = false;
          importButton.disabled = false;
          importInput.value = "";
        }
      });

      migrationActions.append(exportButton, importButton);
      migration.append(migrationTitle, migrationNote, migrationActions, importInput);

      const prune = document.createElement("button");
      prune.type = "button";
      prune.textContent = "检查失效绑定";
      prune.addEventListener("click", async () => {
        prune.disabled = true;
        try {
          await pruneMappings();
          status.textContent = `已绑定多图朋友圈：${getBoundCount()} 条`;
          ctx.ui.toast("检查完成");
        } finally {
          prune.disabled = false;
        }
      });

      const refresh = () => {
        status.textContent = `已绑定多图朋友圈：${getBoundCount()} 条`;
      };
      refresh();
      window.addEventListener("fmmi-map-updated", refresh);

      root.append(compatibility, status, storageNote, warning, migration, versionNote, prune);
      container.append(root);

      return () => {
        window.removeEventListener("fmmi-map-updated", refresh);
        root.remove();
      };
    });

    document.addEventListener("change", onFileChangeCapture, true);
    document.addEventListener("click", onClickCapture, true);
    window.addEventListener("moments-updated", onMomentsUpdated);

    const observer = new MutationObserver(mutations => {
      syncComposePresence();

      let composeNeedsRender = false;
      let feedMayHaveChanged = false;

      for (const mutation of mutations) {
        const target = mutation.target instanceof Element
          ? mutation.target
          : mutation.target?.parentElement;

        const insideCompose = Boolean(
          target?.closest?.('[role="dialog"][aria-label="发朋友圈"]')
        );

        if (insideCompose) {
          // 只关心 Float/React 自己对图片区的真实变动。
          // 插件自己的 .fmmi-* 节点增删不再触发下一轮重绘。
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          const nativeMediaChanged = nodes.some(node => {
            if (!(node instanceof Element)) return false;
            if (node.matches?.(".fmmi-compose-extra,.fmmi-compose-add,.fmmi-compose-count,.fmmi-processing")) {
              return false;
            }
            return node.matches?.(".compose-photo-block-preview,.compose-photo-block")
              || Boolean(node.querySelector?.(".compose-photo-block-preview,.compose-photo-block"));
          });
          if (nativeMediaChanged) composeNeedsRender = true;
          continue;
        }

        // Feed 本身变化时才安排九宫格检查；编辑弹窗内部变化不再拖着 feed 重跑。
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        const momentNodeChanged =
          Boolean(target?.closest?.("[data-moment-post-id]"))
          || nodes.some(node => node instanceof Element && (
            node.matches?.("[data-moment-post-id]")
            || Boolean(node.querySelector?.("[data-moment-post-id]"))
          ));
        if (momentNodeChanged) feedMayHaveChanged = true;
      }

      if (activeCompose && composeNeedsRender) scheduleComposeRender();
      if (feedMayHaveChanged) scheduleFeedRender();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    syncComposePresence();
    scheduleFeedRender();
    schedulePrune();

    ctx.system.log("[朋友圈多图] v1.1.0 已启用");

    return () => {
      destroyed = true;
      observer.disconnect();
      document.removeEventListener("change", onFileChangeCapture, true);
      document.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("moments-updated", onMomentsUpdated);

      if (composeRenderTimer !== null) clearTimeout(composeRenderTimer);
      if (feedRenderTimer !== null) clearTimeout(feedRenderTimer);
      if (pruneTimer !== null) clearTimeout(pruneTimer);

      if (!publishInFlight && pendingExtras.length) {
        void deletePendingAssets();
      } else {
        clearPendingVisuals();
      }

      if (overlayCleanup) overlayCleanup();
      else if (overlay) {
        overlay.remove();
        overlay = null;
      }

      document.querySelectorAll(".fmmi-grid,.fmmi-compose-extra,.fmmi-compose-add,.fmmi-compose-count,.fmmi-processing,.fmmi-plugin-media")
        .forEach(node => node.remove());
      document.querySelectorAll(".feed-post-media.fmmi-has-grid")
        .forEach(node => node.classList.remove("fmmi-has-grid"));
      document.querySelectorAll("[data-fmmi]")
        .forEach(node => {
          node.removeAttribute("data-fmmi");
          if (node instanceof HTMLElement) delete node.dataset.fmmiRenderKey;
        });

      ctx.system.log("[朋友圈多图] v1.1.0 已停用");
    };
  },
};
