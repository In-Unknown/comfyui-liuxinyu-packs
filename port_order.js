import { app } from "../../scripts/app.js";

const PROPERTY = "liuxinyu_port_order";
const installed = new WeakSet();

function entries(node, side) {
  const counts = new Map();
  return (node[side] || []).map((slot, index) => {
    const identity = slot.id != null ? ["id", slot.id] : ["name", slot.name];
    const name = JSON.stringify(identity);
    const occurrence = counts.get(name) || 0;
    counts.set(name, occurrence + 1);
    return { slot, index, key: JSON.stringify([...identity, occurrence]) };
  });
}

function ordered(node, side, preference = node.properties?.[PROPERTY]?.[side]) {
  const remaining = new Map(entries(node, side).map(entry => [entry.key, entry]));
  const result = [];
  for (const key of preference || []) {
    if (remaining.has(key)) {
      result.push(remaining.get(key));
      remaining.delete(key);
    }
  }
  return [...result, ...remaining.values()];
}

function active(node, side) {
  return !LiteGraph.vueNodesMode && !node.flags?.collapsed &&
    Array.isArray(node.properties?.[PROPERTY]?.[side]);
}

function applyOrder(node, draft) {
  const value = { version: 1 };
  for (const side of ["inputs", "outputs"]) {
    if (Array.isArray(draft[side])) value[side] = [...draft[side]];
  }
  node.graph?.beforeChange();
  try {
    node.properties ||= {};
    if (value.inputs || value.outputs) node.properties[PROPERTY] = value;
    else delete node.properties[PROPERTY];
    node.arrange();
    node.graph?.change();
    node.setDirtyCanvas(true, true);
  } finally {
    node.graph?.afterChange();
  }
}

let pointerOnCanvas = false;
let pointerPosition = [0, 0];
let hint;
let hintFrame;

function hoveredPort() {
  const canvas = app.canvas;
  const node = canvas?.node_over;
  if (!pointerOnCanvas || LiteGraph.vueNodesMode || !node || !installed.has(node) ||
      node.flags?.collapsed || canvas.read_only || canvas.pointer?.isDown ||
      canvas.linkConnector?.isConnecting || canvas.graph !== node.graph ||
      canvas.selected_nodes?.[node.id] !== node) return null;
  // Native highlighting includes the port label, not just the socket's 20px box.
  for (const [side, field] of [["inputs", "inputId"], ["outputs", "outputId"]]) {
    const index = node.mouseOver?.[field];
    if (Number.isInteger(index) && index >= 0 && node[side]?.[index] && node[side].length > 1) {
      return { node, side, index };
    }
  }
  return null;
}

function refreshHint() {
  if (!hint) return;
  const target = hoveredPort();
  hint.hidden = !target;
  if (!target) return;
  const { node, side, index } = target;
  const slot = node[side][index];
  hint.textContent = `${slot.label || slot.localized_name || slot.name || "端口"}：↑ / ↓ 与相邻端口交换`;
  hint.style.left = `${Math.max(0, Math.min(pointerPosition[0] + 16, window.innerWidth - hint.offsetWidth - 8))}px`;
  hint.style.top = `${Math.max(0, Math.min(pointerPosition[1] + 18, window.innerHeight - hint.offsetHeight - 8))}px`;
}

function onPortKeyDown(event) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
  if (event.composedPath().some(element => element.isContentEditable ||
      element.matches?.('input, textarea, select, [role="textbox"], dialog, [role="dialog"]'))) return;
  const target = hoveredPort();
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  // One press is one swap; key-repeat at a stationary pointer would swap back.
  if (event.repeat) return;
  const { node, side, index } = target;
  const getPosition = side === "inputs" ? "getInputPos" : "getOutputPos";
  const list = entries(node, side).sort((a, b) =>
    node[getPosition](a.index)[1] - node[getPosition](b.index)[1] || a.index - b.index);
  const row = list.findIndex(entry => entry.index === index);
  const next = row + (event.key === "ArrowUp" ? -1 : 1);
  if (next < 0 || next >= list.length) return;
  [list[row], list[next]] = [list[next], list[row]];
  const draft = { ...node.properties?.[PROPERTY] };
  draft[side] = list.map(entry => entry.key);
  applyOrder(node, draft);
  // The mouse has not moved, but a different socket can now occupy this row.
  node.mouseOver.inputId = node.inputs.indexOf(node.getInputOnPos(app.canvas.graph_mouse));
  node.mouseOver.outputId = node.outputs.indexOf(node.getOutputOnPos(app.canvas.graph_mouse));
  refreshHint();
}

