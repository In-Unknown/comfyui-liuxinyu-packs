import { app } from "../../scripts/app.js";

const installed = new WeakSet();

function install(node) {
  if (installed.has(node) || typeof node.drawBadges !== "function") return;
  installed.add(node);
  const drawBadges = node.drawBadges;
  node.drawBadges = function (ctx, ...args) {
    const result = drawBadges.call(this, ctx, ...args);
    if (this.id == null || this.id === -1) return result;

    const label = `ID: ${this.id}`;
    const y = (this.flags?.collapsed ? 0 : this.size[1]) + 4;
    ctx.save();
    try {
      ctx.font = `11px ${LiteGraph.NODE_FONT || "sans-serif"}`;
      ctx.fillStyle = "#243247";
      ctx.beginPath();
      ctx.roundRect(0, y, ctx.measureText(label).width + 12, 18, 4);
      ctx.fill();
      ctx.fillStyle = "#cbd5e1";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 6, y + 9);
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
  name: "liuxinyu.NodeJsonId",
  nodeCreated: install,
  afterConfigureGraph() {
    installGraph(app.rootGraph);
  },
});
