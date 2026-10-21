import { app } from "../../scripts/app.js";

const ROW_HEIGHT = 30;
const isContainer = (value) => value !== null && typeof value === "object";
const kindOf = (value) => value === null ? "null" : Array.isArray(value) ? "数组"
  : ({ object: "对象", string: "字符串", number: "数字", boolean: "布尔值" })[typeof value];

function setupObjectPreview(node) {
  let items = null;
  let rows = [];
  let frame = null;
  let selected = null;
  let lastWindow = "";
  const expanded = new Set();
  const panel = document.createElement("div");
  panel.className = "liuxinyu-object-preview";
  const toolbar = document.createElement("div");
  toolbar.className = "lop-toolbar";
  const summary = document.createElement("span");
  summary.textContent = "等待运行";
  const collapse = document.createElement("button");
  collapse.textContent = "收起";
  const copy = document.createElement("button");
  copy.textContent = "复制JSON";
  copy.disabled = collapse.disabled = true;
  toolbar.append(summary, collapse, copy);
  const body = document.createElement("div");
  body.className = "lop-body";
  body.setAttribute("role", "tree");
  body.setAttribute("aria-label", "对象结构");
  const space = document.createElement("div");
  space.className = "lop-space";
  body.append(space);
  const detail = document.createElement("div");
  detail.className = "lop-detail";
  detail.hidden = true;
  const detailTitle = document.createElement("div");
  detailTitle.className = "lop-detail-title";
  const detailLabel = document.createElement("span");
  const copyValue = document.createElement("button");
  copyValue.textContent = "复制此值";
  const close = document.createElement("button");
  close.textContent = "关闭";
  detailTitle.append(detailLabel, copyValue, close);
  const fullValue = document.createElement("pre");
  fullValue.className = "lop-full-value";
  detail.append(detailTitle, fullValue);
  const hint = document.createElement("div");
  hint.className = "lop-hint";
  hint.textContent = "点击箭头展开；滚轮滚动；Ctrl + 滚轮缩放画布。";
  panel.append(toolbar, body, detail, hint);

  for (const event of ["pointerdown", "keydown"]) {
    panel.addEventListener(event, (e) => e.stopPropagation());
  }
  panel.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.ctrlKey) {
      const target = fullValue.contains(event.target) ? fullValue : body;
      const unit = event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? target.clientHeight : 1;
      target.scrollTop += (event.deltaY || event.deltaX) * unit;
    } else {
      app.canvas.canvas.dispatchEvent(new WheelEvent("wheel", {
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
        deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY,
        ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey,
        bubbles: true, cancelable: true,
      }));
    }
  }, { passive: false });

  function fitPanel() {
    const width = `${Math.max(0, node.size[0] - 20)}px`;
    if (panel.style.width !== width) panel.style.width = width;
  }
  const widget = node.addDOMWidget("object_preview", "custom", panel, {
    hideOnZoom: false, getMinHeight: () => 180, onDraw: fitPanel, afterResize: fitPanel,
  });
  widget.serialize = false;

  function rebuild() {
    rows = [];
    const stack = (items || []).map((value, index) => ({
      value, key: items.length === 1 ? "$" : `结果 ${index + 1}`,
      path: String(index), depth: 0,
    })).reverse();
    while (stack.length) {
      const row = stack.pop();
      rows.push(row);
      if (!isContainer(row.value) || !expanded.has(row.path)) continue;
      const keys = Object.keys(row.value);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        stack.push({ value: row.value[key], key: Array.isArray(row.value) ? `[${key}]` : key,
          path: `${row.path}/${encodeURIComponent(key)}`, depth: row.depth + 1 });
      }
    }
    space.style.height = `${rows.length * ROW_HEIGHT}px`;
    lastWindow = "";
    schedule();
  }
  function toggle(row) {
    if (expanded.has(row.path)) expanded.delete(row.path);
    else expanded.add(row.path);
    rebuild();
  }
  function select(row) {
    selected = row;
    detailLabel.textContent = `${row.key} · ${kindOf(row.value)}`;
    fullValue.textContent = JSON.stringify(row.value, null, 2);
    fullValue.scrollTop = 0;
    detail.hidden = false;
    copyValue.textContent = "复制此值";
    lastWindow = "";
    schedule();
  }
  function draw() {
    frame = null;
    const first = Math.max(0, Math.floor(body.scrollTop / ROW_HEIGHT) - 3);
    const end = Math.min(rows.length, first + Math.ceil(body.clientHeight / ROW_HEIGHT) + 7);
    const windowKey = `${first}:${end}`;
    if (windowKey === lastWindow) return;
    lastWindow = windowKey;
    space.replaceChildren();
    if (items === null || !items.length) {
      const empty = document.createElement("div");
      empty.className = "lop-empty";
      empty.textContent = items === null ? "连接对象或数组，运行后查看。" : "没有输入条目。";
      space.append(empty);
      return;
    }
    for (let index = first; index < end; index++) {
      const row = rows[index];
      const container = isContainer(row.value);
      const count = container ? Object.keys(row.value).length : 0;
      const line = document.createElement("div");
      line.className = "lop-row" + (selected?.path === row.path ? " lop-selected" : "");
      line.style.top = `${index * ROW_HEIGHT}px`;
      line.style.paddingLeft = `${6 + Math.min(row.depth, 10) * 12}px`;
      line.setAttribute("role", "treeitem");
      line.setAttribute("aria-level", String(row.depth + 1));
      if (container) line.setAttribute("aria-expanded", String(expanded.has(row.path)));
      line.tabIndex = 0;
      const arrow = document.createElement("button");
      arrow.className = "lop-arrow";
      arrow.textContent = count ? expanded.has(row.path) ? "▾" : "▸" : "";
      arrow.disabled = !count;
      arrow.setAttribute("aria-label", expanded.has(row.path) ? "收起" : "展开");
      arrow.addEventListener("click", (event) => { event.stopPropagation(); toggle(row); });
      const key = document.createElement("span");
      key.className = "lop-key";
      key.textContent = row.key;
      key.title = row.key;
      const value = document.createElement("span");
      value.className = `lop-value lop-${typeof row.value}`;
      value.textContent = container ? `${Array.isArray(row.value) ? "[ ]" : "{ }"} ${count} ${Array.isArray(row.value) ? "项" : "个属性"}`
        : JSON.stringify(row.value);
      const kind = document.createElement("span");
      kind.className = "lop-kind";
      kind.textContent = kindOf(row.value);
      line.append(arrow, key, value, kind);
      line.addEventListener("click", () => select(row));
      line.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); select(row); }
        if (event.key === " " && count) { event.preventDefault(); toggle(row); }
      });
      space.append(line);
    }
  }
  function schedule() {
    if (frame === null) frame = requestAnimationFrame(draw);
  }
  async function copyText(button, text, label) {
    try { await navigator.clipboard.writeText(text); button.textContent = "已复制"; }
    catch { button.textContent = "复制失败"; }
    button.title = label;
  }
  copy.addEventListener("click", () => copyText(copy,
    JSON.stringify(items.length === 1 ? items[0] : items, null, 2), "复制JSON"));
  copyValue.addEventListener("click", () => copyText(copyValue, fullValue.textContent, "复制此值"));
  close.addEventListener("click", () => { detail.hidden = true; selected = null; lastWindow = ""; schedule(); });
  collapse.addEventListener("click", () => { expanded.clear(); rebuild(); });
  body.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(body);

  const executed = node.onExecuted;
  node.onExecuted = function (message) {
    const result = executed?.apply(this, arguments);
    if (Array.isArray(message?.liuxinyu_object_preview)) {
      items = message.liuxinyu_object_preview.flatMap((payload) => payload.items);
      expanded.clear();
      items.forEach((_, index) => expanded.add(String(index)));
      selected = null;
      detail.hidden = true;
      body.scrollTop = 0;
      summary.textContent = items.length === 1 ? `${kindOf(items[0])} · ${Object.keys(items[0]).length} 项` : `${items.length} 组结果`;
      copy.textContent = "复制JSON";
      copy.disabled = collapse.disabled = false;
      rebuild();
    }
    return result;
  };
  const removed = node.onRemoved;
  node.onRemoved = function (...args) {
    resize.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    return removed?.apply(this, args);
  };
  node.setSize([Math.max(420, node.size[0]), Math.max(340, node.size[1])]);
  fitPanel();
  schedule();
}

