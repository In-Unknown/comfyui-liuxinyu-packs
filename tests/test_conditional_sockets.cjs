const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let extension;
  const app = { registerExtension(value) { extension = value; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "conditional_loop.js"), "utf8")
    .replace(/^import .*;$/m, ""), { app, queueMicrotask });
  const conditionalExtension = extension;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "packet_tasks.js"), "utf8")
    .replace(/^import .*;$/m, ""), { app, queueMicrotask });
  const packetExtension = extension;
  extension = conditionalExtension;
  const graph = { _nodes: [], links: new Map(), getNodeById(id) { return this._nodes.find(n => n.id === id); } };
  app.graph = graph;
  let nextLink = 1;
  function make(kind) {
    const node = {
      id: graph._nodes.length, comfyClass: kind, graph, inputs: [], outputs: [], size: [300, 100],
      addInput(name, type) { this.inputs.push({ name, type, link: null }); },
      addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
      removeInput(i) { this.disconnectInput(i); this.inputs.splice(i, 1); },
      removeOutput(i) {
        for (const id of [...this.outputs[i].links]) {
          const cable = graph.links.get(id);
          graph.getNodeById(cable.target_id).disconnectInput(cable.target_slot);
        }
        this.outputs.splice(i, 1);
      },
      disconnectInput(i) {
        const cable = graph.links.get(this.inputs[i].link);
        if (!cable) return;
        const source = graph.getNodeById(cable.origin_id);
        source.outputs[cable.origin_slot].links = source.outputs[cable.origin_slot].links.filter(id => id !== cable.id);
        graph.links.delete(cable.id);
        this.inputs[i].link = null;
        this.onConnectionsChange?.(); source.onConnectionsChange?.();
      },
      computeSize() { return [200, Math.max(this.inputs.length, this.outputs.length) * 20]; },
      setSize(size) { this.size = size; }, setDirtyCanvas() {},
    };
    graph._nodes.push(node);
    return node;
  }
  function start() {
    const n = make("LiuxinyuReturnPoint");
    n.addOutput("调回句柄", "LIUXINYU_RETURN_HANDLE");
    for (let i = 0; i < 100; i++) { n.addInput(`value${i}`, "*"); n.addOutput(`输出 ${i + 1}`, "*"); }
    extension.nodeCreated(n);
    return n;
  }
  function end() {
    const n = make("LiuxinyuConditionalReturn");
    n.addInput("handle", "LIUXINYU_RETURN_HANDLE"); n.addInput("repeat", "BOOLEAN");
    for (let i = 0; i < 100; i++) { n.addInput(`value${i}`, "*"); n.addOutput(`输出 ${i + 1}`, "*"); }
    extension.nodeCreated(n);
    return n;
  }
  function packet(isStart) {
    const n = make(isStart ? "LiuxinyuPacketStart" : "LiuxinyuPacketEnd");
    if (isStart) n.addOutput("分包回归条件", "LIUXINYU_PACKET_CONDITION");
    else n.addInput("condition", "LIUXINYU_PACKET_CONDITION");
    for (let i = 0; i < 100; i++) { n.addInput(`value${i}`, "*"); n.addOutput(`输出 ${i + 1}`, "*"); }
    if (isStart) n.addOutput("当前轮次", "INT");
    packetExtension.nodeCreated(n);
    return n;
  }
  function connect(source, output, target, input) {
    const socket = source.outputs[output];
    assert.notEqual(source.onConnectOutput?.(output, target.inputs[input].type, target.inputs[input], target, input), false);
    assert.notEqual(target.onConnectInput?.(input, socket.type, socket, source, output), false);
    target.disconnectInput(input);
    const cable = { id: nextLink++, origin_id: source.id, origin_slot: output, target_id: target.id, target_slot: input, type: socket.type };
    graph.links.set(cable.id, cable);
    socket.links.push(cable.id); target.inputs[input].link = cable.id;
    source.onConnectionsChange?.(); target.onConnectionsChange?.();
    return cable.id;
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const source = make("Source");
  for (const type of ["INT", "STRING", "IMAGE", "BOOLEAN"]) source.addOutput(type, type);
  const a = start(), b = end();
  await settle();
  assert.equal(a.inputs.length, 1);
  assert.equal(a.outputs.length, 1);
  assert.equal(b.inputs.length, 2);
  assert.equal(b.outputs.length, 0);
  connect(source, 0, a, 0); connect(a, 0, b, 0);
  await settle();
  assert.equal(a.inputs.length, 2);
  assert.equal(a.outputs[1].type, "INT");
  assert.equal(b.inputs[2].type, "INT");
  assert.equal(a.outputs.length, 2);
  assert.equal(b.outputs[0].type, "INT");
  assert.equal(b.inputs[2].label, "输入 1 · INT");
  assert.equal(b.outputs[0].label, "输出 1 · INT");
  assert.equal(a.outputs[1].label, "输出 1 · INT");
  assert.equal(b.onConnectOutput(0, "STRING"), false);
  assert.equal(b.onConnectOutput(0, "INT"), true);
  connect(source, 1, a, 1);
  await settle();
  assert.equal(a.inputs.length, 3);
  assert.equal(a.outputs.length, 3); // Handle plus two data outputs; no spare output.
  const feedback = connect(a, 2, b, 3);
  connect(a, 1, b, 2); connect(source, 3, b, 1);
  await settle();
  assert.equal(b.inputs[3].type, "STRING");
  assert.equal(b.onConnectInput(2, "STRING", source.outputs[1], source, 1), false);
  assert.equal(b.onConnectInput(0, "LIUXINYU_RETURN_HANDLE", {}, source, 0), false);
  extension.afterConfigureGraph(); a.onConfigure?.(); b.onConfigure?.();
  await settle();
  assert.equal(b.inputs[3].link, feedback);
  assert.equal(graph.links.get(feedback).origin_slot, 2);
  // Updating the pair together must preserve a valid direct feedback cable.
  const directFeedback = b.inputs[2].link;
  a.disconnectInput(0); connect(source, 2, a, 0);
  await settle();
  assert.equal(b.inputs[2].link, directFeedback);
  assert.equal(b.inputs[2].label, "输入 1 · IMAGE");
  assert.equal(b.outputs[0].label, "输出 1 · IMAGE");
  a.disconnectInput(0); connect(source, 0, a, 0);
  await settle();
  const mismatched = connect(source, 0, b, 2);
  a.disconnectInput(0); connect(source, 2, a, 0);
  await settle();
  assert.equal(b.inputs[2].type, "IMAGE");
  assert.equal(b.onConnectOutput(0, "INT"), false);
  assert.equal(b.onConnectOutput(0, "IMAGE"), true);
  assert.equal(b.inputs[2].link, null);
  assert.equal(graph.links.has(mismatched), false);
  assert.equal(b.inputs[3].link, feedback);
  const inner = start(), innerEnd = end();
  await settle();
  connect(a, 1, inner, 0); connect(inner, 0, innerEnd, 0);
  await settle();
  assert.equal(innerEnd.inputs[2].type, "IMAGE");
  b.disconnectInput(0);
  await settle();
  assert.equal(b.inputs.length, 2);
  assert.equal(b.outputs.length, 0);
  assert.equal(graph.links.has(feedback), false);
  // The full packet -> return point -> conditional return chain carries types.
  const packets = packet(true), collected = packet(false), jump = start(), returned = end();
  await settle();
  connect(source, 2, packets, 0);
  connect(packets, 0, collected, 0);
  await settle();
  connect(packets, 1, collected, 1);
  await settle();
  connect(collected, 0, jump, 0);
  connect(jump, 0, returned, 0);
  await settle();
  for (const output of [packets.outputs[1], collected.outputs[0], jump.outputs[1], returned.outputs[0]]) {
    assert.equal(output.type, "IMAGE");
    assert.equal(output.label, "输出 1 · IMAGE");
  }
  assert.equal(collected.inputs[1].type, "IMAGE");
  assert.equal(returned.inputs[2].type, "IMAGE");
  assert.equal(collected.onConnectOutput(0, "INT"), false);
  assert.equal(collected.onConnectInput(1, "INT"), false);
  const stablePacketLink = collected.inputs[1].link;
  const stableJumpLink = jump.inputs[0].link;
  packets.disconnectInput(0);
  await settle();
  connect(source, 1, packets, 0);
  await settle();
  assert.equal(collected.inputs[1].link, stablePacketLink);
  assert.equal(jump.inputs[0].link, stableJumpLink);
  assert.equal(returned.outputs[0].type, "STRING");
  // Packet End follows its own result input, not the original packet input.
  collected.disconnectInput(1);
  await settle();
  connect(source, 0, collected, 1);
  await settle();
  assert.equal(packets.outputs[1].type, "STRING");
  assert.equal(collected.outputs[0].type, "INT");
  assert.equal(returned.inputs[2].type, "INT");
  collected.onConfigure(); packets.onConfigure(); extension.afterConfigureGraph();
  await settle();
  assert.equal(returned.outputs[0].type, "INT");
  // ARRAY containers are unpacked only by Start, and remain whole at End.
  source.addOutput("array", "ARRAY");
  packets.disconnectInput(0); collected.disconnectInput(1);
  await settle();
  connect(source, 4, packets, 0); connect(source, 4, collected, 1);
  await settle();
  assert.equal(packets.inputs[0].type, "ARRAY");
  assert.equal(packets.outputs[1].type, "*");
  assert.equal(packets.outputs[1].label, "输出 1 · 任意（数组元素）");
  assert.equal(collected.outputs[0].type, "ARRAY");
  assert.equal(returned.inputs[2].type, "ARRAY");
  // Memory controls grow beyond 100 pairs and reuse the same type propagation.
  function memoryControl(kind) {
    const n = make(kind);
    n.addInput("value0", "*"); n.addOutput("输出 1", "*");
    extension.nodeCreated(n);
    return n;
  }
  const ignore = memoryControl("LiuxinyuIgnoreMemoryChecks");
  const restore = memoryControl("LiuxinyuRestoreMemoryChecks");
  await settle();
  for (let i = 0; i < 150; i++) {
    connect(source, i % 3, ignore, i);
    await settle();
    connect(ignore, i, restore, i);
    await settle();
  }
  assert.equal(ignore.inputs.length, 151);
  assert.equal(restore.outputs.length, 150);
  assert.equal(restore.outputs[149].type, "IMAGE");
  assert.equal(restore.outputs[148].type, "STRING");
  const preserved = restore.inputs[149].link;
  ignore.disconnectInput(149); connect(source, 0, ignore, 149);
  await settle();
  assert.equal(restore.inputs[149].link, preserved);
  assert.equal(restore.outputs[149].type, "INT");
  ignore.onConfigure(); restore.onConfigure(); extension.afterConfigureGraph();
  await settle();
  assert.equal(restore.outputs[149].label, "输出 150 · INT");
  restore.disconnectInput(149); ignore.disconnectInput(149);
  await settle();
  assert.equal(ignore.inputs.length, 150);
  assert.equal(restore.inputs.length, 150);
  const packetControl = memoryControl("LiuxinyuIgnoreMemoryChecks");
  await settle();
  connect(collected, 0, packetControl, 0);
  await settle();
  collected.disconnectInput(1);
  await settle();
  connect(source, 1, collected, 1);
  await settle();
  assert.equal(packetControl.outputs[0].type, "STRING");
  assert.notEqual(packetControl.inputs[0].link, null);
  console.log("Conditional and memory sockets: types, 150 pairs, restore, disconnect and nesting passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
