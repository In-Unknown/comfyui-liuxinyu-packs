const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../workflow_file_sync.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const menuSource = fs.readFileSync(path.join(__dirname, '../menu_source.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const menuOrder = fs.readFileSync(path.join(__dirname, '../menu_order.js'), 'utf8').replace(/^export /gm, '');
const graph = (value) => ({ nodes: [{ id: 1, widgets_values: [value] }], links: [] });
const copy = (value) => JSON.parse(JSON.stringify(value));

function harness({ savedAt = 1000, modified = 2000, server = graph('server'), storage } = {}) {
  const listeners = {};
  const actions = { draft: [], workflow: [] };
  const timers = new Map();
  const frames = [];
  const intervals = [];
  const dialogs = [];
  const requests = [];
  const loads = [];
  const warnings = [];
  let extension, menuExtension, nextTimer = 0;
  const now = 5000;
  storage ||= new Map();
  if (!storage.has('Comfy.Workflow.DraftIndex.v2:personal')) {
    storage.set('Comfy.Workflow.DraftIndex.v2:personal', JSON.stringify({ entries: {
      test: { path: 'workflows/test.json', updatedAt: savedAt, isTemporary: false },
    } }));
  }
  const workflow = {
    path: 'workflows/test.json', key: 'test.json', isPersisted: true,
    lastModified: modified, size: 80, isModified: true,
    activeState: graph('cached'), originalContent: JSON.stringify(graph('initial')),
    content: JSON.stringify(graph('cached')),
    changeTracker: {
      initialState: graph('initial'),
      reset(current) {
        if (current) workflow.activeState = copy(current);
        this.initialState = copy(workflow.activeState);
      },
      updateModified() {
        workflow.isModified = JSON.stringify(this.initialState) !== JSON.stringify(workflow.activeState);
      },
      captureCanvasState() {
        workflow.activeState = copy(state.canvas);
        this.updateModified();
      },
    },
  };
  const payloads = new Map([[workflow.path, { data: JSON.stringify(workflow.activeState), updatedAt: savedAt }]]);
  const drafts = {
    $onAction(fn) { actions.draft.push(fn); },
    getDraft(p) { return payloads.get(p); },
    saveDraft(p, data, meta) {
      const afters = [];
      actions.draft.forEach((fn) => fn({ name: 'saveDraft', args: [p, data, meta], after: (f) => afters.push(f) }));
      payloads.set(p, { data, updatedAt: now });
      afters.forEach((fn) => fn(true));
      return true;
    },
    removeDraft(p) { payloads.delete(p); },
  };
  const workflows = {
    activeWorkflow: workflow,
    _p: { _s: new Map([['workflowDraftV2', drafts]]) },
    $onAction(fn) { actions.workflow.push(fn); },
  };
  const state = { modified, server, canvas: copy(workflow.activeState), normalizeAfterLoad: false,
    failFetch: false, failLoad: false, invalidJSON: false };
  function element(tag) {
    const events = {};
    const el = {
      tag, style: {}, children: [], returnValue: '', closed: false,
      append(...children) { this.children.push(...children); },
      setAttribute() {},
      addEventListener(name, cb) { events[name] = cb; },
      dispatchEvent(event) { events[event.type]?.(event); },
      showModal() { dialogs.push(this); },
      close(value = '') { if (this.closed) return; this.closed = true; this.returnValue = value; events.close?.(); },
      remove() {},
    };
    return el;
  }
  const api = {
    api_base: '', user: '',
    addEventListener(name, cb) { listeners[name] = cb; },
    async fetchApi(url, options) {
      requests.push({ url, options });
      return { ok: !state.failFetch, status: state.failFetch ? 503 : 200,
        async json() { return [{ path: 'test.json', modified: state.modified, size: 80 }]; } };
    },
    async getUserData(p, options) {
      requests.push({ path: p, options });
      return { ok: !state.failFetch, status: state.failFetch ? 503 : 200,
        async text() {
          await state.beforeRead?.();
          return state.invalidJSON ? '{broken' : JSON.stringify(state.server);
        } };
    },
  };
  const app = {
    rootGraph: { serialize: () => copy(state.canvas) },
    extensionManager: { workflow: workflows, toast: { add: (v) => warnings.push(v) } },
    registerExtension(e) { if (e.name === 'liuxinyu.MenuSource') menuExtension = e; else extension = e; },
    async loadGraphData(data, clean, restoreView, target) {
      loads.push(copy(data));
      assert.equal(target, workflow);
      extension.beforeLoadGraph();
      if (state.failLoad) { state.failLoad = false; return false; }
      state.canvas = copy(data);
      state.afterConfigure?.({ frames, canvas: state.canvas });
      await extension.afterConfigureGraph();
      // Native afterLoadNewGraph snapshots only after afterConfigureGraph resolves.
      workflow.activeState = copy(state.canvas);
      workflow.changeTracker.initialState = copy(state.canvas);
      workflow.changeTracker.updateModified();
      drafts.saveDraft(workflow.path, JSON.stringify(data), {});
      extension.afterLoadGraph();
      // Native activation takes its baseline before afterLoadGraph extensions
      // and the final model/media pipeline have finished normalizing nodes.
      if (state.normalizeAfterLoad) state.canvas.nodes[0].properties = { initialized: true };
      state.afterLoad?.({ frames, canvas: state.canvas });
      return true;
    },
  };
  class TestDate extends Date { static now() { return now; } }
  const document = { createElement: element, body: { append() {} }, visibilityState: 'visible' };
  vm.runInNewContext(menuOrder + '\n' + menuSource + '\n' + source, {
    app, api, Date: TestDate,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document,
    window: { addEventListener(name, cb) { listeners[name] = cb; } },
    console: { warn() {} },
    setTimeout(cb) { const id = ++nextTimer; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(cb) { intervals.push(cb); return intervals.length; },
    requestAnimationFrame(cb) { frames.push(cb); },
  });
  extension.setup();
  async function flush() {
    for (let i = 0; i < 8; i++) {
      const batch = [...timers.values()]; timers.clear(); batch.forEach((cb) => cb());
      await new Promise(setImmediate);
      // Native callbacks can enqueue microtasks that propagate socket types.
      for (const callback of frames.splice(0)) {
        callback();
        await Promise.resolve();
      }
    }
  }
  async function restore() {
    extension.beforeLoadGraph();
    // Native restoration writes a fresh timestamp; it must not hide the
    // previous session's interval or change this extension's decision.
    drafts.saveDraft(workflow.path, JSON.stringify(workflow.activeState), {});
    extension.afterLoadGraph();
    await flush();
  }
  return { extension, menuExtension, workflow, workflows, drafts, payloads, state, storage,
    load: (data) => app.loadGraphData(data, true, true, workflow),
    dialogs, requests, loads, warnings, listeners, actions, restore, flush, intervals, document, frames };
}

test('ordinary open and repeated save/reload capture initialized nested Switch sockets', async () => {
  for (const type of ['STRING', 'ARRAY', 'INT']) {
    const saved = { nodes: [], links: [], definitions: { subgraphs: [760, 736].map(id => ({
      id: 'sub-' + id, nodes: [{ id, type: 'ComfySwitchNode',
        inputs: [{ name: 'on_false', type }, { name: 'on_true', type }, { name: 'switch', type: 'BOOLEAN' }],
        outputs: [{ name: 'output', type }], widgets_values: [false] }],
    })) } };
    const h = harness({ modified: 900, server: saved });
    h.state.afterConfigure = ({ frames, canvas }) => {
      for (const sub of canvas.definitions.subgraphs) {
        const node = sub.nodes[0];
        node.inputs[0].type = node.inputs[1].type = node.outputs[0].type = '*';
        // Reproduce native applyMatchType: configure resets the sockets;
        // its queued animation-frame callback infers them from the cables.
        frames.push(() => {
          node.inputs[0].type = node.inputs[1].type = node.outputs[0].type = type;
          frames.push(() => { node.outputs[0].type = type; });
        });
      }
    };
    let serialized = copy(saved);
    for (let reload = 0; reload < 3; reload++) {
      const loading = h.load(serialized);
      await h.flush();
      assert.equal(await loading, true);
      h.workflow.changeTracker.captureCanvasState();
      assert.equal(h.workflow.isModified, false, type + ': no edit after load');
      assert.deepEqual(h.workflow.changeTracker.initialState, saved);
      serialized = copy(h.state.canvas); // save and refresh the same file
      assert.deepEqual(serialized, saved);
      assert.equal(h.dialogs.length, 0);
    }
    const node = h.state.canvas.definitions.subgraphs[0].nodes[0];
    node.widgets_values[0] = true;
    h.workflow.changeTracker.captureCanvasState();
    assert.equal(h.workflow.isModified, true, 'later widget edits still mark dirty');
    node.widgets_values[0] = false;
    h.workflow.changeTracker.captureCanvasState();
    assert.equal(h.workflow.isModified, false);
    node.outputs[0].type = 'FLOAT';
    h.workflow.changeTracker.captureCanvasState();
    assert.equal(h.workflow.isModified, true, 'later socket changes are not filtered');
  }
});

test('initialization barrier never rewrites a baseline, clears drafts, or suppresses real edits', async () => {
  const h = harness({ modified: 900 });
  const initial = copy(h.workflow.changeTracker.initialState);
  const draft = copy(h.payloads.get(h.workflow.path));
  const waiting = h.extension.afterConfigureGraph();
  h.state.canvas.nodes[0].widgets_values[0] = 'unsaved draft or real edit';
  await h.flush();
  await waiting;
  assert.deepEqual(h.workflow.changeTracker.initialState, initial);
  assert.deepEqual(h.payloads.get(h.workflow.path), draft);
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, true);
  assert.equal(h.loads.length, 0);
  assert.equal(h.requests.length, 0);
});

test('normal loading waits for downstream JSONata microtasks before its native baseline', async () => {
  const h = harness({ modified: 900 });
  let structured;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../structured_data.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, ''), {
    app: { registerExtension(e) { structured = e; } }, queueMicrotask,
  });
  const saved = { nodes: [{ id: 1, type: 'LiuxinyuStructuredTransform',
    inputs: [{ name: 'sources.data0', type: 'STRING', label: 'data0 · STRING', link: 1 }],
    outputs: [{ type: 'DICT', label: '结果 · DICT' }] }], links: [] };
  h.state.afterConfigure = ({ frames, canvas }) => {
    const data = canvas.nodes[0], sw = { outputs: [{ type: '*' }] };
    const node = { comfyClass: data.type, inputs: data.inputs, outputs: data.outputs,
      widgets: [{ name: 'result_type', value: '字典' }],
      graph: { links: new Map([[1, { origin_id: 2, origin_slot: 0 }]]), getNodeById: () => sw },
      setDirtyCanvas() {}, disconnectInput() { assert.fail('no cables should disconnect'); } };
    structured.nodeCreated(node);
    frames.push(() => { sw.outputs[0].type = 'STRING'; node.onConnectionsChange(1, 0, true); });
  };
  const loading = h.load(saved);
  await h.flush(); await loading;
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, false);
  assert.deepEqual(h.workflow.changeTracker.initialState, saved);
});

