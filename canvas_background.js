import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { registerMenuItem } from "./menu_source.js";
import { mosaicLayout, createHierarchy, positionSeed, regionFamily, regionChildren } from "./canvas_background_layout.js";
import { createBackgroundStore } from "./canvas_background_storage.js";

const defaults = { enabled: true, size: 1800, opacity: 0.35, groupFade: 0.65, gridOpacity: 1, gifSpeed: 1, seed: 1, levels: 2 };
let settings = { ...defaults };
let pictures = [], records = [], texture = null, panel = null, busy = false;
let animationFrame = null, animationTime = 0, animationSignature = "";
let saveChain = Promise.resolve();
let saveRevision = 0;
let panelPosition = null;
let saveStatus = "", saveErrorToast = null, updateSaveStatus = () => {};
const backgroundStore = createBackgroundStore(api, () => browserStorage());
const installed = new WeakSet();
const grids = new WeakMap();

// Read spacing and solid line colors once; never enlarge or draw the bitmap itself.
export function gridProfile(data, width, height) {
  const counts = new Map();
  const keyAt = i => `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
  for (let i = 0; i < data.length; i += 4) {
    const key = keyAt(i);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const backing = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const scan = vertical => {
    const length = vertical ? width : height, cross = vertical ? height : width, lines = [];
    let run = null;
    const finish = () => {
      if (!run) return;
      const color = [...run.colors].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
      lines.push({ at: run.at, width: run.width, color: `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})` });
      run = null;
    };
    for (let position = 0; position < length; position++) {
      const colors = new Map(); let ink = 0;
      for (let other = 0; other < cross; other++) {
        const i = 4 * (vertical ? other * width + position : position * width + other);
        const key = keyAt(i);
        if (data[i + 3] && key !== backing) { ink++; colors.set(key, (colors.get(key) || 0) + 1); }
      }
      if (ink > cross / 2) {
        if (!run) run = { at: position, width: 0, colors: new Map() };
        run.width++;
        for (const [color, count] of colors) run.colors.set(color, (run.colors.get(color) || 0) + count);
      } else finish();
    }
    finish(); return lines;
  };
  return { width, height, vertical: scan(true), horizontal: scan(false) };
}

const STANDARD_GRID = { width: 100, height: 100,
  vertical: Array.from({ length: 10 }, (_, i) => ({ at: i * 10, width: i ? 1 : 2, color: i ? "#191919" : "#141414" })),
  horizontal: Array.from({ length: 10 }, (_, i) => ({ at: i * 10, width: i ? 1 : 2, color: i ? "#191919" : "#141414" })) };

export function drawVectorGrid(ctx, canvas, profile, opacity, dpr) {
  if (opacity <= 0 || canvas.ds.scale <= 0.5) return;
  const matrix = ctx.getTransform(), area = canvas.visible_area;
  const left = Math.max(0, area[0] * matrix.a + matrix.e), top = Math.max(0, area[1] * matrix.d + matrix.f);
  const right = Math.min(ctx.canvas.width, (area[0] + area[2]) * matrix.a + matrix.e);
  const bottom = Math.min(ctx.canvas.height, (area[1] + area[3]) * matrix.d + matrix.f);
  if (right <= left || bottom <= top) return;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity * (canvas.zoom_modify_alpha ? 1 - 0.5 / canvas.ds.scale : 1) * canvas.editor_alpha;
    const axis = (lines, period, scale, offset, start, end, vertical) => {
      const first = Math.floor((start - offset) / (period * scale)) - 1;
      const last = Math.ceil((end - offset) / (period * scale));
      for (let repeat = first; repeat <= last; repeat++) for (const line of lines) {
        const position = Math.round((repeat * period + line.at) * scale + offset);
        const thickness = Math.max(1, Math.round(line.width * dpr));
        if (position + thickness <= start || position >= end) continue;
        ctx.fillStyle = line.color;
        if (vertical) ctx.fillRect(position, top, thickness, bottom - top);
        else ctx.fillRect(left, position, right - left, thickness);
      }
    };
    axis(profile.vertical, profile.width, matrix.a, matrix.e, left, right, true);
    axis(profile.horizontal, profile.height, matrix.d, matrix.f, top, bottom, false);
  } finally { ctx.restore(); }
}

function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

function buildTexture(images, files, prepared) {
  if (!images.length) return null;
  const layout = prepared?.layout || mosaicLayout(files.map(record => record.ratio), settings.seed);
  const hierarchy = prepared?.hierarchy || createHierarchy(layout, settings.levels, settings.seed);
  const unit = settings.size * 4 ** Math.min(hierarchy.depth, 3);
  const sample = surface(1, 1), sampleContext = sample.getContext("2d");
  const averages = images.map(image => {
    sampleContext.clearRect(0, 0, 1, 1); sampleContext.drawImage(drawable(image), 0, 0, 1, 1);
    return sampleContext.getImageData(0, 0, 1, 1).data;
  });
  const mean = [0, 0, 0, 0];
  for (const tile of layout.tiles) {
    const pixel = averages[tile.image], alpha = pixel[3] / 255;
    const weight = tile.width * tile.height / layout.width;
    for (let channel = 0; channel < 3; channel++) mean[channel] += pixel[channel] * alpha * weight;
    mean[3] += alpha * weight;
  }
  const color = `rgba(${mean.slice(0, 3).map(value => Math.round(value / (mean[3] || 1))).join(",")},${mean[3]})`;
  return { width: unit * layout.width, height: unit,
    method: images.length === 1 ? "single" : layout.method, layout, images, hierarchy, color,
    thumbnails: new Map(), thumbnailPixels: 0 };
}

async function prepareTexture(images, files) {
  if (!images.length) return null;
  if (typeof Worker === "undefined") return buildTexture(images, files);
  const worker = new Worker("/extensions/comfyui-liuxinyu-packs/canvas_background_worker.js", { type: "module" });
  try {
    const prepared = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = () => reject(new Error("布局计算失败，请刷新后重试"));
      worker.postMessage({ ratios: files.map(record => record.ratio), levels: settings.levels, seed: settings.seed });
    });
    return buildTexture(images, files, prepared);
  } finally { worker.terminate(); }
}

async function rebuild() {
  texture = await prepareTexture(pictures, records);
  redraw();
}

function redraw() { app.canvas?.setDirty(true, true); }

function drawable(image) {
  return image?.frames ? image.frames[image.frame].image : image;
}

function isGifRecord(record) {
  return Boolean(record?.animated || record?.blob?.type === "image/gif" || /\.gif$/i.test(record?.file || ""));
}

function hasGif() { return records.some(isGifRecord); }

function hasAnimation() { return pictures.some(image => image?.frames?.length > 1); }

function stopAnimation() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null; animationTime = 0;
}

function animate(timestamp) {
  animationFrame = null;
  if (!hasAnimation() || settings.gifSpeed <= 0) return;
  const elapsed = Math.min(100, animationTime ? timestamp - animationTime : 0);
  animationTime = timestamp;
  let changed = false;
  for (const image of pictures) {
    if (!image?.frames?.length || image.frames.length < 2) continue;
    image.elapsed += elapsed * settings.gifSpeed;
    while (image.elapsed >= image.frames[image.frame].duration) {
      image.elapsed -= image.frames[image.frame].duration;
      image.frame = (image.frame + 1) % image.frames.length;
      changed = true;
    }
  }
  if (changed) {
    if (texture) { texture.thumbnails.clear(); texture.thumbnailPixels = 0; }
    redraw();
  }
  animationFrame = requestAnimationFrame(animate);
}

function syncAnimation() {
  const signature = `${hasAnimation()}:${settings.gifSpeed}`;
  if (signature === animationSignature && (animationFrame !== null || !hasAnimation() || settings.gifSpeed <= 0)) return;
  animationSignature = signature;
  stopAnimation();
  if (hasAnimation() && settings.gifSpeed > 0) animationFrame = requestAnimationFrame(animate);
}

function intersects(x, y, width, height, area) {
  return !area || (x + width > area[0] && y + height > area[1] && x < area[0] + area[2] && y < area[1] + area[3]);
}

function rasterBounds(matrix, x, y, width, height) {
  // Round shared endpoints, not individual widths. The tiny bias makes equivalent
  // recursive coordinates agree when floating-point noise straddles half a pixel.
  const left = Math.round(x * matrix.a + matrix.e + 1e-7);
  const top = Math.round(y * matrix.d + matrix.f + 1e-7);
  const right = Math.round((x + width) * matrix.a + matrix.e + 1e-7);
  const bottom = Math.round((y + height) * matrix.d + matrix.f + 1e-7);
  return [left, top, right - left, bottom - top];
}

function drawRegion(ctx, background, family, seed, x, y, width, height, scale, area, cache, matrix) {
  if (!intersects(x, y, width, height, area)) return;
  if (Math.min(width, height) * scale < 0.8) {
    ctx.fillStyle = background.color; ctx.fillRect(...rasterBounds(matrix, x, y, width, height));
    return;
  }
  if (cache && Math.max(width, height) * scale <= 192) {
    const resolution = 2 ** Math.ceil(Math.log2(Math.max(16, Math.max(width, height) * scale)));
    const key = `${family.id}:${family.variants ? seed : 0}:${resolution}`;
    let thumbnail = background.thumbnails.get(key);
    if (!thumbnail) {
      const ratio = width / height;
      thumbnail = surface(Math.max(1, Math.round(resolution * Math.min(1, ratio))),
        Math.max(1, Math.round(resolution / Math.max(1, ratio))));
      const thumbnailContext = thumbnail.getContext("2d");
      drawRegion(thumbnailContext, background, family, seed, 0, 0, thumbnail.width, thumbnail.height, 1, null, false, thumbnailContext.getTransform());
      background.thumbnailPixels += thumbnail.width * thumbnail.height;
      while (background.thumbnails.size >= 512 || background.thumbnailPixels > 4 * 1024 * 1024) {
        const oldest = background.thumbnails.keys().next().value, previous = background.thumbnails.get(oldest);
        background.thumbnailPixels -= previous.width * previous.height;
        background.thumbnails.delete(oldest);
      }
    } else background.thumbnails.delete(key);
    background.thumbnails.set(key, thumbnail);
    const bounds = rasterBounds(matrix, x, y, width, height);
    if (bounds[2] > 0 && bounds[3] > 0) ctx.drawImage(thumbnail, ...bounds);
    return;
  }
  const children = regionChildren(family, seed);
  if (children) {
    children.forEach((child, index) => drawRegion(ctx, background, child.family,
      positionSeed(seed, family.id, index, 3571), x + child.x * width, y + child.y * height,
      width * child.size, height * child.size, scale, area, cache, matrix));
  } else {
    for (const tile of family.tiles) {
      const tx = x + tile.x / background.layout.width * width, ty = y + tile.y * height;
      const tw = tile.width / background.layout.width * width, th = tile.height * height;
      if (intersects(tx, ty, tw, th, area)) {
        const bounds = rasterBounds(matrix, tx, ty, tw, th);
        if (bounds[2] > 0 && bounds[3] > 0) ctx.drawImage(drawable(background.images[tile.image]), ...bounds);
      }
    }
  }
}

export function drawPictures(ctx, background, area, scale = 1) {
  const matrix = ctx.getTransform();
  ctx.save();
  try {
    // Canvas clipping remains in device space; rasterize each shared edge once.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const [x, y, width, height] = area;
    const x0 = Math.floor(x / background.width), x1 = Math.ceil((x + width) / background.width);
    const y0 = Math.floor(y / background.height), y1 = Math.ceil((y + height) / background.height);
    if ((x1 - x0) * (y1 - y0) > 2048) {
      // At extreme overview scales individual regions are below useful resolution.
      ctx.fillStyle = background.color; ctx.fillRect(...rasterBounds(matrix, ...area));
      return;
    }
    for (let row = y0; row < y1; row++) for (let col = x0; col < x1; col++) {
      const { family, seed } = regionFamily(background.hierarchy, col, row);
      drawRegion(ctx, background, family, seed, col * background.width, row * background.height,
        background.width, background.height, scale, area, true, matrix);
    }
  } finally { ctx.restore(); }
}

function notify(message) {
  app.extensionManager.toast.add({ severity: "warn", summary: "画布背景", detail: message, life: 8000 });
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("liuxinyu-canvas-background", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("background");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function browserStorage() {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("background", "readonly");
      const request = transaction.objectStore("background").get("current");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || new Error("浏览器存储事务已取消"));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

const storage = value => value === undefined ? backgroundStore.load() : backgroundStore.save(value);

function persist() {
  const revision = ++saveRevision;
  const value = { settings: { ...settings }, records: [...records] };
  saveStatus = ""; updateSaveStatus();
  saveChain = saveChain.then(async () => {
    const failures = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (revision !== saveRevision) return;
      try {
        await storage(value);
        if (revision === saveRevision) {
          saveStatus = ""; updateSaveStatus();
          if (saveErrorToast) { app.extensionManager.toast.remove(saveErrorToast); saveErrorToast = null; }
        }
        return;
      } catch (error) {
        if (revision !== saveRevision) return;
        failures.push(`第 ${attempt}/8 次 · ${new Date().toISOString()}\n${error.stack || error.message || String(error)}`);
        if (attempt < 8) await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 8000)));
      }
    }
    saveStatus = [
      "画布背景未能保存：8 次尝试均失败。当前预览仍保留，磁盘配置未确认更新。",
      `配置版本：${revision}；目录：${backgroundStore.directory}`,
      `设置：${JSON.stringify(value.settings, null, 2)}`,
      `图片：${JSON.stringify(value.records.map(record => ({ name: record.name, ratio: record.ratio, bytes: record.blob.size, type: record.blob.type })), null, 2)}`,
      ...failures,
    ].join("\n\n");
    updateSaveStatus();
    if (saveErrorToast) app.extensionManager.toast.remove(saveErrorToast);
    saveErrorToast = { severity: "error", summary: "画布背景保存失败", detail: saveStatus, life: 0 };
    app.extensionManager.toast.add(saveErrorToast);
  });
}

async function decode(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}

async function decodeGif(blob) {
  if (typeof ImageDecoder === "undefined") return null;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: "image/gif" });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const frames = [];
  try {
    for (let index = 0; index < track.frameCount; index++) {
      const result = await decoder.decode({ frameIndex: index });
      const frame = result.image;
      const scale = Math.min(1, 1024 / Math.max(frame.displayWidth, frame.displayHeight));
      const width = Math.max(1, Math.round(frame.displayWidth * scale));
      const height = Math.max(1, Math.round(frame.displayHeight * scale));
      const canvas = surface(width, height);
      canvas.getContext("2d").drawImage(frame, 0, 0, width, height);
      const duration = Math.max(10, Math.round((frame.duration || 100000) / 1000));
      frame.close();
      frames.push({ image: canvas, duration });
    }
  } finally { decoder.close?.(); }
  return frames.length ? { frames, frame: 0, elapsed: 0 } : null;
}

async function decodeRecord(record) {
  if (isGifRecord(record)) {
    try {
      const animation = await decodeGif(record.blob);
      if (animation) return animation;
    } catch { /* Fall back to the browser's static image decoder. */ }
  }
  return decode(record.blob);
}

async function prepare(file) {
  if (file.type === "image/gif" || /\.gif$/i.test(file.name)) {
    let animation = null;
    try { animation = await decodeGif(file); } catch { /* Fall back to the browser's static image decoder. */ }
    if (animation) {
      const image = animation.frames[0].image;
      return { record: { name: file.name, blob: file, ratio: image.width / image.height, animated: true }, image: animation };
    }
  }
  const image = await decode(file);
  const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
  const canvas = surface(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) throw new Error(`无法读取图片：${file.name}`);
  return { record: { name: file.name, blob, ratio: image.width / image.height, animated: false }, image: canvas };
}

function nativeGrid(canvas, source) {
  let entry = grids.get(canvas);
  if (entry?.source === source) return entry.profile;
  entry = { source, profile: STANDARD_GRID };
  grids.set(canvas, entry);
  const image = new Image();
  image.onload = () => {
    try {
      const grid = surface(image.width, image.height), ctx = grid.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height);
      entry.profile = gridProfile(pixels.data, image.width, image.height);
      redraw();
    } catch (error) { notify(`无法读取主题网格，已使用标准矢量网格：${error.message}`); }
  };
  image.onerror = () => notify("主题网格无法加载，已使用标准矢量网格。");
  image.src = source;
  return entry.profile;
}

export function install(canvas) {
  if (!canvas || installed.has(canvas)) return;
  installed.add(canvas);
  const drawBackCanvas = canvas.drawBackCanvas;
  canvas.drawBackCanvas = function (...args) {
    const display = settings;
    const background = texture;
    if (!this.graph) return drawBackCanvas.apply(this, args);
    const source = this.background_image, color = this.clear_background_color;
    const grid = source && display.gridOpacity > 0 ? nativeGrid(this, source) : null;
    // Let native groups, connections, callbacks and viewport clipping run normally.
    this.background_image = null;
    this.clear_background_color = null;
    let result;
    try { result = drawBackCanvas.apply(this, args); }
    finally { this.background_image = source; this.clear_background_color = color; }
    const ctx = this.bgctx;
    ctx.save();
    try {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.viewport) {
        ctx.beginPath(); ctx.rect(...this.viewport); ctx.clip();
      }
      this.ds.toCanvasContext(ctx);
      ctx.globalCompositeOperation = "destination-over";
      const area = this.visible_area;
      const baseColor = color && color !== "transparent" ? color : "#222";
      // Grid is behind native drawing, then pictures behind grid, then the base color.
      if (grid) drawVectorGrid(ctx, this, grid, display.gridOpacity, dpr);
      if (display.enabled && background) {
        if (display.opacity > 0 && display.groupFade > 0) {
          // One nonzero fill covers the union, so overlapping groups fade only once.
          // Under native drawing and grid, this reduces only the image contribution.
          ctx.beginPath();
          let hasGroups = false;
          for (const group of this.graph._groups) {
            const bounds = group._bounding;
            if (bounds?.length === 4 && Array.from(bounds).every(Number.isFinite) &&
                bounds[2] > 0 && bounds[3] > 0 && intersects(...bounds, area)) {
              ctx.rect(...bounds); hasGroups = true;
            }
          }
          if (hasGroups) { ctx.globalAlpha = display.groupFade; ctx.fillStyle = baseColor; ctx.fill(); }
        }
        ctx.globalAlpha = display.opacity;
        drawPictures(ctx, background, area, this.ds.scale * dpr);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = baseColor;
      ctx.fillRect(...area);
    } finally { ctx.restore(); }
    return result;
  };
}

export function panelBounds(x, y, width, height, viewportWidth, viewportHeight) {
  return { x: Math.max(12, Math.min(x, viewportWidth - width - 12)),
    y: Math.max(12, Math.min(y, viewportHeight - height - 12)) };
}

function openPanel() {
  if (panel) { panel.focus(); return; }
  if (!document.getElementById("liuxinyu-bg-style")) {
    const link = document.createElement("link");
    link.id = "liuxinyu-bg-style"; link.rel = "stylesheet";
    link.href = "/extensions/comfyui-liuxinyu-packs/canvas_background.css";
    document.head.append(link);
  }
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // ComfyUI treats every dialog[open] as modal, including dialog.show().
  const dialog = element("div", "liuxinyu-bg-panel");
  dialog.setAttribute("role", "region"); dialog.setAttribute("aria-label", "画布背景"); dialog.tabIndex = -1;
  panel = dialog;
  let closed = false, importMode = "replace", drag = null;
  const urls = [], controls = [], dismissSliders = [];
  const hideSliderEditors = () => dismissSliders.forEach(dismiss => dismiss());
  const capture = () => ({ settings: { ...settings }, pictures, records });
  let committed = capture();
  const same = (a, b) => a.pictures === b.pictures && a.records === b.records && JSON.stringify(a.settings) === JSON.stringify(b.settings);
  const commitAdjustment = () => {
    const state = capture();
    if (!same(state, committed)) {
      committed = state;
      persist();
    }
    sync();
  };
  const track = (control, unavailable = () => false) => { controls.push([control, unavailable]); return control; };
  const button = (text, action, className = "") => {
    const node = element("button", className, text);
    node.type = "button"; node.onclick = action;
    return node;
  };
  const status = element("p", "liuxinyu-bg-status");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.hidden = true;
  const message = text => { status.textContent = text; status.hidden = !text; };
  const position = (x = panelPosition?.x ?? window.innerWidth - 384, y = panelPosition?.y ?? 72) => {
    if (closed) return;
    const rect = dialog.getBoundingClientRect();
    panelPosition = panelBounds(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    dialog.style.left = `${panelPosition.x}px`; dialog.style.top = `${panelPosition.y}px`;
  };
  const resized = () => { hideSliderEditors(); position(); };
  document.getElementById("liuxinyu-bg-style").addEventListener("load", resized, { once: true });
  const header = element("div", "liuxinyu-bg-header");
  const handle = element("h2", "liuxinyu-bg-handle", "画布背景");
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    hideSliderEditors();
    const rect = dialog.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = event => {
    if (drag?.id === event.pointerId) position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  };
  const endDrag = event => { if (drag?.id === event.pointerId) drag = null; };
  handle.onpointerup = endDrag; handle.onpointercancel = endDrag; handle.onlostpointercapture = endDrag;
  const body = element("div", "liuxinyu-bg-body"); body.id = "liuxinyu-bg-body";
  const collapse = button("收起", () => {
    hideSliderEditors();
    body.hidden = !body.hidden; collapse.textContent = body.hidden ? "展开" : "收起";
    collapse.setAttribute("aria-expanded", String(!body.hidden)); position();
  }, "liuxinyu-bg-collapse");
  collapse.setAttribute("aria-expanded", "true"); collapse.setAttribute("aria-controls", body.id);
  const close = button("×", () => closePanel(), "liuxinyu-bg-quiet liuxinyu-bg-close");
  close.title = "关闭"; close.setAttribute("aria-label", "关闭画布背景面板");
  header.append(handle, collapse, close);
  const enabledLabel = element("label", "liuxinyu-bg-switch", "显示图片背景");
  const enabled = track(element("input")); enabled.type = "checkbox"; enabled.name = "enabled"; enabled.checked = settings.enabled;
  enabled.onchange = () => { settings.enabled = enabled.checked; redraw(); commitAdjustment(); };
  enabledLabel.append(enabled); body.append(enabledLabel);

  function rangeControl(key, label, min, max, step, factor, logarithmic = false, piecewise = false, visibleWhen = () => true) {
    const isLevels = key === "levels";
    const block = element("div", "liuxinyu-bg-control"), title = element("label", "", label);
    const slider = element("div", "liuxinyu-bg-slider"), ticks = element("div", "liuxinyu-bg-ticks");
    const editor = element("div", "liuxinyu-bg-slider-editor"), entry = element("div", "liuxinyu-bg-slider-entry");
    const range = track(element("input")), number = track(element("input"));
    const unit = isLevels ? "层" : "%";
    const anchors = piecewise ? [100] : logarithmic ? [50, 100, 200] : [];
    let hoverTimer = null, pressed = false, overThumb = false, wheel = 0;
    range.type = "range"; range.name = key; range.id = `liuxinyu-bg-${key}`;
    range.min = logarithmic || piecewise ? 0 : min; range.max = logarithmic || piecewise ? 1000 : max; range.step = logarithmic || piecewise ? 1 : step;
    number.type = "number"; number.name = `${key}-value`; number.min = min; number.max = max; number.step = logarithmic ? 0.1 : 1;
    title.htmlFor = range.id; number.setAttribute("aria-label", `${label}，${isLevels ? "层" : "百分比"}`);
    editor.id = `${range.id}-editor`; editor.hidden = true;
    editor.setAttribute("role", "dialog"); editor.setAttribute("aria-label", label);
    range.setAttribute("aria-controls", editor.id); range.setAttribute("aria-haspopup", "dialog"); range.setAttribute("aria-expanded", "false");
    ticks.setAttribute("aria-hidden", "true");
    const toSlider = value => logarithmic ? Math.log(value / min) / Math.log(max / min) * 1000 :
      piecewise ? (value <= 100 ? value * 5 : 500 + (value - 100) * 2.5) : value;
    const fromSlider = value => logarithmic ? min * (max / min) ** (value / 1000) :
      piecewise ? (value <= 500 ? value / 5 : 100 + (value - 500) / 2.5) : value;
    const fraction = value => (toSlider(value) - Number(range.min)) / (Number(range.max) - Number(range.min));
    const placeEditor = () => {
      const width = range.getBoundingClientRect().width;
      const x = 16 + Math.max(0, width - 32) * fraction(settings[key] * factor);
      const half = editor.getBoundingClientRect().width / 2 + 2;
      editor.style.left = `${Math.max(half, Math.min(x, width - half))}px`;
    };
    const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
    const hideEditor = () => {
      cancelHover();
      editor.hidden = true; range.setAttribute("aria-expanded", "false"); overThumb = false; wheel = 0;
    };
    dismissSliders.push(hideEditor);
    const showEditor = () => {
      if (range.disabled || closed || body.hidden || document.hidden || !document.hasFocus()) return;
      hideSliderEditors(); editor.hidden = false; placeEditor(); range.setAttribute("aria-expanded", "true");
    };
    const nearThumb = event => {
      const rect = range.getBoundingClientRect();
      const x = rect.left + 16 + Math.max(0, rect.width - 32) * fraction(settings[key] * factor);
      return Math.abs(event.clientX - x) <= 12 && Math.abs(event.clientY - rect.top - rect.height / 2) <= 12;
    };
    const hover = event => {
      if (pressed) return;
      overThumb = nearThumb(event);
      if (!overThumb || event.buttons || range.disabled) { hideEditor(); return; }
      if (hoverTimer === null && editor.hidden) hoverTimer = setTimeout(() => {
        hoverTimer = null; if (overThumb) showEditor();
      }, 1000);
    };
    range.onpointerenter = hover; range.onpointermove = hover;
    range.onpointerleave = event => {
      if (pressed || editor.contains(event.relatedTarget)) return;
      hideEditor();
    };
    range.onpointerdown = event => {
      if (event.button !== 0 || range.disabled) return;
      pressed = true; range.setPointerCapture(event.pointerId); showEditor();
    };
    range.onpointerup = () => { pressed = false; hideEditor(); };
    range.onpointercancel = range.onlostpointercapture = () => { pressed = false; hideEditor(); };
    slider.onpointerleave = (event = {}) => {
      if (pressed) return;
      if (document.activeElement === number) {
        void commit();
        if (event.relatedTarget && !document.hidden && document.hasFocus()) range.focus();
      }
      hideEditor();
    };
    const sizeNumber = () => { number.style.width = `${Math.max(1, number.value.length)}ch`; };
    const update = () => {
      const percentage = Math.round(settings[key] * factor * 100) / 100;
      range.value = String(toSlider(percentage)); number.value = String(percentage);
      sizeNumber();
      range.setAttribute("aria-valuetext", `${percentage}${unit}`);
      if (!editor.hidden) placeEditor();
    };
    const apply = raw => {
      if (raw.trim() === "") return false;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max || (isLevels && !Number.isInteger(value))) return false;
      const previous = settings[key]; settings[key] = value / factor;
      if (key === "size" && texture) { texture.width *= settings.size / previous; texture.height *= settings.size / previous; }
      if (key === "gifSpeed") syncAnimation();
      redraw(); sync(); return true;
    };
    range.oninput = () => {
      let value = fromSlider(Number(range.value));
      if (pressed && anchors.length) {
        const width = Math.max(1, range.getBoundingClientRect().width - 32);
        const closest = anchors.reduce((a, b) => Math.abs(fraction(a) - fraction(value)) < Math.abs(fraction(b) - fraction(value)) ? a : b);
        if (Math.abs(fraction(closest) - fraction(value)) * width <= 6) value = closest;
      }
      if (apply(String(Math.round(value * 100) / 100))) update();
    };
    number.oninput = () => {
      sizeNumber();
      if (apply(number.value)) { range.value = String(toSlider(Number(number.value))); range.setAttribute("aria-valuetext", `${number.value}${isLevels ? "层" : "%"}`); }
    };
    const commit = async () => {
      if (busy) return;
      if (number.value.trim() !== "" && Number.isFinite(Number(number.value))) apply(String(Math.max(min, Math.min(max, Number(number.value)))));
      if (isLevels && settings.levels !== committed.settings.levels) {
        busy = true; sync(); message("正在计算嵌套布局…");
        try { await rebuild(); message(""); }
        catch (error) { settings.levels = committed.settings.levels; message(error.message); }
        finally { busy = false; sync(); }
      }
      update(); commitAdjustment();
    };
    range.onchange = commit;
    number.onchange = commit;
    number.onblur = () => { const result = commit(); hideEditor(); return result; };
    const nudge = amount => {
      const current = settings[key] * factor;
      const next = current + amount;
      apply(String(Math.max(min, Math.min(max, Math.round(next * 100) / 100)))); update(); return commit();
    };
    range.addEventListener("wheel", event => {
      event.preventDefault(); event.stopPropagation();
      if (range.disabled || pressed || event.ctrlKey || event.metaKey) return;
      wheel += event.deltaMode === 1 ? -event.deltaY / 3 : event.deltaMode === 2 ? -Math.sign(event.deltaY) : -event.deltaY / 100;
      const amount = Math.trunc(wheel);
      if (!amount) return;
      wheel -= amount; return nudge(Math.max(-10, Math.min(10, amount)));
    }, { passive: false });
    range.onkeydown = event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === "F2") {
        showEditor(); if (!editor.hidden) { number.focus(); number.select(); }
      }
    };
    number.onkeydown = event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === "Escape") {
        const result = commit(); hideEditor(); range.focus(); return result;
      }
    };
    for (const anchor of anchors) {
      const tick = element("span"); tick.style.left = `${fraction(anchor) * 100}%`; ticks.append(tick);
    }
    entry.append(number, element("small", "", unit)); editor.append(entry);
    if (anchors.length) slider.append(ticks);
    slider.append(range, editor); block.append(title, slider);
    body.append(block); update();
    const syncVisibility = () => {
      block.hidden = !visibleWhen();
      if (block.hidden) hideEditor();
    };
    syncVisibility();
    return { syncVisibility };
  }
  rangeControl("size", "图片缩放", 10, 500, 1, 100 / defaults.size, true);
  rangeControl("opacity", "图片不透明度", 0, 100, 1, 100);
  rangeControl("groupFade", "组内背景淡化", 0, 100, 1, 100);
  rangeControl("gridOpacity", "网格不透明度", 0, 100, 1, 100);
  rangeControl("levels", "嵌套层数", 0, 10, 1, 1);
  const gifSpeedControl = rangeControl("gifSpeed", "GIF 播放速度", 0, 300, 1, 100, false, true, hasGif);

  const levelStatus = element("p", "liuxinyu-bg-level-status");
  const sync = () => {
    controls.forEach(([control, unavailable]) => { control.disabled = busy || unavailable(); });
    if (busy) hideSliderEditors();
    gifSpeedControl.syncVisibility();
    syncAnimation();
    levelStatus.hidden = !texture?.hierarchy || texture.hierarchy.depth === settings.levels;
    levelStatus.textContent = levelStatus.hidden ? "" : `实际嵌套：${texture.hierarchy.depth} 层`;
    grid.querySelectorAll("button").forEach(node => { node.disabled = busy; });
  };
  body.append(levelStatus);
  const seedBlock = element("div", "liuxinyu-bg-seed"), seedLabel = element("label", "", "种子");
  const seedRow = element("div", "liuxinyu-bg-seed-row"), seedInput = track(element("input"));
  seedInput.type = "number"; seedInput.name = "seed"; seedInput.id = "liuxinyu-bg-seed";
  seedInput.min = 0; seedInput.max = 4294967295; seedInput.step = 1; seedInput.value = String(settings.seed);
  seedLabel.htmlFor = seedInput.id;
  const applySeed = async value => {
    if (busy) return;
    const previous = settings.seed;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 4294967295) {
      seedInput.value = String(previous); message("种子须为 0～4294967295 的整数"); return;
    }
    const next = Number(value); seedInput.value = String(next);
    if (next === previous) return;
    busy = true; settings.seed = next; sync(); message("正在计算布局…");
    try { await rebuild(); commitAdjustment(); message(""); }
    catch (error) { settings.seed = previous; message(error.message); }
    finally { seedInput.value = String(settings.seed); busy = false; sync(); }
  };
  seedInput.onchange = seedInput.onblur = () => applySeed(seedInput.value);
  seedInput.onkeydown = event => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) return applySeed(seedInput.value);
  };
  const generate = track(button("生成", () => {
    let next = crypto.getRandomValues(new Uint32Array(1))[0];
    if (next === settings.seed) next = (next + 1) >>> 0;
    return applySeed(String(next));
  }));
  generate.title = "生成新随机种子"; generate.setAttribute("aria-label", generate.title);
  seedRow.append(seedInput, generate); seedBlock.append(seedLabel, seedRow); body.append(seedBlock);

  const collection = element("details", "liuxinyu-bg-images"); collection.open = !records.length;
  const summary = element("summary"), count = element("span"), miniatures = element("span", "liuxinyu-bg-miniatures");
  summary.append(count, miniatures); collection.append(summary); collection.ontoggle = () => position();
  const toolbar = element("div", "liuxinyu-bg-toolbar"), grid = element("div", "liuxinyu-bg-grid");
  const empty = element("p", "liuxinyu-bg-empty", "暂无图片");
  const file = element("input"); file.type = "file"; file.name = "background-images"; file.accept = "image/*"; file.multiple = true; file.hidden = true;
  file.setAttribute("aria-label", "选择背景图片");
  const choose = mode => { importMode = mode; file.click(); };
  toolbar.append(track(button("添加图片", () => choose("append"))), track(button("替换整组", () => choose("replace")), () => !records.length));
  const revokeThumbnails = () => { urls.splice(0).forEach(url => URL.revokeObjectURL(url)); };
  const renderImages = () => {
    if (closed) return;
    revokeThumbnails(); grid.replaceChildren(); miniatures.replaceChildren();
    count.textContent = `图片 · ${records.length} 张`; empty.hidden = !!records.length;
    records.forEach((record, index) => {
      const url = URL.createObjectURL(record.blob); urls.push(url);
      const item = element("div", "liuxinyu-bg-image"), image = element("img"), caption = element("small", "", record.name);
      image.src = url; image.alt = ""; image.loading = "lazy"; caption.title = record.name;
      const remove = button("×", async () => {
        try { await changeImages(pictures.filter((_, i) => i !== index), records.filter((_, i) => i !== index)); }
        catch (error) { message(`未更改原背景：${error.message}`); }
      }, "liuxinyu-bg-remove");
      remove.title = `移除 ${record.name}`; remove.setAttribute("aria-label", remove.title); remove.disabled = busy;
      item.append(image, remove, caption); grid.append(item);
      if (index < 3) { const miniature = element("img"); miniature.src = url; miniature.alt = ""; miniatures.append(miniature); }
    });
  };
  async function changeImages(images, files) {
    busy = true; sync();
    try {
      const prepared = await prepareTexture(images, files);
      pictures = images; records = files; texture = prepared;
      syncAnimation();
      redraw(); renderImages(); commitAdjustment(); position();
    } finally { busy = false; sync(); }
  }
  const clear = track(button("清空", () => changeImages([], []), "liuxinyu-bg-quiet"), () => !records.length);
  toolbar.append(clear);
  collection.append(toolbar, empty, grid, file); body.append(collection, status);
  async function importFiles(files, mode) {
    if (!files.length || busy) return;
    busy = true; sync(); grid.querySelectorAll("button").forEach(node => { node.disabled = true; });
    const next = [];
    try {
      for (const [i, item] of files.entries()) { message(`正在读取 ${i + 1}/${files.length}：${item.name}`); next.push(await prepare(item)); }
      await changeImages([...(mode === "append" ? pictures : []), ...next.map(item => item.image)],
        [...(mode === "append" ? records : []), ...next.map(item => item.record)]);
      message("");
    } catch (error) {
      const text = `未更改原背景：${error.message}`; message(text); if (closed) notify(text);
    } finally { busy = false; file.value = ""; sync(); grid.querySelectorAll("button").forEach(node => { node.disabled = false; }); }
  }
  file.onchange = () => importFiles(Array.from(file.files || []), importMode);
  dialog.ondragover = event => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); dialog.dataset.drop = "true";
  };
  dialog.ondragleave = event => { if (!dialog.contains(event.relatedTarget)) delete dialog.dataset.drop; };
  dialog.ondrop = event => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault(); event.stopPropagation(); delete dialog.dataset.drop;
    return importFiles(Array.from(event.dataTransfer?.files || []), "append");
  };
  const saved = element("pre", "liuxinyu-bg-save-error");
  saved.setAttribute("role", "alert");
  updateSaveStatus = () => { if (closed) return; saved.hidden = !saveStatus; saved.textContent = saveStatus; };
  body.append(saved); updateSaveStatus();
  dialog.append(header, body);
  // Isolate pointer gestures only. Keyboard events pass through to ComfyUI unchanged.
  for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu"]) {
    dialog.addEventListener(type, event => event.stopPropagation());
  }
  const loseFocus = hideSliderEditors;
  const visibility = () => { if (document.hidden) loseFocus(); };
  body.addEventListener("scroll", hideSliderEditors);
  const closePanel = () => {
    if (closed) return;
    hideSliderEditors();
    if (!busy) commitAdjustment(); closed = true; revokeThumbnails(); window.removeEventListener("resize", resized);
    window.removeEventListener("blur", loseFocus); document.removeEventListener("visibilitychange", visibility);
    document.getElementById("liuxinyu-bg-style").removeEventListener("load", resized);
    if (document.hasFocus() && dialog.contains(document.activeElement)) app.canvas?.canvas?.focus?.({ preventScroll: true });
    panel = null; updateSaveStatus = () => {}; dialog.remove();
  };
  renderImages(); sync();
  (document.getElementById("graph-canvas-container") || document.body).append(dialog);
  dialog.focus({ preventScroll: true }); position();
  window.addEventListener("resize", resized);
  window.addEventListener("blur", loseFocus); document.addEventListener("visibilitychange", visibility);
}

app.registerExtension({
  name: "liuxinyu.CanvasBackground",
  async setup() {
    install(app.canvas);
    busy = true;
    try {
      const saved = await storage();
      if (saved) {
        const images = [];
        for (const record of saved.records) images.push(await decodeRecord(record));
        settings = Object.fromEntries(Object.keys(defaults).map(key => [key, saved.settings[key] ?? defaults[key]]));
        settings.levels = Math.max(0, Math.min(10, Math.floor(Number(settings.levels) || 0)));
        settings.groupFade = Number.isFinite(Number(settings.groupFade)) ? Math.max(0, Math.min(1, Number(settings.groupFade))) : defaults.groupFade;
        settings.gifSpeed = Number.isFinite(Number(settings.gifSpeed)) ? Math.max(0, Math.min(3, Number(settings.gifSpeed))) : defaults.gifSpeed;
        records = saved.records; pictures = images;
        await rebuild();
        syncAnimation();
      }
      saveStatus = "";
      if (saved?.needsMigration) persist();
    } catch (error) { saveStatus = `未能读取本地配置：${error.message}`; notify(saveStatus); }
    finally { busy = false; }
  },
  afterConfigureGraph() { install(app.canvas); },
});

registerMenuItem("canvas-background", {
  canvas: () => ({ content: busy ? "画布背景（读取中）" : "画布背景…", disabled: busy, callback: openPanel }),
});
