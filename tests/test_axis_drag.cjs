const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Test against the installed native start/end/autopan methods, without a browser.
const assets = path.resolve(__dirname, '../../../../python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');
const bundle = fs.readFileSync(path.join(assets, 'settingStore-DDHzGrHr.js'), 'utf8');
function method(start, end) {
  const from = bundle.indexOf(start);
  assert.ok(from >= 0, `Native adapter requires ${start}`);
  const to = bundle.indexOf(end, from + start.length);
  assert.ok(to > from);
  return bundle.slice(from, to);
}
const nativeMethods = method('_startDraggingItems(e,t,n=!1){', '_processDraggedItems(e){') +
  method('_processDraggedItems(e){', 'startGhostPlacement(e,t){');
const nestedFunction = method('function getAllNestedItems(e){', 'function findFirstNode(e){');
const sandbox = {
  app: { registerExtension() {} },
  Z: { alwaysSnapToGrid: false },
  AutoPanController: class {
    constructor(options) { this.options = options; }
    updatePointer() {} start() {} stop() {}
  },
  findFirstNode: items => [...items][0],
};
vm.createContext(sandbox);
const pointerSource = method('var dl=class CanvasPointer{', ';function createCursorCache(e){')
  .replace('var dl=', 'globalThis.NativePointer=');