test('sync waits for native match-type frames and real JSONata propagation before marking saved', async () => {
  const jsonTypes = 'DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL';
  const server = { nodes: [], links: [], definitions: { subgraphs: [{ id: 'sub', nodes: [
    { id: 539, type: 'ComfySwitchNode', inputs: [{ type: '*' }], outputs: [{ type: '*' }] },
    { id: 543, type: 'LiuxinyuStructuredTransform',
      inputs: [{ name: 'sources.data0', type: jsonTypes, label: 'data0 · JSON', link: 1 }],
      outputs: [{ type: 'DICT', label: '结果 · DICT' }], widgets_values: ['original expression'] },
  ] }] } };
  const h = harness({ server });
  let structured;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../structured_data.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, ''), {
    app: { registerExtension(e) { structured = e; } }, queueMicrotask,
  });
  let initialized = false;
  h.state.afterLoad = ({ frames, canvas }) => {
    const [sw, jsonata] = canvas.definitions.subgraphs[0].nodes;
    const node = { comfyClass: 'LiuxinyuStructuredTransform', inputs: jsonata.inputs,
      outputs: jsonata.outputs, widgets: [{ name: 'result_type', value: '字典' }],
      graph: { links: new Map([[1, { origin_id: 539, origin_slot: 0 }]]), getNodeById: () => sw },
      setDirtyCanvas() {}, disconnectInput() { assert.fail('valid ARRAY cable must survive'); },
    };
    structured.nodeCreated(node);
    // Native applyMatchType schedules its onConnectionsChange in rAF, not
    // inside the awaited graph load. Its downstream is the real package code.
    frames.push(() => {
      sw.inputs[0].type = sw.outputs[0].type = 'ARRAY';
      node.onConnectionsChange(1, 0, true);
      frames.push(() => { initialized = true; });
    });
  };
  await h.restore();
  const dialog = h.dialogs[0];
  const [keep, sync] = dialog.children.at(-1).children;
  sync.onclick();
  assert.equal(dialog.closed, false, 'canvas remains modal while loading');
  assert.equal(keep.disabled, true);
  assert.equal(sync.disabled, true);
  let cancelled = false;
  dialog.dispatchEvent({ type: 'cancel', preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true, 'Esc cannot expose an editable canvas during initialization');
  await h.flush();
  assert.equal(initialized, true);
  assert.equal(dialog.closed, true);
  assert.equal(h.workflow.isModified, false);
  const nodes = h.workflow.changeTracker.initialState.definitions.subgraphs[0].nodes;
  assert.equal(nodes[0].outputs[0].type, 'ARRAY');
  assert.equal(nodes[1].inputs[0].type, 'ARRAY');
  assert.equal(nodes[1].inputs[0].label, 'data0 · ARRAY');
  h.workflow.changeTracker.captureCanvasState(); // blank click / blur
  assert.equal(h.workflow.isModified, false);
  h.state.canvas.definitions.subgraphs[0].nodes[1].widgets_values[0] = 'real edit';
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, true);
  h.state.canvas.definitions.subgraphs[0].nodes[1].widgets_values[0] = 'original expression';
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, false);
  h.state.canvas.definitions.subgraphs[0].nodes[0].outputs[0].type = 'STRING';
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, true, 'later socket edits are not ignored');
  assert.equal(server.definitions.subgraphs[0].nodes[0].outputs[0].type, '*', 'file was not rewritten');
});

