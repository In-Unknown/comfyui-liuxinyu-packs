const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../workspace_labels.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function harness(response = { ok: true, json: async () => ({ opened: true }) }) {
  let extension, click, contextmenu;
  const requests = [], messages = [], roots = [];
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
      body: {}, querySelectorAll(selector) { return selector === '[data-v-app]' ? roots : []; },
      addEventListener(type, listener, capture) {
        assert.equal(capture, true);
        if (type === 'click') click = listener;
        else if (type === 'contextmenu') contextmenu = listener;
        else assert.fail(type);
      },
    },
    MutationObserver: class { disconnect() {} observe() {} },
  };
  vm.runInNewContext(source, context);
  extension.setup();
  return { click, contextmenu, requests, messages, roots };
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


test('native context menu retains original items and reveals files and directories without duplicates', async () => {
  for (const leaf of [true, false]) {
    const h = harness();
    const node = { key: 'root/项目 空格/目录,%20' + (leaf ? '.json' : ''), leaf,
      contextMenuItems() { assert.equal(this, node); return [{ label: '原生操作' }]; } };
    const element = { getAttribute: () => 'tree-node-' + node.key,
      __vueParentComponent: { props: {}, parent: { props: { node } } } };
    const e = { target: { closest: s => s.includes('sidebar') ? {} : { querySelector: () => element } } };
    h.roots.push({ _vnode: { component: { subTree: { el: element, props: { node } } } } });
    h.contextmenu(e);
    h.contextmenu(e);
    const items = node.contextMenuItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].label, '原生操作');
    assert.equal(items[1].label, '跳转到对应文件夹');
    assert.equal(items[1].visible, true);
    await items[1].command();
    assert.equal(h.requests[0].url, '/liuxinyu/workspace/reveal');
    assert.equal(JSON.parse(h.requests[0].body).path, node.key.slice(5));
  }
});

test('folder with no existing menu gets a native menu; API failure reports the selected path', async () => {
  const h = harness({ ok: false, json: async () => ({ error: '文件已删除' }) });
  const node = { key: 'root/目录', leaf: false };
  const element = { getAttribute: () => 'tree-node-root/目录', __vueParentComponent: { props: { node } } };
  h.roots.push({ _vnode: { children: [{ el: element, component: { props: { node } } }] } });
  h.contextmenu({ target: { closest: s => s.includes('sidebar') ? {} : { querySelector: () => element } } });
  await node.contextMenuItems()[0].command();
  assert.equal(h.messages[0].detail, '目录\n文件已删除');
  h.contextmenu({ target: { closest: () => null } });
  assert.equal(h.requests.length, 1);
});
