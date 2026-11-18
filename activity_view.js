// Rendering facades have separate geometry; no node is constructed, registered or executed.
function own(object, values) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: true });
  }
  return object;
}

export function presentation(source, values = {}) {
  const copy = Object.create(source);
  // Native converters sometimes spread a plain slot/widget into a concrete class.
  // Keep its enumerable fields, rather than losing name/type/options through inheritance.
  own(copy, Object.fromEntries(Object.keys(source).map(key => [key, source[key]])));
  if (source._state) own(copy, { _state: { ...source._state,
    flags: { ...source._state.flags }, options: { ...source._state.options },
    properties: { ...source._state.properties } } });
  return own(copy, values);
}

export function nodeView(source, width, domHeights = new Map()) {
  const titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;
  const view = presentation(source, {
    graph: source.graph ? presentation(source.graph, {
      rootGraph: source.graph.rootGraph || source.graph,
      setDirtyCanvas() {}, change() {}, beforeChange() {}, afterChange() {},
    }) : null,
    pos: [0, 0], size: [width, Math.max(60, source.size?.[1] || 60)],
    flags: { ...source.flags, collapsed: false }, collapsed: false, selected: false,
    mouseOver: false, clip_area: false, _concreteInputs: [], _concreteOutputs: [],
    properties: { ...source.properties },
    title_buttons: source.title_buttons?.map(button => presentation(button)),
    // State hooks may use graph identity to find nested execution paths.
    strokeStyles: Object.fromEntries(Object.entries(source.strokeStyles || {}).map(([key, hook]) =>
      [key, typeof hook === "function" ? () => hook.call(source) : hook])),
    setDirtyCanvas() {}, onResize: undefined,
  });
  Object.defineProperties(view, {
    renderingSize: { get: () => view.size },
    boundingRect: { get: () => [0, -titleHeight, view.size[0], view.size[1] + titleHeight] },
    width: { get: () => view.size[0] },
    height: { get: () => view.size[1] + titleHeight },
    bodyHeight: { get: () => view.size[1] },
  });
  own(view, { setSize(size) { view.size = [...size]; } });
  for (const side of ["inputs", "outputs"]) {
    own(view, { [side]: (source[side] || []).map(slot => presentation(slot, {
      _node: view, node: view, boundingRect: [...(slot.boundingRect || [0, 0, 20, 20])],
    })) });
  }
  own(view, { widgets: (source.widgets || []).map(widget => {
    const height = domHeights.get(widget);
    const copy = presentation(widget, { node: view, _node: view, y: widget.y || 0,
      last_y: widget.last_y, computedHeight: widget.computedHeight, width: undefined,
      value: widget.value, options: { ...widget.options },
      callback: undefined, afterResize: undefined, beforeResize: undefined });
    if (height != null) own(copy, {
      draw() {}, computeSize: () => [width, height + 8], computeLayoutSize: undefined,
      element: undefined, inputEl: undefined,
    });
    return copy;
  }) });
  for (const slot of [...view.inputs, ...view.outputs]) {
    if (slot._widget) own(slot, { _widget: view.widgets[source.widgets.indexOf(slot._widget)] });
    if (slot.pos) own(slot, { pos: [...slot.pos] });
  }
  // Instance layout wrappers may close over the original node (e.g. port_order's restore).
  // Use the class layout, then project the original visual row positions onto expanded widgets.
  const arrange = Object.getPrototypeOf(source)?.arrange || source.arrange;
  own(view, { arrange() {
    // Port-order snapshots contain absolute local X positions from the original width.
    // Let the installed layout recompute output X before restoring visual row order.
    for (const slot of this.outputs) slot.pos = undefined;
    if (arrange) arrange.call(this);
    else {
      // Older LiteGraph lays out widgets in drawNodeWidgets, without node.arrange().
      let y = source.widgets_start_y ?? Math.max(this.inputs.length, this.outputs.length) * 20 + 8;
      for (const widget of this.widgets) {
        if (widget.hidden && !widget._liuxinyuMultilineCompact) continue;
        widget.y = y; widget.last_y = y;
        widget.computedHeight = (widget.computeSize?.(width)?.[1] ?? 20) + 4;
        y += widget.computedHeight;
      }
    }
    const nativeWidgetY = new Map(this.widgets.map(widget => [widget, widget.y || 0]));
    const rows = (source.widgets || []).map((widget, i) => ({ widget, copy: this.widgets[i], i }))
      .filter(row => row.widget._liuxinyuMultilineCompact || (!row.widget.hidden && source.isWidgetVisible?.(row.widget) !== false))
      .sort((a, b) => (a.widget.y || 0) - (b.widget.y || 0));
    const projectRows = !source.flags?.collapsed && rows.some(row => row.widget.y > 0);
    const changes = [];
    let shift = 0;
    for (const { widget, copy } of projectRows ? rows : []) {
      const y = widget.y || 0;
      const oldHeight = widget.computedHeight || 24;
      const height = copy.computedHeight || 24;
      copy.y = y + shift; copy.last_y = copy.y;
      changes.push({ end: y + oldHeight, delta: height - oldHeight });
      shift += height - oldHeight;
    }
    const mappedY = y => y + changes.reduce((total, row) => total + (row.end <= y ? row.delta : 0), 0);
    for (const [side, getter] of [["inputs", "getInputPos"], ["outputs", "getOutputPos"]]) {
      const position = node => index => typeof node[getter] === "function"
        ? node[getter](index) : node.getConnectionPos?.(side === "inputs", index);
      this[side].forEach((slot, index) => {
        const pos = position(source.flags?.collapsed ? this : source)(index);
        if (!pos) return;
        const y = pos[1] - (source.flags?.collapsed ? this.pos[1] : source.pos[1]);
        const name = typeof slot.widget === "string" ? slot.widget : slot.widget?.name;
        const boundWidget = side === "inputs" && (slot._widget || this.widgets.find(widget => name && widget.name === name));
        const nativePos = position(this)(index);
        // An unvisited subgraph can still have widget.y=0 and no input.pos.
        // Native slot lookup then returns a placeholder above the body (-6px).
        // Keep the mirror's freshly arranged widget/socket pair, including row projection.
        const widgetY = boundWidget && (arrange && nativePos
          ? nativePos[1] - this.pos[1] + boundWidget.y - nativeWidgetY.get(boundWidget)
          : boundWidget.y + (globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20) / 2);
        slot.pos = [nativePos ? nativePos[0] - this.pos[0] : (side === "inputs" ? 10 : this.size[0] - 9),
          boundWidget ? widgetY : mappedY(y)];
        this._measureSlot?.(slot, index, side === "inputs");
      });
    }
  } });
  // Native slot/widget layout runs only on the facade and its copied containers.
  view._setConcreteSlots?.();
  view.arrange?.();
  const bottom = Math.max(60, ...view.widgets.map(w => (w.y || 0) + (w.computedHeight || 24)),
    ...[...view.inputs, ...view.outputs].map(slot => (slot.boundingRect?.[1] || 0) + (slot.boundingRect?.[3] || 20)));
  // Preserve custom image/preview areas that are drawn outside widget geometry.
  view.size[1] = Math.max(bottom + 6, source.size?.[1] || 60);
  view.arrange?.();
  return view;
}

