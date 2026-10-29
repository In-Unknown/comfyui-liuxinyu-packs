const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let extension;
  const app = { registerExtension(value) { extension = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "multiline_collapse.js"), "utf8")
    .replace(/^\uFEFF?import .*;$/gm, ""), { app, queueMicrotask });
  const widgets = ["text", "command"].map(name => ({
    name, type: "customtext", element: { tagName: "TEXTAREA", hidden: false },
    options: {}, computeLayoutSize() { return { minHeight: 140, maxHeight: 140 }; },
  }));
  const node = {
    comfyClass: "RunCmd", widgets, inputs: [
      { widget: { name: "text" }, link: null }, { widget: { name: "command" }, link: null },
    ], size: [300, 320],
    getWidgetFromSlot(index) { return this.widgets[index]; },
    isInputConnected(index) { return this.inputs[index].link != null; },
    computeSize() { return [300, this.widgets.reduce((height, widget) => height + widget.computeLayoutSize().minHeight + 4, 20)]; },
    arrange() {}, setSize(size) { this.size = size; }, setDirtyCanvas() {},
  };
  extension.nodeCreated(node);
  const fullHeight = node.computeSize()[1];
  node.setSize([300, fullHeight]);
  node.inputs[0].link = 1;
  node.onConnectionsChange();
  await Promise.resolve();
  assert.equal(node.size[1], fullHeight - 140);
  assert.equal(widgets[0].element.hidden, true);
  node.inputs[0].link = null;
  node.onConnectionsChange();
  await Promise.resolve();
  assert.equal(node.size[1], fullHeight);
  assert.equal(widgets[0].element.hidden, false);
  node.inputs[1].link = 2;
  node.onConfigure();
  assert.equal(node.size[1], fullHeight - 140);
  console.log("All multiline widgets collapse and restore with connections.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
