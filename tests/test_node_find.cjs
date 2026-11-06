const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let extension;
  const frames = [];
  const listeners = new Map();
  const events = [];
  const doc = { hidden: false, hasFocus: () => true };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.value = ''; this.isConnected = true; }
    setAttribute(name, value) { this[name] = value; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    remove() { this.isConnected = false; }
    focus() { doc.activeElement = this; }
    select() { this.selected = true; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    get firstElementChild() { return this.children[0]; }
  }
  doc.createElement = tag => new Element(tag);
  doc.body = new Element('body'); doc.head = new Element('head');
  const surface = new Element('canvas');
  surface.width = 2000; surface.height = 1600;
  surface.dispatchEvent = event => { events.push(event); surface.handlers[event.type]?.(event); return true; };
  const canvas = {
    canvas: surface, graph: null, ds: { offset: [0, 0], scale: 0.75 },
    clear() {}, setGraph(graph) {
      if (graph === this.graph) return;
      const oldGraph = this.graph;
      graph.attachCanvas(this);
      surface.dispatchEvent({type:'litegraph:set-graph', detail:{oldGraph,newGraph:graph}});
      // Simulate native viewport restore/fit happening on the next render frame.
      frames.push(() => { this.ds.offset = [900, 900]; this.ds.scale = 0.2; });
    },
    openSubgraph(graph, host) { this.setGraph(graph); surface.dispatchEvent({ type: 'subgraph-opened', detail: { subgraph: graph, fromNode: host } }); },
    selectNode(node) { this.selected = node; }, setDirty() {}, setZoom(scale) { this.ds.scale = scale; },
    centerOnNode(node) {
      this.ds.offset = node.pos.map((p, i) => -p - node.size[i] / 2 + [surface.width, surface.height][i] / (2 * this.ds.scale * 2));
    },
  };
  const app = { canvas, registerExtension(e) { extension = e; } };
  const context = vm.createContext({ app, document: doc, window: { devicePixelRatio: 2,
    localStorage: { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, value); } },
    addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); } },
    requestAnimationFrame(callback) { frames.push(callback); },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    URL, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../node_find.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', '"http://localhost/extensions/liuxinyu/node_find.js"');
  vm.runInContext(source + '\nglobalThis.ui = () => ({panel,input,status,results});', context);
  function graph(nodes = []) {
    const g = { _nodes: nodes, attachCanvas(c) { c.graph = this; c.subgraph = this === app.rootGraph ? undefined : this; } };
    nodes.forEach(node => { node.graph = g; });
    return g;
  }
  function node(id, subgraph) { return { id, title: `Node ${id}`, pos: [300, -120], size: [220, 140], subgraph }; }
  async function settle() {
    for (let i = 0; i < 30; i++) {
      const batch = frames.splice(0); batch.forEach(callback => callback());
      await Promise.resolve();
    }
  }
  if (process.argv[2]) {
    const native = fs.readFileSync(process.argv[2], 'utf8');
    for (const [name, end] of [['openSubgraph', 'getCurrentGraph'], ['centerOnNode', 'adjustMouseEvent']]) {
      const start = native.indexOf(`${name}(e`);
      // openSubgraph occurs in callers first; select its actual definition.
      const index = name === 'openSubgraph' ? native.indexOf('openSubgraph(e,t){') : start;
      const stop = native.indexOf(`${end}(`, index);
      assert(index >= 0 && stop > index, `Installed native ${name} located`);
      canvas[name] = vm.runInContext(`(function${native.slice(index + name.length, stop)})`, context);
    }
  }
  return { app, canvas, doc, events, frames, listeners, graph, node, context, settle, get extension() { return extension; } };
}

