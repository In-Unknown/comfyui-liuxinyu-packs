// No node-specific behavior: callers own layout, selection and image files.
const previews = new Set();
const sharpQueue = new Map();
let sharpFrame = 0;
let sharpActive = 0;

function queueFrame() {
  if (!sharpFrame && sharpQueue.size && sharpActive < 2) sharpFrame = requestAnimationFrame(drainSharpQueue);
}

function screenPriority({ element, viewport, canvas }) {
  const screen = canvas?.getBoundingClientRect() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const clip = viewport.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, screen.left, clip.left, rect.left);
  const top = Math.max(0, screen.top, clip.top, rect.top);
  const right = Math.min(window.innerWidth, screen.right, clip.right, rect.right);
  const bottom = Math.min(window.innerHeight, screen.bottom, clip.bottom, rect.bottom);
  if (!(right > left && bottom > top)) return Infinity;
  const cx = (Math.max(0, screen.left) + Math.min(window.innerWidth, screen.right)) / 2;
  const cy = (Math.max(0, screen.top) + Math.min(window.innerHeight, screen.bottom)) / 2;
  return ((left + right) / 2 - cx) ** 2 + ((top + bottom) / 2 - cy) ** 2;
}

function drainSharpQueue() {
  sharpFrame = 0;
  // Measure once after interaction has settled, never in the wheel handler.
  const jobs = [...sharpQueue].map(([owner, job]) => ({ owner, job, priority: screenPriority(job) }))
    .sort((a, b) => a.priority - b.priority);
  for (const { owner, job, priority } of jobs) {
    if (!Number.isFinite(priority)) { sharpQueue.delete(owner); continue; }
    if (sharpActive >= 2) break;
    sharpQueue.delete(owner);
    sharpActive++;
    Promise.resolve().then(job.run).catch(error => console.error("[SmoothPreview]", error)).finally(() => {
      sharpActive--;
      queueFrame();
    });
  }
}

export function queueSharpPreview(owner, element, viewport, canvas, run) {
  sharpQueue.set(owner, { element, viewport, canvas, run });
  queueFrame();
}

export function cancelSharpPreview(owner) {
  sharpQueue.delete(owner);
  if (!sharpQueue.size && sharpFrame) { cancelAnimationFrame(sharpFrame); sharpFrame = 0; }
}

function captureCanvasWheel(event) {
  for (const preview of previews) {
    if (event.target === preview.app.canvas?.canvas) preview.begin();
  }
}

export function beginPreviewZoom(app) {
  for (const preview of previews) if (preview.app === app) preview.begin();
}

export class PreviewZoom {
  constructor(app, { onStart, onEnd, settleMs = 250 }) {
    this.app = app;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.settleMs = settleMs;
    this.zoom = app.canvas?.ds?.scale || 1;
    this.view = `${app.canvas?.ds?.offset}/${app.canvas?.visible_area}`;
    this.lowQuality = false;
    this.timer = null;
    if (!previews.size) document.addEventListener("wheel", captureCanvasWheel, { capture: true, passive: true });
    previews.add(this);
  }

  begin() {
    if (!this.lowQuality) {
      this.lowQuality = true;
      this.onStart();
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lowQuality = false;
      this.zoom = this.app.canvas?.ds?.scale || 1;
      this.onEnd();
    }, this.settleMs);
  }

  draw(position = "") {
    const zoom = this.app.canvas?.ds?.scale || 1;
    const view = `${this.app.canvas?.ds?.offset}/${this.app.canvas?.visible_area}`;
    if (zoom !== this.zoom || view !== this.view || (this.position !== undefined && position !== this.position)) {
      this.zoom = zoom; this.view = view; this.begin();
    }
    this.position = position;
  }

  dispose() {
    clearTimeout(this.timer);
    previews.delete(this);
    if (!previews.size) document.removeEventListener("wheel", captureCanvasWheel, true);
  }
}