function setupKeyboard() {
  hint = document.createElement("div");
  hint.hidden = true;
  hint.setAttribute("role", "tooltip");
  hint.style.cssText = "position:fixed;z-index:10000;pointer-events:none;padding:6px 9px;border:1px solid #666;border-radius:5px;background:#252525;color:#eee;font:12px sans-serif;max-width:calc(100vw - 20px);overflow-wrap:anywhere";
  document.body.append(hint);
  const scheduleHint = () => {
    if (hintFrame) cancelAnimationFrame(hintFrame);
    hintFrame = requestAnimationFrame(() => { hintFrame = undefined; refreshHint(); });
  };
  window.addEventListener("pointermove", event => {
    pointerOnCanvas = event.composedPath().includes(app.canvas?.canvas);
    pointerPosition = [event.clientX, event.clientY];
    scheduleHint();
  }, true);
  window.addEventListener("pointerup", scheduleHint, true);
  window.addEventListener("blur", () => { pointerOnCanvas = false; refreshHint(); });
  window.addEventListener("pointerout", event => {
    if (!event.relatedTarget) { pointerOnCanvas = false; refreshHint(); }
  }, true);
  window.addEventListener("pointerdown", () => { hint.hidden = true; }, true);
  window.addEventListener("keydown", onPortKeyDown, true);
}

