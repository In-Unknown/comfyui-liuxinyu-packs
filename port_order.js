import { app } from "../../scripts/app.js";

const PROPERTY = "liuxinyu_port_order";
const installed = new WeakSet();
const boundaryLayouts = new WeakSet();
const positionRestorers = new WeakMap();

function sharedGraph(node) {
  const graph = node.subgraph;
  return graph?.inputNode && graph?.outputNode ? graph : null;
}

function boundaryKey(node, side, entry) {
  const graph = sharedGraph(node);
  if (!graph) return undefined;
  const slot = entry.slot._subgraphSlot || graph[side]?.[entry.index];
  return entries(graph, side).find(item => item.slot === slot)?.key;
}

function preference(node, side) {
  const graph = sharedGraph(node);
  const record = graph?.extra?.[PROPERTY];
  if (!record || !(side in record)) return node.properties?.[PROPERTY]?.[side];
  const shared = record[side];
  if (!Array.isArray(shared)) return undefined;
  const keys = new Map(entries(node, side).map(entry => [boundaryKey(node, side, entry), entry.key]));
  return shared.map(key => keys.get(key)).filter(key => key !== undefined);
}

export function subgraphOrderHosts(graph) {
  const hosts = [];
  const visited = new Set();
  const visit = current => {
    if (!current || visited.has(current)) return;
    visited.add(current);
    for (const node of current._nodes || []) {
      if (node.subgraph === graph) hosts.push(node);
      if (node.subgraph) visit(node.subgraph);
    }
  };
  visit(graph.rootGraph || app.rootGraph);
  return hosts;
}

export function refreshSubgraphOrder(graph) {
  if (!graph) return;
  for (const panel of [graph.inputNode, graph.outputNode]) {
    installBoundaryLayout(panel);
    panel?.arrange();
  }
  for (const host of subgraphOrderHosts(graph)) {
    install(host);
    host.arrange();
  }
  graph.setDirtyCanvas?.(true, true);
}

// Also used by automatic layout; its trial/rollback saves the shared preference.
export function writePortOrder(node, value) {
  node.properties ||= {};
  if (value?.inputs || value?.outputs) node.properties[PROPERTY] = value;
  else delete node.properties[PROPERTY];
  const graph = sharedGraph(node);
  if (!graph) return;
  const shared = { version: 1 };
  for (const side of ["inputs", "outputs"]) {
    if (!Array.isArray(value?.[side])) { shared[side] = null; continue; }
    const keys = new Map(entries(node, side).map(entry => [entry.key, boundaryKey(node, side, entry)]));
    shared[side] = value[side].map(key => keys.get(key)).filter(key => key !== undefined);
  }
  graph.extra ||= {};
  // Explicit nulls reset native layout even if an instance has an old local
  // preference, without rewriting every instance's properties.
  graph.extra[PROPERTY] = shared;
  refreshSubgraphOrder(graph);
}

function installBoundaryLayout(target) {
  if (!target || typeof target.arrange !== "function" || boundaryLayouts.has(target.arrange)) return;
  const arrange = target.arrange;
  const wrapped = function (...args) {
    const result = arrange.apply(this, args);
    const graph = this.subgraph;
    const side = graph?.inputNode === this ? "inputs" : graph?.outputNode === this ? "outputs" : null;
    const order = graph?.extra?.[PROPERTY]?.[side];
    if (LiteGraph.vueNodesMode || !side || !Array.isArray(order) || !this.slots.length) return result;
    // Native layout establishes widths, anchors and heights. Shift entire rows
    // vertically, leaving the actual slot array and all connection indices alone.
    let y = Math.min(...this.slots.map(slot => slot.boundingRect[1]));
    for (const { slot } of ordered(graph, side, order)) {
      const delta = y - slot.boundingRect[1];
      slot.pos = [slot.pos[0], slot.pos[1] + delta];
      slot.boundingRect[1] = y;
      y += slot.boundingRect[3];
    }
    return result;
  };
  boundaryLayouts.add(wrapped);
  target.arrange = wrapped;
}

export function entries(node, side) {
  const counts = new Map();
  return (node[side] || []).map((slot, index) => {
    const identity = slot.id != null ? ["id", slot.id] : ["name", slot.name];
    const name = JSON.stringify(identity);
    const occurrence = counts.get(name) || 0;
    counts.set(name, occurrence + 1);
    return { slot, index, key: JSON.stringify([...identity, occurrence]) };
  });
}

function ordered(node, side, order = preference(node, side)) {
  const remaining = new Map(entries(node, side).map(entry => [entry.key, entry]));
  const result = [];
  for (const key of order || []) {
    if (remaining.has(key)) {
      result.push(remaining.get(key));
      remaining.delete(key);
    }
  }
  return [...result, ...remaining.values()];
}

function active(node, side) {
  return !LiteGraph.vueNodesMode && !node.flags?.collapsed &&
    node[side]?.length > 0 &&
    Array.isArray(preference(node, side));
}

