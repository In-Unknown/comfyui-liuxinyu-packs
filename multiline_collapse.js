import { app } from "../../scripts/app.js";

const installed = new WeakMap();

function supportsCollapse(node) {
  const type = node?.comfyClass || node?.type || "";
  return type.startsWith("Liuxinyu") || type === "RunCmd" ||
    type === "llm_remote_reply" || type.startsWith("LLMHarness") || !!node?.subgraph;
}

function widgetForInput(node, input) {
  const name = typeof input?.widget === "string" ? input.widget : input?.widget?.name;
  return (name && node.widgets?.find(widget => widget.name === name)) || node.getWidgetFromSlot?.(input);
}

function isMultiline(widget) {
  const tag = widget?.element?.tagName || widget?.element?.nodeName;
  return widget?.options?.multiline === true || tag === "TEXTAREA" || widget?.type === "customtext";
}

function setup(node) {
  if (!supportsCollapse(node) || installed.has(node)) return installed.get(node);
  const state = { entries: new Map(), resize: false, arranging: false, queued: false };
  installed.set(node, state);
  const rowHeight = globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;

  function refresh() {
    const current = new Set();
    for (const [index, input] of (node.inputs || []).entries()) {
      const widget = widgetForInput(node, input);
      if (!isMultiline(widget)) continue;
      current.add(widget);
      let entry = state.entries.get(widget);
      if (!entry) {
        entry = { widget, collapsed: false, compact: false };
        state.entries.set(widget, entry);
        const layout = widget.computeLayoutSize;
        const size = widget.computeSize;
        if (layout) widget.computeLayoutSize = function (...args) {
          return entry.collapsed ? { minHeight: entry.compact ? rowHeight : 0,
            maxHeight: entry.compact ? rowHeight : 0, minWidth: 0 } : layout.apply(this, args);
        };
        if (size) widget.computeSize = function (...args) {
          return entry.collapsed ? [0, (entry.compact ? rowHeight : 0) - 4] : size.apply(this, args);
        };
        Object.defineProperty(widget, "_liuxinyuMultilineCollapsed", {
          configurable: true, get: () => entry.collapsed,
        });
      }
      // Configure/promoted widgets can replace either object. Resolve the current
      // slot each time instead of treating its array index as a permanent identity.
      const collapsed = !globalThis.LiteGraph?.vueNodesMode &&
        (node.isInputConnected ? node.isInputConnected(index) : input.link != null);
      // Dynamic text blocks already have a dedicated header/port row.
      const separateHeader = input._widget && input._widget !== widget && node.widgets?.includes(input._widget);
      const compact = collapsed && !separateHeader;
      if (entry.collapsed !== collapsed || entry.compact !== compact) state.resize = true;
      Object.assign(entry, { input, collapsed, compact });
      widget.hidden = collapsed;
      if (widget.element) {
        widget.element.hidden = collapsed;
        widget.element.readOnly = collapsed;
      }
    }
    for (const [widget, entry] of state.entries) {
      if (current.has(widget)) continue;
      if (entry.collapsed) state.resize = true;
      entry.collapsed = entry.compact = false;
      widget.hidden = false;
      if (widget.element) widget.element.hidden = widget.element.readOnly = false;
      state.entries.delete(widget);
    }
  }

  const layoutWidgets = node.getLayoutWidgets;
  node.getLayoutWidgets = function (...args) {
    const visible = layoutWidgets?.apply(this, args) || (this.widgets || []).filter(widget => !widget.hidden);
    const included = new Set(visible);
    // The editor stays hidden, but native layout assigns its socket a compact row
    // instead of retaining the old widget.y and leaving a gap or overlapping.
    const widgets = this.widgets || [];
    return [...widgets.filter(widget => included.has(widget) || state.entries.get(widget)?.compact),
      ...visible.filter(widget => !widgets.includes(widget))];
  };
  const computeSize = node.computeSize;
  if (computeSize) node.computeSize = function (...args) {
    refresh();
    const size = computeSize.apply(this, args);
    // Native computeSize ignores hidden widgets; include only their socket rows.
    size[1] += [...state.entries.values()].filter(entry => entry.compact).length * rowHeight;
    return size;
  };

  const arrange = node.arrange;
  node.arrange = function (...args) {
    if (state.arranging) return arrange?.apply(this, args);
    state.arranging = true;
    try {
      refresh();
      if (state.resize && this.graph && !this.flags?.collapsed) {
        state.resize = false;
        const minimum = this.computeSize();
        this.setSize([this.size[0], minimum[1]]);
      }
      return arrange?.apply(this, args);
    } finally { state.arranging = false; }
  };
  const drawSlots = node.drawSlots;
  if (drawSlots) node.drawSlots = function (ctx, options = {}) {
    const result = drawSlots.call(this, ctx, options);
    if (options.lowQuality || this.flags?.collapsed) return result;
    ctx.save();
    ctx.textAlign = "left";
    for (const entry of state.entries.values()) {
      if (!entry.compact) continue;
      const index = this.inputs.indexOf(entry.input);
      if (index < 0) continue;
      const [x, y] = this.getInputPos(index);
      ctx.fillStyle = this.mouseOver?.inputId === index ? "#fff" : (globalThis.LiteGraph?.NODE_TEXT_COLOR || "#aaa");
      ctx.fillText(entry.input.label || entry.input.localized_name || entry.input.name,
        x - this.pos[0] + 10, y - this.pos[1] + 5);
    }
    ctx.restore();
    return result;
  };

  function sync(force = false) {
    refresh();
    if (!node.graph) return;
    if (force && [...state.entries.values()].some(entry => entry.collapsed)) state.resize = true;
    const minimum = node.computeSize();
    if (node.size[1] < minimum[1]) state.resize = true;
    node.arrange();
    node.setDirtyCanvas?.(true, true);
  }
  function schedule(force = false) {
    state.force ||= force;
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      const force = state.force;
      state.force = false;
      sync(force);
    });
  }
  for (const callback of ["onConnectionsChange", "onConfigure"]) {
    const original = node[callback];
    node[callback] = function (...args) {
      const result = original?.apply(this, args);
      schedule(callback === "onConfigure");
      return result;
    };
  }
  state.sync = sync;
  schedule(true);
  return state;
}

function setupGraph(graph, visited = new Set()) {
  if (!graph || visited.has(graph)) return;
  visited.add(graph);
  for (const node of graph._nodes || []) {
    setup(node)?.sync(true);
    if (node.subgraph) setupGraph(node.subgraph, visited);
  }
}

app.registerExtension({
  name: "liuxinyu.MultilineInputCollapse",
  nodeCreated: setup,
  afterConfigureGraph() { setupGraph(app.rootGraph); },
});
