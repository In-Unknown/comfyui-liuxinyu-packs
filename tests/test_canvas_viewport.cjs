const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const element = box => ({ getBoundingClientRect: () => box });
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  let surface = rect(50, 40, 1000, 800), central = surface, panels = [], now = 0;
  const frames = new Map(); let next = 0, dirty = 0, extension;
  const context = vm.createContext({
    window: { devicePixelRatio: 1.25, innerWidth: 1600, innerHeight: 1100 },
    document: { querySelector: () => central && element(central), querySelectorAll: () => panels },
    getComputedStyle: el => el.style || {},
    performance: { now: () => now }, ui: { EASE_IN_OUT_QUAD: 'easeInOutQuad' },
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; }, cancelAnimationFrame(id) { frames.delete(id); },
  });
  // Use the installed frontend's actual methods, including its real animation.
  const assets = path.resolve(root, '../../../python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');
  const bundle = fs.readdirSync(assets).filter(n => /^settingStore-.*\.js$/.test(n))
    .map(n => fs.readFileSync(path.join(assets, n), 'utf8')).find(s => s.includes('animateToBounds(e,t,{'));
  assert(bundle, 'Installed frontend animation is available');
  const method = (start, end) => {
    const index = bundle.indexOf(start), stop = bundle.indexOf(end, index);
    assert(index >= 0 && stop > index);
    return bundle.slice(index, stop);
  };
  vm.runInContext('this.NativeDS=class {' + method('fitToBounds(e,', 'reset(){this.scale=1') + '};' +
    'this.NativeCanvas=class {' + method('centerOnNode(e){', 'adjustMouseEvent(e){') + '};', context);
  const canvas = new context.NativeCanvas();
  canvas.canvas = { width: 2000, height: 1250, getBoundingClientRect: () => surface };
  canvas.ds = Object.assign(new context.NativeDS(), { element: canvas.canvas, scale: 0.8, max_scale: 10, offset: [11, 22] });
  canvas.setDirty = () => dirty++;
  context.app = { canvas, registerExtension(value) { extension = value; } };
  vm.runInContext(source('canvas_viewport.js') + '\n' + source('canvas_focus.js'), context);
  extension.setup();
  return { canvas, context, extension, get dirty() { return dirty; },
    set surface(value) { surface = value; }, set central(value) { central = value; }, set panels(value) { panels = value; },
    finish() { now += 1000; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now)); },
    screen(x, y) { const d = canvas.ds, ratio = context.window.devicePixelRatio;
      return [surface.left + (x + d.offset[0]) * d.scale * surface.width / (canvas.canvas.width / ratio),
        surface.top + (y + d.offset[1]) * d.scale * surface.height / (canvas.canvas.height / ratio)]; },
  };
}
function near(actual, expected) { actual.forEach((v, i) => assert(Math.abs(v - expected[i]) < 1e-7, `${actual} != ${expected}`)); }

test('splitter and overlapping panels share one visible rectangle, independent of panel order', () => {
  const h = harness(); h.central = rect(100, 80, 850, 700);
  const panels = [element(rect(750, 40, 300, 800)), element(rect(50, 40, 200, 800)), element(rect(50, 640, 1000, 200))];
  for (const list of [panels, [...panels].reverse()]) {
    h.panels = list;
    assert.deepEqual(plain(h.context.visibleCanvasRect(h.canvas)), rect(250, 80, 500, 560));
    h.canvas.centerOnNode({ pos: [100, 200], size: [200, 100] });
    near(h.screen(200, 250), [500, 360]);
    assert.equal(h.canvas.ds.scale, 0.8);
  }
});
test('hidden and outside panels are ignored; already resized canvas is not reduced twice', () => {
  const h = harness(); h.surface = h.central = rect(50, 40, 600, 800);
  h.panels = [element(rect(650, 40, 400, 800)), { ...element(rect(50, 40, 600, 800)), hidden: true },
    { ...element(rect(50, 40, 600, 800)), style: { visibility: 'hidden' } }, element(rect(50, 40, 0, 800))];
  h.canvas.ds.fitToBounds([0, 0, 800, 400]); near(h.screen(400, 200), [350, 440]);
  assert.equal(h.canvas.ds.scale, 1.5);
});
test('native animated focus preserves animation options and intersects existing viewport without double subtraction', () => {
  const h = harness(); h.panels = [element(rect(650, 40, 400, 800))];
  const options = { duration: 120, easing: 'linear', zoom: 0, viewport: [0, 0, 960, 1000] };
  h.canvas.ds.animateToBounds([100, 200, 200, 100], () => {}, options);
  assert.deepEqual(h.canvas.ds.offset, [11, 22], 'still animated, not an immediate jump');
  h.finish(); near(h.screen(200, 250), [350, 440]); assert.equal(h.canvas.ds.scale, 0.8);
  assert.deepEqual(options.viewport, [0, 0, 960, 1000], 'caller options are unchanged');
  h.canvas.ds.animateToBounds([100, 200, 800, 400], () => {}, { zoom: 0.5 });
  h.finish(); near(h.screen(500, 400), [350, 440]); assert(Math.abs(h.canvas.ds.scale - 0.6) < 1e-8);
});
test('fit preserves native padding/minimum bounds and zoom=0 preserves scale', () => {
  const h = harness(); h.panels = [element(rect(650, 40, 400, 800))];
  h.canvas.ds.fitToBounds([100, 200, 800, 400]);
  assert.equal(h.canvas.ds.scale, 0.9); near(h.screen(500, 400), [350, 440]);
  h.canvas.ds.fitToBounds([0, 0, 10, 10], { zoom: 0 });
  assert.equal(h.canvas.ds.scale, 0.9); near(h.screen(5, 5), [350, 440]);
});
test('fully covered canvas does not jump into a hidden area', () => {
  const h = harness(); h.panels = [element(rect(0, 0, 1600, 1100))];
  h.canvas.centerOnNode({ pos: [0, 0], size: [20, 20] }); h.canvas.ds.fitToBounds([0, 0, 100, 100]);
  h.canvas.ds.animateToBounds([0, 0, 100, 100], () => {}); h.finish();
  assert.deepEqual(h.canvas.ds.offset, [11, 22]); assert.equal(h.canvas.ds.scale, 0.8);
});
test('adapter is instance-scoped, idempotent and follows subsequent layout changes', () => {
  const h = harness(), animate = h.canvas.ds.animateToBounds;
  h.extension.afterConfigureGraph(); assert.equal(h.canvas.ds.animateToBounds, animate);
  const other = new h.context.NativeDS(); assert.notEqual(other.animateToBounds, animate);
  h.central = rect(300, 100, 400, 500); h.context.centerCanvasOn(h.canvas, 0, 0); near(h.screen(0, 0), [500, 350]);
  h.central = rect(50, 40, 1000, 800); h.context.centerCanvasOn(h.canvas, 0, 0); near(h.screen(0, 0), [550, 440]);
});
