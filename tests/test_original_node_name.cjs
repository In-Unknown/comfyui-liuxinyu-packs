const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let extension;
const app = { registerExtension(value) { extension = value; } };
const source = fs.readFileSync(path.join(__dirname, "../original_node_name.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "");
vm.runInNewContext(source, { app, LiteGraph: { NODE_TITLE_HEIGHT: 30, NODE_FONT: "sans-serif" } });

class Context {
  constructor() { this.text = []; this.boxes = []; this.depth = 0; }
  rect(x, y, width, height) { this.boxes.push({ x, y, width, height }); }
  roundRect(x, y, width, height) { this.boxes.push({ x, y, width, height }); }
  save() { this.depth++; }
  restore() { this.depth--; }
  beginPath() {}
  fill() {}
  measureText(text) { return { width: [...text].length * 12 }; }
  fillText(text, x, y) { this.text.push({ text, x, y }); }
}

class Node {
  static title = "Default type title";
  constructor() { this.title = "Renamed task"; this.type = "ExampleNode"; this.width = 400; }
  drawBadges(ctx) {
    ctx.roundRect(this.width - 130, -52, 130, 20, 5);
    ctx.fillText("package-name", this.width - 124, -41);
    return "existing-result";
  }
}

function draw(node) {
  const ctx = new Context();
  assert.equal(node.drawBadges(ctx), "existing-result");
  assert.equal(ctx.depth, 0);
  assert.equal(Object.hasOwn(ctx, "rect"), false);
  assert.equal(Object.hasOwn(ctx, "roundRect"), false);
  return ctx;
}

// The registered Chinese display name survives renaming, copies and restored titles.
extension.beforeRegisterNodeDef(Node, { name: "ExampleNode", display_name: "保存图像到绝对路径" });
const node = new Node();
extension.nodeCreated(node);
let ctx = draw(node);
assert.equal(ctx.text[1].text, "保存图像到绝对路径");
assert.equal(ctx.boxes[1].x, 0);
assert.equal(ctx.boxes[1].y, -52);
assert.equal(node.title, "Renamed task");
node.title = "Another task";
assert.equal(draw(node).text[1].text, "保存图像到绝对路径");
const clone = new Node();
extension.nodeCreated(clone);
assert.equal(draw(clone).text[1].text, "保存图像到绝对路径");

// Narrow/collapsed nodes put the full original name above source badges.
node.width = 180;
ctx = draw(node);
assert.equal(ctx.boxes[0].y, -52);
assert.equal(ctx.boxes[1].y, -74);
assert.equal(ctx.text[1].text, "保存图像到绝对路径");

// Official nodes and other packs use the same hook; frontend-only nodes use class titles.
class Official extends Node {}
extension.beforeRegisterNodeDef(Official, { name: "KSampler", display_name: "K采样器" });
const official = new Official();
extension.nodeCreated(official);
assert.equal(draw(official).text[1].text, "K采样器");
class Note extends Node { static title = "笔记"; }
const note = new Note();
extension.nodeCreated(note);
assert.equal(draw(note).text[1].text, "笔记");

// Imported graphs and nodes inside subgraphs get one label, including repeated loads.
const child = new Node();
class SubgraphNode extends Node { isSubgraphNode() { return true; } }
const subgraph = new SubgraphNode();
subgraph.subgraph = { _nodes: [child] };
extension.nodeCreated(subgraph);
app.rootGraph = { _nodes: [node, subgraph] };
extension.afterConfigureGraph();
extension.afterConfigureGraph();
assert.equal(draw(node).text.length, 2);
assert.equal(draw(child).text.length, 2);
assert.equal(draw(subgraph).text.length, 1);
assert.equal(subgraph.drawBadges, Node.prototype.drawBadges);

// A drawing error in another extension must not leave canvas methods patched.
const broken = new Node();
broken.drawBadges = () => { throw new Error("other extension failed"); };
extension.nodeCreated(broken);
ctx = new Context();
assert.throws(() => broken.drawBadges(ctx), /other extension failed/);
assert.equal(Object.hasOwn(ctx, "rect"), false);
assert.equal(Object.hasOwn(ctx, "roundRect"), false);

console.log("Original names: Chinese names, renaming, copies, official/frontend nodes, subgraphs, collision layout and cleanup passed.");
