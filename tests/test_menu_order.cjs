const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const clean = value => JSON.parse(JSON.stringify(value));

function harness(order) {
  const extensions = [];
  const app = { registerExtension(value) { extensions.push(value); } };
  const scope = vm.createContext({ app });
  vm.runInContext(order ? `const MENU_ORDER = ${JSON.stringify(order)};` : source('menu_order.js'), scope);
  vm.runInContext(source('menu_source.js'), scope);
  return { app, scope, extensions, menu: extensions[0],
    order: clean(vm.runInContext('MENU_ORDER', scope)), register: scope.registerMenuItem };
}

function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (const [i, value] of values.entries()) {
    for (const tail of permutations(values.filter((_, j) => j !== i))) yield [value, ...tail];
  }
}

const expected = harness().order;
let runs = 0;
for (const order of permutations(expected)) {
  const h = harness();
  for (const id of order) h.register(id, { canvas: () => ({ content: id }), node: () => ({ content: id }) });
  for (const hook of ['getCanvasMenuItems', 'getNodeMenuItems']) {
    assert.deepEqual(clean(h.menu[hook]().map(item => item.content)), expected);
    assert(h.menu[hook]().every(item => item.className === 'liuxinyu-menu-source'));
  }
  assert.equal(h.extensions.length, 1, 'One extension supplies the complete package menu');
  runs++;
}

const h = harness();
let shown = false, busy = false, called = 0;
const callback = () => ++called;
h.register('workflow-differences', { canvas: () => ({ content: '查看未保存差异' }) });
h.register('graph-layout', { canvas: (...args) => shown ? { content: busy ? '整理节点（计算中）' : '整理节点',
  disabled: busy, callback, className: 'existing', args } : null });
h.register('viewport-origin', { node: node => ({ content: node.title }) });
assert.deepEqual(clean(h.menu.getCanvasMenuItems().map(item => item.content)), ['查看未保存差异']);
shown = busy = true;
const args = { title: 'chosen node' };
let items = h.menu.getCanvasMenuItems(args);
assert.deepEqual(clean(items.map(item => item.content)), ['整理节点（计算中）', '查看未保存差异']);
assert.equal(items[0].disabled, true);
assert.equal(items[0].args[0], args);
assert.equal(items[0].callback, callback);
assert.equal(items[0].className, 'existing liuxinyu-menu-source');
items[0].callback(); assert.equal(called, 1);
busy = false;
assert.equal(h.menu.getCanvasMenuItems()[0].content, '整理节点');
assert.deepEqual(clean(h.menu.getNodeMenuItems(args).map(item => item.content)), ['chosen node']);
h.register('canvas-background', { canvas: () => ({ content: 'late registration' }) });
assert.equal(h.menu.getCanvasMenuItems()[0].content, 'late registration');
assert.throws(() => h.register('graph-layout', {}), /重复/);
for (const id of ['z-new', 'a-new']) h.register(id, { canvas: () => ({ content: id }) });
assert.deepEqual(clean(h.menu.getCanvasMenuItems().slice(-2).map(item => item.content)), ['a-new', 'z-new']);

const reordered = harness([...expected].reverse());
for (const id of expected) reordered.register(id, { canvas: () => ({ content: id }) });
assert.deepEqual(clean(reordered.menu.getCanvasMenuItems().map(item => item.content)), [...expected].reverse());

// Exercise a real producer through the shared entry point, including its callback.
const viewport = harness();
vm.runInContext(source('viewport_origin.js'), viewport.scope);
assert.equal(viewport.menu.getCanvasMenuItems().length, 0);
let redraw = 0;
viewport.scope.window = { devicePixelRatio: 1 };
viewport.app.canvas = { canvas: { width: 1000, height: 600 },
  ds: { offset: [300, -200], scale: 0.5 }, setDirty() { redraw++; } };
for (const hook of ['getCanvasMenuItems', 'getNodeMenuItems']) {
  const entry = viewport.menu[hook]()[0];
  assert.equal(entry.content, '视窗回归原点');
  for (const ratio of [1, 1.25, 2]) for (const scale of [0.25, 0.5, 1, 2]) {
    for (const [width, height] of [[1000, 600], [600, 1000]]) {
      const canvas = viewport.app.canvas;
      viewport.scope.window.devicePixelRatio = ratio;
      Object.assign(canvas.canvas, { width: width * ratio, height: height * ratio });
      canvas.ds.scale = scale;
      canvas.ds.offset = [-1234, 987];
      entry.callback();
      // Project graph origin into CSS pixels, independently checking its target.
      assert.deepEqual(canvas.ds.offset.map(value => value * scale), [width / 2, height / 2]);
      assert.equal(canvas.ds.scale, scale);
      const previous = [...canvas.ds.offset];
      entry.callback();
      assert.deepEqual(canvas.ds.offset, previous, 'Repeated centering is stable');
    }
  }
}
assert.equal(redraw, 96);
console.log(`PASS: ${runs} registration orders; both menus, dynamic visibility/labels, callbacks, config order, late/unknown IDs and real viewport action`);
