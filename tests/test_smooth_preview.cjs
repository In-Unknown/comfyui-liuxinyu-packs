const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pack = path.join(__dirname, "..");
const requests = [], rasters = [], layouts = [], frames = new Map(), timers = new Map(), events = new Map();
let serial = 0;
const screen = { left: 0, top: 0, right: 900, bottom: 600 };
class Element {
  constructor(tag) {
    this.tag = tag; this.style = {}; this.children = []; this.events = {}; this.dataset = {};
    this.naturalWidth = 1600; this.naturalHeight = 800;
  }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  addEventListener(name, fn) { this.events[name] = fn; }
  removeEventListener(name) { delete this.events[name]; }
  removeAttribute(name) { delete this[`_${name}`]; }
  getBoundingClientRect() { return this.rect || this.parentElement?.getBoundingClientRect() || screen; }
  getContext() { return { drawImage: (...args) => rasters.push(args.slice(-2)) }; }
  focus() {}
  set src(url) { this._src = url; requests.push(url); queueMicrotask(() => { if (this._src === url) this.onload?.(); }); }
  get src() { return this._src; }
}
const app = { canvas: { canvas: new Element("canvas"), ds: { scale: 1, offset: [0, 0] } }, nodeOutputs: {} };
const api = { apiURL: url => url };
const context = {
  app, api, URLSearchParams, console,
  document: {
    createElement: tag => new Element(tag),
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
  },
  window: { innerWidth: 900, innerHeight: 600, devicePixelRatio: 2, comfyAPI: { imagePreview: {
    calculateImageGrid(images, width, height) {
      layouts.push(images.map(image => [image.naturalWidth, image.naturalHeight]));
      const cols = Math.min(3, images.length), rows = Math.ceil(images.length / cols);
      const scale = Math.min(width / cols / images[0].naturalWidth, height / rows / images[0].naturalHeight, 1);
      return { cols, rows, cellWidth: images[0].naturalWidth * scale, cellHeight: images[0].naturalHeight * scale };
    },
  } } },
  getComputedStyle: () => ({ width: "900", height: "600" }),
  requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
  ResizeObserver: class { constructor(fn) { this.callback = fn; } observe() {} disconnect() {} },
  IntersectionObserver: class { constructor(fn) { this.callback = fn; } observe() {} disconnect() {} },
  enablePreviewResize() {},
};
vm.createContext(context);
for (const name of ["smooth_preview.js", "thumbnail_grid.js", "smooth_image_grid.js"]) {
  vm.runInContext(fs.readFileSync(path.join(pack, name), "utf8").replace(/^import .*;$/gm, "").replace(/^export /gm, ""), context);
}
const { SmoothImageGrid, attachSmoothImagePreview } = vm.runInContext("({ SmoothImageGrid, attachSmoothImagePreview })", context);
async function flush() {
  for (let n = 0; n < 100; n++) {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
    await new Promise(resolve => setImmediate(resolve));
    if (!frames.size) return;
  }
  assert.fail("Preview work must settle");
}
async function settle() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await flush(); }
function wheel() { for (const fn of events.get("wheel") || []) fn({ target: app.canvas.canvas }); }
const metas = [0, 1, 2, 3].map(index => ({ filename: `original${index}.png`, type: "temp", preview_size: [1600, 800] }));

async function main() {
  const host = new Element("div");
  const gallery = new SmoothImageGrid(host, app, api, { allowFocus: true });
  gallery.setImages(metas);
  [0, 400, 510, 1000].forEach((left, index) => {
    gallery.entries[index].cell.rect = { left, right: left + 100, top: 250, bottom: 350 };
  });
  await flush();
  assert.deepEqual(requests.map(url => new URLSearchParams(url.split("?")[1]).get("filename")),
    ["original1.png", "original2.png", "original0.png"], "Restore from canvas center outward; skip offscreen images");
  assert.deepEqual([...layouts[0][0]], [1600, 800], "Layout uses original dimensions rather than the 192px raster");
  for (const entry of gallery.entries.slice(0, 3)) {
    assert.equal(entry.image.raster.width, 768, "Stable zoom selects a sufficient raster for display size and DPR");
    assert.equal(entry.image.raster.style.display, "block");
    assert.equal(entry.image.low.style.display, "none", "Transparent images have only one visible layer");
  }
  const count = requests.length, rasterCount = rasters.length, layoutCount = layouts.length;
  for (let n = 0; n < 100; n++) {
    wheel(); app.canvas.ds.scale = 1 + n / 50; gallery.draw(); await flush();
    for (const entry of gallery.entries) assert.equal(entry.image.low.style.display, "block");
  }
  assert.equal(requests.length, count);
  assert.equal(rasters.length, rasterCount, "No raster resampling during interaction");
  assert.equal(layouts.length, layoutCount, "Zoom leaves packing and cell edges unchanged");
  await settle();
  assert.equal(requests.length, count, "Restoration reuses already decoded sources");
  assert.equal(gallery.entries[1].image.sharp.style.display, "block", "Large zoom restores original-pixel detail");
  assert.equal(gallery.entries[1].image.raster.style.display, "none");
  const cells = gallery.entries.map(entry => entry.cell);
  gallery.setImages(metas.map(meta => ({ ...meta }))); await flush();
  assert.deepEqual(gallery.entries.map(entry => entry.cell), cells, "Incremental events retain existing DOM and decoded images");
  wheel(); gallery.setImages([...metas, { ...metas[0], filename: "new.png" }]); await flush();
  assert.equal(requests.length, count, "New results cannot start sharp loads in the middle of a zoom gesture");
  gallery.entries[4].cell.rect = { left: 600, right: 700, top: 250, bottom: 350 };
  await settle();
  assert.equal(requests.length, count + 1);
  gallery.focus(1); await flush();
  assert.equal(gallery.entries[0].cell.style.display, "none");
  host.events.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); await flush();
  assert.equal(gallery.focusIndex, null);
  app.canvas.ds.offset = [25, 0]; gallery.draw();
  assert.equal(gallery.entries[1].image.low.style.display, "block", "Panning also defers expensive restoration");
  gallery.dispose(); await flush();
  assert.equal(timers.size, 0);
  assert.equal(events.get("wheel").size, 0);

  // Optional adapter preserves the node's own execution/progress hooks.
  let executed = 0, removed = 0, native = 0;
  const node = {
    id: 8, widgets: [{ name: "$$canvas-image-preview", onRemove() { native++; } }],
    addDOMWidget(name, type, element, options) { const widget = { name, element, options }; this.widgets.push(widget); return widget; },
    onExecuted(result) { executed++; assert.equal(result.images, undefined); assert.equal(result.progress, 7); },
    onRemoved() { removed++; }, onDrawBackground() { native++; }, setDirtyCanvas() {},
  };
  const adapted = attachSmoothImagePreview(node, app, api);
  node.onExecuted({ images: [metas[0]], progress: 7 }); await flush();
  node.onDrawBackground();
  assert.equal(executed, 1);
  assert.equal(native, 1, "Only old widget cleanup runs; native full-image loader is suppressed");
  assert.equal(adapted.entries.length, 1);
  node.onRemoved(); await flush();
  assert.equal(removed, 1);
  assert.equal(events.get("wheel").size, 0);
  assert.equal(frames.size, 0);
  console.log("Center-first visible loading, zoom-level detail, 100 low-quality frames, incremental reuse, pan/focus, adapter hooks and cleanup passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