const styleProperties = ["color", "background", "border", "border-radius", "box-shadow", "font",
  "letter-spacing", "text-align", "text-decoration", "padding", "margin", "gap", "align-items",
  "justify-content", "flex-direction", "grid-template-columns", "opacity", "box-sizing"];

export function domSource(widget) {
  if (widget.element || widget.inputEl) return widget.element || widget.inputEl;
  if (!widget.id) return null;
  // Vue component widgets have no element property or data-widget-id in the current frontend.
  for (const element of document.querySelectorAll(".dom-widget")) {
    if (element.__vueParentComponent?.props?.widgetState?.widget?.id === widget.id) return element;
  }
  return null;
}

export class DomMirror {
  constructor(source, host, invalidate) {
    this.source = source;
    this.host = host;
    this.root = host.attachShadow({ mode: "open" });
    this.dirty = true;
    this.observer = new MutationObserver(() => { this.dirty = true; invalidate(); });
    this.observer.observe(source, { subtree: true, childList: true, characterData: true, attributes: true });
    this.width = 0;
    this.pairs = [];
  }

  sync(width) {
    if (this.dirty || this.width !== width) {
      this.width = width;
      this.dirty = false;
      this.pairs = [];
      const copy = source => {
        if (source.nodeType !== 1) return source.cloneNode(false);
        if (["SCRIPT", "STYLE", "LINK", "IFRAME", "OBJECT", "EMBED"].includes(source.tagName)) {
          const message = document.createElement("span");
          if (["IFRAME", "OBJECT", "EMBED"].includes(source.tagName)) message.textContent = "此嵌入控件需在原节点查看";
          return message;
        }
        // Custom elements must not construct another running component. Copy their rendered DOM.
        const custom = source.localName?.includes("-") || source.hasAttribute?.("is");
        const target = source.tagName === "VIDEO" ? document.createElement("canvas")
          : custom ? document.createElement("div") : source.cloneNode(false);
        for (const attr of [...target.attributes]) if (/^on/i.test(attr.name) || attr.name === "autofocus") target.removeAttribute(attr.name);
        this.pairs.push([source, target]);
        if (source.shadowRoot) this.observer.observe(source.shadowRoot,
          { subtree: true, childList: true, characterData: true, attributes: true });
        const assigned = source.tagName === "SLOT" ? source.assignedNodes?.({ flatten: true }) : null;
        const children = assigned?.length ? assigned : (source.shadowRoot || source).childNodes;
        if (source.tagName !== "VIDEO") for (const child of children) target.append(copy(child));
        if (custom && !children.length) target.textContent = "此组件未提供可读取的显示内容，请点击查看原节点";
        return target;
      };
      const clone = copy(this.source);
      for (const [source, target] of this.pairs) {
        const css = getComputedStyle(source);
        for (const name of styleProperties) target.style.setProperty(name, css.getPropertyValue(name));
        Object.assign(target.style, { position: "relative", left: "auto", top: "auto", right: "auto",
          bottom: "auto", transform: "none", maxWidth: "100%", maxHeight: "none", minHeight: "0",
          height: "auto", overflow: "visible", textOverflow: "clip", whiteSpace: "pre-wrap",
          overflowWrap: "anywhere", flex: "0 0 auto", pointerEvents: "none" });
        // Keep intentionally hidden sub-elements; the outer widget may be hidden by canvas culling.
        target.style.display = source !== this.source && css.display === "none" ? "none"
          : css.display === "none" ? "block" : css.display;
        if (["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName)) {
          target.readOnly = true;
          target.tabIndex = -1;
          target.style.width = "100%";
        }
        if (target.tagName === "IMG" || target.tagName === "VIDEO") target.style.objectFit = "contain";
      }
      clone.inert = true;
      clone.style.width = "100%";
      clone.style.margin = "0";
      this.root.replaceChildren(clone);
      this.clone = clone;
    }
    this.host.style.width = `${width}px`;
    for (const [source, target] of this.pairs) {
      if ("value" in source && "value" in target) target.value = source.value;
      if ("checked" in source) target.checked = source.checked;
      if ("selectedIndex" in source) target.selectedIndex = source.selectedIndex;
      if (target.tagName === "TEXTAREA") {
        target.style.height = "auto";
        target.style.height = `${target.scrollHeight + 2}px`;
      }
      if (source.tagName === "CANVAS" || source.tagName === "VIDEO") {
        const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
        if (!width || !height || target.tagName !== "CANVAS") continue;
        if (target.width !== width) target.width = width;
        if (target.height !== height) target.height = height;
        try { target.getContext("2d").drawImage(source, 0, 0); } catch { /* A video may not have a decoded frame yet. */ }
      }
    }
    return Math.max(24, this.clone?.scrollHeight || 0, this.clone?.getBoundingClientRect().height || 0);
  }

  destroy() { this.observer.disconnect(); this.host.remove(); }
}

export function preferredWidth(node, ctx) {
  ctx.font = "14px sans-serif";
  const texts = [node.title || ""];
  for (const widget of node.widgets || []) {
    if (widget.element || widget.inputEl || widget.hidden) continue;
    const value = typeof widget.value === "object" ? "" : String(widget.value ?? "");
    texts.push(`${widget.label || widget.name || ""}    ${value}`);
  }
  const inputs = Math.max(0, ...(node.inputs || []).map(s => ctx.measureText(s.label || s.name || "").width));
  const outputs = Math.max(0, ...(node.outputs || []).map(s => ctx.measureText(s.label || s.name || "").width));
  return Math.ceil(Math.max(360, inputs + outputs + 80, ...texts.map(t => ctx.measureText(t).width + 90)));
}

// Observe the live drawing callbacks, including labels added by later extensions.
export function drawingBounds(ctx, draw, initial) {
  const bounds = [...initial];
  const saved = [];
  const include = (x, y, width = 0, height = 0) => {
    const m = ctx.getTransform();
    for (const [px, py] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]) {
      const tx = m.a * px + m.c * py + m.e, ty = m.b * px + m.d * py + m.f;
      bounds[0] = Math.min(bounds[0], tx); bounds[1] = Math.min(bounds[1], ty);
      bounds[2] = Math.max(bounds[2], tx); bounds[3] = Math.max(bounds[3], ty);
    }
  };
  const wrap = (name, measure) => {
    const fn = ctx[name], had = Object.hasOwn(ctx, name);
    if (!fn) return;
    saved.push(() => { if (had) ctx[name] = fn; else delete ctx[name]; });
    ctx[name] = function (...args) { measure(...args); return fn.apply(this, args); };
  };
  for (const name of ["rect", "roundRect", "fillRect", "strokeRect"]) wrap(name, include);
  for (const name of ["moveTo", "lineTo"]) wrap(name, (x, y) => include(x, y));
  wrap("arc", (x, y, r) => include(x - r, y - r, r * 2, r * 2));
  wrap("ellipse", (x, y, rx, ry) => include(x - rx, y - ry, rx * 2, ry * 2));
  wrap("quadraticCurveTo", (cx, cy, x, y) => { include(cx, cy); include(x, y); });
  wrap("bezierCurveTo", (ax, ay, bx, by, x, y) => { include(ax, ay); include(bx, by); include(x, y); });
  wrap("drawImage", (image, ...args) => {
    const rect = args.length === 8 ? args.slice(4) : args.length === 4 ? args : [args[0], args[1], image.width, image.height];
    include(...rect);
  });
  for (const name of ["fillText", "strokeText"]) wrap(name, (text, x, y) => {
    const metric = ctx.measureText(text), height = parseFloat(ctx.font) || 14;
    const offset = ctx.textAlign === "right" || ctx.textAlign === "end" ? metric.width : ctx.textAlign === "center" ? metric.width / 2 : 0;
    include(x - offset, y - height, metric.width, height * 1.5);
  });
  try { draw(); } finally { saved.reverse().forEach(restore => restore()); }
  return bounds;
}

