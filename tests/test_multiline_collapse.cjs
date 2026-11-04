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
      { name: "text", widget: { name: "text" }, link: null }, { name: "command", widget: { name: "command" }, link: null },
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
  // Configure replaces the ports and moves the template behind connected t-inputs.
  const template = {
    name: "template", type: "customtext", value: "渠道：{t1}\n内容：{t2}",
    element: { tagName: "TEXTAREA", hidden: false, readOnly: false },
    computeLayoutSize() { return { minHeight: 180, maxHeight: 180 }; },
  };
  let originalConfigureCalls = 0;
  let originalConnectionCalls = 0;
  const dynamic = {
    ...node, comfyClass: "LiuxinyuTextFromTemplate", widgets: [template], size: [350, 240],
    inputs: [{ name: "template", widget: { name: "template" }, link: null }],
    onConfigure() { originalConfigureCalls++; return 23; },
    onConnectionsChange() { originalConnectionCalls++; return 17; },
    _liuxinyuMultilineCollapseSetup: false,
  };
  extension.nodeCreated(dynamic);
  const contents = template.value;
  dynamic.inputs = [
    { name: "strings.t1", link: 91 }, { name: "strings.t2", link: 92 },
    { name: "parameters", link: null },
    { name: "template", widget: { name: "template" }, link: null },
    { name: "strings.t3", link: null },
  ];
  dynamic.size = [350, 134]; // Saved while the template was incorrectly collapsed.
  assert.equal(dynamic.onConfigure(), 23);
  await Promise.resolve();
  assert.equal(template.hidden, false, "Connected t1 must not hide the template");
  assert.equal(template.element.hidden, false);
  assert.equal(template.element.readOnly, false);
  assert.equal(template.computeLayoutSize().minHeight, 180);
  assert.ok(dynamic.size[1] >= 204, "Recover a saved node height that cannot fit the editor");
  dynamic.inputs[3].link = 0;
  assert.equal(dynamic.onConnectionsChange(), 17);
  await Promise.resolve();
  assert.equal(template.element.hidden, true, "Only the template connection collapses its editor");
  assert.equal(template.element.readOnly, true);
  assert.equal(template.computeLayoutSize().minHeight, 0);
  dynamic.inputs.unshift({ name: "strings.t0", link: null });
  dynamic.onConnectionsChange(); await Promise.resolve();
  assert.equal(template.hidden, true, "Adding a port before the template preserves its state");
  dynamic.inputs.find(p => p.name === "template").link = null;
  dynamic.onConnectionsChange(); await Promise.resolve();
  assert.equal(template.hidden, false);
  assert.equal(template.element.readOnly, false);
  assert.equal(template.value, contents, "Connecting, reordering and disconnecting never edits text");
  dynamic.size = [350, 600];
  dynamic.onConnectionsChange(); await Promise.resolve();
  assert.equal(dynamic.size[1], 600, "Keep manually enlarged nodes when visibility is unchanged");
  assert.equal(originalConfigureCalls, 1);
  assert.equal(originalConnectionCalls, 4);
  // The legacy computeSize path also follows the named port after replacement.
  const legacyWidget = { name: "text", type: "customtext", value: "keep", computeSize() { return [250, 120]; } };
  const legacy = {
    ...node, _liuxinyuMultilineCollapseSetup: false,
    inputs: [{ name: "text", widget: "text", link: null }], widgets: [legacyWidget],
    onConnectionsChange() {}, onConfigure() {},
    computeSize() { return [300, 30 + legacyWidget.computeSize()[1]]; },
  };
  extension.nodeCreated(legacy);
  legacy.inputs = [{ name: "other", link: null }, { name: "text", widget: "text", link: 7 }];
  legacy.onConfigure(); await Promise.resolve();
  assert.equal(legacyWidget.computeSize()[1], 0);
  legacy.inputs.splice(1, 1);
  legacy.onConnectionsChange(); await Promise.resolve();
  assert.equal(legacyWidget.computeSize()[1], 120, "Removed port restores the editor");
  console.log("All multiline widgets collapse and restore with connections.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
