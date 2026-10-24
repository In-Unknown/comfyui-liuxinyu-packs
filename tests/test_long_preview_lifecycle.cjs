const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pack = path.join(__dirname, "..");
let requests = [], frames = new Map(), timers = new Map(), serial = 0, layouts = 0, nativeDraws = 0;
let extension, resizeObserver, visibilityObserver;
const documentEvents = new Map();
const timerDelays = new Map();
const dimensions = { width: 395, height: 700 };
class Element {
  constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; this.scrollLeft = this.scrollTop = 0; }
  get clientWidth() { return dimensions.width; }
  get clientHeight() { return dimensions.height; }
  getBoundingClientRect() {
    const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
    return { left, top, right: left + (parseFloat(this.style.width) || dimensions.width),
      bottom: top + (parseFloat(this.style.height) || dimensions.height) };
  }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
  replaceChildren() { for (const child of [...this.children]) child.remove(); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  addEventListener(name, handler) { this.events[name] = handler; }
  removeAttribute(name) { delete this[`_${name}`]; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0]; }
  set src(url) { this._src = url; requests.push(url); queueMicrotask(() => { if (this._src === url) this.onload?.(); }); }
  get src() { return this._src; }
}
const context = {
  URLSearchParams,
  document: { createElement: tag => new Element(tag), head: new Element("head"),
    addEventListener(name, fn, options) {
      if (name === "wheel") { assert.equal(options.capture, true); assert.equal(options.passive, true); }
      if (!documentEvents.has(name)) documentEvents.set(name, new Set());
      documentEvents.get(name).add(fn);
    },
    removeEventListener(name, fn) { documentEvents.get(name)?.delete(fn); },
  },
  window: { devicePixelRatio: 2, innerWidth: 395, innerHeight: 700 },
  api: { apiURL: value => value },
  app: { canvas: { ds: { scale: 1 }, canvas: new Element("canvas") }, nodeOutputs: {}, registerExtension(value) { extension = value; } },
  enablePreviewResize() {},
  getComputedStyle: () => ({ width: `${dimensions.width}px`, height: `${dimensions.height}px` }),
  requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
  cancelAnimationFrame(id) { frames.delete(id); },
  setTimeout(fn, delay) { const id = ++serial; timers.set(id, fn); timerDelays.set(id, delay); return id; },
  clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
  ResizeObserver: class { constructor(fn) { this.callback = fn; resizeObserver = this; } observe() {} disconnect() { this.disconnected = true; } },
  IntersectionObserver: class { constructor(fn) { this.callback = fn; visibilityObserver = this; } observe() {} disconnect() { this.disconnected = true; } },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(pack, "smooth_preview.js"), "utf8").replace(/^export /gm, ""), context);
