import { app } from "../../scripts/app.js";

function isLiuxinyuNode(node) {
  return typeof node?.comfyClass === "string" &&
    (node.comfyClass.startsWith("Liuxinyu") || node.comfyClass === "RunCmd");
}

function widgetForInput(node, input, index) {
  const widget = node.getWidgetFromSlot?.(index);
  if (widget) return widget;
  const name = typeof input?.widget === "string" ? input.widget : input?.widget?.name;
  return name ? node.widgets?.find(candidate => candidate.name === name) : null;
}

function isMultiline(widget) {
  const tag = widget?.element?.tagName || widget?.element?.nodeName;
  return widget?.options?.multiline === true || tag === "TEXTAREA" || widget?.type === "customtext";
}

function setup(node) {
  if (node._liuxinyuMultilineCollapseSetup) return;
  const entries = (node.inputs || []).map((input, index) => {
    const widget = widgetForInput(node, input, index);
    if (!widget || !isMultiline(widget)) return null;
    const layout = widget.computeLayoutSize?.bind(widget);
    const size = widget.computeSize?.bind(widget);
    if (!layout && !size) return null;
    return { input, widget, layout, size, index, collapsed: false };
  });
  if (!entries.some(Boolean)) return;
  node._liuxinyuMultilineCollapseSetup = true;

  function sync() {
    let changed = false;
    for (const entry of entries) {
      if (!entry) continue;
      const collapsed = node.isInputConnected(entry.index);
      if (entry.collapsed !== collapsed) changed = true;
      entry.collapsed = collapsed;
      entry.widget.hidden = collapsed;
      if (entry.widget.element) {
        entry.widget.element.hidden = collapsed;
        entry.widget.element.readOnly = collapsed;
      }
    }
    if (!changed) return;
    node.arrange?.();
    node.setSize?.([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas?.(true, true);
  }

  for (const entry of entries) {
    if (!entry) continue;
    const { widget, layout, size } = entry;
    if (layout) {
      widget.computeLayoutSize = function (...args) {
        const result = layout(...args);
        return this._liuxinyuMultilineCollapsed ? { ...result, minHeight: 0, maxHeight: 0 } : result;
      };
    } else {
      widget.computeSize = function (...args) {
        return this._liuxinyuMultilineCollapsed ? [0, 0] : size(...args);
      };
    }
    Object.defineProperty(widget, "_liuxinyuMultilineCollapsed", {
      configurable: true,
      get: () => entries.find(item => item?.widget === widget)?.collapsed === true,
    });
  }

  const originalConnection = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnection?.apply(this, args);
    queueMicrotask(sync);
    return result;
  };
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    sync();
    return result;
  };
  sync();
}

app.registerExtension({
  name: "liuxinyu.MultilineInputCollapse",
  nodeCreated(node) {
    if (!isLiuxinyuNode(node)) return;
    setup(node);
    queueMicrotask(() => setup(node));
  },
});