test('programmatic workflow change during load frames cannot reset the other workflow or remove its draft', async () => {
  const h = harness();
  const before = copy(h.workflow.changeTracker.initialState);
  h.state.afterLoad = ({ frames }) => frames.push(() => {
    h.extension.beforeLoadGraph();
    h.workflows.activeWorkflow = { path: 'workflows/other.json' };
  });
  await h.restore();
  h.dialogs[0].children.at(-1).children[1].onclick();
  await h.flush();
  assert.equal(h.dialogs[0].closed, true);
  assert.equal(h.workflows.activeWorkflow.path, 'workflows/other.json');
  assert.equal(h.payloads.has(h.workflow.path), true);
  assert.deepEqual(h.workflow.changeTracker.initialState, h.state.server);
  assert.notDeepEqual(h.workflow.changeTracker.initialState, before);
});

test('failed sync closes the busy modal and preserves the cached canvas', async () => {
  const h = harness(); await h.restore();
  h.state.failFetch = true;
  h.dialogs[0].children.at(-1).children[1].onclick();
  await h.flush();
  assert.equal(h.dialogs[0].closed, true);
  assert.deepEqual(h.workflow.activeState, graph('cached'));
});

test('dirty diagnostics expose delayed layout and real edits without changing graph, draft or baseline', async () => {
  const h = harness(); await h.restore();
  h.dialogs[0].close('sync'); await h.flush();
  h.state.canvas.nodes[0].size = [200, 140];
  h.workflow.changeTracker.captureCanvasState();
  h.state.canvas.nodes[0].widgets_values[0] = 'edited after capture';
  const before = JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas,
    drafts: [...h.payloads], storage: [...h.storage], requests: h.requests });
  h.menuExtension.getCanvasMenuItems().find(item => item.content === '查看未保存差异').callback();
  const report = h.dialogs.at(-1).children.find(child => child.tag === 'textarea');
  assert.equal(report.readOnly, true);
  assert.match(report.value, /nodes\[id=1\]\.size/);
  assert.match(report.value, /nodes\[id=1\]\.widgets_values\.0/);
  assert.match(report.value, /edited after capture/);
  assert.equal(JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas,
    drafts: [...h.payloads], storage: [...h.storage], requests: h.requests }), before);
});