vm.runInContext(fs.readFileSync(path.join(pack, "long_preview_tiles.js"), "utf8").replace(/^export /gm, ""), context);
vm.runInContext(fs.readFileSync(path.join(pack, "thumbnail_grid.js"), "utf8").replace(/^export /gm, ""), context);
vm.runInContext("const realLayout = layoutThumbnailRows; layoutThumbnailRows = (...args) => { countLayout(); return realLayout(...args); };", Object.assign(context, { countLayout() { layouts++; } }));
vm.runInContext(fs.readFileSync(path.join(pack, "preview_long_image.js"), "utf8").replace(/^import .*;$/gm, ""), context);
async function flush() {
  for (let count = 0; count < 100; count++) {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(fn => fn());
    await new Promise(resolve => setImmediate(resolve));
    if (!frames.size) return;
  }
  assert.fail("Layout/paint must settle");
}
async function finishTimers() { const pending = [...timers.values()]; timers.clear(); timerDelays.clear(); pending.forEach(fn => fn()); await flush(); }
function canvasWheel(target = context.app.canvas.canvas) { for (const fn of documentEvents.get("wheel") || []) fn({ target }); }
class Node {
  constructor() { this.id = 42; }
  onDrawBackground() { nativeDraws++; }
  addDOMWidget(name, type, element, options) { this.widget = { element, options }; return this.widget; }
}
async function main() {
extension.beforeRegisterNodeDef(Node, { name: "LiuxinyuPreviewLongImage" }, context.app);
const node = new Node(); node.onNodeCreated();
const images = [0, 1, 2].map(index => ({ filename: `original${index}.png`, subfolder: "", type: "temp", preview_size: [790, 36153],
  display: { thumbnails: [{ filename: `small${index}.png`, width: 108, height: 192 }, { filename: `thumb${index}.png`, width: 432, height: 768 }],
    levels: [{ width: 790, height: 36153, tile_size: 1024, prefix: `tile${index}_` },
             { width: 13, height: 565, tile_size: 1024, filename: `overview${index}.png` }] } }));
const output = { images, scroll_direction: ["从左向右"], tall_scroll_direction: ["从上到下"] };
node.onExecuted(output); await flush();
assert.equal(layouts, 1, "Layout uses metadata without waiting for full image decoding");
assert.equal(requests.length, 6, "Low previews stay preloaded alongside selected sharp thumbnails");
const gridView = node.widget.element.children[0], grid = gridView.children[0];
const pairs = grid.children.map(cell => cell.querySelectorAll("img"));
for (const [low, sharp] of pairs) {
  assert.ok(low.src.includes("small"));
  sharp.onload();
  assert.equal(low.style.display, "none");
  assert.equal(sharp.style.display, "block");
}
canvasWheel(new Element("input"));
assert.equal(timers.size, 0, "Unrelated controls must not trigger preview changes");
canvasWheel();
for (const [low, sharp] of pairs) {
  assert.equal(low.style.display, "block");
  assert.equal(sharp.style.display, "none", "Capture switches quality synchronously, before canvas zoom or RAF");
  sharp.onload();
  assert.equal(sharp.style.display, "none", "A pending load must not restore sharpness midgesture");
}
for (let i = 0; i < 100; i++) {
  canvasWheel();
  context.app.canvas.ds.scale = 0.1 + i / 100;
  node.onDrawBackground(); await flush();
  assert.equal(timers.size, 1, "Every wheel event postpones the same settle operation");
}
assert.equal([...timerDelays.values()][0], 250);
assert.equal(requests.length, 6, "No sharp image requests during continuous zoom");
await finishTimers();
for (const [low, sharp] of pairs) {
  assert.equal(low.style.display, "none");
  assert.equal(sharp.style.display, "block", "Sharp images return after settling");
}
context.app.canvas.processMouseWheel = () => {
  for (const [, sharp] of pairs) assert.equal(sharp.style.display, "none", "Grid switches before forwarding wheel to canvas");
};
gridView.events.wheel({ preventDefault() {}, stopPropagation() {} });
await finishTimers();
assert.equal(nativeDraws, 0, "Default full-image preview loader is disabled on this node");
assert.equal(layouts, 1, "Canvas zoom must not recompute thumbnail packing");
visibilityObserver.callback([{ isIntersecting: false }]);
resizeObserver.callback([{ contentRect: { width: 0, height: 0 } }]);
visibilityObserver.callback([{ isIntersecting: true }]); await flush();
assert.equal(layouts, 1, "Leaving and reentering the viewport reuses the existing layout");
grid.children[0].events.click({ preventDefault() {} }); await flush();
assert.equal(node._llpViewMode, "single");
assert.ok(requests.some(url => url.includes("tile0_")));
assert.ok(requests.every(url => !url.includes("original") && !url.includes("rand=")));
const requestCount = requests.length;
const singleView = node.widget.element.children[1], scroll = singleView.children[0];
const surface = scroll.children[0].children[0], overview = surface.children[0];
overview.onload(); await flush();
scroll.scrollTop = 1; scroll.events.scroll(); await flush();
assert.equal(requests.length, requestCount, "Small scroll retains decoded tiles");
assert.ok(surface.children.length > 1);
canvasWheel();
assert.equal(surface.children.length, 1, "Sharp tiles detach immediately during zoom");
assert.equal(overview.style.display, "block");
assert.equal(overview.style.visibility, "visible");
context.app.canvas.ds.scale = 1.2;
node.onDrawBackground(); scroll.events.scroll(); await flush();
assert.equal(surface.children.length, 1);
assert.equal(requests.length, requestCount, "Scroll and draw callbacks cannot request tiles during zoom");
await finishTimers();
assert.ok(surface.children.length > 1);
assert.equal(overview.style.display, "none");
assert.equal(requests.length, requestCount, "Settled single view restores cached tiles");
context.app.canvas.ds.scale = 1.3;
node.onDrawBackground();
assert.equal(surface.children.length, 1, "Non-wheel canvas zoom also switches to the overview");
for (const fn of documentEvents.get("keydown")) fn({ key: "ArrowRight" });
await flush();
assert.equal(surface.children.length, 1, "Switching images midgesture keeps the low-quality mode");
assert.ok(!requests.some(url => url.includes("tile1_")));
await finishTimers();
assert.ok(requests.some(url => url.includes("tile1_")));
dimensions.width = 900; dimensions.height = 50000;
node.widget.options.afterResize(); await flush();
assert.equal(singleView.children[1].style.opacity, "0");
assert.equal(singleView.children[2].style.opacity, "0", "Resize removes overflow masks without waiting for scroll");
canvasWheel();
node.onRemoved();
assert.equal(frames.size, 0);
assert.equal(timers.size, 0);
assert.ok(resizeObserver.disconnected && visibilityObserver.disconnected);
assert.equal(documentEvents.get("wheel").size, 0);
assert.equal(documentEvents.get("keydown").size, 0);

// Restored execution outputs can expose a different wrapper for the same file
// on each access. Async validity must belong to the grid entry, not that wrapper.
dimensions.width = 395; dimensions.height = 700;
context.app.canvas.ds.scale = 1;
const restoredImages = new Proxy(images, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    return /^\d+$/.test(String(property)) ? new Proxy(value, {}) : value;
  },
});
assert.notEqual(restoredImages[0], restoredImages[0]);
const restored = new Node(); restored.onNodeCreated();
restored.onExecuted({ ...output, images: restoredImages }); await flush();
const restoredGrid = restored.widget.element.children[0].children[0];
for (const cell of restoredGrid.children) {
  const [low, sharp] = cell.querySelectorAll("img");
  assert.equal(sharp.style.display, "block", "Restored output wrappers must not suppress a completed sharp load");
  assert.equal(low.style.display, "none");
}
let otherPreviewRan = false;
const queueSharpPreview = vm.runInContext("queueSharpPreview", context);
const otherElement = new Element("div");
queueSharpPreview({}, otherElement, otherElement, context.app.canvas.canvas, () => { otherPreviewRan = true; });
await flush();
assert.ok(otherPreviewRan, "Restoring a long preview must release the shared queue for the other galleries");
canvasWheel(); await finishTimers();
for (const cell of restoredGrid.children) assert.equal(cell.querySelectorAll("img")[1].style.display, "block");
restored.onRemoved(); await flush();
assert.equal(documentEvents.get("wheel").size, 0);
assert.equal(documentEvents.get("keydown").size, 0);
console.log("Zoom, cached restoration, image switching, viewport reentry, resize masks, workflow restoration, shared queue release and teardown passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
