const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Independent area-coverage raster model for axis-aligned Canvas rectangles.
// It reproduces fractional-edge alpha loss without opening a browser or using
// the implementation's coordinate-rounding helper to calculate expected pixels.
class RasterCanvas {
  constructor(width = 1, height = 1) { this.width = width; this.height = height; }
  getContext() { return this.ctx ||= new RasterContext(this); }
}
class RasterContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.data = new Float64Array(canvas.width * canvas.height * 4);
    this.matrix = { a: 1, d: 1, e: 0, f: 0 };
    this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this.stack = [];
  }
  getTransform() { return { ...this.matrix }; }
  setTransform(a, _b, _c, d, e, f) { this.matrix = { a, d, e, f }; }
  save() { this.stack.push([this.getTransform(), this.globalAlpha, this.globalCompositeOperation, this.fillStyle]); }
  restore() { [this.matrix, this.globalAlpha, this.globalCompositeOperation, this.fillStyle] = this.stack.pop(); }
  paint(x, y, width, height, sample) {
    const m = this.matrix, left = x * m.a + m.e, top = y * m.d + m.f;
    const right = left + width * m.a, bottom = top + height * m.d;
    for (let py = Math.max(0, Math.floor(top)); py < Math.min(this.canvas.height, Math.ceil(bottom)); py++) {
      for (let px = Math.max(0, Math.floor(left)); px < Math.min(this.canvas.width, Math.ceil(right)); px++) {
        const coverage = Math.max(0, Math.min(px + 1, right) - Math.max(px, left)) *
          Math.max(0, Math.min(py + 1, bottom) - Math.max(py, top));
        const pixel = sample((px + .5 - left) / (right - left), (py + .5 - top) / (bottom - top));
        const weight = coverage * this.globalAlpha, index = (py * this.canvas.width + px) * 4;
        const sourceAlpha = pixel[3] * weight, destAlpha = this.data[index + 3];
        for (let channel = 0; channel < 4; channel++) {
          const source = pixel[channel] * weight, dest = this.data[index + channel];
          this.data[index + channel] = this.globalCompositeOperation === 'destination-over' ?
            dest + source * (1 - destAlpha) : source + dest * (1 - sourceAlpha);
        }
      }
    }
  }
  drawImage(source, x, y, width, height) {
    this.paint(x, y, width, height, (u, v) => {
      if (source.pixel) return source.pixel;
      const sx = Math.min(source.width - 1, Math.max(0, Math.floor(u * source.width)));
      const sy = Math.min(source.height - 1, Math.max(0, Math.floor(v * source.height)));
      return source.getContext().data.subarray((sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4);
    });
  }
  fillRect(x, y, width, height) {
    const alpha = Number(this.fillStyle.match(/,([\d.]+)\)$/)[1]);
    this.paint(x, y, width, height, () => [alpha, alpha, alpha, alpha]);
  }
}

const root = path.resolve(__dirname, '..');
const context = vm.createContext({
  document: { createElement: () => new RasterCanvas() },
  app: { registerExtension() {} }, api: {}, createBackgroundStore: () => ({}), registerMenuItem() {},
});
for (const name of ['canvas_background_layout.js', 'canvas_background.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
}

// Prove the test can see the original seam, including with translucent images.
for (const alpha of [1, .4]) {
  const ctx = new RasterCanvas(3, 2).getContext();
  const source = { pixel: [alpha, alpha, alpha, alpha] };
  ctx.drawImage(source, 0, 0, 1.5, 2); ctx.drawImage(source, 1.5, 0, 1.5, 2);
  assert(ctx.data[7] < alpha, 'Fractional independently composited edges expose the background');
}

const tiles = [[0, 0, 4, 2], [4, 0, 2, 4], [2, 4, 4, 2], [0, 2, 2, 4], [2, 2, 2, 2]]
  .map(([x, y, width, height]) => ({ x: x / 6, y: y / 6, width: width / 6, height: height / 6, image: 0 }));
const edges = { left: [[0, 1, 0]], right: [[0, 1, 0]], top: [[0, 1, 0]], bottom: [[0, 1, 0]] };
const leaf = { id: 0, tiles, edges };
const nested = { id: 1, edges, variants: [[
  { x: 0, y: 0, size: .5, family: leaf }, { x: .5, y: 0, size: .5, family: leaf },
  { x: 0, y: .5, size: .5, family: leaf }, { x: .5, y: .5, size: .5, family: leaf },
]] };
let checked = 0;
for (const family of [leaf, nested]) for (const dpr of [1, 1.25, 2]) for (const zoom of [.63, 1, 1.37]) {
  for (const unit of [37.3, 511.7]) for (const imageAlpha of [1, .4]) for (const opacity of [1, .35]) {
    for (const operation of ['source-over', 'destination-over']) {
      const background = { width: unit, height: unit * .83, layout: { width: 1 }, images: [{ pixel: [imageAlpha, imageAlpha, imageAlpha, imageAlpha] }],
        hierarchy: { families: [family], seed: 7, regions: new Map(), contacts: new Map() },
        color: `rgba(255,255,255,${imageAlpha})`, thumbnails: new Map(), thumbnailPixels: 0 };
      const ctx = new RasterCanvas(101, 77).getContext(), scale = dpr * zoom;
      ctx.setTransform(scale, 0, 0, scale, -37.5, 15.375);
      ctx.globalAlpha = opacity; ctx.globalCompositeOperation = operation;
      const before = ctx.getTransform(), area = [(0 - before.e) / scale, (0 - before.f) / scale, 101 / scale, 77 / scale];
      context.drawPictures(ctx, background, area, scale);
      for (let index = 0; index < ctx.data.length; index += 4) {
        assert(Math.abs(ctx.data[index + 3] - imageAlpha * opacity) < 1e-9,
          `No uncovered/overlapping pixel: family=${family.id}, DPR=${dpr}, zoom=${zoom}, unit=${unit}, alpha=${imageAlpha}, opacity=${opacity}, pixel=${index / 4}`);
      }
      assert.deepEqual(ctx.getTransform(), before); assert.equal(ctx.globalAlpha, opacity);
      assert.equal(ctx.globalCompositeOperation, operation); assert.equal(ctx.stack.length, 0);
      if (unit === 37.3) assert(background.thumbnails.size > 0, 'Exercise cached rasterization as well as direct leaves');
      checked++;
    }
  }
}
console.log(`PASS: ${checked} direct/cached/nested raster cases, DPR/zoom/panning, opaque/translucent coverage without seams or overlap, context restoration`);
