import { PreviewZoom, SmoothPreviewImage, beginPreviewZoom, previewImageURL } from "./smooth_preview.js";
import { layoutThumbnailGrid } from "./thumbnail_grid.js";
import { enablePreviewResize } from "./preview_resize.js";

export class SmoothImageGrid {
  constructor(container, app, api, { onClick, allowFocus = false } = {}) {
    this.container = container;
    this.app = app;
    this.api = api;
    this.entries = [];
    this.focusIndex = null;
    this.visible = true;
    this.frame = 0;
    this.disposed = false;
    this.layoutKey = "";
    this.signature = null;
    container.style.cssText = "position:relative; display:flex; justify-content:center; align-items:flex-start; width:100%; height:100%; overflow:hidden; contain:layout paint;";
    this.grid = document.createElement("div");
    this.grid.style.cssText = "display:grid; gap:0; flex:none;";
    container.appendChild(this.grid);
    this.back = document.createElement("button");
    this.back.textContent = "返回缩略图";
    this.back.style.cssText = "position:absolute; top:8px; right:8px; display:none; cursor:pointer; z-index:2;";
    this.back.addEventListener("click", event => { event.stopPropagation(); this.focus(null); });
    container.appendChild(this.back);
    this.zoom = new PreviewZoom(app, {
      onStart: () => { for (const entry of this.entries) entry.image.setLowQuality(true); },
      onEnd: () => this.schedule(),
    });
    this.onClick = onClick || ((index) => {
      if (allowFocus) { this.focus(index); container.focus({ preventScroll: true }); }
    });
    this.allowFocus = allowFocus;
    this.onKeyDown = event => {
      if (!allowFocus || this.focusIndex === null) return;
      if (event.key === "Escape") this.focus(null);
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        this.focus((this.focusIndex + (event.key === "ArrowLeft" ? -1 : 1) + this.entries.length) % this.entries.length);
      } else return;
      event.preventDefault(); event.stopPropagation();
    };
    if (allowFocus) container.tabIndex = 0;
    container.addEventListener("keydown", this.onKeyDown);
    this.onWheel = event => {
      event.preventDefault(); event.stopPropagation();
      beginPreviewZoom(app);
      app.canvas?.processMouseWheel?.(event);
    };
    container.addEventListener("wheel", this.onWheel, { passive: false });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(container);
    this.visibility = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.schedule();
    });
    this.visibility.observe(container);
  }

  setImages(metas) {
    const signature = JSON.stringify(metas.map(meta => [meta.filename, meta.subfolder, meta.type, meta.preview_size, meta.display]));
    if (signature === this.signature) return;
    this.signature = signature;
    const previous = new Map(this.entries.map(entry => [entry.key, entry]));
    const counts = new Map();
    this.entries = metas.map((meta, index) => {
      const url = previewImageURL(this.api, meta);
      const count = counts.get(url) || 0;
      counts.set(url, count + 1);
      const key = `${url}/${count}`;
      let entry = previous.get(key);
      if (entry) previous.delete(key);
      else {
        const cell = document.createElement("div");
        cell.style.cssText = "position:relative; min-width:0; min-height:0; overflow:hidden; cursor:pointer;";
        const image = new SmoothPreviewImage(this.api, meta, () => this.schedule());
        cell.appendChild(image.element);
        entry = { key, cell, image };
        cell.addEventListener("click", event => this.onClick(this.entries.indexOf(entry), event));
        if (this.allowFocus) {
          cell.title = "单击放大，双击打开原图；放大后可用左右键切图、Esc 返回";
          cell.addEventListener("dblclick", () => window.open(url, "_blank", "noopener"));
        }
      }
      entry.cell.dataset.index = String(index);
      if (this.zoom.lowQuality) entry.image.setLowQuality(true);
      this.grid.appendChild(entry.cell);
      return entry;
    });
    for (const entry of previous.values()) { entry.image.dispose(); entry.cell.remove(); }
    if (this.focusIndex >= metas.length) this.focusIndex = null;
    this.layoutKey = "";
    this.schedule();
  }

  focus(index) {
    this.focusIndex = index;
    this.layoutKey = "";
    this.layout();
  }

  schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.layout(); });
  }

  draw(position) { this.zoom.draw(position); }

  layout() {
    if (this.disposed || !this.visible) return;
    const bounds = getComputedStyle(this.container);
    const width = parseFloat(bounds.width), height = parseFloat(bounds.height);
    if (!(width > 0 && height > 0)) return;
    const entries = this.focusIndex === null ? this.entries : this.entries.slice(this.focusIndex, this.focusIndex + 1);
    const key = `${width}/${height}/${this.focusIndex}/${entries.map(entry => entry.image.size).join(";")}`;
    if (key !== this.layoutKey) {
      const sizes = entries.map(entry => ({ naturalWidth: entry.image.size?.[0] || 192, naturalHeight: entry.image.size?.[1] || 192 }));
      const layout = layoutThumbnailGrid(this.grid, sizes, width, height);
      if (layout) { this.cellWidth = layout.cellWidth; this.cellHeight = layout.cellHeight; this.layoutKey = key; }
      for (let index = 0; index < this.entries.length; index++) {
        this.entries[index].cell.style.display = this.focusIndex === null || index === this.focusIndex ? "block" : "none";
      }
      this.back.style.display = this.focusIndex !== null && this.entries.length > 1 ? "block" : "none";
      this.container.style.alignItems = this.focusIndex !== null || this.entries.length === 1 ? "center" : "flex-start";
    }
    for (const entry of entries) {
      const size = entry.image.size;
      const imageWidth = size ? Math.min(this.cellWidth, this.cellHeight * size[0] / size[1]) : this.cellWidth;
      entry.image.render(imageWidth || 192, this.zoom.zoom, this.zoom.lowQuality,
        this.container, this.app.canvas?.canvas, this.focusIndex !== null);
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.zoom.dispose();
    this.resize.disconnect(); this.visibility.disconnect();
    this.container.removeEventListener("wheel", this.onWheel);
    this.container.removeEventListener("keydown", this.onKeyDown);
    for (const entry of this.entries) entry.image.dispose();
    this.entries = [];
    this.grid.remove(); this.back.remove();
  }
}

