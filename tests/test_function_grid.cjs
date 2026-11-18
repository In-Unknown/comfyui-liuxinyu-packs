const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  const listeners = new Map(), warnings = [], requests = [];
  const documentListeners = new Map();
  const frames = new Map(); let frameId = 0;
  let anchor = { left: 215, right: 279, top: 392, bottom: 420, width: 64, height: 28 };
  class Element {
    constructor(tag) {
      this.tag = tag; this.textContent = ''; this.style = { setProperty(k, v) { this[k] = v; } };
      this.children = []; this.dataset = {}; this.attrs = {}; this.events = new Map();
      this.isConnected = true; this.scrollTop = 0; this.scrollHeight = 260;
    }
    setAttribute(name, value) { this.attrs[name] = value; }
    append(...elements) { elements.forEach(e => { e.parent = this; this.children.push(e); }); }
    replaceChildren() { this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    dispatch(name, event = {}) { this.events.get(name)?.({ stopPropagation() {}, preventDefault() {}, ...event }); }
    focus() { fakeDocument.activeElement = this; }
    getBoundingClientRect() { return anchor; }
    querySelectorAll() { return this.children.flatMap(child => [...(child.tag === 'details' && child.open ? [child] : []), ...child.querySelectorAll()]); }
  }
  const fakeDocument = {
    addEventListener(name, handler) { documentListeners.set(name, handler); },
    removeEventListener(name) { documentListeners.delete(name); },
    createElement(tag) { return new Element(tag); }, getElementById(id) { return this.head.children.find(child => child.id === id); },
    createElementNS(namespace, tag) { return new Element(tag); },
    head: new Element('head'), body: new Element('body'), activeElement: null,
  };
  const api = {
    fileURL: path => path,
    clientId: 'test-client', addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    async fetchApi(url, options) {
      const body = JSON.parse(options.body); requests.push({ url, body });
      if (body.expression === 'invalid') return { ok: false, json: async () => ({ error: '公式不完整' }) };
      if (url.endsWith('/inspect')) return { ok: true, json: async () => ({
        variables: body.expression.startsWith('y') ? ['y', 'x'] : ['x', 'y'], series: [{ name: '项数', infinite: true }],
      }) };
      return { ok: true, json: async () => ({ complete: true, summary: '完成', series: [{
        name: '项数', infinite: true, convergence: '暂时无法确定', terms: JSON.parse(body.axes_json).series.项数,
        properties: { '证明状态': '依赖参数', '误差界': '范围检查失败：参数未绑定', '单调性': '幅值差分小于零' },
      }] }) };
    },
  };
  const app = { registerExtension(value) { extension = value; }, extensionManager: { toast: { add(value) { warnings.push(value); } } } };
  const ComfyWidgets = { STRING(node, name, spec) {
    const widget = { name, type: 'text', value: spec[1].default, options: {} }; node.widgets.push(widget); return { widget };
  } };
  const context = { app, api, ComfyWidgets, AbortController, setTimeout, clearTimeout, URL, console,
    fetch: async (url, options) => { requests.push({ url, options }); return { text: async () => 'fresh help' }; },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    document: fakeDocument, window: { innerWidth: 1000, innerHeight: 800 } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../function_grid_info.js'), 'utf8')
    .replace(/^export /gm, '').replace('import.meta.url', '"http://localhost/extensions/function_grid_info.js"'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../function_grid.js'), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  await extension.setup();
  assert.equal(requests[0].options.cache, 'reload', 'startup must replace stale HTTP help responses');
  let mouseCalls = 0, removalCalls = 0;
  const node = {
    id: 17, pos: [200, 300], comfyClass: 'LiuxinyuFunctionGrid', inputs: [], outputs: [{name: '多维数列', label: '多维数列', type: 'ARRAY', links: [456], shape: 6}, {name: '采样坐标'}], size: [300, 400],
    widgets: [{ name: 'expression', value: 'x+y+sum(项数=1 to INF) 1/项数' },
      { name: 'axes_json', value: JSON.stringify({ axes: { x: { min: '9223372036854775806', max: '9223372036854775807', step: '1', precision: '0' } }, series: { 项数: '9223372036854775807' }, order: ['x', 'y'], series_order: ['项数'] }) }],
    addCustomWidget(widget) { this.widgets.push(widget); return widget; },
    addDOMWidget(name, type, element, options) { const widget = { name, type, element, options }; this.widgets.push(widget); return widget; },
    addInput(name, type) { const input = { name, type, link: null }; this.inputs.push(input); return input; },
    addOutput(name, type) { this.outputs.push({ name, type }); },
    removeInput(index) { this.inputs.splice(index, 1); }, removeWidget(widget) { this.widgets.splice(this.widgets.indexOf(widget), 1); },
    computeSize() { return [300, 400]; }, setSize(size) { this.size = size; }, setDirtyCanvas() {},
    onMouseDown() { mouseCalls++; return 'original'; }, onRemoved() { removalCalls++; },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 510));
  extension.nodeCreated(node);
  // Saved sockets exist before asynchronous formula inspection returns.
  for (const name of ['expression', 'axes_json']) {
    const input = node.addInput(name, 'STRING'); input.widget = {name};
  }
  const savedMin = node.addInput('min1', 'FLOAT'); savedMin.widget = {name: 'min1'}; savedMin.link = 123;
  node.onConfigure();
  assert.equal(node.inputs.indexOf(savedMin), 2, 'Do not shift restored link indices during node configuration');
  node.onAfterGraphConfigured();
  assert.ok(!node.inputs.some(input => input.name === 'axes_json'), 'Hidden storage must not mask the first numeric socket');
  assert.equal(node.widgets.find(widget => widget.name === 'min1')?.value, '9223372036854775806',
    'Saved controls must exist immediately, without waiting for inspection');
  assert.equal(node.inputs.find(input => input.name === 'min1'), savedMin);
  assert.equal(savedMin.type, 'FLOAT,INT,STRING');
  assert.equal(savedMin.link, 123);
  const legacy = node.addInput('axes_json', 'STRING'); legacy.widget = {name: 'axes_json'}; legacy.link = 7;
  node.onAfterGraphConfigured();
  assert.equal(legacy.link, 7, 'Do not drop a connected legacy configuration input');
  assert.ok(!legacy.widget, 'Legacy wire gets a separate socket row');
  legacy.link = null; node.onAfterGraphConfigured();
  assert.ok(!node.inputs.includes(legacy));
  await settle();
  assert.equal(node.outputs[2].name, '高精度数列');
  assert.equal(node.outputs[0].name, '值执行列表');
  assert.equal(node.outputs[0].label, '值执行列表');
  assert.deepEqual(node.outputs[0].links, [456]);
  assert.equal(node.outputs[0].type, 'ARRAY');
  assert.equal(node.outputs[0].shape, 6);
  assert.equal(node.widgets.find(widget => widget.name === 'terms1').value, '9223372036854775807');
  assert.equal(node.widgets.find(widget => widget.name === 'terms1').label, '项数 运行项数');
  assert.equal(node.widgets.find(widget => widget.name === 'min1').value, '9223372036854775806');
  assert.equal(warnings[0].severity, 'warn');
  assert.equal(warnings[0].summary, '存在不确定收敛性的级数');
  assert.equal(warnings[0].detail.includes('依赖参数'), true);
  const xMin = node.inputs.find(input => input.name === 'min1'); xMin.link = 123;
  const expression = node.widgets.find(widget => widget.name === 'expression');
  expression.value = 'y+x+sum(项数=1 to INF) 1/项数'; expression.callback(); await settle();
  assert.equal(node.inputs.find(input => input.name === 'min2'), xMin);
  assert.equal(xMin.link, 123);
  const count = node.widgets.find(widget => widget.name === 'terms1'); count.value = '5001'; count.callback(); await settle();
  assert.equal(JSON.parse(node.widgets.find(widget => widget.name === 'axes_json').value).series.项数, '5001');
  assert.equal(requests.at(-1).body.client_id, 'test-client');
  const inputCount = node.inputs.length;
  expression.value = 'invalid'; expression.callback(); await settle();
  assert.equal(node.inputs.length, inputCount, 'incomplete formula must not destroy existing wires');
  assert.equal(xMin.link, 123);
  const info = node.widgets.find(widget => widget.name === 'liuxinyu_series_info');
  const trigger = info.element.children[0];
  trigger.offsetHeight = 28;
  const graph = {}; node.graph = graph;
  app.canvas = { graph, canvas: {}, convertEventToCanvasOffset: event => [event.canvasX, event.canvasY] };
  const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const click = () => trigger.dispatch('click');
  const card = () => fakeDocument.body.children[0];
  const allText = e => e.textContent + e.children.map(allText).join('');
  assert.equal(info.serialize, false);
  assert.equal(info.options.getMinHeight(), 32);
  click();
  assert.equal(fakeDocument.body.children.length, 1);
  assert.equal(trigger.attrs['aria-expanded'], 'true');
  assert.equal(card().attrs.role, 'dialog');
  assert.equal(card().dataset.side, 'above');
  assert.equal(card().style.left, '203px');
  assert.equal(card().style.transform, 'scale(1)');
  assert.equal(card().style.maxHeight, '480px');
  const firstTop = parseFloat(card().style.top);
  anchor = { ...anchor, top: 452, bottom: 480, left: 255, right: 319 };
  tick();
  assert.equal(parseFloat(card().style.top), firstTop + 60, 'popover follows node movement');
  assert.equal(card().style.left, '243px');
  anchor = { ...anchor, width: 32, right: 287, height: 14, bottom: 466 };
  tick();
  assert.equal(card().style.transform, 'scale(0.5)', 'panel and all descendants inherit canvas zoom');
  assert.equal(card().style.width, '320px', 'logical panel width is independent of zoom');
  assert.equal(card().style.left, '249px');
  assert.equal(card().style.top, '294px', 'placement uses scaled height and gap');
  assert.equal(card().style['--arrow-x'], '44px', 'arrow remains centered in panel coordinates');
  anchor = { ...anchor, top: 20, bottom: 34 };
  tick(); assert.equal(card().dataset.side, 'below', 'top edge flips popover');
  anchor = { ...anchor, left: 950, right: 982 };
  tick(); assert.equal(card().style.left, '828px', 'right edge avoidance uses displayed width');
  context.window.innerWidth = 340;
  anchor = { left: 20, right: 84, top: 20, bottom: 48, width: 64, height: 28 };
  tick(); assert.equal(card().style.width, '320px'); assert.equal(card().style.left, '12px');
  assert.equal(card().style.transform, 'scale(1)');
  context.window.innerHeight = 150;
  tick(); assert.equal(card().style.maxHeight, '480px', 'viewport size does not resize the panel');
  assert.equal(fakeDocument.body.children.length, 1, 'small viewports do not close the panel');
  context.window.innerHeight = 800;
  context.window.innerWidth = 1000;
  anchor = { left: 215, right: 343, top: 100, bottom: 156, width: 128, height: 56 };
  tick();
  assert.equal(card().style.transform, 'scale(2)');
  assert.equal(card().style.width, '320px');
  assert.equal(card().style.top, '176px');
  assert.equal(card().style['--arrow-x'], '44px');
  anchor = { left: 215, right: 279, top: 392, bottom: 420, width: 64, height: 28 };
  tick();
  documentListeners.get('pointerdown')({ target: card() });
  assert.equal(fakeDocument.body.children.length, 1);
  documentListeners.get('pointerdown')({ target: app.canvas.canvas, button: 1 });
  assert.equal(fakeDocument.body.children.length, 1, 'pan keeps popover attached');
  documentListeners.get('pointerdown')({ target: app.canvas.canvas, button: 0, canvasX: 210, canvasY: 310 });
  assert.equal(fakeDocument.body.children.length, 1, 'dragging owner node keeps it open');
  click(); assert.equal(fakeDocument.body.children.length, 0);
  assert.equal(trigger.attrs['aria-expanded'], 'false'); assert.equal(frames.size, 0);
  click(); documentListeners.get('pointerdown')({ target: {}, button: 0 });
  assert.equal(fakeDocument.body.children.length, 0);
  trigger.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(fakeDocument.activeElement, card().children[0].children[1]);
  documentListeners.get('keydown')({ key: 'Escape', stopPropagation() {}, preventDefault() {} });
  assert.equal(fakeDocument.body.children.length, 0); assert.equal(fakeDocument.activeElement, trigger);
  click(); node.flags = { collapsed: true }; tick();
  assert.equal(fakeDocument.body.children.length, 0); node.flags.collapsed = false;
  click(); app.canvas.graph = {}; tick(); assert.equal(fakeDocument.body.children.length, 0);
  app.canvas.graph = graph;
  expression.value = 'x'; expression.callback(); await settle(); click();
  const body = card().children[1];
  assert.equal(body.querySelectorAll().length, 0, 'secondary properties start collapsed');
  const firstDetail = body.children[0].children.find(child => child.tag === 'details');
  firstDetail.open = true; body.scrollTop = 40;
  const report = { complete: true, series: [{ name: 'item', convergence: 'unknown', properties: { '单调性': '幅值差分小于零' },
    calculations: [{ operation: '差分', expression: 'b(n+1)-b(n)', result: '-2/((2n+1)(2n+3))', status: '已证明' }] }] };
  // Keep the same index name to exercise preservation across streamed reports.
  report.series[0].name = JSON.parse(requests.at(-1).body.axes_json).series_order[0];
  report.series[0].numerics = { invocations: 1, sample: {
    N: '5000', algorithm: '精确有理数累加', working_digits: 80, condition: '6.67264769154',
    sum: '0.7853481634', sum_abs: '5.24035160955', lost_digits: '0.8243',
    summation_roundoff: '0', relative_roundoff: '0', output_conversion_error: '1.93658e-17',
    binary64_term_overflow: 0, binary64_term_underflow: 0, binary64_term_subnormal: 0,
  } };
  node.onExecuted({ liuxinyu_series_analysis: [report] });
  assert.equal(body.querySelectorAll().length, 1, 'stream updates retain expanded section');
  assert.equal(body.scrollTop, 40);
  assert.ok(allText(body).includes('6.67264769154'), 'computed condition number is rendered');
  assert.ok(allText(body).includes('-2/((2n+1)(2n+3))'), 'actual symbolic calculation is rendered');
  assert.ok(!allText(body).includes('尚未获得严格结论'), 'no generic empty property placeholders');
  report.series[0].analysis = { '误差界': { title: '误差界', status: '已证明', classification: '严格截断界',
    subject: '无穷和减去前 N 项和', domain: 'N≥1', quantities: [{ label: '严格上界', value: '1/(2*N+1)' }],
    steps: ['幅值差分为负，极限为零，应用莱布尼茨余项定理。'] } };
  report.series[0].infinite = true;
  report.series[0].convergence = '确定收敛';
  report.series[0].properties['证明状态'] = '莱布尼茨判别';
  node.onExecuted({ liuxinyu_series_analysis: [report] });
  assert.ok(allText(body).includes('严格上界'));
  assert.ok(allText(body).includes('1/(2*N+1)'));
  assert.ok(allText(body).includes('莱布尼茨余项定理'));
  assert.equal(warnings.at(-1).summary, '确定收敛的级数');
  report.complete = false;
  report.series[0].phases = {
    proof: { label: '收敛证明', state: 'completed', seconds: 0.5 },
    numerical: { label: '数值诊断', state: 'timeout', seconds: 20, reason: '高精度参考重算达到预算' },
  };
  node.onExecuted({ liuxinyu_series_analysis: [report] });
  assert.ok(allText(body).includes('已完成 · 0.5 秒'));
  assert.ok(allText(body).includes('达到时间预算 · 20 秒'));
  assert.ok(allText(body).includes('高精度参考重算达到预算'));
  assert.equal(warnings.at(-1).summary, '确定收敛的级数', 'diagnostic timeout does not change the mathematical verdict');
  anchor = { left: 215, right: 247, top: 392, bottom: 406, width: 32, height: 14 };
  tick();
  assert.equal(card().style.width, '400px', 'full report keeps its own logical width');
  assert.equal(card().style.transform, 'scale(0.5)', 'full report displays at 200px when canvas is at half scale');
  assert.equal(body.scrollTop, 40, 'zoom preserves reading position');
  anchor = { left: 215, right: 279, top: 392, bottom: 420, width: 64, height: 28 };
  tick();
  const before = warnings.length;
  node.onExecuted({ liuxinyu_series_analysis: [report] });
  assert.equal(warnings.length, before, 'same proof and inputs do not repeat notifications');
  report.series[0].convergence = '确定发散';
  report.series[0].properties['证明状态'] = '通项极限为 1';
  node.onExecuted({ liuxinyu_series_analysis: [report] });
  assert.equal(warnings.at(-1).summary, '存在发散级数');
  assert.equal(warnings.at(-1).severity, 'error');
  node.onExecuted({ liuxinyu_series_analysis: [{ complete: true, series: [] }] });
  assert.equal(body.children.length, 1, 'ordinary expression gets compact empty state');
  assert.equal(body.children[0].children.length, 2);
  click(); click();
  card().children[0].children[1].dispatch('click');
  assert.equal(fakeDocument.body.children.length, 0, 'close button works');
  click();
  assert.equal(node.onMouseDown({}, [100, 100]), 'original');
  assert.equal(mouseCalls, 1);
  node.onRemoved();
  assert.equal(removalCalls, 1); assert.equal(listeners.size, 0);
  assert.equal(documentListeners.size, 0);
  assert.equal(frames.size, 0);
  console.log('PASS: native DOM trigger, anchored movement/zoom/viewport placement, keyboard, dismissal, streamed disclosures, help refresh, exact controls and retained wires');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
