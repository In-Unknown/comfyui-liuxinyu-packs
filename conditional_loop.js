import { app } from "../../scripts/app.js";

const START = "LiuxinyuReturnPoint";
const END = "LiuxinyuConditionalReturn";
const CONTROLS = ["LiuxinyuIgnoreMemoryChecks", "LiuxinyuRestoreMemoryChecks"];
const GROWING = [START, ...CONTROLS];
const TYPES = [...GROWING, END];
const HANDLE = "LIUXINYU_RETURN_HANDLE";
const LIMIT = 100;
const pending = new Set();

function kind(node) { return node?.comfyClass || node?.type; }
function link(graph, id) { return graph?.links?.get?.(id) || graph?.links?.[id]; }
function origin(node, input) {
  const cable = link(node.graph, input?.link);
  const source = cable && node.graph.getNodeById(cable.origin_id);
  return { cable, source, output: source?.outputs?.[cable?.origin_slot] };
}
function compatible(a, b) {
  if (!a || !b || a === "*" || b === "*") return true;
  const left = String(a).split(",").map(value => value.trim());
  return String(b).split(",").some(value => left.includes(value.trim()));
}
function socketLabel(socket, direction, index, type) {
  const label = `${direction} ${index + 1} · ${type === "*" ? "任意" : type}`;
  if (socket.label === label) return false;
  socket.label = label;
  return true;
}
function resize(node) {
  const minimum = node.computeSize();
  node.setSize([Math.max(node.size[0], minimum[0]), minimum[1]]);
  node.setDirtyCanvas(true, true);
}
function inputType(node, index, type) {
  const input = node.inputs[index];
  if (input.type === type) return false;
  input.type = type;
  const upstream = origin(node, input).output;
  if (input.link != null && upstream && !compatible(upstream.type, type)) node.disconnectInput(index);
  return true;
}
function outputType(node, index, type) {
  const output = node.outputs[index];
  if (output.type === type) return false;
  output.type = type;
  for (const id of [...(output.links || [])]) {
    const cable = link(node.graph, id);
    if (!cable) continue;
    cable.type = type;
    const target = node.graph.getNodeById(cable.target_id);
    const input = target?.inputs?.[cable.target_slot];
    // A nested return point derives its type from this output on the next pass.
    const pairedReturn = kind(node) === START && kind(target) === END &&
      origin(target, target.inputs[0]).source === node && cable.target_slot === index + 1;
    const packetData = ["LiuxinyuPacketStart", "LiuxinyuPacketEnd"].includes(kind(target)) && /^value\d+$/.test(input?.name || "");
    if (input && !GROWING.includes(kind(target)) && !pairedReturn && !packetData && !compatible(type, input.type)) {
      target.disconnectInput(cable.target_slot);
    } else {
      target?.onConnectionsChange?.(1, cable.target_slot, true, cable, input);
    }
  }
  return true;
}
function updateStart(node) {
  const offset = kind(node) === START ? 1 : 0;
  let last = -1;
  node.inputs.forEach((input, index) => { if (input.link != null) last = Math.max(last, index); });
  node.outputs.slice(offset).forEach((output, index) => { if (output.links?.length) last = Math.max(last, index); });
  const count = offset ? Math.min(LIMIT, last + 2) : last + 2;
  const outputCount = Math.max(0, last + 1);
  let changed = node.inputs.length !== count || node.outputs.length !== outputCount + offset;
  while (node.inputs.length > count) node.removeInput(node.inputs.length - 1);
  while (node.outputs.length > outputCount + offset) node.removeOutput(node.outputs.length - 1);
  while (node.inputs.length < count) node.addInput(`value${node.inputs.length}`, "*");
  while (node.outputs.length < outputCount + offset) node.addOutput(`输出 ${node.outputs.length - offset + 1}`, "*");
  for (let i = 0; i < count; i++) {
    const type = origin(node, node.inputs[i]).output?.type || "*";
    changed = socketLabel(node.inputs[i], "输入", i, type) || changed;
    changed = inputType(node, i, type) || changed;
    if (i < outputCount) {
      changed = socketLabel(node.outputs[i + offset], "输出", i, type) || changed;
      changed = outputType(node, i + offset, type) || changed;
    }
  }
  if (offset) node.outputs[0].type = HANDLE;
  if (changed) resize(node);
  return changed;
}
function updateEnd(node) {
  const upstream = origin(node, node.inputs[0]);
  const start = kind(upstream.source) === START && upstream.cable.origin_slot === 0 ? upstream.source : null;
  let count = 0;
  start?.inputs.forEach((input, index) => { if (input.link != null) count = index + 1; });
  const conditionLabel = "跳回循环（true）/ 进入下游（false）";
  let changed = node.inputs.length !== count + 2 || node.outputs.length !== count || node.inputs[1].label !== conditionLabel;
  node.inputs[1].label = conditionLabel;
  while (node.inputs.length > count + 2) node.removeInput(node.inputs.length - 1);
  while (node.outputs.length > count) node.removeOutput(node.outputs.length - 1);
  while (node.inputs.length < count + 2) node.addInput(`value${node.inputs.length - 2}`, "*");
  while (node.outputs.length < count) node.addOutput(`输出 ${node.outputs.length + 1}`, "*");
  for (let i = 0; i < count; i++) {
    const type = start.inputs[i].type || "*";
    changed = socketLabel(node.inputs[i + 2], "输入", i, type) || changed;
    changed = socketLabel(node.outputs[i], "输出", i, type) || changed;
    changed = inputType(node, i + 2, type) || changed;
    changed = outputType(node, i, type) || changed;
  }
  if (changed) resize(node);
  return changed;
}
function sync(graph) {
  const nodes = (graph?._nodes || []).filter(node => TYPES.includes(kind(node)));
  // Propagate types through nested/serial loops without depending on canvas order.
  for (let pass = 0; pass <= nodes.length; pass++) {
    let changed = false;
    for (const node of nodes.filter(node => GROWING.includes(kind(node)))) changed = updateStart(node) || changed;
    for (const node of nodes.filter(node => kind(node) === END)) changed = updateEnd(node) || changed;
    if (!changed) break;
  }
}
function schedule(graph) {
  if (!graph || pending.has(graph)) return;
  pending.add(graph);
  queueMicrotask(() => { pending.delete(graph); sync(graph); });
}
function syncTree(graph) {
  if (!graph) return;
  schedule(graph);
  for (const node of graph._nodes || []) if (node.subgraph) syncTree(node.subgraph);
}