test('diagnostics ignore root viewport and node ordering but retain subgraph viewport differences', async () => {
  const h = harness({ modified: 900 });
  const baseline = { nodes: [{id: 1}, {id: 2}], extra: {},
    definitions: { subgraphs: [{ id: 'sub', extra: { ds: { scale: 1 } } }] } };
  h.workflow.changeTracker.initialState = copy(baseline);
  h.workflow.activeState = copy(baseline);
  h.workflow.activeState.nodes.reverse();
  h.workflow.activeState.extra.ds = { scale: 2 };
  h.state.canvas = copy(h.workflow.activeState);
  h.state.canvas.definitions.subgraphs[0].extra.ds.scale = 3;
  h.menuExtension.getCanvasMenuItems().find(item => item.content === '查看未保存差异').callback();
  const report = h.dialogs.at(-1).children.find(child => child.tag === 'textarea').value;
  assert.match(report, /已保存基准 → 前端已记录状态：\n未发现字段差异。/);
  assert.match(report, /definitions.subgraphs.0.extra.ds.scale/);
});

test('restoration is not blocked or replaced; prompt appears afterwards', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  h.extension.beforeLoadGraph();
  assert.equal(h.requests.length, 0);
  await h.restore();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.loads.length, 0);
  assert.deepEqual(h.workflow.activeState, graph('cached'));
});

