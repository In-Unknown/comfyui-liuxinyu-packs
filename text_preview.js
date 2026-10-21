import { app } from "../../scripts/app.js";

function setupPreview(node) {
  let items = null;
  let columns = [];
  let parameters = false;
  let pendingFrame = null;
  let viewport = null;
  let header = null;
  let rows = null;
  let lastWindow = "";
  let layoutWidth = -1;
  let columnWidth = 0;
  let indexWidth = 0;
  let headerHeight = 0;
  let offsets = [];
  const measure = document.createElement("canvas").getContext("2d");
  const panel = document.createElement("div");
  panel.className = "liuxinyu-text-preview";
  for (const event of ["pointerdown", "keydown"]) {
    panel.addEventListener(event, (e) => e.stopPropagation());
  }
  const toolbar = document.createElement("div");
  toolbar.className = "ltp-toolbar";
  const summary = document.createElement("span");
  summary.style.flex = "1";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "复制全部";
  copy.disabled = true;
  copy.addEventListener("click", async () => {
    if (items === null) return;
    const value = items.length === 1 && typeof items[0] === "string"
      ? items[0] : JSON.stringify(items, null, 2);
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = "已复制";
    } catch {
      copy.textContent = "复制失败，请选中文本复制";
    }
  });
  toolbar.append(summary, copy);
  const body = document.createElement("div");
  body.className = "ltp-body";
  panel.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.ctrlKey) {
      const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? body.clientHeight : 1;
      body.scrollTop += (event.deltaY || event.deltaX) * unit;
    } else {
      // DOM widgets overlay the canvas, so forward the wheel to its native handler.
      app.canvas.canvas.dispatchEvent(new WheelEvent("wheel", {
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
        deltaMode: event.deltaMode, clientX: event.clientX, clientY: event.clientY,
        ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey,
        bubbles: true, cancelable: true,
      }));
    }
  }, { passive: false });
  const hint = document.createElement("div");
  hint.className = "ltp-hint";
  hint.textContent = "滚轮滚动表格；Ctrl + 滚轮缩放画布。";
  panel.append(toolbar, body, hint);

  function fitPanel() {
    const width = `${Math.max(0, node.size[0] - 20)}px`;
    if (panel.style.width !== width) panel.style.width = width;
  }
  const widget = node.addDOMWidget("text_preview", "custom", panel, {
    hideOnZoom: false, getMinHeight: () => 120,
    onDraw: fitPanel, afterResize: fitPanel,
  });
  widget.serialize = false;

  function cell(parent, value, x, y, width, height, isHeader = false) {
    const element = document.createElement("div");
    element.className = "ltp-cell" + (isHeader ? " ltp-heading" : "");
    element.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px;`;
    const text = document.createElement("span");
    text.textContent = value === "" && !isHeader ? "（空字符串）" : String(value ?? "");
    element.append(text);
    if (value === "" && !isHeader) element.classList.add("ltp-empty");
    if (!isHeader) element.tabIndex = 0;
    parent.append(element);
  }

  function layout() {
    const width = body.clientWidth;
    if (width === layoutWidth) return;
    layoutWidth = width;
    indexWidth = Math.min(44, width * 0.12);
    columnWidth = Math.max(1, (width - indexWidth) / Math.max(1, columns.length));
    const fontSize = Math.max(1, Math.min(13, columnWidth / 7));
    const padding = Math.min(5, columnWidth * 0.04);
    const lineHeight = fontSize * 1.5;
    headerHeight = Math.ceil(lineHeight + 9);
    viewport.style.setProperty("--ltp-font", `${fontSize}px`);
    viewport.style.setProperty("--ltp-padding", `${padding}px`);
    header.style.height = `${headerHeight}px`;
    measure.font = `${fontSize}px sans-serif`;
    const heights = new Map();
    const glyphWidths = new Map();
    function textHeight(value, available) {
      const text = value === "" ? "（空字符串）" : String(value ?? "");
      const key = `${available}:${text}`;
      if (heights.has(key)) return heights.get(key);
      let lines = 0;
      for (const paragraph of text.replace(/\t/g, "    ").split(/\r\n|\r|\n/)) {
        lines++;
        let used = 0;
        for (const character of paragraph) {
          if (!glyphWidths.has(character)) glyphWidths.set(character, measure.measureText(character).width);
          const size = glyphWidths.get(character);
          if (used > 0 && used + size > available) { lines++; used = 0; }
          used += size;
        }
      }
      const height = Math.ceil(lines * lineHeight + 9);
      heights.set(key, height);
      return height;
    }
    offsets = [headerHeight];
    for (let i = 0; i < items.length; i++) {
      let height = textHeight(parameters ? i + 1 : i, Math.max(1, indexWidth - 2 * padding - 2));
      for (const name of columns) {
        height = Math.max(height, textHeight(parameters ? items[i][name] : items[i],
          Math.max(1, columnWidth - 2 * padding - 2)));
      }
      offsets.push(offsets[i] + height);
    }
    viewport.style.height = `${offsets.at(-1)}px`;
    lastWindow = "";
  }

  function rowAt(y) {
    let low = 0, high = items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid + 1] <= y) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function drawWindow() {
    pendingFrame = null;
    if (!viewport || !rows) return;
    layout();
    const firstRow = Math.max(0, rowAt(body.scrollTop) - 3);
    const endRow = Math.min(items.length, rowAt(body.scrollTop + body.clientHeight) + 4);
    const windowKey = `${firstRow}:${endRow}:${layoutWidth}`;
    if (windowKey === lastWindow) return;
    lastWindow = windowKey;
    header.replaceChildren();
    rows.replaceChildren();
    cell(header, parameters ? "序号" : "下标", 0, 0, indexWidth, headerHeight, true);
    for (let col = 0; col < columns.length; col++) {
      cell(header, columns[col], indexWidth + col * columnWidth, 0, columnWidth, headerHeight, true);
    }
    for (let index = firstRow; index < endRow; index++) {
      const top = offsets[index];
      const height = offsets[index + 1] - top;
      cell(rows, parameters ? index + 1 : index, 0, top, indexWidth, height);
      for (let col = 0; col < columns.length; col++) {
        cell(rows, parameters ? items[index][columns[col]] : items[index],
          indexWidth + col * columnWidth, top, columnWidth, height);
      }
    }
  }
  function scheduleDraw() {
    if (pendingFrame === null) pendingFrame = requestAnimationFrame(drawWindow);
  }
  body.addEventListener("scroll", scheduleDraw, { passive: true });
  const resize = new ResizeObserver(scheduleDraw);
  resize.observe(body);

  function render() {
    body.replaceChildren();
    body.scrollTop = body.scrollLeft = 0;
    viewport = header = rows = null;
    lastWindow = "";
    layoutWidth = -1;
    copy.textContent = "复制全部";
    copy.disabled = items === null;
    hint.hidden = true;
    if (items === null) {
      summary.textContent = "等待运行";
      body.textContent = "连接参数组合、字符串数组或字符串，运行后在这里查看。";
      return;
    }
    parameters = items.length > 0 && items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    const singleText = items.length === 1 && typeof items[0] === "string";
    summary.textContent = parameters ? `参数组合 · 共 ${items.length} 组`
      : singleText ? `字符串 · ${items[0].split(/\r\n|\r|\n/).length} 行`
      : `字符串数组 · 共 ${items.length} 项 · 下标从 0 开始`;
    if (!items.length) {
      body.textContent = "没有条目（输入列表为空）。";
      return;
    }
    const names = new Set();
    if (parameters) for (const item of items) for (const name of Object.keys(item)) names.add(name);
    columns = parameters ? [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : ["字符串"];
    viewport = document.createElement("div");
    viewport.className = "ltp-viewport";
    header = document.createElement("div");
    header.className = "ltp-header";
    rows = document.createElement("div");
    viewport.append(header, rows);
    body.append(viewport);
    hint.hidden = false;
    scheduleDraw();
  }
  const executed = node.onExecuted;
  node.onExecuted = function (message) {
    const result = executed?.apply(this, arguments);
    if (Array.isArray(message?.liuxinyu_preview)) {
      items = message.liuxinyu_preview.flatMap((payload) => payload.items);
      render();
    }
    return result;
  };
  const removed = node.onRemoved;
  node.onRemoved = function (...args) {
    resize.disconnect();
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    return removed?.apply(this, args);
  };
  node.setSize([Math.max(node.size[0], 480), Math.max(node.size[1], 340)]);
  fitPanel();
  render();
}

app.registerExtension({
  name: "liuxinyu.TextPreview",
  setup() {
    const style = document.createElement("style");
    style.textContent = `
      .liuxinyu-text-preview { display:flex; flex-direction:column; gap:8px; padding:10px; box-sizing:border-box; width:100%; max-width:100%; min-width:0; height:100%; min-height:0; overflow:hidden; contain:inline-size; color:var(--input-text,#ddd); background:var(--comfy-input-bg,#222); border-radius:6px; font:13px sans-serif; }
      .liuxinyu-text-preview .ltp-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; flex:none; min-width:0; overflow-wrap:anywhere; }
      .liuxinyu-text-preview .ltp-toolbar > span { min-width:0; }
      .liuxinyu-text-preview .ltp-body { flex:1; min-width:0; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable; overflow-wrap:anywhere; user-select:text; overflow-anchor:none; }
      .liuxinyu-text-preview .ltp-body { scrollbar-width:auto; scrollbar-color:auto; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar { width:5px; height:5px; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar-track { background:transparent; border:0; box-shadow:none; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar-thumb { background:#777; border:0; border-radius:999px; min-height:24px; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar-thumb:hover { background:#aaa; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar-button { display:none; width:0; height:0; }
      .liuxinyu-text-preview .ltp-body::-webkit-scrollbar-corner { background:transparent; }
      .liuxinyu-text-preview button { font:inherit; color:inherit; background:var(--comfy-menu-bg,#333); border:1px solid #666; border-radius:4px; padding:4px 8px; cursor:pointer; }
      .liuxinyu-text-preview button:disabled { opacity:.4; cursor:default; }
      .liuxinyu-text-preview .ltp-viewport { position:relative; width:100%; }
      .liuxinyu-text-preview .ltp-header { position:sticky; top:0; z-index:2; background:var(--comfy-menu-bg,#333); }
      .liuxinyu-text-preview .ltp-cell { position:absolute; display:flex; align-items:center; justify-content:center; text-align:center; box-sizing:border-box; padding:4px var(--ltp-padding); border-bottom:1px solid #484848; border-right:1px solid #484848; overflow:hidden; font:var(--ltp-font)/1.5 sans-serif; }
      .liuxinyu-text-preview .ltp-cell > span { min-width:0; max-width:100%; white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere; tab-size:4; }
      .liuxinyu-text-preview .ltp-heading { font-weight:bold; overflow:hidden; }
      .liuxinyu-text-preview .ltp-empty,.liuxinyu-text-preview .ltp-hint { color:#999; }
      .liuxinyu-text-preview .ltp-hint { flex:none; font-size:11px; }
    `;
    document.head.append(style);
  },
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuPreviewText") setupPreview(node);
  },
});
