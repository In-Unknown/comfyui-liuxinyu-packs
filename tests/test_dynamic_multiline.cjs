const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let extension;
  const app = { registerExtension(value) { extension = value; } };
  const ComfyWidgets = {
    STRING(node, name, [, options]) {
      const widget = {
        name, type: "customtext", options: {}, value: options.default,
        element: { hidden: false },
        // Native DOM widgets provide computeLayoutSize, not computeSize.
        computeLayoutSize() { return { minHeight: this.options.getMinHeight() }; },
      };
      node.widgets.push(widget);
      return { widget };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "dynamic_multiline.js"), "utf8")
    .replace(/^\uFEFF/, "").replace(/^import .*;$/gm, ""), { app, ComfyWidgets, queueMicrotask });
  function make() {
    const node = {
      comfyClass: "LiuxinyuDynamicMultilineText", inputs: [], outputs: [],
      widgets: [{ name: "blocks_json", value: '["first","second","third"]' }],
      size: [400, 100], pos: [10, 20],
      graph: { beforeChange() {}, afterChange() {} },
      addInput(name, type, options) { this.inputs.push({ name, type, link: null, ...options }); },
      addOutput(name, type) { this.outputs.push({ name, type, boundingRect: [0, 0, 0, 0] }); },
      removeInput(i) { this.inputs.splice(i, 1); },
      removeOutput(i) { this.outputs.splice(i, 1); },
      isInputConnected(i) { return this.inputs[i]?.link != null; },
      addCustomWidget(widget) { this.widgets.push(widget); return widget; },
      addWidget(type, name, value, callback, options) {
        return this.addCustomWidget({ type, name, value, callback, options, computeSize: () => [0, 20] });
      },
      removeWidget(widget) { this.widgets.splice(this.widgets.indexOf(widget), 1); },
      computeSize() {
        const height = this.widgets.filter(w => !w.hidden).reduce((sum, w) =>
          sum + (w.computeSize ? w.computeSize()[1] : w.computeLayoutSize().minHeight) + 4, 14);
        return [400, height];
      },
      setSize(size) { this.size = size; this.arrange(); },
      setDirtyCanvas() {},
      arrange() {
        let y = 0;
        for (const widget of this.widgets.filter(w => !w.hidden)) {
          widget.y = y;
          y += (widget.computeSize ? widget.computeSize()[1] : widget.computeLayoutSize().minHeight) + 4;
        }
      },
    };
    extension.nodeCreated(node);
    return node;
  }
  const node = make();
  const fields = () => node.widgets.filter(w => w.type === "customtext");
  const height = node.size[1];
  node.inputs[0].link = 0;
  node.inputs[2].link = 2;
  node.onConnectionsChange();
  await Promise.resolve();
  assert.equal(node.size[1], height - 2 * 144);
  assert.deepEqual(fields().map(w => !!w.hidden), [true, false, true]);
  assert.equal(node.outputs[2].pos[1], node.inputs[2]._widget.y + 10);
  node.inputs[0].link = null;
  node.onConnectionsChange();
  await Promise.resolve();
  assert.equal(node.size[1], height - 144);
  assert.equal(fields()[0].element.hidden, false);
  assert.equal(fields()[0].element.readOnly, false);
  assert.equal(fields()[0].value, "first");
  fields()[0].value = "edited\ntext";
  fields()[0].callback();
  assert.deepEqual(JSON.parse(node.widgets[0].value), ["edited\ntext", "second", "third"]);
  node.inputs.forEach((input, i) => { input.link = i; });
  node.onConnectionsChange();
  await Promise.resolve();
  assert.equal(node.size[1], height - 3 * 144);
  assert.equal(node.inputs.length, 3);
  assert.equal(node.outputs.length, 3);
  node.widgets.at(-1).callback();
  assert.equal(node.inputs.length, 4);
  assert.equal(node.outputs.length, 4);
  assert.equal(fields()[3].hidden, false);
  const restored = make();
  restored.widgets[0].value = node.widgets[0].value;
  restored.inputs = node.inputs.map(input => ({ ...input }));
  restored.onConfigure();
  assert.equal(restored.size[1], node.size[1]);
  assert.deepEqual(restored.widgets.filter(w => w.type === "customtext").map(w => !!w.hidden), [true, true, true, false]);
  assert.equal(restored.widgets.find(w => w.name === "texts.text1").value, "edited\ntext");
  console.log("Multiline collapse, reconnect, values, socket positions, add and restore passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
