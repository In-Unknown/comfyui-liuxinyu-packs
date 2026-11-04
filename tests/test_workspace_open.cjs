const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../workspace_labels.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function harness(response = { ok: true, json: async () => ({ opened: true }) }) {
  let extension, click;
  const requests = [], messages = [];
  const context = {
    console,
    MouseEvent: class {
      constructor(type, options) { this.type = type; Object.assign(this, options); }
    },
    app: {
      registerExtension(value) { extension = value; },
      extensionManager: {
        workflow: { _p: { _s: new Map([['sidebarTab', { sidebarTabs: [{ id: 'workflows' }] }]]) } },
        toast: { add(message) { messages.push(message); } },
      },
    },
    api: { async fetchApi(url, options) { requests.push({ url, ...options }); return response; } },
    document: {
      body: {}, querySelectorAll() { return []; },
      addEventListener(type, listener, capture) {
        assert.equal(type, 'click'); assert.equal(capture, true); click = listener;
      },
    },
    MutationObserver: class { disconnect() {} observe() {} },
  };
  vm.runInNewContext(source, context);
  extension.setup();
  return { click, requests, messages };
}

function event(filename, { action = false, panel = true, folder = false, detail = 1, button = 0 } = {}) {
  const leaf = { getAttribute: () => `tree-node-root/${filename}` };
  return {
    button, detail, stopped: false, defaultPrevented: false,
    target: {
      isConnected: true,
      closest(selector) {
        if (selector.startsWith('[data-testid=')) return panel;
        if (selector === '.p-tree-node-content') return { querySelector: () => folder ? null : leaf };
        return action;
      },
    },
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

test('document row/file-icon click opens the exact path once and blocks native JSON loading', async () => {
  const h = harness();
  const e = event('目录 空格/说明%20文档.md');
  await h.click(e);
  assert.equal(e.stopped, true);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(JSON.parse(h.requests[0].body), { path: '目录 空格/说明%20文档.md' });
  assert.equal(h.requests[0].method, 'POST');
  const doubleClick = event('目录 空格/说明%20文档.md', { detail: 2 });
  await h.click(doubleClick);
  assert.equal(doubleClick.stopped, true);
  assert.equal(h.requests.length, 1);
});

test('bookmark buttons, edit controls, folders and other panels keep native behavior', async () => {
  const h = harness();
  for (const e of [event('说明.md', { action: true }),
    event('目录', { folder: true }), event('说明.md', { panel: false }), event('说明.md', { button: 2 })]) {
    await h.click(e);
    assert.equal(e.stopped, false);
  }
  assert.equal(h.requests.length, 0);
});

test('ordinary JSON is intercepted before native navigation and never replays a canvas open', async () => {
  const h = harness();
  const e = event('summary_conclusion-sales.json');
  e.target.dispatchEvent = () => assert.fail('Must not open a canvas or tab for a document');
  await h.click(e);
  assert.equal(e.stopped, true);
  assert.equal(h.requests.length, 1);
});

test('possible workflows replay the native click only after checking, without checking twice', async () => {
  const h = harness({ ok: true, json: async () => ({ opened: false, action: 'workflow' }) });
  for (const filename of ['流程.json', '应用.app.JSON']) {
    const e = event(filename);
    let opened = 0;
    e.target.dispatchEvent = (replay) => {
      opened++;
      replay.target = e.target;
      h.click(replay);
    };
    await h.click(e);
    assert.equal(e.stopped, true);
    assert.equal(opened, 1);
  }
  assert.equal(h.requests.length, 2);
});

test('failed JSON inspection does not fall back to either native navigation or a blank canvas', async () => {
  const h = harness({ ok: false, json: async () => ({ error: '文件读取失败' }) });
  const e = event('文件.json');
  e.target.dispatchEvent = () => assert.fail('Inspection failure must leave the canvas alone');
  await h.click(e);
  assert.equal(e.stopped, true);
  assert.match(h.messages[0].detail, /文件读取失败/);
});

test('failed open displays the backend reason and releases the file for retry', async () => {
  const h = harness({ ok: false, json: async () => ({ error: 'Windows 尚未设置默认程序' }) });
  await h.click(event('说明.md'));
  assert.match(h.messages[0].detail, /说明.md\nWindows 尚未设置默认程序/);
  await h.click(event('说明.md'));
  assert.equal(h.requests.length, 2);
});