// Optional adapter for a node which only needs a gallery. Progress, execution
// and output tensors remain with its own extension.
export function attachSmoothImagePreview(node, app, api) {
  const container = document.createElement("div");
  const gallery = new SmoothImageGrid(container, app, api, { allowFocus: true });
  let lastOutput;
  const draw = () => {
    gallery.draw(String(node.pos));
    const output = app.nodeOutputs?.[node.id];
    if (output?.images && output !== lastOutput) { lastOutput = output; gallery.setImages(output.images); }
  };
  const widget = node.addDOMWidget("smooth_image_preview", "custom", container, {
    hideOnZoom: false, margin: 0, getMinHeight: () => 220,
    onDraw: widget => { widget.width = undefined; draw(); },
    afterResize: () => gallery.layout(),
  });
  widget.serialize = false;
  enablePreviewResize(node, widget);
  container.addEventListener("pointerdown", event => {
    event.stopPropagation();
    if (event.button === 0) app.canvas?.selectNode?.(node);
    else if (event.button === 1) app.canvas?.processMouseDown?.(event);
  });
  const emptyImages = [];
  Object.defineProperty(node, "imgs", { get: () => emptyImages, set: () => {}, configurable: true });
  // Async optional adapters can attach after core has created its widget.
  for (const item of [...node.widgets]) {
    if (item.name !== "$$canvas-image-preview") continue;
    item.onRemove?.();
    node.widgets.splice(node.widgets.indexOf(item), 1);
  }
  node.onDrawBackground = draw;
  const executed = node.onExecuted;
  node.onExecuted = function (result) {
    const previous = executed?.call(this, result?.images ? { ...result, images: undefined } : result);
    if (result?.images) gallery.setImages(result.images);
    return previous;
  };
  const removed = node.onRemoved;
  node.onRemoved = function () { gallery.dispose(); return removed?.apply(this, arguments); };
  draw();
  node.setDirtyCanvas(true, true);
  return gallery;
}
