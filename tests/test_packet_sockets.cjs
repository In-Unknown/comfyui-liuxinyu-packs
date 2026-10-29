const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let extension;
  const app = { registerExtension(value) { extension = value; } };
  const source = fs.readFileSync(path.join(__dirname, "..", "packet_tasks.js"), "utf8");
  vm.runInNewContext(source.replace(/^import .*;$/m, ""), {
    app, queueMicrotask,
  });
  for (const isStart of [true, false]) {
    const inputOffset = isStart ? 0 : 1;
    const outputOffset = isStart ? 1 : 0;
    const condition = () => ({ name: "condition", type: "LIUXINYU_PACKET_CONDITION", link: 900, links: [901] });
    const node = {
      comfyClass: isStart ? "LiuxinyuPacketStart" : "LiuxinyuPacketEnd",
      inputs: [...(isStart ? [] : [condition()]), ...Array.from({ length: 100 }, (_, i) => ({ name: `value${i}`, link: null }))],
      outputs: [...(isStart ? [condition()] : []), ...Array.from({ length: 100 }, (_, i) => ({ name: `output${i}`, links: null }))],
      size: [300, 2400],
      addInput(name, type) { this.inputs.push({ name, type, link: null }); },
      addOutput(name, type) { this.outputs.push({ name, type, links: null }); },
      removeInput(i) { this.inputs.splice(i, 1); }, removeOutput(i) { this.outputs.splice(i, 1); },
      computeSize() { return [200, 40 + Math.max(this.inputs.length, this.outputs.length) * 20]; },
      setSize(size) { this.size = size; }, setDirtyCanvas() {},
    };
    extension.nodeCreated(node);
    await Promise.resolve();
    assert.equal(node.inputs.length, inputOffset + 1);
    assert.equal(node.outputs.length, outputOffset + (isStart ? 1 : 0));
    for (let index = 0; index < 100; index++) {
      node.inputs[index + inputOffset].link = index;
      node.onConnectionsChange(1, index + inputOffset, true);
      await Promise.resolve();
      assert.equal(node.inputs.length, inputOffset + Math.min(100, index + 2));
      assert.equal(node.outputs.length, outputOffset + index + 1 + (isStart ? 1 : 0));
    }
    assert.equal(node.inputs.length, inputOffset + 100);
    assert.equal(node.outputs.length, outputOffset + 100 + (isStart ? 1 : 0));
    node.outputs[99 + outputOffset].links = [123];
    node.inputs[99 + inputOffset].link = null;
    node.inputs[2 + inputOffset].link = null;
    node.onConfigure();
    await Promise.resolve();
    assert.equal(node.outputs[99 + outputOffset].links[0], 123);
    assert.equal(node.inputs[3 + inputOffset].link, 3);
    assert.equal(node.inputs[99 + inputOffset].name, "value99");
    node.outputs[99 + outputOffset].links = [];
    node.inputs[98 + inputOffset].link = null;
    node.onConnectionsChange(2, 99 + outputOffset, false);
    await Promise.resolve();
    assert.equal(node.inputs.length, inputOffset + 99);
    assert.equal(node.outputs.length, outputOffset + 98 + (isStart ? 1 : 0));
    assert.equal((isStart ? node.outputs : node.inputs)[0].type, "LIUXINYU_PACKET_CONDITION");
    assert.equal(node.size[0], 300);
    if (isStart) {
      assert.equal(node.outputs.at(-1).name, "当前轮次");
      assert.equal(node.outputs.at(-1).type, "INT");
      node.graph = { links: { 777: { origin_slot: node.outputs.length - 1 } } };
      node.outputs.at(-1).links = [777];
      node.inputs[98].link = 98;
      node.onConnectionsChange();
      await Promise.resolve();
      assert.equal(node.outputs.at(-1).links[0], 777);
      assert.equal(node.graph.links[777].origin_slot, node.outputs.length - 1);
    }
  }
  app.graphToPrompt = async () => ({
    workflow: { nodes: [{ id: 1, type: "LiuxinyuPacketStart", outputs: [
      { name: "分包回归条件" }, { name: "输出 1" }, { name: "当前轮次" }
    ] }] },
    output: { "2": { inputs: { round: ["1", 2], data: ["1", 1], condition: ["1", 0] } } }
  });
  extension.setup();
  const prompt = await app.graphToPrompt();
  assert.deepEqual(prompt.output["2"].inputs.round, ["1", 101]);
  assert.deepEqual(prompt.output["2"].inputs.data, ["1", 1]);
  assert.deepEqual(prompt.output["2"].inputs.condition, ["1", 0]);
  console.log("Paired socket growth, stable indices, condition ports, reload and disconnect checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