export class ActivityNodeView {
  constructor(node, canvas, navigate) {
    this.node = node;
    this.canvas = canvas;
    this.element = document.createElement("article");
    this.element.className = "liuxinyu-activity-node";
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "button");
    this.element.setAttribute("aria-label", `定位节点：${node.title || node.id}`);
    this.surface = document.createElement("div");
    this.surface.className = "liuxinyu-activity-surface";
    this.element.append(this.surface);
    this.element.addEventListener("click", navigate);
    this.element.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(); }
    });
    this.mirrors = new Map();
    this.tiles = new Map();
    this.probe = document.createElement("canvas").getContext("2d");
    this.dirty = true;
  }

  render(availableWidth) {
    const source = this.node;
    if (typeof this.canvas?.drawNode !== "function") throw new Error("当前画布未提供节点绘制接口");
    if (globalThis.LiteGraph?.vueNodesMode) throw new Error("活动镜像目前需要经典画布模式，请关闭 Vue Nodes 后查看");
    const width = preferredWidth(source, this.probe);
    const heights = new Map();
    const liveWidgets = new Set();
    for (const widget of source.widgets || []) {
      if (widget.hidden || source.isWidgetVisible?.(widget) === false) continue;
      const element = domSource(widget);
      if (!element) continue;
      liveWidgets.add(widget);
      let mirror = this.mirrors.get(widget);
      if (mirror && mirror.source !== element) { mirror.destroy(); mirror = null; }
      if (!mirror) {
        const host = document.createElement("div");
        host.className = "liuxinyu-activity-dom";
        this.surface.append(host);
        mirror = new DomMirror(element, host, () => { this.dirty = true; });
        this.mirrors.set(widget, mirror);
      }
      heights.set(widget, mirror.sync(width - 20));
    }
    for (const [widget, mirror] of this.mirrors) if (!liveWidgets.has(widget)) {
      mirror.destroy(); this.mirrors.delete(widget);
    }
    const view = nodeView(source, width, heights);
    const renderer = presentation(this.canvas, { canvas: this.probe.canvas, ctx: this.probe,
      ds: { ...this.canvas.ds, scale: 1, offset: [0, 0] }, graph: source.graph,
      low_quality: false, editor_alpha: 1, render_shadows: false, current_node: view,
      node_over: null, selected_nodes: {}, selectedItems: new Set(),
      linkConnector: { renderLinks: [] }, setDirty() {} });
    const draw = ctx => { renderer.canvas = ctx.canvas; renderer.ctx = ctx; renderer.drawNode(view, ctx); };
    const bounds = drawingBounds(this.probe, () => draw(this.probe), [-12, -36, width + 12, view.size[1] + 12]);
    const left = Math.floor(bounds[0] - 4), top = Math.floor(bounds[1] - 4);
    const fullWidth = Math.ceil(bounds[2] - left + 4), fullHeight = Math.ceil(bounds[3] - top + 4);
    // Keep text readable. Wide scalar values scroll horizontally instead of being clipped/scaled to dust.
    const scale = Math.max(0.85, Math.min(1, (availableWidth - 12) / fullWidth));
    this.surface.style.width = `${fullWidth}px`;
    this.surface.style.height = `${fullHeight}px`;
    this.surface.style.zoom = String(scale);
    this.element.style.flexBasis = `${Math.min(availableWidth, fullWidth * scale + 12)}px`;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.surface.getBoundingClientRect();
    const viewport = this.element.parentElement?.parentElement?.getBoundingClientRect();
    const visible = visibleTiles(fullWidth, fullHeight, {
      left: this.element.scrollLeft / scale,
      right: (this.element.scrollLeft + availableWidth) / scale,
      top: viewport ? (viewport.top - rect.top) / scale : 0,
      bottom: viewport ? (viewport.bottom - rect.top) / scale : fullHeight,
    });
    const liveTiles = new Set(visible.map(tile => tile.key));
    for (const [key, tile] of this.tiles) if (!liveTiles.has(key)) { tile.remove(); this.tiles.delete(key); }
    for (const { key, x, y, width, height } of visible) {
      let tile = this.tiles.get(key);
      if (!tile) {
        tile = document.createElement("canvas"); tile.className = "liuxinyu-activity-tile";
        this.surface.prepend(tile); this.tiles.set(key, tile);
      }
      tile.width = Math.ceil(width * ratio); tile.height = Math.ceil(height * ratio);
      Object.assign(tile.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      const ctx = tile.getContext("2d");
      ctx.scale(ratio, ratio); ctx.translate(-left - x, -top - y);
      draw(ctx);
    }
    source.widgets?.forEach((widget, index) => {
      const mirror = this.mirrors.get(widget);
      if (mirror) Object.assign(mirror.host.style, { left: `${10 - left}px`, top: `${(view.widgets[index].y || 0) + 4 - top}px` });
    });
    this.dirty = false;
  }

  destroy() { for (const mirror of this.mirrors.values()) mirror.destroy(); this.element.remove(); }
}

// Tile both axes, and allocate only visible pixels. Long scalar text must not create a giant canvas.
export function visibleTiles(width, height, viewport) {
  const size = 1024;
  const tiles = [];
  const startX = Math.max(0, Math.floor(viewport.left / size));
  const startY = Math.max(0, Math.floor(viewport.top / size));
  const endX = Math.min(Math.ceil(width / size), Math.ceil(viewport.right / size));
  const endY = Math.min(Math.ceil(height / size), Math.ceil(viewport.bottom / size));
  for (let row = startY; row < endY; row++) for (let column = startX; column < endX; column++) {
    const x = column * size, y = row * size;
    tiles.push({ key: `${column}:${row}`, x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
  }
  return tiles;
}
