// DOM rectangles are CSS pixels; LiteGraph offsets use logical canvas pixels.
const panelSelector = '[data-testid="properties-panel"], .side-bar-panel, .side-toolbar-container, .bottom-panel';

function boxOf(element) {
  if (!element || element.hidden) return null;
  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return null;
  }
  const r = element.getBoundingClientRect?.();
  return r?.width > 0 && r?.height > 0
    ? { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height } : null;
}

function intersect(a, b) {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}
const areaOf = r => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

export function visibleCanvasRect(canvas) {
  const rect = boxOf(canvas.canvas);
  if (!rect) return null;
  const panel = boxOf(document.querySelector?.(".graph-canvas-panel"));
  let usable = panel ? intersect(rect, panel) : rect;
  if (window.innerWidth > 0 && window.innerHeight > 0) {
    usable = intersect(usable, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  }
  // Keep all candidate rectangles until every overlapping panel is subtracted.
  // Splitter bounds and overlay panels may coexist; never subtract widths twice.
  let spaces = areaOf(usable) ? [usable] : [];
  for (const element of document.querySelectorAll?.(panelSelector) || []) {
    const obstacle = boxOf(element);
    if (!obstacle) continue;
    spaces = spaces.flatMap(space => {
      const cut = intersect(space, obstacle);
      if (!areaOf(cut)) return [space];
      return [{ ...space, right: cut.left }, { ...space, left: cut.right },
        { ...space, bottom: cut.top }, { ...space, top: cut.bottom }].filter(areaOf);
    });
    spaces = spaces.filter((space, i) => !spaces.some((other, j) => j !== i &&
      other.left <= space.left && other.top <= space.top && other.right >= space.right && other.bottom >= space.bottom &&
      (areaOf(other) > areaOf(space) || j < i)));
  }
  const best = spaces.sort((a, b) => areaOf(b) - areaOf(a))[0];
  return best ? { ...best, width: best.right - best.left, height: best.bottom - best.top }
    : { left: usable.left, top: usable.top, width: 0, height: 0 };
}

export function visibleCanvasArea(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.canvas.width / ratio, height = canvas.canvas.height / ratio;
  const rect = canvas.canvas.getBoundingClientRect?.(), visible = visibleCanvasRect(canvas);
  if (!visible || !rect?.width || !rect?.height) return { x: 0, y: 0, width, height };
  return { x: (visible.left - rect.left) * width / rect.width,
    y: (visible.top - rect.top) * height / rect.height,
    width: visible.width * width / rect.width, height: visible.height * height / rect.height };
}

export function centerCanvasOn(canvas, x, y, area = visibleCanvasArea(canvas)) {
  if (area.width <= 0 || area.height <= 0) return;
  canvas.ds.offset[0] = (area.x + area.width / 2) / canvas.ds.scale - x;
  canvas.ds.offset[1] = (area.y + area.height / 2) / canvas.ds.scale - y;
  canvas.setDirty(true, true);
}

const adaptedCanvases = new WeakSet();
export function installCanvasFocus(canvas) {
  if (!canvas?.ds || adaptedCanvases.has(canvas)) return;
  adaptedCanvases.add(canvas);
  const center = canvas.centerOnNode;
  canvas.centerOnNode = function(node, ...args) {
    const area = visibleCanvasArea(this);
    if (area.width <= 0 || area.height <= 0) return;
    const result = center.call(this, node, ...args);
    centerCanvasOn(this, node.pos[0] + node.size[0] / 2, node.pos[1] + node.size[1] / 2, area);
    return result;
  };
  const ds = canvas.ds, animate = ds.animateToBounds;
  ds.animateToBounds = function(bounds, redraw, options = {}) {
    const area = visibleCanvasArea(canvas);
    let viewport = [area.x, area.y, area.width, area.height];
    if (options.viewport) {
      const [x, y, w, h] = options.viewport;
      const left = Math.max(area.x, x), top = Math.max(area.y, y);
      viewport = [left, top, Math.max(0, Math.min(area.x + area.width, x + w) - left),
        Math.max(0, Math.min(area.y + area.height, y + h) - top)];
    }
    if (viewport[2] <= 0 || viewport[3] <= 0) return;
    return animate.call(this, bounds, redraw, { ...options, viewport });
  };
  ds.fitToBounds = function(bounds, { zoom = 0.75 } = {}) {
    const area = visibleCanvasArea(canvas);
    if (area.width <= 0 || area.height <= 0) return;
    if (zoom > 0) this.scale = Math.min(zoom * area.width / Math.max(bounds[2], 300),
      zoom * area.height / Math.max(bounds[3], 300), this.max_scale);
    centerCanvasOn(canvas, bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2, area);
  };
}
