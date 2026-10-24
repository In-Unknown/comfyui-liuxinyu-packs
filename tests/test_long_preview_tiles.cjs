const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let requests = [];
const surface = { children: new Set(), appendChild(image) { image.parentElement = this; this.children.add(image); } };
const context = {
  URLSearchParams,
  document: { createElement() {
    return { style: {}, parentElement: null, children: new Set(),
      appendChild(image) { image.parentElement = this; this.children.add(image); },
      set src(value) { requests.push(value); this.url = value; },
      removeAttribute() { this.url = null; },
      remove() { this.parentElement?.children.delete(this); this.parentElement = null; },
    };
  } },
};
vm.createContext(context);
const code = fs.readFileSync(path.join(__dirname, "..", "long_preview_tiles.js"), "utf8").replace(/^export /gm, "");
vm.runInContext(`${code}\nglobalThis.exports = { choosePreviewLevel, visiblePreviewTiles, PreviewTiles, previewURL };`, context);
const { choosePreviewLevel, visiblePreviewTiles, PreviewTiles, previewURL } = context.exports;
const levels = [];
for (let width = 790, height = 36153; ; width = Math.ceil(width / 2), height = Math.ceil(height / 2)) {
  const level = { width, height, tile_size: 1024, prefix: `level${levels.length}_` };
  levels.push(level);
  if (Math.max(width, height) <= 1024) { level.filename = "overview.png"; break; }
}
assert.equal(choosePreviewLevel(levels, 790, 36153, 0.5, 1, 1), levels[1]);
assert.equal(choosePreviewLevel(levels, 790, 36153, 0.5, 1, 2), levels[0]);
assert.equal(choosePreviewLevel(levels, 790, 36153, 0.5, 0.01, 1), levels.at(-1));

const geometry = { width: 395, height: 36153 / 2, viewportWidth: 395, viewportHeight: 700, scale: 0.5 };
for (const top of [0, 250.25, 9000, geometry.height - 700]) {
  const selected = visiblePreviewTiles(levels[0], geometry, 0, top);
  assert.ok(selected.length <= 5, `Decoded ${selected.length} tiles for one viewport`);
  const covering = selected.filter(tile => tile.top < top + 700 && tile.top + tile.height > top);
  assert.ok(covering[0].top <= top);
  assert.ok(covering.at(-1).top + covering.at(-1).height >= top + 700);
  for (let i = 1; i < selected.length; i++) {
    assert.ok(Math.abs(selected[i - 1].top + selected[i - 1].height - selected[i].top) < 1e-8);
  }
}
const wideLevel = { width: 36153, height: 790, tile_size: 1024, prefix: "wide_" };
const clipped = visiblePreviewTiles(levels[0], { ...geometry, viewportHeight: 10000,
  clip: { left: 0, top: 3000, right: 395, bottom: 3700 } }, 0, 0);
assert.ok(clipped.length <= 5, "A mostly offscreen node must only load its visible canvas slice");
const wideGeometry = { width: 36153 / 2, height: 395, viewportWidth: 700, viewportHeight: 500, scale: 0.5 };
const right = visiblePreviewTiles(wideLevel, wideGeometry, wideGeometry.width - 700, 0);
assert.equal(right.at(-1).left + right.at(-1).width, wideGeometry.width);
assert.equal(right.at(-1).height, wideGeometry.height);

const api = { apiURL(value) { return value; } };
const meta = { filename: "original.png", type: "temp", subfolder: "", preview_size: [790, 36153], display: { levels } };
const overview = { style: {} };
const renderer = new PreviewTiles(surface, api, overview);
renderer.render(meta, geometry, 0, 0, 1, 2);
const initialRequests = requests.length;
renderer.render(meta, geometry, 0, 1, 1, 2);
assert.equal(requests.length, initialRequests, "Small scroll must reuse decoded tiles");
assert.ok(requests.every(url => !url.includes("original.png") && !url.includes("rand=")));
const firstCell = [...surface.children][0];
const firstImage = [...firstCell.children][0];
firstImage.onload();
assert.equal(firstImage.style.opacity, "1");
assert.equal(firstCell.style.backgroundImage, "none", "Transparent tiles must replace their blurred backing");
renderer.showOverview();
assert.equal(overview.style.display, "block");
assert.equal(surface.children.size, 0, "Zoom must detach sharp tiles from the paint tree");
assert.equal(renderer.cache.size, initialRequests, "Zoom retains decoded tiles for restoration");
renderer.render(meta, geometry, 0, 1, 1, 2);
assert.equal(overview.style.display, "none");
assert.equal(requests.length, initialRequests, "Restoring sharp tiles must reuse their cached images");
assert.equal(surface.children.size, initialRequests);
for (let top = 0; top < geometry.height - 700; top += 800) renderer.render(meta, geometry, 0, top, 1, 2);
assert.ok(renderer.cache.size <= 16);
assert.ok(surface.children.size <= 5);
renderer.clear();
assert.equal(renderer.cache.size, 0);
assert.equal(surface.children.size, 0);
assert.equal(previewURL(api, meta), previewURL(api, meta), "Reopening uses a stable cacheable URL");
console.log(`Tile coverage, all edges, zoom levels, reuse and eviction passed; ${initialRequests} tiles initially requested for 790×36153.`);