test('mtime strictly defines the interval, including identical or reverted content', async () => {
  for (const modified of [999, 1000, 1001]) {
    const h = harness({ modified, server: graph('cached') });
    await h.restore();
    assert.equal(h.dialogs.length, modified > 1000 ? 1 : 0);
    assert.equal(h.requests.some((r) => r.path), false, 'no JSON comparison/download before choice');
  }
});

test('do nothing preserves graph, cache, and file metadata; same revision is not prompted twice', async () => {
  const h = harness();
  await h.restore();
  const before = JSON.stringify(h.workflow);
  const draft = JSON.stringify([...h.payloads]);
  h.dialogs[0].close('keep'); await h.flush();
  h.listeners.focus(); await h.flush();
  assert.equal(h.dialogs.length, 1);
  assert.equal(JSON.stringify(h.workflow), before);
  assert.equal(JSON.stringify([...h.payloads]), draft);
  assert.equal(h.loads.length, 0);
  h.state.modified = 3000;
  h.listeners.reconnected(); await h.flush();
  assert.equal(h.dialogs.length, 2);
});

test('dismiss and browser restart preserve the ignored revision', async () => {
  const h = harness(); await h.restore();
  h.dialogs[0].close(); await h.flush();
  const next = harness({ storage: h.storage }); await next.restore();
  assert.equal(next.dialogs.length, 0);
});