app.registerExtension({
  name: "liuxinyu.ConditionalLoop",
  nodeCreated(node) {
    if (!TYPES.includes(kind(node))) return;
    const connect = node.onConnectInput;
    node.onConnectInput = function (slot, type, output, source, sourceSlot) {
      if (kind(this) === START) return slot < LIMIT;
      if (CONTROLS.includes(kind(this))) return true;
      if (slot === 0 && (kind(source) !== START || sourceSlot !== 0)) return false;
      if (!compatible(type, this.inputs[slot]?.type)) return false;
      return connect?.apply(this, arguments) ?? true;
    };
    const connectOutput = node.onConnectOutput;
    node.onConnectOutput = function (slot, type) {
      if (!compatible(this.outputs[slot]?.type, type)) return false;
      return connectOutput?.apply(this, arguments) ?? true;
    };
    for (const event of ["onAdded", "onConfigure", "onConnectionsChange"]) {
      const original = node[event];
      node[event] = function (...args) {
        const result = original?.apply(this, args);
        schedule(this.graph);
        return result;
      };
    }
    const removed = node.onRemoved;
    node.onRemoved = function (...args) {
      const graph = this.graph;
      const result = removed?.apply(this, args);
      schedule(graph);
      return result;
    };
    schedule(node.graph);
  },
  afterConfigureGraph() {
    syncTree(app.rootGraph || app.graph);
  },
});
