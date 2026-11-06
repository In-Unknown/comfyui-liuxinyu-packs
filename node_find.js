import { app } from "../../scripts/app.js";

const definitions = new WeakMap();

function rootGraph() {
  return app.rootGraph || app.canvas?.graph?.rootGraph || app.graph;
}

function findNodes(root, query) {
  const text = query.trim();
  if (!text) return [];
  const id = text.replace(/^#/, "");
  const byId = /^\d+(?::\d+)*$/.test(id);
  const name = text.toLocaleLowerCase();
  const matches = [];
  function visit(graph, hosts, ancestors) {
    if (!graph || ancestors.has(graph)) return;
    const next = new Set([...ancestors, graph]);
    for (const node of graph.nodes || graph._nodes || []) {
      const path = [...hosts.map(host => String(host.id)), String(node.id)].join(":");
      const definition = definitions.get(node.constructor) || node.constructor?.nodeData;
      const names = [node.title, node.subgraph?.name, definition?.display_name,
        node.constructor?.title, node.type, node.comfyClass];
      if (byId ? (id.includes(":") ? path === id : String(node.id) === id)
        : names.some(value => typeof value === "string" && value.toLocaleLowerCase().includes(name))) {
        matches.push({ root, graph, node, hosts, path });
      }
      if (node.subgraph) visit(node.subgraph, [...hosts, node], next);
    }
  }
  visit(root, [], new Set());
  return matches;
}

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
let navigation = 0;
let returnRoute;
let viewChange = 0;
let revealing = false;

function onSubgraphOpened(event) {
  if (revealing) return;
  const host = event.detail?.fromNode;
  const root = rootGraph();
  if (!host?.subgraph || !root) return;
  const route = returnRoute?.root === root ? returnRoute.hosts : [];
  const parentIndex = [root, ...route.map(node => node.subgraph)].indexOf(host.graph);
  const parentHosts = parentIndex >= 0 ? route.slice(0, parentIndex)
    : findNodes(root, String(host.id)).find(match => match.node === host)?.hosts;
  if (parentHosts) returnRoute = { root, hosts: [...parentHosts, host] };
}

function focusNode(canvas, node) {
  const ratio = window.devicePixelRatio || 1;
  // A normal node is shown at approximately the screenshot's 190% zoom.
  // Reserve space for its title/badges, and fit large nodes inside the viewport.
  const scale = Math.min(1.9,
    canvas.canvas.width / ratio * 0.8 / (node.size[0] + 40),
    canvas.canvas.height / ratio * 0.8 / (node.size[1] + 80));
  canvas.setZoom(scale);
  canvas.selectNode(node);
  canvas.centerOnNode(node);
}

async function onGraphChange(event) {
  const ticket = ++viewChange;
  if (revealing || !returnRoute || returnRoute.root !== rootGraph()) return;
  const { oldGraph, newGraph } = event.detail || {};
  const { hosts, root } = returnRoute;
  const graphs = [root, ...hosts.map(host => host.subgraph)];
  const from = graphs.indexOf(oldGraph);
  const to = graphs.indexOf(newGraph);
  if (to < 0 || from <= to) return;
  const host = hosts[to];
  await frame();
  await frame();
  if (ticket !== viewChange || revealing || root !== rootGraph() || app.canvas.graph !== newGraph) return;
  if (host?.graph !== newGraph || !(newGraph.nodes || newGraph._nodes || []).includes(host)) return;
  focusNode(app.canvas, host);
}

async function revealNode(match) {
  const canvas = app.canvas;
  const ticket = ++navigation;
  const current = findNodes(rootGraph(), match.path).find(item => item.node === match.node);
  if (match.root !== rootGraph() || !current) throw new Error("工作流或节点已变化，请重新查找。");
  revealing = true;
  viewChange++;
  const active = () => ticket === navigation && rootGraph() === match.root;
  // Use the same graph events as native subgraph navigation, so breadcrumbs and
  // viewport caches follow the canvas. Wait for native fit/restore before centering.
  try {
    if (canvas.graph !== match.graph) {
      canvas.setGraph(match.root);
      await frame();
      for (const host of current.hosts) {
        if (!active()) return false;
        if (host.graph !== canvas.graph || !host.subgraph) throw new Error("子图路径已变化，请重新查找。");
        focusNode(canvas, host);
        canvas.openSubgraph(host.subgraph, host);
        if (canvas.graph !== host.subgraph) throw new Error("子图未能打开，请关闭当前编辑操作后重试。");
        await frame();
      }
    }
    await frame();
    if (!active() || canvas.graph !== match.graph) return false;
    if (!(match.graph.nodes || match.graph._nodes || []).includes(match.node)) {
      throw new Error("节点已被删除，请重新查找。");
    }
    focusNode(canvas, match.node);
    returnRoute = current;
    return true;
  } finally {
    revealing = false;
  }
}

let panel;
let input;
let status;
let results;
let previousFocus;
let searching = false;
const HISTORY_KEY = "liuxinyu.node-find.history";
let history;
let historyPosition = 0;
let historyDraft = "";

function searchHistory() {
  if (!history) {
    history = [];
    try {
      const saved = JSON.parse(window.localStorage.getItem(HISTORY_KEY));
      if (Array.isArray(saved)) history = [...new Set(saved.filter(value => typeof value === "string" && value.trim()))].slice(-50);
    } catch { /* History still works in memory when browser storage is unavailable. */ }
  }
  return history;
}

function resetHistoryPosition() {
  historyPosition = searchHistory().length;
  historyDraft = input?.value || "";
}

function rememberQuery() {
  const query = input?.value.trim();
  if (!query) return;
  history = [...searchHistory().filter(value => value !== query), query].slice(-50);
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* Keep in memory. */ }
  resetHistoryPosition();
}