test('sync reads latest content after choice, clears stale draft, and never writes backend', async () => {
  const h = harness(); await h.restore();
  h.state.server = graph('newer while dialog open');
  h.state.modified = 2500;
  h.dialogs[0].close('sync'); await h.flush();
  assert.deepEqual(h.workflow.activeState, h.state.server);
  assert.equal(h.workflow.isModified, false);
  assert.equal(h.workflow.lastModified, 2500);
  assert.equal(h.payloads.has(h.workflow.path), false);
  assert.ok(h.requests.every((r) => !r.options.method && r.options.cache === 'no-store'));
});

test('a new frontend draft save starts a new time window', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.drafts.saveDraft(h.workflow.path, JSON.stringify(graph('edited')), {});
  h.state.modified = 4000;
  h.listeners.focus(); await h.flush();
  assert.equal(h.dialogs.length, 0);
  h.state.modified = 6000;
  h.listeners.focus(); await h.flush();
  assert.equal(h.dialogs.length, 1);
});

test('autosave while a decision is pending keeps the dialog and its boundary across refresh', async () => {
  const h = harness(); await h.restore();
  h.drafts.saveDraft(h.workflow.path, JSON.stringify(graph('autosaved canvas')), {});
  await h.flush();
  assert.equal(h.dialogs[0].closed, false, 'autosave must not close the pending decision');
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(JSON.parse(h.payloads.get(h.workflow.path).data), graph('autosaved canvas'));
  assert.equal(h.loads.length, 0);
  const next = harness({storage: h.storage}); await next.restore();
  assert.equal(next.dialogs.length, 1, 'refresh must still offer the unhandled file revision');
  h.dialogs[0].close('sync'); await h.flush();
  assert.deepEqual(h.workflow.activeState, h.state.server);
});

test('a successful file save still cancels an obsolete pending question', async () => {
  const h = harness(); await h.restore();
  h.workflow.lastModified = 6000; h.state.modified = 6000;
  for (const fn of h.actions.workflow) fn({name:'saveWorkflow',args:[h.workflow],after:cb=>cb()});
  await h.flush();
  assert.equal(h.dialogs[0].closed, true);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.loads.length, 0);
});

test('sync stays saved after normalized canvas is checked again; next real edit is dirty', async () => {
  const h = harness(); await h.restore();
  h.state.normalizeAfterLoad = true;
  h.dialogs[0].close('sync'); await h.flush();
  const syncedCanvas = copy(h.state.canvas);
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, false, 'post-load normalization must belong to the saved baseline');
  assert.deepEqual(h.workflow.changeTracker.initialState, syncedCanvas);
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, false, 'repeated checks must stay clean');
  h.state.canvas.nodes[0].widgets_values[0] = 'user edit';
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, true, 'later user edits must still be detected');
  h.state.canvas = syncedCanvas;
  h.workflow.changeTracker.captureCanvasState();
  assert.equal(h.workflow.isModified, false, 'returning to the synced state must be clean');
});

test('sync acknowledgement does not pretend a new frontend save occurred', async () => {
  const h = harness(); await h.restore();
  h.dialogs[0].close('sync'); await h.flush();
  // Newer than the acknowledged file, but earlier than this browser's clock.
  // Sync itself must not move the save boundary forward and hide this edit.
  h.state.modified = 3000;
  h.listeners.focus(); await h.flush();
  assert.equal(h.dialogs.length, 2);
});

test('successful frontend file save does not look like an external change', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.workflow.lastModified = 6000; h.state.modified = 6000;
  for (const fn of h.actions.workflow) fn({ name: 'saveWorkflow', args: [h.workflow], after: (cb) => cb() });
  h.listeners.focus(); await h.flush();
  assert.equal(h.dialogs.length, 0);
});

