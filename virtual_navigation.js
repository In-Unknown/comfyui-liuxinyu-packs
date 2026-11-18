import { app } from "../../scripts/app.js";
import { findNodes, revealNode, isCurrentGraphLocation } from "./node_find.js";

const SEND = "LiuxinyuVirtualOutput";
const RECEIVE = "LiuxinyuVirtualInput";
const kind = node => node?.comfyClass || node?.type;
const keyOf = node => node.widgets?.find(widget => widget.name === "key")?.value || "";
const rootGraph = () => app.rootGraph || app.canvas?.graph?.rootGraph || app.graph;
const installed = new WeakSet();
const controls = new Map();
let popup;
let refreshFrame;

export function pairedNodes(root, source) {
  const key = keyOf(source);
  if (!key) return [];
  const target = kind(source) === SEND ? RECEIVE : SEND;
  return findNodes(root, target).filter(match => kind(match.node) === target && keyOf(match.node) === key);
}

export function targetLocation(match) {
  // Shared graph definitions can have several host instances. Show their full
  // routes even when the definition is also the currently displayed graph.
  if (isCurrentGraphLocation(match)) return "同级";
  return ["主图", ...match.hosts.map(host => `${host.title || host.subgraph?.name || "子图"} (#${host.id})`)].join(" → ");
}

export function headerAnchor(node, matrix, surface) {
  const rect = surface.getBoundingClientRect();
  const sx = rect.width / surface.width, sy = rect.height / surface.height;
  const titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;
  const x = node.size[0] - 30, y = -(titleHeight + 24) / 2;
  return { left: rect.left + (matrix.a * x + matrix.c * y + matrix.e) * sx,
    top: rect.top + (matrix.b * x + matrix.d * y + matrix.f) * sy,
    scale: Math.hypot(matrix.a * sx, matrix.b * sy) };
}

function closePopup(focus = false) {
  if (!popup) return;
  const { card, button, frame } = popup;
  cancelAnimationFrame(frame);
  card.remove();
  button.setAttribute("aria-expanded", "false");
  popup = null;
  if (focus && !button.hidden) button.focus();
}

async function jump(match) {
  closePopup();
  try { await revealNode(match); }
  catch (error) {
    app.extensionManager.toast.add({ severity: "warn", summary: "跳转失败", detail: error.message, life: 5000 });
  }
}

function trackPopup() {
  if (!popup) return;
  const { card, button, node, key } = popup;
  if (button.hidden || !button.isConnected || node.graph !== app.canvas?.graph || keyOf(node) !== key) {
    closePopup(); return;
  }
  const anchor = button.getBoundingClientRect();
  const scale = anchor.width / 24;
  const width = 340 * scale, height = Math.min(card.scrollHeight, 300) * scale;
  const gap = 6 * scale;
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const below = anchor.bottom + gap;
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - gap - height);
  card.style.transform = `scale(${scale})`;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  popup.frame = requestAnimationFrame(trackPopup);
}

function activate(node, button) {
  if (popup?.node === node) { closePopup(); return; }
  closePopup();
  const matches = pairedNodes(rootGraph(), node);
  if (matches.length === 1) { void jump(matches[0]); return; }
  if (!matches.length) return;
  const card = document.createElement("div");
  card.className = "lxy-virtual-targets";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "配对接口");
  for (const match of matches) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lxy-virtual-target";
    const name = document.createElement("span");
    name.className = "lxy-virtual-target-name";
    name.textContent = keyOf(match.node);
    const id = document.createElement("span");
    id.className = "lxy-virtual-target-id";
    id.textContent = `#${match.path}`;
    const location = document.createElement("span");
    location.className = "lxy-virtual-target-location";
    location.textContent = targetLocation(match);
    row.append(name, id, location);
    row.addEventListener("click", () => {
      if (keyOf(match.node) === keyOf(node) && keyOf(node)) void jump(match);
      else closePopup();
    });
    card.append(row);
  }
  card.addEventListener("pointerdown", event => event.stopPropagation());
  card.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
  document.body.append(card);
  popup = { card, button, node, key: keyOf(node) };
  button.setAttribute("aria-expanded", "true");
  trackPopup();
  card.firstElementChild.focus({ preventScroll: true });
}

function makeButton(node) {
  const button = document.createElement("button");
  button.className = "lxy-virtual-jump";
  button.type = "button";
  button.hidden = true;
  const label = kind(node) === SEND ? "跳转到传出接口" : "跳转到传入接口";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", "false");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind(node) === SEND ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5");
  svg.append(path);
  button.append(svg);
  button.addEventListener("pointerdown", event => { event.stopPropagation(); });
  button.addEventListener("dblclick", event => event.stopPropagation());
  button.addEventListener("click", event => { event.stopPropagation(); activate(node, button); });
  document.body.append(button);
  controls.set(node, button);
  return button;
}

function refreshVisibility() {
  refreshFrame = null;
  const canvas = app.canvas;
  for (const [node, button] of controls) {
    if (!node.graph) { button.remove(); controls.delete(node); continue; }
    const rect = button.getBoundingClientRect();
    if (node.graph !== canvas.graph || node.flags?.collapsed ||
        !canvas.visible_nodes?.includes(node) || rect.right < 0 || rect.bottom < 0 ||
        rect.left > window.innerWidth || rect.top > window.innerHeight) button.hidden = true;
  }
  if (popup?.button.hidden || (popup && !popup.button.isConnected)) closePopup();
}

function install(node) {
  if (![SEND, RECEIVE].includes(kind(node)) || installed.has(node)) return;
  installed.add(node);
  const draw = node.onDrawForeground;
  node.onDrawForeground = function(ctx, ...args) {
    const result = draw?.call(this, ctx, ...args);
    if (this.flags?.collapsed || this.graph !== app.canvas?.graph) return result;
    const button = controls.get(this) || makeButton(this);
    const anchor = headerAnchor(this, ctx.getTransform(), app.canvas.canvas);
    button.style.left = `${anchor.left}px`;
    button.style.top = `${anchor.top}px`;
    button.style.transform = `scale(${anchor.scale})`;
    button.hidden = false;
    button.disabled = !keyOf(this);
    return result;
  };
  const removed = node.onRemoved;
  node.onRemoved = function(...args) {
    if (popup?.node === this) closePopup();
    controls.get(this)?.remove();
    controls.delete(this);
    return removed?.apply(this, args);
  };
}

app.registerExtension({
  name: "liuxinyu.VirtualNavigation",
  nodeCreated: install,
  setup() {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = new URL("./virtual_navigation.css", import.meta.url).href;
    document.head.append(style);
    const canvas = app.canvas;
    const draw = canvas.onDrawForeground;
    canvas.onDrawForeground = function(...args) {
      const result = draw?.apply(this, args);
      if (!refreshFrame) refreshFrame = requestAnimationFrame(refreshVisibility);
      return result;
    };
    canvas.canvas.addEventListener("litegraph:set-graph", () => {
      closePopup();
      for (const button of controls.values()) button.hidden = true;
    });
    window.addEventListener("pointerdown", event => {
      if (popup && !popup.card.contains(event.target) && !popup.button.contains(event.target)) closePopup();
    }, true);
    window.addEventListener("keydown", event => {
      if (popup && event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closePopup(true);
      }
    }, true);
  },
  afterConfigureGraph() {
    closePopup();
    for (const button of controls.values()) button.remove();
    controls.clear();
  },
});
