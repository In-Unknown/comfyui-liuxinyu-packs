const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  const notices = [];
  let extension;
  const app = { registerExtension(e) { extension = e; }, extensionManager: { toast: { add(e) { notices.push(e); } } } };
  const context = { app, queueMicrotask };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "virtual_connections.js"), "utf8")
    .replace(/^import .*;$/m, "") + "\nglobalThis.testApi = { compileConnections, validateCanvas, sync, entries };", context);
  const { compileConnections, validateCanvas, sync } = context.testApi;
  const SEND = "LiuxinyuVirtualOutput", RECEIVE = "LiuxinyuVirtualInput";
  let nextNode = 1, nextLink = 1;
  const root = { _nodes: [], links: new Map(), getNodeById(id) { return this._nodes.find(n => n.id === id); } };
  root.rootGraph = root;
  app.rootGraph = root;
  function make(kind, graph = root, nativeKey = false) {
    const node = {
      id: nextNode++, comfyClass: kind, type: kind, mode: 0, graph,
      inputs: [], outputs: [], widgets: [{ name: "key", value: "" }], size: [240, 70],
      addInput(name, type) { this.inputs.push({ name, type, link: null }); },
      addOutput(name, type) { this.outputs.push({ name, type, links: [] }); },
      disconnectInput(index) {
        const input = this.inputs[index];
        const link = this.graph.links.get(input.link);
        if (!link) return;
        const source = this.graph.getNodeById(link.origin_id);
        if (source) source.outputs[link.origin_slot].links = source.outputs[link.origin_slot].links.filter(id => id !== link.id);
        input.link = null;
        this.graph.links.delete(link.id);
        source?.onConnectionsChange?.(); this.onConnectionsChange?.();
      },
      removeInput(index) {
        this.disconnectInput(index); this.inputs.splice(index, 1);
        for (const link of this.graph.links.values()) {
          if (link.target_id === this.id && link.target_slot > index) link.target_slot--;
        }
      },
      removeOutput(index) {
        for (const id of [...this.outputs[index].links]) {
          const link = this.graph.links.get(id);
          this.graph.getNodeById(link.target_id).disconnectInput(link.target_slot);
        }
        this.outputs.splice(index, 1);
        for (const link of this.graph.links.values()) {
          if (link.origin_id === this.id && link.origin_slot > index) link.origin_slot--;
        }
      },
      computeSize() { return [240, 50 + Math.max(this.inputs.length, this.outputs.length) * 20]; },
      setSize(size) { this.size = size; }, setDirtyCanvas() {},
    };
    if (nativeKey) node.inputs.push({ name: "key", type: "STRING", link: null, widget: { name: "key" } });
    graph._nodes.push(node);
    extension.nodeCreated(node);
    node.onAdded?.();
    return node;
  }
  function connect(source, slot, target, input) {
    assert.notEqual(source.onConnectOutput?.(slot, target.inputs[input].type), false);
    assert.notEqual(target.onConnectInput?.(input, source.outputs[slot].type), false);
    assert.equal(source.graph, target.graph);
    const link = { id: nextLink++, origin_id: source.id, origin_slot: slot, target_id: target.id, target_slot: input, type: source.outputs[slot].type };
    source.graph.links.set(link.id, link);
    source.outputs[slot].links.push(link.id); target.inputs[input].link = link.id;
    source.onConnectionsChange?.(); target.onConnectionsChange?.();
    return link.id;
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));
  async function key(node, value) {
    node.widgets[0].value = value; node.widgets[0].callback(); await settle();
  }
  const send = make(SEND), receive = make(RECEIVE);
  await settle();
  assert.equal(send.inputs.length, 0); assert.equal(send.outputs.length, 0);
  assert.equal(receive.inputs.length, 0); assert.equal(receive.outputs.length, 0);
  await key(send, "test");
  assert.equal(send.inputs.length, 1); assert.equal(send.inputs[0].type, "*");
  const source = make("Source");
  source.addOutput("image", "IMAGE"); source.addOutput("text", "STRING");
  source.addOutput("array", "ARRAY");
  const imageLink = connect(source, 0, send, 0); await settle();
  assert.equal(send.inputs.length, 2);
  await key(receive, "test");
  assert.equal(receive.outputs.length, 2); assert.equal(receive.outputs[0].type, "IMAGE");
  const target = make("Target"); target.addInput("image", "IMAGE"); target.addInput("text", "STRING");
  const targetLink = connect(receive, 0, target, 0);
  connect(source, 1, send, 1); await settle();
  connect(receive, 1, target, 1); await settle();
  assert.equal(send.inputs.length, 3); assert.equal(receive.outputs.length, 3);
  assert.equal(receive.outputs[1].type, "STRING");
  assert.equal(receive.onConnectOutput(0, "INT"), false);
  const duplicate = make(RECEIVE); await settle(); await key(duplicate, "test");
  assert.equal(duplicate.widgets[0].value, "test"); assert.equal(duplicate.outputs.length, 3);
  assert.equal(notices.length, 0);
  const secondTarget = make("SecondTarget"); secondTarget.addInput("text", "STRING");
  connect(duplicate, 1, secondTarget, 0); await settle();
  duplicate.onConfigure(); await settle();
  assert.equal(duplicate.widgets[0].value, "test");
  const duplicateSender = make(SEND); await settle(); await key(duplicateSender, "test");
  assert.equal(duplicateSender.widgets[0].value, "");
  assert.ok(notices.at(-1).detail.includes("test"));
  assert.equal(send.inputs[0].link, imageLink);
  assert.equal(target.inputs[0].link, targetLink);
  validateCanvas(root);
  secondTarget.inputs[0].type = "INT";
  assert.throws(() => validateCanvas(root), new RegExp(`类型不匹配.*${duplicate.id}`));
  secondTarget.inputs[0].type = "STRING";
  const before = JSON.stringify([send.inputs, receive.outputs, [...root.links.values()]]);
  send.onConfigure(); receive.onConfigure(); extension.afterConfigureGraph(); await settle();
  assert.equal(JSON.stringify([send.inputs, receive.outputs, [...root.links.values()]]), before);
  // Existing incompatible cables are retained and reported, not silently removed.
  source.outputs[0].type = "INT"; send.onConnectionsChange(); await settle();
  assert.equal(target.inputs[0].link, targetLink);
  assert.throws(() => validateCanvas(root), /类型不匹配/);
  source.outputs[0].type = "IMAGE"; send.onConnectionsChange(); await settle();
  validateCanvas(root);
  // Receiver-first discovery and growth also work across nested subgraphs.
  const subgraph = { ...root, _nodes: [], links: new Map(), rootGraph: root };
  const subgraphNode = make("Subgraph"); subgraphNode.subgraph = subgraph;
  const rx = make(RECEIVE, subgraph); await settle(); await key(rx, "reverse");
  const rx2 = make(RECEIVE); await settle(); await key(rx2, "reverse");
  const downstream = make("Downstream", subgraph); downstream.addInput("array", "ARRAY");
  connect(rx, 0, downstream, 0); await settle();
  assert.equal(rx.outputs[0].type, "ARRAY"); assert.equal(rx.outputs.length, 2);
  assert.equal(rx2.outputs[0].type, "ARRAY"); assert.equal(rx2.outputs.length, 2);
  const tx = make(SEND); await settle(); await key(tx, "reverse");
  assert.equal(tx.inputs[0].type, "ARRAY"); assert.equal(tx.inputs.length, 2);
  assert.throws(() => validateCanvas(root), /对应输入未连接/);
  connect(source, 2, tx, 0); await settle(); validateCanvas(root);
  const extraTarget = make("ExtraTarget"); extraTarget.addInput("array", "ARRAY");
  connect(rx2, 1, extraTarget, 0); await settle();
  assert.equal(tx.inputs.length, 3); assert.equal(rx.outputs.length, 3);
  assert.throws(() => validateCanvas(root), /第 2 路/);
  extraTarget.disconnectInput(0); await settle();
  assert.equal(tx.inputs.length, 2); assert.equal(rx.outputs.length, 2);
  // More than 100 lanes are accepted; no unrelated port indices move.
  for (let i = 1; i < 105; i++) { connect(source, 2, tx, i); await settle(); }
  assert.equal(tx.inputs.length, 106); assert.equal(rx.outputs.length, 106);
  assert.equal(rx2.outputs.length, 106);
  await key(tx, "renamed");
  assert.throws(() => validateCanvas(root), /未找到传入虚拟连接/);
  await key(rx, "renamed"); validateCanvas(root);
  // Empty keys remove all data sockets, including their actual cables.
  await key(tx, ""); assert.equal(tx.inputs.length, 0); assert.equal(tx.outputs.length, 0);
  await key(rx, ""); assert.equal(rx.outputs.length, 0); assert.equal(downstream.inputs[0].link, null);
  // Compile a flattened prompt: two lanes, nested IDs, list-transparent direct links.
  const original = {
    source: { class_type: "RealSource", inputs: {} },
    "20:send": { class_type: SEND, inputs: { key: "cross", value0: ["source", 0], value1: ["source", 1] } },
    "40:rx": { class_type: RECEIVE, inputs: { key: "cross" } },
    target: { class_type: "RealTarget", inputs: { a: ["40:rx", 0], b: ["40:rx", 1] } },
  };
  const snapshot = JSON.stringify(original);
  const compiled = compileConnections(original);
  assert.equal(JSON.stringify(compiled.target.inputs), JSON.stringify({ a: ["source", 0], b: ["source", 1] }));
  assert.equal(Object.keys(compiled).length, 2); assert.equal(JSON.stringify(original), snapshot);
  assert.throws(() => compileConnections({ ...original, extra: original["20:send"] }), /重复传入/);
  const fanout = { ...original, "50:rx": original["40:rx"],
    secondTarget: { class_type: "RealTarget", inputs: { a: ["50:rx", 0], b: ["50:rx", 1] } } };
  const expanded = compileConnections(fanout);
  assert.equal(JSON.stringify(expanded.secondTarget.inputs), JSON.stringify(compiled.target.inputs));
  assert.equal(Object.keys(expanded).length, 3);
  const brokenFanout = structuredClone(fanout); brokenFanout.secondTarget.inputs.a = ["50:rx", 2];
  assert.throws(() => compileConnections(brokenFanout), /第 3 路/);
  const missing = structuredClone(original); delete missing["20:send"];
  assert.throws(() => compileConnections(missing), /没有配对/);
  const lane = structuredClone(original); delete lane["20:send"].inputs.value1;
  assert.throws(() => compileConnections(lane), /第 2 路/);
  const cycle = structuredClone(original); cycle.source.inputs = { a: ["40:rx", 0] };
  assert.throws(() => compileConnections(cycle), /依赖环/);
  const chain = structuredClone(original);
  chain["second-send"] = { class_type: SEND, inputs: { key: "chain", value0: ["40:rx", 1] } };
  chain["second-rx"] = { class_type: RECEIVE, inputs: { key: "chain" } };
  chain.target.inputs.a = ["second-rx", 0];
  assert.equal(JSON.stringify(compileConnections(chain).target.inputs.a), JSON.stringify(["source", 1]));
  chain["20:send"].inputs.value1 = ["second-rx", 0];
  assert.throws(() => compileConnections(chain), /循环配对/);
  // Do not unwrap array-valued constants from the native prompt wrapper.
  const literal = structuredClone(original);
  literal["20:send"].inputs.value0 = { __value__: [1, [2, 3]] };
  assert.equal(JSON.stringify(compileConnections(literal).target.inputs.a), JSON.stringify({ __value__: [1, [2, 3]] }));
  // The setup wrapper preserves canvas serialization and delegates other wrappers.
  let delegated = 0;
  app.graphToPrompt = async function (graph) { assert.equal(graph, root); delegated++; return { output: original, workflow: { saved: true } }; };
  extension.setup();
  const result = await app.graphToPrompt(root);
  assert.equal(delegated, 1); assert.equal(result.workflow.saved, true);
  assert.equal(JSON.stringify(result.output), JSON.stringify(compiled));
  // Repeated receiver-only subgraphs share one source; repeated senders fail.
  await key(rx, "instance");
  await key(tx, "instance");
  connect(source, 2, tx, 0); connect(rx, 0, downstream, 0); await settle();
  const copy = make("SubgraphCopy"); copy.subgraph = subgraph;
  validateCanvas(root);
  const nestedSender = make(SEND, subgraph); await settle(); await key(nestedSender, "nested-source");
  assert.throws(() => validateCanvas(root), /都是传入虚拟连接/);
  copy.subgraph = null;
  validateCanvas(root);
  // Real frontend versions keep a hidden widget-backed key input in inputs[].
  // It must never consume a data lane or change the valueN prompt mapping.
  const nativeSend = make(SEND, root, true), nativeReceive = make(RECEIVE, root, true);
  await settle();
  const keySlot = nativeSend.inputs[0];
  assert.equal(nativeSend.inputs.length, 1); assert.equal(nativeReceive.outputs.length, 0);
  await key(nativeSend, "native-key"); await key(nativeReceive, "native-key");
  const nativeLink = connect(source, 1, nativeSend, 1); await settle();
  assert.equal(nativeSend.inputs[1].name, "value0");
  assert.equal(nativeSend.inputs[1].label, "输入 1 · STRING");
  assert.equal(nativeSend.inputs[2].name, "value1");
  assert.equal(nativeSend.inputs[2].label, "输入 2 · 任意");
  assert.equal(nativeReceive.outputs.length, 2);
  assert.equal(nativeReceive.outputs[0].type, "STRING");
  assert.equal(nativeReceive.outputs[1].type, "*");
  assert.equal(keySlot.type, "STRING"); assert.equal(keySlot.label, undefined);
  const nativeTarget = make("NativeTarget");
  nativeTarget.addInput("a", "STRING"); nativeTarget.addInput("b", "STRING");
  connect(nativeReceive, 0, nativeTarget, 0); await settle();
  // Restore the screenshot's stale extra typed output; it should disappear.
  nativeReceive.outputs[1].type = "STRING";
  nativeReceive.addOutput("输出 3", "*");
  keySlot.type = "*"; keySlot.label = "输入 1 · 任意";
  nativeSend.onConfigure(); nativeReceive.onConfigure(); extension.afterConfigureGraph(); await settle();
  assert.equal(keySlot.type, "STRING"); assert.equal(keySlot.label, undefined);
  assert.equal(nativeReceive.outputs.length, 2); assert.equal(nativeReceive.outputs[1].type, "*");
  assert.equal(nativeSend.inputs[1].link, nativeLink);
  validateCanvas(root);
  connect(nativeReceive, 1, nativeTarget, 1); await settle();
  assert.throws(() => validateCanvas(root), new RegExp(`第 2 路.*${nativeReceive.id}.*${nativeSend.id}.*对应输入未连接`));
  const delegatedBefore = delegated;
  await assert.rejects(app.graphToPrompt(root), /第 2 路.*缺少有效输入/);
  assert.equal(delegated, delegatedBefore, "Missing data must stop before prompt submission/export");
  connect(source, 1, nativeSend, 2); await settle(); validateCanvas(root);
  // A source cable pointing to a nonexistent socket is also an error.
  root.links.get(nativeLink).origin_slot = 99;
  assert.throws(() => validateCanvas(root), /上游接口不存在/);
  root.links.get(nativeLink).origin_slot = 1;
  nativeTarget.disconnectInput(1); nativeSend.disconnectInput(2); await settle();
  assert.equal(nativeReceive.outputs.length, 2); assert.equal(nativeReceive.outputs[1].type, "*");
  validateCanvas(root);
  await key(nativeSend, "");
  assert.equal(nativeSend.inputs.length, 1); assert.equal(nativeSend.inputs[0], keySlot);
  assert.throws(() => validateCanvas(root), /未找到传入虚拟连接/);
  await key(nativeReceive, ""); validateCanvas(root);
  // Bidirectional growth, shared retention, and middle-lane removal across graphs.
  const shrinkSend = make(SEND, root, true);
  const shrinkA = make(RECEIVE), shrinkB = make(RECEIVE, subgraph);
  await settle();
  await key(shrinkSend, "shrink"); await key(shrinkA, "shrink"); await key(shrinkB, "shrink");
  const shrinkTargetA = make("ShrinkTargetA"), shrinkTargetB = make("ShrinkTargetB", subgraph);
  for (const target of [shrinkTargetA, shrinkTargetB]) {
    target.addInput("image", "IMAGE"); target.addInput("text", "STRING"); target.addInput("array", "ARRAY");
  }
  connect(source, 0, shrinkSend, 1); await settle();
  assert.equal(shrinkA.outputs.length, 2); assert.equal(shrinkB.outputs.length, 2);
  connect(shrinkB, 1, shrinkTargetB, 1); await settle();
  assert.equal(shrinkSend.inputs.length, 4); assert.equal(shrinkA.outputs.length, 3);
  connect(source, 1, shrinkSend, 2); await settle();
  const keptInput = connect(source, 2, shrinkSend, 3); await settle();
  const keptOutputA = connect(shrinkA, 2, shrinkTargetA, 2);
  const keptOutputB = connect(shrinkB, 2, shrinkTargetB, 2);
  connect(shrinkA, 1, shrinkTargetA, 1); await settle();
  assert.equal(shrinkA.outputs.length, 4); assert.equal(shrinkB.outputs.length, 4);
  shrinkSend.disconnectInput(2); await settle();
  assert.equal(shrinkA.outputs.length, 4); // Both receivers still use the middle lane.
  assert.throws(() => validateCanvas(root), /第 2 路.*对应输入未连接/);
  shrinkTargetA.disconnectInput(1); await settle();
  assert.equal(shrinkA.outputs.length, 4); // Receiver B alone still retains it everywhere.
  shrinkTargetB.disconnectInput(1); await settle();
  assert.equal(shrinkSend.inputs.length, 4); // hidden key + two live lanes + spare
  for (const receiver of [shrinkA, shrinkB]) {
    assert.equal(receiver.outputs.length, 3);
    assert.equal(receiver.outputs[1].type, "ARRAY"); assert.equal(receiver.outputs[2].type, "*");
  }
  assert.equal(shrinkSend.inputs[2].name, "value1");
  assert.equal(shrinkSend.inputs[2].link, keptInput);
  assert.equal(root.links.get(keptInput).target_slot, 2);
  assert.equal(root.links.get(keptOutputA).origin_slot, 1);
  assert.equal(subgraph.links.get(keptOutputB).origin_slot, 1);
  assert.equal(shrinkTargetA.inputs[2].link, keptOutputA);
  assert.equal(shrinkTargetB.inputs[2].link, keptOutputB);
  validateCanvas(root);
  const afterShrink = compileConnections({
    source: { class_type: "Source", inputs: {} },
    send: { class_type: SEND, inputs: { key: "shrink", value0: ["source", 0], value1: ["source", 2] } },
    a: { class_type: RECEIVE, inputs: { key: "shrink" } },
    b: { class_type: RECEIVE, inputs: { key: "shrink" } },
    target: { class_type: "Target", inputs: {
      a: ["a", root.links.get(keptOutputA).origin_slot],
      b: ["b", subgraph.links.get(keptOutputB).origin_slot] } },
  });
  assert.equal(JSON.stringify(afterShrink.target.inputs), JSON.stringify({ a: ["source", 2], b: ["source", 2] }));
  shrinkTargetA.disconnectInput(2); shrinkTargetB.disconnectInput(2); await settle();
  assert.equal(shrinkA.outputs.length, 3); // Sender still connected, keep the lane.
  shrinkSend.disconnectInput(2); await settle();
  assert.equal(shrinkA.outputs.length, 2); assert.equal(shrinkB.outputs.length, 2);
  shrinkSend.disconnectInput(1); await settle();
  assert.equal(shrinkSend.inputs.length, 2); // hidden key + one spare
  assert.equal(shrinkA.outputs.length, 1); assert.equal(shrinkB.outputs.length, 1);
  assert.equal(shrinkA.outputs[0].type, "*"); validateCanvas(root);
  console.log("PASS: blank keys, one-to-many pairing, unique sender, receiver-first discovery, 105 lanes, all receiver type checks, reload, reused subgraphs, compile/export and cycles.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
