const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let extension;
const app = { registerExtension(value) { extension = value; } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../node_json_id.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, ""), { app, LiteGraph: { NODE_FONT: "sans-serif" } });

function node(id) {
  return { id, size: [300, 100], flags: {}, title: "用户标题",
    drawBadges(ctx) { ctx.labels.push("existing"); return "original-result"; } };
}
function draw(value) {
  const ctx = { labels: [], boxes: [], depth: 0,
    save() { this.depth++; }, restore() { this.depth--; }, beginPath() {}, fill() {},
    measureText(text) { return { width: text.length * 6 }; },
    roundRect(...args) { this.boxes.push(args); }, fillText(text) { this.labels.push(text); } };
  assert.equal(value.drawBadges(ctx), "original-result");
  assert.equal(ctx.depth, 0);
  return ctx;
}

const parent = node(522), child = node(530);
parent.subgraph = { _nodes: [child] };
app.rootGraph = { _nodes: [parent] };
const before = JSON.stringify(parent);
extension.nodeCreated(parent);
extension.afterConfigureGraph();
extension.afterConfigureGraph();
assert.equal(JSON.stringify(parent), before);
assert.deepEqual(draw(parent).labels, ["existing", "ID: 522"]);
assert.deepEqual(draw(child).labels, ["existing", "ID: 530"]);
assert.equal(draw(parent).boxes[0][1], 104);
parent.flags.collapsed = true;
assert.equal(draw(parent).boxes[0][1], 4);
parent.id = 600;
assert.deepEqual(draw(parent).labels, ["existing", "ID: 600"]);
parent.id = -1;
assert.deepEqual(draw(parent).labels, ["existing"]);
parent.id = null;
assert.deepEqual(draw(parent).labels, ["existing"]);
extension.nodeCreated({ id: 5 });
console.log("Node ID badges: nesting, repeated installation, changed IDs, collapsed position and saved data preserved.");