app.registerExtension({
  name: "liuxinyu.ObjectPreview",
  setup() {
    const style = document.createElement("style");
    style.textContent = `
      .liuxinyu-object-preview { display:flex; flex-direction:column; gap:6px; padding:8px; box-sizing:border-box; max-width:100%; min-width:0; height:100%; min-height:0; overflow:hidden; contain:inline-size; border-radius:6px; background:var(--comfy-input-bg,#222); color:var(--input-text,#ddd); font:13px sans-serif; }
      .liuxinyu-object-preview .lop-toolbar,.liuxinyu-object-preview .lop-detail-title { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .liuxinyu-object-preview .lop-toolbar > span,.liuxinyu-object-preview .lop-detail-title > span { flex:1; min-width:0; overflow-wrap:anywhere; }
      .liuxinyu-object-preview button { font:inherit; color:inherit; background:transparent; border:1px solid #555; border-radius:4px; padding:3px 6px; cursor:pointer; }
      .liuxinyu-object-preview button:disabled { opacity:.4; cursor:default; }
      .liuxinyu-object-preview .lop-body { flex:1; min-height:40px; min-width:0; overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable; overflow-anchor:none; }
      .liuxinyu-object-preview .lop-space { position:relative; }
      .liuxinyu-object-preview .lop-row { position:absolute; left:0; right:0; height:30px; display:flex; align-items:center; gap:6px; box-sizing:border-box; padding-right:5px; border-bottom:1px solid #ffffff0c; cursor:pointer; }
      .liuxinyu-object-preview .lop-row:hover,.liuxinyu-object-preview .lop-selected { background:#ffffff0d; }
      .liuxinyu-object-preview .lop-arrow { flex:none; width:16px; padding:0; border:0; }
      .liuxinyu-object-preview .lop-key { flex:0 1 36%; color:#b9d4f1; }
      .liuxinyu-object-preview .lop-value { flex:1; }
      .liuxinyu-object-preview .lop-key,.liuxinyu-object-preview .lop-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .liuxinyu-object-preview .lop-string { color:#b3d6a1; }
      .liuxinyu-object-preview .lop-number { color:#ebc88d; }
      .liuxinyu-object-preview .lop-boolean { color:#c9b3e8; }
      .liuxinyu-object-preview .lop-kind { flex:none; color:#999; font-size:10px; }
      .liuxinyu-object-preview .lop-detail { flex:none; min-width:0; max-height:45%; overflow:hidden; border-top:1px solid #555; padding-top:6px; display:flex; flex-direction:column; gap:4px; }
      .liuxinyu-object-preview .lop-detail[hidden] { display:none; }
      .liuxinyu-object-preview .lop-full-value { margin:0; min-height:0; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.5 sans-serif; user-select:text; }
      .liuxinyu-object-preview .lop-hint,.liuxinyu-object-preview .lop-empty { color:#999; font-size:11px; }
      .liuxinyu-object-preview .lop-empty { padding:8px; }
      .liuxinyu-object-preview .lop-body,.liuxinyu-object-preview .lop-full-value { scrollbar-width:auto; scrollbar-color:auto; }
      .liuxinyu-object-preview ::-webkit-scrollbar { width:5px; height:5px; }
      .liuxinyu-object-preview ::-webkit-scrollbar-track { background:transparent; }
      .liuxinyu-object-preview ::-webkit-scrollbar-thumb { background:#777; border:0; border-radius:999px; }
      .liuxinyu-object-preview ::-webkit-scrollbar-button { display:none; width:0; height:0; }
    `;
    document.head.append(style);
  },
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuPreviewJSObject") setupObjectPreview(node);
  },
});
