const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let extension;
const frames = new Map(), listeners = {}, jumps = [];
let frameId = 0;
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.handlers = {}; this.hidden = false; this.scrollHeight = 100; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { for (const child of children) { child.parent = this; child.isConnected = true; this.children.push(child); } }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  focus() { document.activeElement = this; }
  get firstElementChild() { return this.children[0]; }
  getBoundingClientRect() {
    const scale = Number(this.style.transform?.match(/scale\(([^)]+)/)?.[1] || 1);
    const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
    return { left, top, width: 24 * scale, height: 24 * scale, right: left + 24 * scale, bottom: top + 24 * scale };
  }
}
const document = { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), body: new Element('body'), head: new Element('head') };
const surface = new Element('canvas');
surface.width = 2000; surface.height = 1200;
surface.getBoundingClientRect = () => ({left: 20, top: 40, width: 1000, height: 600});
const app = { canvas: { canvas: surface, visible_nodes: [] }, registerExtension(e) { extension = e; }, extensionManager: { toast: { add(error) { throw Error(error.detail); } } } };
const context = vm.createContext({ app, document, console, URL, LiteGraph: {NODE_TITLE_HEIGHT: 30},
  window: { innerWidth: 1400, innerHeight: 900, addEventListener(type, fn) { listeners[type] = fn; } },
  requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
  revealNode: async match => { jumps.push(match); },
  isCurrentGraphLocation: match => match.graph === app.canvas.graph && match.hosts.length === 0,
});
// Use the real traversal so exact key and shared-subgraph tests cover integration.
const finder = fs.readFileSync(path.join(__dirname, '../node_find.js'), 'utf8');
vm.runInContext('const definitions = new WeakMap();\n' + finder.slice(finder.indexOf('export function findNodes'), finder.indexOf('const frame =')).replace('export ', ''), context);
const source = fs.readFileSync(path.join(__dirname, '../virtual_navigation.js'), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', '"http://localhost/extensions/liuxinyu/virtual_navigation.js"');
vm.runInContext(source + '\nglobalThis.ui = () => ({popup,controls});', context);
const SEND = 'LiuxinyuVirtualOutput', RECEIVE = 'LiuxinyuVirtualInput';
function node(id, type, key) { return { id, type, widgets: [{name:'key', value:key}], size:[220,80], flags:{} }; }
function graph(nodes) { const g = {_nodes: nodes}; nodes.forEach(n => n.graph = g); return g; }
const sender = node(1, SEND, '目录'), r1 = node(2, RECEIVE, '目录'), r2 = node(3, RECEIVE, '目录');
const other = node(4, RECEIVE, '目录 '), blank = node(5, RECEIVE, '');
const inner = graph([r2]), h1 = {id:10,title:'准备',subgraph:inner}, h2 = {id:11,title:'执行',subgraph:inner};
const root = graph([sender,r1,other,blank,h1,h2]);
app.rootGraph = root; app.canvas.graph = root;
assert.deepEqual(Array.from(context.pairedNodes(root,sender), m => m.path), ['2','10:3','11:3']);
assert.deepEqual(Array.from(context.pairedNodes(root,r2), m => m.path), ['1']);
assert.equal(context.pairedNodes(root,blank).length,0);
assert.equal(context.targetLocation(context.pairedNodes(root,sender)[0]),'同级');
assert.equal(context.targetLocation(context.pairedNodes(root,sender)[2]),'主图 → 执行 (#11)');
const cycle = {id:12,subgraph:root}; inner._nodes.push(cycle);
assert.equal(context.pairedNodes(root,sender).length,3); inner._nodes.pop();
let originalDraw = 0, originalRemove = 0, originalCanvas = 0;
app.canvas.onDrawForeground = () => originalCanvas++;
extension.setup();
app.canvas.onDrawForeground(); assert.equal(originalCanvas, 1);
sender.onDrawForeground = () => originalDraw++;
sender.onRemoved = () => originalRemove++;
extension.nodeCreated(sender); extension.nodeCreated(sender); extension.nodeCreated(r1); extension.nodeCreated(blank);
const matrix = {a:1,b:0,c:0,d:1,e:100,f:160};
const ctx = {getTransform: () => matrix};
sender.onDrawForeground(ctx); r1.onDrawForeground(ctx); blank.onDrawForeground(ctx);
assert.equal(originalDraw,1);
const button = context.ui().controls.get(sender), back = context.ui().controls.get(r1);
assert.equal(button.children[0].tagName,'svg');
assert.equal(button.children[0].children[0].d, 'M6 3.5 10.5 8 6 12.5');
assert.equal(back.children[0].children[0].d, 'M10 3.5 5.5 8 10 12.5');
assert.equal(button.style.transform,'scale(0.5)');
assert.equal(button.style.left,'165px'); assert.equal(button.style.top,'106.5px');
assert(context.ui().controls.get(blank).disabled);
const event = {stopPropagation(){},preventDefault(){},stopImmediatePropagation(){}};
button.handlers.click(event);
let popup = context.ui().popup;
assert.equal(popup.card.children.length,3);
assert.deepEqual(popup.card.children[1].children.map(x=>x.textContent), ['目录','#10:3','主图 → 准备 (#10)']);
assert.equal(popup.card.style.transform,'scale(0.5)');
assert.equal(button['aria-expanded'],'true');
assert.equal(document.activeElement, popup.card.firstElementChild);
matrix.a = 2; matrix.d = 2; sender.onDrawForeground(ctx); context.trackPopup();
assert.equal(popup.card.style.transform,'scale(1)');
assert.equal(button.style.left,'260px');
popup.card.children[2].handlers.click();
assert.equal(jumps.at(-1).path,'11:3'); assert.equal(context.ui().popup,null);
back.handlers.click(event); assert.equal(jumps.at(-1).node,sender); assert.equal(context.ui().popup,null);
button.handlers.click(event); listeners.keydown({...event,key:'Escape'});
assert.equal(context.ui().popup,null); assert.equal(document.activeElement,button);
button.handlers.click(event); listeners.pointerdown({target:document.body}); assert.equal(context.ui().popup,null);
button.handlers.click(event); sender.widgets[0].value='changed'; context.trackPopup(); assert.equal(context.ui().popup,null);
sender.widgets[0].value='目录';
button.handlers.click(event); app.canvas.visible_nodes=[r1,blank]; context.refreshVisibility();
assert(button.hidden); assert.equal(context.ui().popup,null);
sender.onDrawForeground(ctx); button.handlers.click(event);
surface.handlers['litegraph:set-graph'](); assert(button.hidden); assert.equal(context.ui().popup,null);
sender.onDrawForeground(ctx); sender.onRemoved(); assert.equal(originalRemove,1); assert(!button.isConnected);
sender.onDrawForeground(ctx); assert(context.ui().controls.get(sender).isConnected, 'Undo/add can recreate the button');
const keyBefore = JSON.stringify(sender.widgets); extension.afterConfigureGraph();
assert.equal(context.ui().controls.size,0); assert.equal(JSON.stringify(sender.widgets),keyBefore);
console.log('PASS: exact pairing, shared instances, SVG directions, DPR/zoom anchor, target-only list, direct jump, keyboard, stale keys, hidden/deleted nodes, workflow cleanup and callbacks');