vm.runInContext(pointerSource, sandbox);
vm.runInContext(`${nestedFunction}; globalThis.Native = class Native {${nativeMethods}};`, sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../axis_drag.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export function', 'function'), sandbox);

class Item {
  constructor(x, y, children = []) { this.pos = [x, y]; this.children = new Set(children); this.pinned = false; }
  move(dx, dy, skipChildren) {
    if (this.pinned) return;
    this.pos = [this.pos[0] + dx, this.pos[1] + dy];
    if (!skipChildren) for (const child of this.children) child.move(dx, dy);
    return 41;
  }
}
function fixture(items, initialShift = false) {
  const listeners = new Map();
  const keys = { addEventListener(name, fn) { listeners.set(name, fn); } };
  const c = new sandbox.Native();
  const events = [];
  c.graph = {
    beforeChange() { events.push('before'); },
    afterChange() { events.push('after'); c.saved = items.map(item => [...item.pos]); },
    snapToGrid(selected) { events.push('snap'); for (const item of selected) item.pos = item.pos.map(n => Math.round(n / 10) * 10); },
  };
  c.canvas = {}; c.ds = {scale: 1}; c.mouse = [0, 0]; c.state = {}; c.selectedItems = new Set(items);
  c.processSelect = () => {};
  c.emitBeforeChange = () => events.push('emit-before');
  c.emitAfterChange = () => events.push('emit-after');
  c._dirty = c.setDirty = () => {};
  c.onNodeMoved = () => events.push('moved');
  c.onDrawForeground = () => 59;
  c.processMouseCancel = () => { c.pointer.reset(); return 71; };
  c.processMouseMove = function (e) {
    if (this.pendingStart) {
      this.pendingStart = false;
      this._startDraggingItems(items[0], this.pointer, true);
    }
    if (!this.isDragging) return 29;
    this._lastDragModifiers = e;
    for (const item of sandbox.getDraggedItems(this.selectedItems, e)) item.move(e.dx / this.ds.scale, e.dy / this.ds.scale, true);
    return 29;
  };
  const originalMove = c.processMouseMove;
  sandbox.installAxisDrag(c, keys);
  const wrappedMove = c.processMouseMove;
  sandbox.installAxisDrag(c, keys);
  assert.equal(c.processMouseMove, wrappedMove, 'Installation is idempotent');
  assert.notEqual(wrappedMove, originalMove);
  c.pointer = new sandbox.NativePointer({});
  c.pointer.eDown = {shiftKey: initialShift, canvasX: 30, canvasY: 40};
  c._startDraggingItems(items[0], c.pointer, true);
  assert.equal(c.isDragging, true, 'Native finally setter must not prematurely end the drag');
  assert.deepEqual(events, ['emit-before', 'before'], 'No afterChange before actual release');
  function move(dx, dy, shiftKey = false, ctrlKey = false) {
    assert.equal(c.processMouseMove({dx, dy, shiftKey, ctrlKey}), 29);
  }
  function key(pressed) { listeners.get(pressed ? 'keydown' : 'keyup')({key: 'Shift'}); }
  function end(shiftKey) { c._processDraggedItems({shiftKey}); c.pointer.reset(); }
  function draw() {
    const lines = [], circles = []; let saves = 0, restores = 0;
    const ctx = {save() { saves++; }, restore() { restores++; }, setLineDash() {}, beginPath() {},
      moveTo(x,y) { lines.push([x,y]); }, lineTo(x,y) { lines.push([x,y]); }, stroke() {},
      arc(x,y) { circles.push([x,y]); }};
    assert.equal(c.onDrawForeground(ctx), 59);
    assert.equal(saves, restores);
    return {lines, circles, width: ctx.lineWidth};
  }
  return {c, events, move, key, end, draw, listeners};
}

let cases = 0;
function test(name, fn) { fn(); cases++; console.log('PASS:', name); }

test('Mid-drag horizontal projection is immediate on Shift; origin retained until end', () => {
  const item = new Item(7, 13), f = fixture([item]);
  f.move(120, 35); f.key(true);
  assert.deepEqual(item.pos, [127, 13]);
  f.move(10, 300, true); assert.deepEqual(item.pos, [137, 13]);
  assert.deepEqual(f.draw().lines, [[30,40],[160,40]]);
  f.end(true); assert.deepEqual(item.pos, [137,13]);
  assert.deepEqual(f.events, ['emit-before','before','moved','after','emit-after']);
  assert.deepEqual(f.c.saved, [[137,13]]);
  assert.equal(Object.hasOwn(item, 'move'), false);
  assert.deepEqual(f.draw().lines, []);
});
test('Vertical including negative movement; no axis switch while held', () => {
  const item = new Item(7,13), f = fixture([item]);
  f.move(-10,-90); f.key(true); assert.deepEqual(item.pos,[7,-77]);
  f.move(900,200,true); assert.deepEqual(item.pos,[7,123]);
  f.end(true);
});
test('Shift before dragging: first nonzero displacement; ties horizontal', () => {
  for (const [dx,dy,expected] of [[0,0,[7,13]], [0.01,0.02,[7,13.02]], [-0.01,0.01,[6.99,13]]]) {
    const item = new Item(7,13), f = fixture([item], true);
    f.move(dx,dy,true); assert.deepEqual(item.pos,expected); f.end(true);
  }
});
test('Release immediately catches up to the mouse; re-press still uses original start', () => {
  const item = new Item(0,0), f = fixture([item],true);
  f.move(30,10,true); f.key(false);
  assert.deepEqual(item.pos,[30,10], 'Keyup alone restores filtered movement');
  f.move(1,70); assert.deepEqual(item.pos,[31,80]);
  f.key(true); assert.deepEqual(item.pos,[0,80]);
  f.move(99,10,true); assert.deepEqual(item.pos,[0,90]);
  f.key(false); assert.deepEqual(item.pos,[130,90]); f.end(false);
});
test('Nested groups, duplicate selection, pinned children retain spacing', () => {
  const a = new Item(10,20), b = new Item(30,45), pin = new Item(50,60); pin.pinned=true;
  const inner = new Item(5,6,[a]), outer = new Item(-10,-20,[inner,b,pin]);
  const items = [outer,a,b]; const f = fixture(items);
  f.move(90,20); f.key(true); f.move(5,100,true);
  assert.deepEqual(outer.pos,[85,-20]); assert.deepEqual(inner.pos,[100,6]);
  assert.deepEqual(a.pos,[105,20]); assert.deepEqual(b.pos,[125,45]); assert.deepEqual(pin.pos,[50,60]);
  f.end(true); for (const item of [outer,inner,a,b,pin]) assert.equal(Object.hasOwn(item,'move'),false);
});
test('Native Ctrl group-only movement is preserved', () => {
  const child=new Item(20,30), group=new Item(1,2,[child]), f=fixture([group],true);
  f.move(40,10,true,true); assert.deepEqual(group.pos,[41,2]); assert.deepEqual(child.pos,[20,30]); f.end(true);
});
test('Zoom and native edge autopan obey axis; line uses graph coordinates', () => {
  const item=new Item(0,0), f=fixture([item],true); f.c.ds.scale=2;
  f.move(40,10,true); f.c._autoPan.options.onPan(5,90);
  assert.deepEqual(item.pos,[25,0]); assert.deepEqual(f.draw().lines,[[30,40],[55,40]]);
  assert.equal(f.draw().width,0.75); f.end(true);
});
test('Always-snap does not corrupt constrained geometry; normal snapping restored', () => {
  sandbox.Z.alwaysSnapToGrid=true;
  const item=new Item(7,13), f=fixture([item],true), snap=f.c.graph.snapToGrid;
  f.move(12,2,true); f.end(true); assert.deepEqual(item.pos,[19,13]); assert.equal(f.c.graph.snapToGrid,snap);
  const other=new Item(7,13), g=fixture([other]); g.move(12,2); g.end(false);
  assert.deepEqual(other.pos,[20,20]); sandbox.Z.alwaysSnapToGrid=false;
});
test('Cancel, graph switch, blur and idle keyboard leave no stale lock', () => {
  const item=new Item(0,0), f=fixture([item],true); f.move(20,2,true);
  f.listeners.get('blur')(); f.move(0,10); assert.deepEqual(item.pos,[20,12]);
  assert.equal(f.c.processMouseCancel(),71); assert.equal(Object.hasOwn(item,'move'),false);
  const before=[...item.pos]; f.key(true); assert.deepEqual(item.pos,before);
  const other=new Item(0,0), g=fixture([other],true); g.move(20,2,true);
  g.c.graph={}; g.draw(); assert.equal(Object.hasOwn(other,'move'),false);
});
test('No actual drag means no interception or extra undo state', () => {
  const item=new Item(0,0), f=fixture([item]); f.end(false);
  assert.deepEqual(item.pos,[0,0]);
  const events=[...f.events]; f.key(true); f.key(false); assert.deepEqual(f.events,events);
  assert.deepEqual(f.draw().lines,[]);
});
test('Existing own move descriptor and return values are preserved', () => {
  const item=new Item(0,0);
  const original=function(dx,dy){ this.pos=[this.pos[0]+dx,this.pos[1]+dy]; return 83; };
  Object.defineProperty(item,'move',{value:original,writable:true,configurable:true,enumerable:false});
  const descriptor=Object.getOwnPropertyDescriptor(item,'move'), f=fixture([item],true);
  assert.equal(item.move(10,2,true),83); f.end(true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(item,'move'),descriptor);
});
test('Shift pressed between pointer-down and native drag threshold uses current event', () => {
  const item=new Item(0,0), f=fixture([item]); f.end(false);
  f.c.pointer=new sandbox.NativePointer({});
  f.c.pointer.eDown={shiftKey:false,canvasX:30,canvasY:40};
  f.c.pendingStart=true;
  f.move(5,20,true);
  assert.deepEqual(item.pos,[0,20]); f.end(true);
});
test('No Shift: native move arguments, positions and undo lifecycle remain unchanged', () => {
  const a=new Item(7,13), b=new Item(40,60), f=fixture([a,b]);
  f.move(12,18); f.move(-4,6);
  assert.deepEqual(a.pos,[15,37]); assert.deepEqual(b.pos,[48,84]);
  assert.equal(f.c.isDragging,true);
  assert.deepEqual(f.events,['emit-before','before']);
  assert.deepEqual(f.draw().lines,[]);
  f.end(false);
  assert.equal(f.c.isDragging,false);
  assert.deepEqual(f.events,['emit-before','before','moved','after','emit-after']);
});
test('Release restores all nested members and accumulated autopan exactly once', () => {
  const child=new Item(20,30), group=new Item(1,2,[child]), f=fixture([group,child]);
  f.move(40,10); f.key(true); f.move(5,80,true);
  f.c._autoPan.options.onPan(3,7);
  assert.deepEqual(group.pos,[49,2]); assert.deepEqual(child.pos,[68,30]);
  f.key(false);
  assert.deepEqual(group.pos,[49,99]); assert.deepEqual(child.pos,[68,127]);
  f.move(2,3); assert.deepEqual(group.pos,[51,102]); assert.deepEqual(child.pos,[70,130]);
  f.end(false);
});
console.log(`${cases} axis-drag behavior groups passed using installed native drag lifecycle/autopan.`);
