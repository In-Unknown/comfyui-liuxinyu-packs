import { app } from "../../scripts/app.js";

const definitions = new WeakMap();
const installed = new WeakSet();
const HEIGHT = 20;
const GAP = 2;
const PADDING = 6;

function originalName(node) {
  const type = node.constructor;
  const definition = definitions.get(type) || type.nodeData;
  return definition?.display_name || type.title || definition?.name || node.type || "";
}

function install(node) {
  if (node.isSubgraphNode?.()) return;
  if (installed.has(node) || typeof node.drawBadges !== "function") return;
  installed.add(node);
  const drawBadges = node.drawBadges;
  node.drawBadges = function (ctx, ...args) {
    const name = originalName(this);
    if (!name) return drawBadges.call(this, ctx, ...args);

    // Observe the existing badge backgrounds so neither label covers the other.
    const bounds = [];
    const methods = ["rect", "roundRect"].map((key) => ({
      key, value: ctx[key], own: Object.hasOwn(ctx, key),
    }));
    for (const { key, value } of methods) {
      ctx[key] = function (x, y, width, height, ...rest) {
        bounds.push({ x, y, width, height });
        return value.call(this, x, y, width, height, ...rest);
      };
    }
    let result;
    try {
      result = drawBadges.call(this, ctx, ...args);
    } finally {
      for (const { key, value, own } of methods) {
        if (own) ctx[key] = value;
        else delete ctx[key];
      }
    }

    ctx.save();
    try {
      ctx.font = `12px ${LiteGraph.NODE_FONT || "sans-serif"}`;
      const width = ctx.measureText(name).width + PADDING * 2;
      let y = -(LiteGraph.NODE_TITLE_HEIGHT + GAP + HEIGHT);
      const overlapping = bounds.filter((box) => box.x < width + GAP && box.x + box.width > -GAP);
      if (overlapping.some((box) => box.y < y + HEIGHT + GAP && box.y + box.height > y - GAP)) {
        y = Math.min(y, ...overlapping.map((box) => box.y)) - HEIGHT - GAP;
      }
      ctx.fillStyle = "#243247";
      ctx.beginPath();
      ctx.roundRect(0, y, width, HEIGHT, 5);
      ctx.fill();
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(name, PADDING, y + HEIGHT / 2 + 1);
    } finally {
      ctx.restore();
    }
    return result;
  };
}

function installGraph(graph) {
  for (const node of graph?._nodes || []) {
    install(node);
    if (node.subgraph) installGraph(node.subgraph);
  }
}

app.registerExtension({
  name: "liuxinyu.OriginalNodeName",
  beforeRegisterNodeDef(nodeType, nodeData) {
    definitions.set(nodeType, nodeData);
  },
  nodeCreated: install,
  afterConfigureGraph() {
    installGraph(app.rootGraph);
  },
});