test('switching workflows cancels stale decisions without loading into the wrong tab', async () => {
  const h = harness(); await h.restore();
  h.extension.beforeLoadGraph();
  h.workflows.activeWorkflow = { path: 'workflows/other.json', isPersisted: false };
  h.dialogs[0].close('sync'); await h.flush();
  assert.equal(h.loads.length, 0);
});

test('failed download or invalid JSON leaves current workflow and draft intact', async () => {
  for (const failure of ['failFetch', 'invalidJSON']) {
    const h = harness(); await h.restore();
    const before = JSON.stringify(h.workflow);
    h.state[failure] = true;
    h.dialogs[0].close('sync'); await h.flush();
    assert.equal(JSON.stringify(h.workflow), before);
    assert.equal(h.loads.length, 0);
    assert.equal(h.payloads.has(h.workflow.path), true);
    assert.equal(h.warnings.length, 1);
  }
});

test('failed graph load restores cached content and leaves a recoverable draft', async () => {
  const h = harness(); await h.restore();
  const original = h.workflow.originalContent;
  h.state.failLoad = true;
  h.dialogs[0].close('sync'); await h.flush();
  assert.deepEqual(h.workflow.activeState, graph('cached'));
  assert.equal(h.workflow.originalContent, original);
  assert.deepEqual(JSON.parse(h.payloads.get(h.workflow.path).data), graph('cached'));
  assert.equal(h.workflow.isModified, true);
  assert.equal(h.warnings.length, 1);
});

test('temporary workflows are not checked', async () => {
  const h = harness(); h.workflow.isPersisted = false;
  await h.restore();
  assert.equal(h.requests.length, 0);
});

test('concurrent focus/reconnect checks do not stack duplicate dialogs', async () => {
  const h = harness(); await h.restore();
  h.listeners.focus(); h.listeners.reconnected(); await h.flush();
  assert.equal(h.dialogs.length, 1);
  h.dialogs[0].close('keep'); await h.flush();
  assert.equal(h.dialogs.length, 1);
});

test('focus during restoration does not cancel completion and permanently disable checks', async () => {
  const h = harness();
  h.extension.beforeLoadGraph();
  h.extension.afterLoadGraph();
  h.listeners.focus();
  await h.flush();
  assert.equal(h.dialogs.length, 1);
});

test('restoration cache rewrites do not advance the saved boundary on next startup', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.storage.set('Comfy.Workflow.DraftIndex.v2:personal', JSON.stringify({ entries: {
    test: { path: h.workflow.path, updatedAt: 5000, isTemporary: false },
  } }));
  const next = harness({ modified: 2000, storage: h.storage });
  await next.restore();
  assert.equal(next.dialogs.length, 1);
});

test('visible page detects a later backend revision after cancelling without a focus event', async () => {
  const h = harness(); await h.restore();
  h.dialogs[0].close('keep'); await h.flush();
  assert.equal(h.intervals.length, 1);
  h.state.modified = 3000;
  h.document.visibilityState = 'hidden';
  const requests = h.requests.length;
  h.intervals[0](); await h.flush();
  assert.equal(h.requests.length, requests);
  h.document.visibilityState = 'visible';
  h.intervals[0](); await h.flush();
  assert.equal(h.dialogs.length, 2);
});

test('manual canvas command offers the same file again after cancelling', async () => {
  const h = harness(); await h.restore();
  h.dialogs[0].close('keep'); await h.flush();
  const menu = h.menuExtension.getCanvasMenuItems();
  assert(menu.every(item => item.className === 'liuxinyu-menu-source'));
  menu[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 2);
  h.dialogs[1].close('sync'); await h.flush();
  assert.deepEqual(h.workflow.activeState, h.state.server);
  assert.equal(h.workflow.isModified, false);
});

