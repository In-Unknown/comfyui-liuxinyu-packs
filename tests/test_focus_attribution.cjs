const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveStack } = require('../diagnostics/focus_source_report.cjs');
const root = path.resolve(__dirname, '../../../..');
const assets = path.join(root, 'python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');
const bundles = fs.readdirSync(assets).filter(file => /^settingStore-.*\.js$/.test(file) && fs.existsSync(path.join(assets, file + '.map')));
assert.equal(bundles.length, 1, 'Select an unambiguous installed frontend bundle');
const bundle = bundles[0], source = fs.readFileSync(path.join(assets, bundle), 'utf8');
const matches = [...source.matchAll(/addEventListener\(`blur`,(function\(\)\{this\.focus\(\)\})\)/g)];
assert.equal(matches.length, 3, 'Review actual installed handlers if the frontend changes');
function target() {
  const handlers = new Map();
  return { handlers,
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    removeEventListener() {},
    emit(type, event) { for (const fn of handlers.get(type) || []) { fn(event); if (event.stopped) break; } },
  };
}
const results = [];
for (const match of matches) {
  let focusCalls = 0, extension;
  const document = { ...target(), hidden: false, focused: false, hasFocus() { return this.focused; } };
  class Element { focus() { focusCalls++; return 19; } }
  const input = Object.assign(new Element(), { ownerDocument: document, tagName: 'INPUT', className: 'value',
    matches: selector => selector === '.graphdialog input.value' });
  const canvas = Object.assign(new Element(), { ownerDocument: document });
  const window = { ...target(), focus() {}, HTMLDialogElement: class {} };
  const app = { canvas: { canvas }, registerExtension(value) { extension = value; } };
  const context = vm.createContext({ window, document, HTMLElement: Element, app, performance: { now: () => 1000 },
    Date, Error, Reflect, Blob, URL, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../focus_diagnostics.js'), 'utf8').replace('export function', 'function'),
    context, { filename: 'http://127.0.0.1:8188/extensions/comfyui-liuxinyu-packs/focus_diagnostics.js' });
  const trace = vm.runInContext('startFocusTrace()', context);
  const start = match.index + match[0].indexOf(match[1]);
  const before = source.slice(0, start), lineOffset = before.split('\n').length - 1;
  const column = start - before.lastIndexOf('\n') - 1;
  const handler = new vm.Script('(' + match[1] + ')', {
    filename: 'http://127.0.0.1:8188/assets/' + bundle,
    lineOffset, columnOffset: column - 1,
  }).runInContext(context);
  const blur = relatedTarget => {
    const event = { target: input, relatedTarget, stopImmediatePropagation() { this.stopped = true; } };
    document.emit('blur', event);
    if (!event.stopped) handler.call(input);
  };
  for (let i = 0; i < 7; i++) blur(null);
  assert.equal(focusCalls, 7, 'Actual frontend handler must reproduce the unwanted background focus request');
  const event = trace.report().records.find(record => record.kind === 'HTMLElement.focus');
  assert(event.suspicious);
  const frames = resolveStack(event.stack, root);
  const mapped = frames.find(frame => frame.status === 'source-map' && frame.context.some(line => /this\.focus\(\)/.test(line.text)));
  assert(mapped, JSON.stringify(frames));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../focus_guard.js'), 'utf8').replace(/^import .*;\r?$/gm, ''), context);
  extension.setup();
  for (let i = 0; i < 7; i++) blur(null);
  assert.equal(focusCalls, 7, 'Fix must remove repeated background focus requests');
  document.focused = true;
  blur({});
  assert.equal(focusCalls, 8, 'Normal in-page focus must still execute');
  document.focused = false;
  let committed = 0;
  document.emit('blur', { target: { matches: () => false }, relatedTarget: null,
    stopImmediatePropagation() { throw new Error('Unrelated commit was blocked'); } });
  committed++;
  assert.equal(committed, 1);
  results.push({ source: mapped.source, line: mapped.line, context: mapped.context,
    backgroundRequestsBefore: 7, backgroundRequestsAfter: 0, normalInPageRequestsAfter: 1,
    stack: event.stack });
  trace.stop();
}
assert.equal(new Set(results.map(result => result.source + ':' + result.line)).size, 3,
  'Three identical handler bodies must be distinguished by their actual source locations');
const output = process.argv[2];
if (output) fs.writeFileSync(output, JSON.stringify({ kind: 'source-level-unit-regression', results }, null, 2), 'utf8');
console.log(JSON.stringify({ passed: true, cases: results.map(({ source, line, ...rest }) => ({ source, line,
  before: rest.backgroundRequestsBefore, after: rest.backgroundRequestsAfter, normal: rest.normalInPageRequestsAfter })) }));