// A socket may anchor to a separate header while its named widget is an editor.
// Both belong to the same visual input row; hidden editors leave just the header.
export function inputWidgetGroup(node, slot, widgets = node.getLayoutWidgets?.() || []) {
  const name = typeof slot.widget === "string" ? slot.widget : slot.widget?.name;
  const editor = (node.widgets || widgets).find(widget => widget.name === name);
  const members = new Set([slot._widget, editor].filter(Boolean));
  // Native auxiliary controls (e.g. seed actions) and explicitly attached
  // picker buttons travel with their owner, never with unrelated input rows.
  for (const widget of members) {
    for (const linked of widget.linkedWidgets || []) {
      if (!node.inputs?.some(input => input !== slot && input.widget?.name === linked.name)) members.add(linked);
    }
  }
  return widgets.filter(widget => members.has(widget) ||
    (widget.liuxinyuInputName != null && widget.liuxinyuInputName === slot.name));
}

export function widgetLayoutHeight(widget) {
  return Math.max(0, widget.computedHeight ?? LiteGraph.NODE_WIDGET_HEIGHT + 4);
}

export function inputLayoutTop(node) {
  const height = LiteGraph.NODE_SLOT_HEIGHT;
  return Math.min((node.constructor.slot_start_y || 0) + height * 0.2,
    ...entries(node, "inputs").map(entry => node.getInputPos(entry.index)[1] - node.pos[1] - height / 2));
}

// Dynamic lanes may be renumbered after an empty middle lane is removed.
// Preserve each surviving slot's visual identity across that name change.
export function preservePortOrder(node, change) {
  const saved = {};
  for (const side of ["inputs", "outputs"]) {
    if (Array.isArray(preference(node, side))) saved[side] = ordered(node, side).map(entry => entry.slot);
  }
  positionRestorers.get(node)?.();
  try { return change(); }
  finally {
    positionRestorers.get(node)?.();
    if (Object.keys(saved).length) {
      const value = { ...node.properties?.[PROPERTY], version: 1 };
      for (const [side, slots] of Object.entries(saved)) {
        const keys = new Map(entries(node, side).map(entry => [entry.slot, entry.key]));
        value[side] = slots.filter(slot => keys.has(slot)).map(slot => keys.get(slot));
      }
      writePortOrder(node, value);
    }
  }
}

