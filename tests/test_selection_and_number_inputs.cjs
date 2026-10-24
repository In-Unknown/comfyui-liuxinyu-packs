const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pack = path.resolve(__dirname, "..");

async function main() {
  let extension;
  vm.runInNewContext(fs.readFileSync(path.join(pack, "number_array.js"), "utf8").replace(/^import .*;$/m, ""), {
    app: { registerExtension(value) { extension = value; } }, queueMicrotask,
  });
  const node = {
    comfyClass: "LiuxinyuNumberArray", inputs: [{ name: "number0", link: null }], size: [300, 100],
    addInput(name, type) { this.inputs.push({ name, type, link: null }); },
    removeInput(index) { this.inputs.splice(index, 1); },
    computeSize() { return [200, 40 + this.inputs.length * 20]; },
    setSize(value) { this.size = value; }, setDirtyCanvas() {},
  };
  extension.nodeCreated(node);
  await Promise.resolve();
  for (let i = 0; i < 150; i++) {
    node.inputs[i].link = i; // Link zero is connected too.
    node.onConnectionsChange(1, i, true);
    await Promise.resolve();
  }
  assert.equal(node.inputs.length, 151);
  assert.equal(node.inputs[150].name, "number150");
  assert.equal(node.inputs[150].type, "FLOAT,INT");
  node.inputs = JSON.parse(JSON.stringify(node.inputs));
  node.onConfigure();
  await Promise.resolve();
  node.inputs[2].link = null;
  node.onConnectionsChange(1, 2, false);
  await Promise.resolve();
  assert.equal(node.inputs[3].link, 3);
  assert.equal(node.inputs[149].link, 149);
  node.inputs[149].link = null;
  node.onConnectionsChange(1, 149, false);
  await Promise.resolve();
  assert.equal(node.inputs.length, 150);
  node.inputs[149].link = 1000;
  node.onConnectionsChange(1, 149, true);
  await Promise.resolve();
  assert.equal(node.inputs[150].name, "number150");
  assert.equal(node.size[0], 300);

  const source = fs.readFileSync(path.join(pack, "folder_picker.js"), "utf8");
  const start = source.indexOf("function onBatchExecuted(");
  const end = source.indexOf("function renderBatchCells(", start);
  const context = {
    updateButtonLabel(node) { node.count = node._batchState.selected.size; },
    renderBatchCells() { context.renders++; }, relayoutBatchGrid() {}, renders: 0,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const cells = [0, 1, 2].map(index => ({
    dataset: { index: String(index) },
    classList: { toggle(name, value) { this.selected = value; } },
  }));
  const batch = { widgets: [{ name: "selection", value: "2,0" }], _batchState: {
    selected: new Set(), inner: { querySelectorAll() { return cells; } },
  }};
  const images = cells.map((_, i) => ({ filename: `${i}.png`, type: "temp", selected: i !== 1 }));
  context.onBatchExecuted(batch, { images });
  assert.deepEqual([...batch._batchState.selected], [0, 2]);
  assert.equal(batch.widgets[0].value, "2,0");
  assert.equal(batch.count, 2);
  batch._batchState.selected.clear();
  context.onBatchExecuted(batch, { images });
  assert.equal(context.renders, 1); // Cached preview updates selections without loading images again.
  assert.deepEqual(cells.map(cell => cell.classList.selected), [true, false, true]);
  context.onBatchExecuted(batch, { images: images.map(meta => ({ ...meta, selected: false })) });
  assert.equal(batch.count, 0);
  assert.deepEqual(cells.map(cell => cell.classList.selected), [false, false, false]);
  console.log("Selection refresh, cached results, dynamic inputs beyond 100, reload and reconnect checks passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