function onHistoryKey(event) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || searching) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const entries = searchHistory();
  if (!entries.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (historyPosition === entries.length) historyDraft = input.value;
  historyPosition = Math.max(0, Math.min(entries.length, historyPosition + (event.key === "ArrowUp" ? -1 : 1)));
  input.value = historyPosition === entries.length ? historyDraft : entries[historyPosition];
  input.setSelectionRange(input.value.length, input.value.length);
  search();
}

function closePanel(restoreFocus = false) {
  rememberQuery();
  navigation++;
  panel?.remove();
  panel = input = status = results = null;
  searching = false;
  if (restoreFocus && !document.hidden && document.hasFocus()) {
    const target = previousFocus?.isConnected ? previousFocus : app.canvas?.canvas;
    target?.focus({ preventScroll: true });
  }
}

async function choose(match) {
  if (searching) return;
  rememberQuery();
  searching = true;
  const currentPanel = panel;
  status.textContent = "正在定位…";
  try {
    const revealed = await revealNode(match);
    if (panel !== currentPanel) return;
    if (revealed) {
      closePanel();
      if (!document.hidden && document.hasFocus()) app.canvas.canvas.focus({ preventScroll: true });
    } else status.textContent = "视图已变化，请重新查找。";
  } catch (error) {
    if (panel === currentPanel) status.textContent = error.message;
  } finally {
    if (panel === currentPanel) searching = false;
  }
}

function search(go = false) {
  if (searching) return;
  results.replaceChildren();
  const query = input.value.trim();
  if (!query) {
    status.textContent = "";
    return;
  }
  if (go) rememberQuery();
  const matches = findNodes(rootGraph(), query);
  status.textContent = matches.length
    ? `找到 ${matches.length} 处${matches.length > 1 ? "，请选择所在路径" : "，按 Enter 定位"}。`
    : "当前工作流中没有找到匹配节点。";
  for (const match of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "liuxinyu-node-find-result";
    const title = document.createElement("strong");
    title.textContent = `#${match.node.id} · ${match.node.title || match.node.type || "节点"}`;
    const path = document.createElement("small");
    path.textContent = ["主图", ...match.hosts.map(host => `${host.title || host.subgraph.name || "子图"} (#${host.id})`)].join(" → ");
    const id = document.createElement("small");
    id.textContent = match.path;
    button.append(title, path, id);
    button.addEventListener("click", () => choose(match));
    results.append(button);
  }
  if (go && matches.length === 1) void choose(matches[0]);
  else if (go && matches.length > 1) results.firstElementChild.focus();
}

function openPanel() {
  if (panel) {
    input.focus();
    input.select();
    return;
  }
  previousFocus = document.activeElement;
  panel = document.createElement("section");
  panel.className = "liuxinyu-node-find";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "按节点 ID 或名称查找");
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "查找节点";
  const source = document.createElement("small");
  source.textContent = "liuxinyu";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭查找");
  close.addEventListener("click", () => closePanel(true));
  header.append(title, source, close);
  const form = document.createElement("form");
  input = document.createElement("input");
  input.type = "text";
  input.placeholder = "节点 ID 或名称";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "节点 ID、名称或完整路径");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "定位";
  form.append(input, submit);
  form.addEventListener("submit", event => { event.preventDefault(); search(true); });
  input.addEventListener("input", () => { resetHistoryPosition(); search(); });
  input.addEventListener("keydown", onHistoryKey);
  resetHistoryPosition();
  status = document.createElement("div");
  status.className = "liuxinyu-node-find-status";
  status.setAttribute("role", "status");
  results = document.createElement("div");
  results.className = "liuxinyu-node-find-results";
  panel.append(header, form, status, results);
  document.body.append(panel);
  search();
  input.focus();
}

function onKeyDown(event) {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
    if (!app.canvas?.graph || !rootGraph()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPanel();
  } else if (event.key === "Escape" && panel) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closePanel(true);
  }
}

let installed = false;
app.registerExtension({
  name: "liuxinyu.NodeFind",
  beforeRegisterNodeDef(nodeType, nodeData) { definitions.set(nodeType, nodeData); },
  setup() {
    if (installed) return;
    installed = true;
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = new URL("./node_find.css", import.meta.url).href;
    document.head.append(style);
    window.addEventListener("keydown", onKeyDown, true);
    app.canvas.canvas.addEventListener("litegraph:set-graph", onGraphChange);
    app.canvas.canvas.addEventListener("subgraph-opened", onSubgraphOpened);
  },
  afterConfigureGraph() { closePanel(); returnRoute = null; viewChange++; },
});