function applyOrder(node, draft) {
  const value = { version: 1 };
  for (const side of ["inputs", "outputs"]) {
    if (Array.isArray(draft[side])) value[side] = [...draft[side]];
  }
  node.graph?.beforeChange();
  try {
    writePortOrder(node, value);
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
  if (!pointerOnCanvas || !canvas || LiteGraph.vueNodesMode || canvas.read_only ||
      canvas.pointer?.isDown || canvas.linkConnector?.isConnecting) return null;
  for (const [panel, side] of [[canvas.graph?.inputNode, "inputs"], [canvas.graph?.outputNode, "outputs"]]) {
    if (!panel || !canvas.graph_mouse || panel.slots.length < 2) continue;
    installBoundaryLayout(panel);
    const slot = panel.getSlotInPosition(...canvas.graph_mouse);
    const index = panel.slots.indexOf(slot);
    if (index >= 0) return { node: canvas.graph, panel, side, index };
  }
  const node = canvas?.node_over;
  if (node) install(node);
  if (!node || !installed.has(node) ||
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
  hint.textContent = `${slot.label || slot.localized_name || slot.name || "端口"}：↑ / ↓ 与相邻端口交换${target.panel || sharedGraph(node) ? "（子图内外同步）" : ""}`;
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
  const { node, panel, side, index } = target;
  const getPosition = side === "inputs" ? "getInputPos" : "getOutputPos";
  const list = entries(node, side).sort((a, b) =>
    (panel ? a.slot.pos[1] - b.slot.pos[1] :
      node[getPosition](a.index)[1] - node[getPosition](b.index)[1]) || a.index - b.index);
  const row = list.findIndex(entry => entry.index === index);
  const next = row + (event.key === "ArrowUp" ? -1 : 1);
  if (next < 0 || next >= list.length) return;
  [list[row], list[next]] = [list[next], list[row]];
  if (panel) {
    node.beforeChange();
    try {
      node.extra ||= {};
      node.extra[PROPERTY] = { ...node.extra[PROPERTY], version: 1, [side]: list.map(entry => entry.key) };
      refreshSubgraphOrder(node);
      node.change();
    } finally { node.afterChange(); }
    const [canvasX, canvasY] = app.canvas.graph_mouse;
    panel.onPointerMove({ canvasX, canvasY });
    refreshHint();
    return;
  }
  const draft = {};
  for (const current of ["inputs", "outputs"]) {
    const order = preference(node, current);
    if (Array.isArray(order)) draft[current] = order;
  }
  draft[side] = list.map(entry => entry.key);
  applyOrder(node, draft);
  // The mouse has not moved, but a different socket can now occupy this row.
  node.mouseOver.inputId = node.inputs.indexOf(node.getInputOnPos(app.canvas.graph_mouse));
  node.mouseOver.outputId = node.outputs.indexOf(node.getOutputOnPos(app.canvas.graph_mouse));
  refreshHint();
}

function setupKeyboard() {
  installBoundaryLayout(LiteGraph.Classes?.SubgraphIONodeBase?.prototype);
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
  const subgraph = sharedGraph(node);
  if (subgraph) {
    installBoundaryLayout(subgraph.inputNode);
    installBoundaryLayout(subgraph.outputNode);
  }
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
    const surviving = new Set(current.values());
    for (const [key, { slot, original, visual }] of positions) {
      // LiteGraph can replace a plain dynamic slot with a concrete slot instance.
      for (const candidate of surviving.has(slot) ? [slot] : [slot, current.get(key)]) {
        if (candidate?.pos?.[0] === visual[0] && candidate.pos[1] === visual[1]) candidate.pos = original;
      }
    }
    positions.clear();
  };
  positionRestorers.set(node, () => { restore(); restoreWidths(); });
  const arrange = node.arrange;
  node.arrange = function (...args) {
    if (arranging) return;
    arranging = true;
    try {
      // Configure callbacks run before the first native measurement. Its cached
      // concrete slots can still be empty (or belong to the old configuration).
      // Otherwise native layout gives their space to flexible widgets and our
      // reordered rows add that same height a second time on every early pass.
      if (active(this, "inputs") || active(this, "outputs")) this._setConcreteSlots?.();
      restore();
      restoreWidths();
      const result = arrange.apply(this, args);
      const height = LiteGraph.NODE_SLOT_HEIGHT;
      const place = (entry, side, y) => {
        const { slot, index, key } = entry;
        const input = side === "inputs";
        const visual = [input ? height / 2 : this.size[0] + 1 - height / 2, y];
        positions.set(`${side}:${key}`, { slot, original: slot.pos, visual });
        slot.pos = visual;
        this._measureSlot(slot, index, input);
      };
      const arrangeOutputs = () => {
        // Compound widgets can align their native output rows to the final headers.
        this.onPortOrderInputLayout?.();
        if (!active(this, "outputs")) return;
        const rows = entries(this, "outputs").map(entry => this.getOutputPos(entry.index)[1] - this.pos[1]).sort((a, b) => a - b);
        ordered(this, "outputs").forEach((entry, row) => place(entry, "outputs", rows[row]));
      };
      if (active(this, "inputs")) {
        const widgets = this.getLayoutWidgets();
        const moved = new Set();
        const widgetHeight = widgetLayoutHeight;
        const moveWidget = (widget, y) => {
          widget.y = y;
          if (widget.last_y !== undefined) widget.last_y = y;
          moved.add(widget);
        };
        // Some nodes reserve ordinary socket rows below a leading widget.
        // Its original top row must remain available when exchanging them.
        let top = inputLayoutTop(this);
        for (const entry of ordered(this, "inputs")) {
          const group = inputWidgetGroup(this, entry.slot, widgets).filter(widget => !moved.has(widget));
          const centre = top + height / 2;
          let rowHeight = 0;
          for (const widget of group) {
            moveWidget(widget, top + rowHeight);
            rowHeight += widgetHeight(widget);
          }
          top += Math.max(height, rowHeight);
          place(entry, "inputs", centre);
        }
        arrangeOutputs();
        // Controls without a socket follow the input rows in their native order.
        const outputBottom = Math.max(0, ...(this.outputs || []).map((slot, i) =>
          this.getOutputPos(i)[1] - this.pos[1] + height / 2));
        top = Math.max(top, outputBottom + 2);
        for (const widget of widgets) {
          if (moved.has(widget)) continue;
          moveWidget(widget, top);
          top += widgetHeight(widget);
        }
        if (top > this.size[1]) this.setSize([this.size[0], top]);
      } else arrangeOutputs();
      if (active(this, "inputs") || active(this, "outputs")) {
        // Either side can move a different output label beside a control.
        // Keep the native output readable instead of painting the control over it.
        for (const widget of this.getLayoutWidgets()) {
          let reserve = 0;
          const drawnHeight = Math.max(0, widgetLayoutHeight(widget) - (widget.computeSize ? 4 : 0));
          for (const [index, slot] of (this.outputs || []).entries()) {
            const y = this.getOutputPos(index)[1] - this.pos[1];
            // computeSize widgets include four pixels of native spacing.
            // A label touching that gap does not overlap the drawn control.
            if (drawnHeight === 0 || y + height / 2 <= widget.y || y - height / 2 >= widget.y + drawnHeight) continue;
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
      if (this.graph && (this.properties?.[PROPERTY] || sharedGraph(this)?.extra?.[PROPERTY])) {
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
  installBoundaryLayout(graph.inputNode);
  installBoundaryLayout(graph.outputNode);
  for (const node of graph._nodes || []) {
    install(node);
    if (node.subgraph) installGraph(node.subgraph, visited);
    if (installed.has(node) && (preference(node, "inputs") || preference(node, "outputs"))) node.arrange();
  }
  graph.inputNode?.arrange();
  graph.outputNode?.arrange();
}

app.registerExtension({
  name: "liuxinyu.PortOrder",
  setup: setupKeyboard,
  nodeCreated: install,
  afterConfigureGraph() { installGraph(app.rootGraph); },
});