async function main() {
  const h = harness();
  const { graph, node, context: c } = h;
  const target = node(729);
  const inner = graph([target]);
  const middleHost = node(745, inner);
  const middle = graph([middleHost]);
  const outerHost = node(771, middle);
  const otherHost = node(800, inner);
  const rootNode = node(785);
  const root = graph([outerHost, otherHost, rootNode]);
  h.app.rootGraph = root; h.canvas.setGraph(root);
  assert.deepEqual(Array.from(c.findNodes(root, '729'), x => x.path), ['771:745:729', '800:729']);
  assert.equal(c.findNodes(root, '#771:745:729')[0].node, target);
  assert.equal(c.findNodes(root, '72').length, 0, 'Exact IDs, not substring matches');
  target.title = '渠道报告 · 汇报'; target.type = 'ReportNode';
  target.constructor = {nodeData:{display_name:'读取报告文本'}};
  assert.equal(c.findNodes(root, '渠道报告').length, 2);
  assert.equal(c.findNodes(root, 'reportnode').length, 2, 'Type names are case insensitive');
  assert.equal(c.findNodes(root, '读取报告').length, 2, 'Original display names remain searchable after renaming');
  for (const query of ['', 'invalid', '771::729', '-10']) assert.equal(c.findNodes(root, query).length, 0);
  const cycle = node(999, root); inner._nodes.push(cycle); cycle.graph = inner;
  assert.equal(c.findNodes(root, '729').length, 2, 'Cycle guard must not remove sibling instances');
  inner._nodes.pop();
  const before = JSON.stringify([target.pos, target.size, root._nodes.map(n => n.id)]);
  let locating = c.revealNode(c.findNodes(root, '771:745:729')[0]);
  await h.settle(); assert.equal(await locating, true);
  assert.equal(h.canvas.graph, inner); assert.equal(h.canvas.selected, target);
  assert.equal(h.canvas.ds.scale, 1.9);
  assert.deepEqual(h.events.filter(e => e.type === 'subgraph-opened').map(e => e.detail.fromNode.id), [771, 745]);
  target.pos.forEach((p, i) => assert(Math.abs((p + target.size[i] / 2 + h.canvas.ds.offset[i]) * h.canvas.ds.scale * 2 -
    [h.canvas.canvas.width, h.canvas.canvas.height][i] / 2) < 1e-8, 'Target is centered at current DPR and scale'));
  assert.equal(JSON.stringify([target.pos, target.size, root._nodes.map(n => n.id)]), before);
  locating = c.revealNode(c.findNodes(root, '785')[0]);
  await h.settle(); assert.equal(await locating, true); assert.equal(h.canvas.graph, root);
  const obsolete = c.findNodes(root, '785')[0]; root._nodes.pop();
  await assert.rejects(c.revealNode(obsolete), /变化/); root._nodes.push(rootNode);
  locating = c.revealNode(c.findNodes(root, '771:745:729')[0]);
  h.app.rootGraph = graph([]);
  await h.settle(); assert.equal(await locating, false, 'Workflow changes cancel navigation');
  h.app.rootGraph = root; h.canvas.setGraph(root);

  h.extension.setup(); h.extension.setup();
  assert.equal(h.doc.head.children.length, 1, 'Styles and handler installed once');
  assert.equal(h.listeners.get('keydown').capture, true);
  locating = c.revealNode(c.findNodes(root, '771:745:729')[0]);
  await h.settle(); assert.equal(await locating, true);
  h.canvas.setGraph(middle); await h.settle();
  assert.equal(h.canvas.selected, middleHost, 'Returning one level centers the exact host');
  assert.equal(h.canvas.ds.scale, 1.9);
  h.canvas.setGraph(root); await h.settle();
  assert.equal(h.canvas.selected, outerHost, 'Returning to root centers the outer host');
  locating = c.revealNode(c.findNodes(root, '800:729')[0]);
  await h.settle(); assert.equal(await locating, true);
  h.canvas.setGraph(root); await h.settle();
  assert.equal(h.canvas.selected, otherHost, 'Shared subgraphs return to the selected instance');
  locating = c.revealNode(c.findNodes(root, '771:745:729')[0]);
  await h.settle(); await locating;
  h.canvas.setGraph(root); await h.settle();
  assert.equal(h.canvas.selected, outerHost, 'Skipping levels returns to the host in root');
  h.canvas.openSubgraph(inner, otherHost); await h.settle();
  h.canvas.setGraph(root); await h.settle();
  assert.equal(h.canvas.selected, otherHost, 'Manual entry updates the return target to the actual instance');
  const large = node(900); large.size = [1400, 2000];
  c.focusNode(h.canvas, large);
  assert(h.canvas.ds.scale < 1.9);
  assert(large.size[0] * h.canvas.ds.scale <= h.canvas.canvas.width / 2 * 0.8);
  assert(large.size[1] * h.canvas.ds.scale <= h.canvas.canvas.height / 2 * 0.8);
  const key = (name, extra = {}) => ({ key: name, ctrlKey: false, metaKey: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  let event = key('f', { ctrlKey: true }); c.onKeyDown(event);
  assert(event.prevented && event.stopped);
  let ui = c.ui(); assert.equal(h.doc.activeElement, ui.input);
  ui.input.value = '729'; c.search(true);
  assert.equal(ui.results.children.length, 2);
  assert.equal(h.doc.activeElement, ui.results.firstElementChild, 'Duplicate ID requires choosing a path');
  assert.equal(h.canvas.graph, root);
  ui.input.value = '渠道报告'; c.search(true);
  assert.equal(ui.results.children.length, 2);
  assert.equal(h.canvas.graph, root, 'Enter on multiple name matches does not navigate');
  ui.input.value = '777777'; c.search(true); assert.match(ui.status.textContent, /没有找到/);
  ui.input.value = '771:745:729'; c.search(true); await h.settle();
  assert.equal(c.ui().panel, null); assert.equal(h.canvas.selected, target);
  c.onKeyDown(key('f', { ctrlKey: true }));
  h.doc.hidden = true;
  const focus = h.doc.activeElement;
  c.onKeyDown(key('Escape')); assert.equal(c.ui().panel, null);
  assert.equal(h.doc.activeElement, focus, 'Closing in background does not request focus');
  h.doc.hidden = false;
  for (const event of [key('s', {ctrlKey:true}), key('f', {ctrlKey:true, shiftKey:true}), key('f', {ctrlKey:true, isComposing:true})]) {
    c.onKeyDown(event); assert(!event.prevented);
  }
  c.onKeyDown(key('f', {ctrlKey:true})); h.extension.afterConfigureGraph(); assert.equal(c.ui().panel, null);

  c.openPanel();
  ui = c.ui();
  ui.input.value = '历史一'; c.search(true);
  ui.input.value = '历史二'; c.search(true);
  ui.input.value = '正在输入'; ui.input.handlers.input();
  let arrow = key('ArrowUp'); ui.input.handlers.keydown(arrow);
  assert(arrow.prevented && arrow.stopped);
  assert.equal(ui.input.value, '历史二');
  assert.equal(ui.input.selectionStart, ui.input.value.length);
  ui.input.handlers.keydown(key('ArrowUp')); assert.equal(ui.input.value, '历史一');
  ui.input.handlers.keydown(key('ArrowDown')); assert.equal(ui.input.value, '历史二');
  ui.input.handlers.keydown(key('ArrowDown')); assert.equal(ui.input.value, '正在输入');
  ui.input.handlers.keydown(key('ArrowDown')); assert.equal(ui.input.value, '正在输入');
  ui.input.handlers.keydown(key('ArrowUp'));
  ui.input.value = '修改后的草稿'; ui.input.handlers.input();
  ui.input.handlers.keydown(key('ArrowUp')); assert.equal(ui.input.value, '历史二');
  ui.input.handlers.keydown(key('ArrowDown')); assert.equal(ui.input.value, '修改后的草稿');
  for (const extra of [{isComposing:true},{ctrlKey:true},{shiftKey:true}]) {
    arrow = key('ArrowUp', extra); ui.input.handlers.keydown(arrow); assert(!arrow.prevented);
  }
  ui.input.value = '历史一'; c.search(true);
  assert.equal(Array.from(c.searchHistory()).filter(value => value === '历史一').length, 1);
  assert.equal(c.searchHistory().at(-1), '历史一');
  c.closePanel(); c.openPanel(); ui = c.ui();
  ui.input.handlers.keydown(key('ArrowUp')); assert.equal(ui.input.value, '历史一');
  for (let i = 0; i < 55; i++) { ui.input.value = `历史 ${i}`; c.rememberQuery(); }
  assert.equal(c.searchHistory().length, 50);
  const stored = h.context.window.localStorage.values.get('liuxinyu.node-find.history');
  const fresh = harness(); fresh.app.rootGraph = fresh.graph([]); fresh.canvas.graph = fresh.app.rootGraph;
  fresh.context.window.localStorage.setItem('liuxinyu.node-find.history', stored);
  fresh.context.openPanel();
  fresh.context.ui().input.handlers.keydown(key('ArrowUp'));
  assert.equal(fresh.context.ui().input.value, '历史 54', 'History survives a new page context');
  for (let i = 0; i < 60; i++) fresh.context.ui().input.handlers.keydown(key('ArrowUp'));
  assert.equal(fresh.context.ui().input.value, '历史 5', 'Oldest boundary does not wrap');

  if (process.argv[3]) {
    const saved = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const defs = new Map(saved.definitions.subgraphs.map(g => [g.id, graph([])]));
    function fill(raw, g) {
      g._nodes = raw.nodes.map(n => Object.assign(node(n.id, defs.get(n.type)), {title:n.title || n.type}));
      g._nodes.forEach(n => { n.graph = g; });
    }
    for (const raw of saved.definitions.subgraphs) fill(raw, defs.get(raw.id));
    const current = graph([]); fill(saved, current);
    const rawDefs = new Map(saved.definitions.subgraphs.map(g => [g.id, g]));
    const expected = new Map();
    function collect(raw, hosts = [], ancestors = new Set()) {
      if (ancestors.has(raw)) return;
      const next = new Set([...ancestors, raw]);
      for (const item of raw.nodes) {
        const id = String(item.id), fullPath = [...hosts, id].join(':');
        if (!expected.has(id)) expected.set(id, []);
        expected.get(id).push(fullPath);
        if (rawDefs.has(item.type)) collect(rawDefs.get(item.type), [...hosts, id], next);
      }
    }
    collect(saved);
    assert(expected.size > 0, 'The supplied workflow must contain saved nodes');
    for (const [id, paths] of expected) {
      assert.deepEqual(Array.from(c.findNodes(current, id), result => result.path).sort(), paths.sort());
      for (const fullPath of paths) {
        assert(c.findNodes(current, fullPath).some(result => result.path === fullPath));
      }
    }
  }
  console.log('PASS: ID/path search, duplicate instances, recursive graphs, nested native navigation, centering, stale targets, keyboard and panel lifecycle');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