export function previewImageURL(api, meta, filename = meta.filename) {
  return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: meta.subfolder || "", type: meta.type || "temp" })}`);
}

export class SmoothPreviewImage {
  constructor(api, meta, onReady) {
    this.api = api;
    this.meta = meta;
    this.onReady = onReady;
    this.size = meta.preview_size;
    this.lowQuality = false;
    this.ready = false;
    this.wantsSharp = false;
    this.url = null;
    this.disposed = false;
    this.resolveLoad = null;
    this.version = 0;
    this.element = document.createElement("div");
    this.element.style.cssText = "position:absolute; inset:0; pointer-events:none;";
    this.sharp = document.createElement("img");
    this.sharp.alt = "";
    this.sharp.decoding = "async";
    this.sharp.draggable = false;
    this.sharp.style.cssText = "position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:none;";
    const thumbnail = meta.display?.thumbnails?.[0];
    this.low = document.createElement(thumbnail ? "img" : "canvas");
    this.low.style.cssText = "width:100%; height:100%; object-fit:contain; display:block;";
    if (thumbnail) {
      this.low.alt = "";
      this.low.decoding = "async";
      this.low.draggable = false;
      this.lowURL = previewImageURL(api, meta, thumbnail.filename);
      this.low.src = this.lowURL;
    }
    this.element.appendChild(this.low);
    this.element.appendChild(this.sharp);
    this.raster = document.createElement("canvas");
    this.raster.style.cssText = "width:100%; height:100%; object-fit:contain; display:none;";
    this.element.appendChild(this.raster);
    this.sharp.onload = () => {
      if (this.disposed) return;
      this.ready = true;
      if (!this.size) this.size = [this.sharp.naturalWidth, this.sharp.naturalHeight];
      // Other packs and old history need no backend dependency. Decode once,
      // then keep a tiny raster for subsequent zoom gestures.
      if (!thumbnail) {
        const scale = Math.min(1, 192 / Math.max(...this.size));
        this.low.width = Math.max(1, Math.round(this.size[0] * scale));
        this.low.height = Math.max(1, Math.round(this.size[1] * scale));
        this.low.getContext("2d").drawImage(this.sharp, 0, 0, this.low.width, this.low.height);
      }
      this.prepareRaster();
      this.show();
      this.resolveLoad?.(); this.resolveLoad = null;
      this.onReady();
    };
    this.sharp.onerror = () => {
      this.ready = false; this.show();
      this.resolveLoad?.(); this.resolveLoad = null;
    };
  }

  prepareRaster() {
    if (this.lowURL || !this.ready || this.lowQuality) return;
    const longest = Math.max(...this.size);
    const needed = this.density / this.size[0] * longest;
    const edge = Math.min(longest, 192 * 2 ** Math.max(0, Math.ceil(Math.log2(needed / 192))));
    this.useRaster = edge < longest;
    if (!this.useRaster || this.rasterEdge === edge) return;
    this.rasterEdge = edge;
    this.raster.width = Math.max(1, Math.round(this.size[0] * edge / longest));
    this.raster.height = Math.max(1, Math.round(this.size[1] * edge / longest));
    this.raster.getContext("2d").drawImage(this.sharp, 0, 0, this.raster.width, this.raster.height);
  }

  show() {
    const sharp = !this.lowQuality && this.ready && this.wantsSharp;
    this.sharp.style.display = sharp && !this.useRaster ? "block" : "none";
    this.raster.style.display = sharp && this.useRaster ? "block" : "none";
    this.low.style.display = sharp ? "none" : "block";
  }

  setLowQuality(value) {
    this.lowQuality = value;
    if (value) { this.version++; cancelSharpPreview(this); }
    this.show();
  }

  render(width, zoom, lowQuality, viewport, canvas, fullResolution = false) {
    if (lowQuality) { this.setLowQuality(true); return; }
    const thumbnails = this.meta.display?.thumbnails;
    this.density = width * zoom * (window.devicePixelRatio || 1);
    const density = this.density;
    let thumbnail = fullResolution ? null : (thumbnails?.find(item => item.width >= density) || thumbnails?.at(-1));
    if (thumbnail && thumbnail.width < density && this.size?.[0] > thumbnail.width) thumbnail = null;
    const url = previewImageURL(this.api, this.meta, thumbnail?.filename || this.meta.filename);
    if (!this.lowQuality && (this.ready || url === this.lowURL) && this.lastURL === url && this.lastDensity === density) return;
    const version = this.version;
    queueSharpPreview(this, this.element, viewport, canvas, () => {
      if (this.disposed || version !== this.version) return;
      this.lowQuality = false;
      this.lastDensity = density;
      this.lastURL = url;
      this.wantsSharp = url !== this.lowURL;
      if (this.wantsSharp && url !== this.url) {
        this.url = url;
        this.ready = false;
        this.resolveLoad?.();
        const loaded = new Promise(resolve => { this.resolveLoad = resolve; });
        this.sharp.src = url;
        this.show();
        return loaded;
      }
      this.prepareRaster();
      this.show();
    });
  }

  dispose() {
    this.disposed = true;
    cancelSharpPreview(this);
    this.resolveLoad?.(); this.resolveLoad = null;
    this.sharp.onload = this.sharp.onerror = null;
    this.sharp.removeAttribute("src");
    this.low.removeAttribute("src");
    if (!this.lowURL) this.low.width = this.low.height = 1;
    this.raster.width = this.raster.height = 1;
    this.element.remove();
  }
}