function install(node) {
  if (installed.has(node) || typeof node.arrange !== "function" ||
      typeof node._measureSlot !== "function" || typeof node.serializeFromStoreState !== "function") return;
  installed.add(node);
  // Native slot indices remain untouched. Only transient canvas positions change.
  const positions = new Map();
  const widths = new Map();
  const restoreWidths = () => {
    for (const [widget, { original, visual }] of widths) {
      if (widget.width === visual) widget.width = original;
    }
    widths.clear();
  };
  let arranging = false;
  const restore = () => {
    if (!positions.size) return;
    const current = new Map(["inputs", "outputs"].flatMap(side =>
      entries(node, side).map(entry => [`${side}:${entry.key}`, entry.slot])));
    for (const [key, { slot, original, visual }] of positions) {
      // LiteGraph can replace a plain dynamic slot with a concrete slot instance.
      for (const candidate of new Set([slot, current.get(key)])) {
        if (candidate?.pos?.[0] === visual[0] && candidate.pos[1] === visual[1]) candidate.pos = original;
      }
    }
    positions.clear();
  };
  const arrange = node.arrange;
  node.arrange = function (...args) {
    if (arranging) return;
    arranging = true;
    try {
      restore();
      restoreWidths();
      const result = arrange.apply(this, args);
      const height = LiteGraph.NODE_SLOT_HEIGHT;
      const startY = this.constructor.slot_start_y || 0;
      const place = (entry, side, y) => {
        const { slot, index, key } = entry;
        const input = side === "inputs";
        const visual = [input ? height / 2 : this.size[0] + 1 - height / 2, y];
        positions.set(`${side}:${key}`, { slot, original: slot.pos, visual });
        slot.pos = visual;
        this._measureSlot(slot, index, input);
      };
      if (active(this, "outputs")) {
        ordered(this, "outputs").forEach((entry, row) => place(entry, "outputs", startY + (row + 0.7) * height));
      }
      if (active(this, "inputs")) {
        const widgets = this.getLayoutWidgets();
        const byName = new Map(widgets.map(widget => [widget.name, widget]));
        const moved = new Set();
        const widgetHeight = widget => Math.max(height, widget.computedHeight ?? LiteGraph.NODE_WIDGET_HEIGHT + 4);
        const moveWidget = (widget, y) => {
          widget.y = y;
          if (widget.last_y !== undefined) widget.last_y = y;
          moved.add(widget);
        };
        let top = startY + height * 0.2;
        for (const entry of ordered(this, "inputs")) {
          const widget = entry.slot.widget && byName.get(entry.slot.widget.name);
          const centre = top + height / 2;
          if (widget && !moved.has(widget)) {
            moveWidget(widget, top);
            top += widgetHeight(widget);
          } else {
            top += height;
          }
          place(entry, "inputs", centre);
        }
        // Controls without a socket follow the input rows in their native order.
        const outputBottom = Math.max(0, ...(this.outputs || []).map((slot, i) =>
          this.getOutputPos(i)[1] - this.pos[1] + height / 2));
        top = Math.max(top, outputBottom + 2);
        for (const widget of widgets) {
          if (moved.has(widget)) continue;
          moveWidget(widget, top);
          top += widgetHeight(widget);
        }
        // A moved control can now share a row with an output label.
        // Keep the native output readable instead of painting the control over it.
        for (const widget of moved) {
          let reserve = 0;
          for (const [index, slot] of (this.outputs || []).entries()) {
            const y = this.getOutputPos(index)[1] - this.pos[1];
            if (y + height / 2 < widget.y || y - height / 2 > widget.y + widgetHeight(widget)) continue;
            const label = slot.label || slot.localized_name || slot.name || "";
            const ctx = app.canvas?.ctx;
            let labelWidth = label.length * 14;
            if (ctx) {
              const font = ctx.font;
              try {
                ctx.font = app.canvas.inner_text_font || "14px sans-serif";
                labelWidth = ctx.measureText(label).width;
              } finally { ctx.font = font; }
            }
            reserve = Math.max(reserve, labelWidth + 30);
          }
          if (reserve) {
            const original = widget.width;
            const visual = Math.min(original || this.size[0], Math.max(80, this.size[0] - reserve));
            widths.set(widget, { original, visual });
            widget.width = visual;
          }
        }
        if (top > this.size[1]) this.setSize([this.size[0], top]);
      }
      return result;
    } finally {
      arranging = false;
    }
  };
  const serialize = node.serializeFromStoreState;
  node.serializeFromStoreState = function (...args) {
    // Also covers undo snapshots, which call this method without serialize().
    const savedPositions = new Map(positions);
    restore();
    try {
      return serialize.apply(this, args);
    } finally {
      // Serialization must not run layout or resize nodes as a side effect.
      const current = savedPositions.size ? new Map(["inputs", "outputs"].flatMap(side =>
        entries(this, side).map(entry => [`${side}:${entry.key}`, entry.slot]))) : new Map();
      for (const [key, state] of savedPositions) {
        const slot = current.get(key);
        if (slot && slot.pos === state.original) {
          slot.pos = state.visual;
          positions.set(key, { ...state, slot });
        }
      }
    }
  };
  const configure = node.onConfigure;
  node.onConfigure = function (...args) {
    restore();
    restoreWidths();
    const result = configure?.apply(this, args);
    queueMicrotask(() => {
      if (this.graph && this.properties?.[PROPERTY]) {
        this.arrange();
        this.setDirtyCanvas(true, true);
      }
    });
    return result;
  };

}

function installGraph(graph, visited = new Set()) {
  if (!graph || visited.has(graph)) return;
  visited.add(graph);
  for (const node of graph._nodes || []) {
    install(node);
    if (node.subgraph) installGraph(node.subgraph, visited);
  }
}

app.registerExtension({
  name: "liuxinyu.PortOrder",
  setup: setupKeyboard,
  nodeCreated: install,
  afterConfigureGraph() { installGraph(app.rootGraph); },
});