test('manual check after saving identical content reports no update without changing canvas or draft', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.state.server = copy(h.state.canvas);
  h.workflow.lastModified = h.state.modified = 6000;
  for (const fn of h.actions.workflow) fn({ name: 'saveWorkflow', args: [h.workflow], after: cb => cb() });
  const before = JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas, drafts: [...h.payloads] });
  h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.loads.length, 0);
  assert.equal(h.warnings.at(-1).summary, '无需更新');
  assert.equal(JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas, drafts: [...h.payloads] }), before);
  assert.ok(h.requests.some(r => r.path && r.options.cache === 'no-store'));
});

test('manual equality ignores root viewport, object keys and root node serialization order', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.state.server = { nodes: [{ id: 1, type: 'A' }, { id: 2, type: 'B' }], links: [] };
  h.state.canvas = { links: [], nodes: [{ type: 'B', id: 2 }, { type: 'A', id: 1 }], extra: { ds: { scale: 2, offset: [3, 4] } } };
  h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.warnings.at(-1).summary, '无需更新');
});

test('manual check can acknowledge identical content with a newer mtime after cancelling automatic prompt', async () => {
  const h = harness({ server: graph('cached') }); await h.restore();
  h.dialogs[0].close('keep'); await h.flush();
  h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.warnings.at(-1).summary, '无需更新');
  assert.equal(h.loads.length, 0);
});

test('manual check uses live canvas and preserves widget, wiring and nested subgraph differences', async () => {
  const changes = [
    canvas => { canvas.nodes[0].widgets_values[0] = 'live edit'; },
    canvas => { canvas.links.push([1, 1, 0, 2, 0, 'STRING']); },
    canvas => { canvas.definitions = { subgraphs: [{ id: 'sub', nodes: [{ id: 3 }] }] }; },
  ];
  for (const change of changes) {
    const h = harness({ modified: 900, server: graph('cached') }); await h.restore();
    assert.deepEqual(h.workflow.activeState, h.state.server);
    change(h.state.canvas);
    h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
    assert.equal(h.dialogs.length, 1);
    assert.match(h.dialogs[0].children[1].textContent, /当前画布与后端文件内容不同/);
    assert.equal(h.loads.length, 0);
    assert.equal(h.warnings.length, 0);
    h.dialogs[0].close('keep'); await h.flush();
  }
});

test('manual read failure or invalid workflow never claims equal or changes the canvas', async () => {
  for (const failure of ['failFetch', 'invalidJSON', 'notWorkflow']) {
    const h = harness({ modified: 900 }); await h.restore();
    const before = JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas, drafts: [...h.payloads] });
    if (failure === 'notWorkflow') h.state.server = {};
    else h.state[failure] = true;
    h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.loads.length, 0);
    assert.equal(h.warnings.at(-1).severity, 'warn');
    assert.equal(JSON.stringify({ workflow: h.workflow, canvas: h.state.canvas, drafts: [...h.payloads] }), before);
  }
});

test('navigation while manual content read is pending suppresses stale results', async () => {
  const h = harness({ modified: 900, server: graph('cached') }); await h.restore();
  h.state.beforeRead = () => {
    h.extension.beforeLoadGraph();
    h.workflows.activeWorkflow = { path: 'workflows/other.json', isPersisted: false };
  };
  h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.loads.length, 0);
  assert.equal(h.warnings.length, 0);
});

test('manual synchronization rereads content changed after its comparison', async () => {
  const h = harness({ modified: 900 }); await h.restore();
  h.menuExtension.getCanvasMenuItems()[0].callback(); await h.flush();
  assert.equal(h.dialogs.length, 1);
  h.state.server = graph('changed after manual comparison');
  h.state.modified = 950;
  h.dialogs[0].close('sync'); await h.flush();
  assert.deepEqual(h.workflow.activeState, h.state.server);
  assert.equal(h.requests.filter(r => r.path).length, 2);
  assert.equal(h.workflow.lastModified, 950);
});
