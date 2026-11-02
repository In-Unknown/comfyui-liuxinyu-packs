import { app } from "../../scripts/app.js";

const START = "LiuxinyuPacketReturnStart";
const END = "LiuxinyuPacketReturnEnd";
const HANDLE = "LIUXINYU_PACKET_RETURN";
const pending = new Set();
const kind = node => node?.comfyClass || node?.type;
const cable = (graph, id) => graph?.links?.get?.(id) || graph?.links?.[id];

function upstream(node, input) {
  const link = cable(node.graph, input?.link);
  const source = link && node.graph.getNodeById(link.origin_id);
  const boundary = link?.origin_id === -10 ? node.graph.inputs?.[link.origin_slot] : null;
  return { source, link, output: source?.outputs?.[link?.origin_slot] || boundary };
}

function lane(input, group) {
  const match = input.name.match(new RegExp(`^${group}\\.(?:packet|state)(\\d+)$`));
  return match ? Number(match[1]) : -1;
}

function connected(node, group) {
  return (node?.inputs || []).filter(input => lane(input, group) >= 0 && input.link != null)
    .sort((a, b) => lane(a, group) - lane(b, group));
}

function reconcileOutputs(node, wanted) {
  let changed = false;
  const names = new Set(wanted.map(output => output.name));
  for (let i = node.outputs.length - 1; i >= 0; i--) {
    if (!names.has(node.outputs[i].name)) { node.removeOutput(i); changed = true; }
  }
  for (const output of wanted) {
    if (!node.outputs.some(p => p.name === output.name)) { node.addOutput(output.name, output.type); changed = true; }
  }
  // Snapshot cables before moving slots: modern LiteGraph resolves links by slot index.
  const links = new Map(node.outputs.map(p => [p, [...(p.links || [])].map(id => cable(node.graph, id)).filter(Boolean)]));
  const ordered = wanted.map(spec => node.outputs.find(p => p.name === spec.name));
  if (ordered.some((output, i) => node.outputs[i] !== output)) {
    node.outputs.splice(0, node.outputs.length, ...ordered);
    changed = true;
  }
  wanted.forEach((spec, i) => {
    const output = node.outputs[i];
    if (output.label !== spec.name || output.type !== spec.type) changed = true;
    output.label = spec.name;
    output.type = spec.type;
    output.slot_index = i;
    for (const link of links.get(output) || []) { link.origin_slot = i; link.type = spec.type; }
  });
  return changed;
}

function updateStart(node) {
  const states = connected(node, "states"), packets = connected(node, "packets");
  const outputs = [{name: "分包回归条件", type: HANDLE},
    ...states.map(input => ({name: `当前被处理数据${lane(input, "states") + 1}`, type: upstream(node, input).output?.type || "*"})),
    ...packets.map(input => ({name: `当前分包数据${lane(input, "packets") + 1}`, type: "*"})),
    {name: "当前轮次数", type: "INT"}];
  let changed = reconcileOutputs(node, outputs);
  for (const input of node.inputs) {
    const state = lane(input, "states"), packet = lane(input, "packets");
    const label = state >= 0 ? `被处理数据${state + 1}` : packet >= 0 ? `分包数据${packet + 1}` : null;
    if (label && input.label !== label) { input.label = label; changed = true; }
  }
  return changed;
}

function updateEnd(node) {
  const pair = upstream(node, node.inputs.find(p => p.name === "handle"));
  const start = kind(pair.source) === START && pair.link.origin_slot === 0 ? pair.source : null;
  const states = connected(start, "states");
  const wanted = new Set(["handle", ...(start ? ["condition"] : []), ...states.map(p => p.name)]);
  let changed = false;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    if (!wanted.has(node.inputs[i].name)) { node.removeInput(i); changed = true; }
  }
  if (start && !node.inputs.some(p => p.name === "condition")) {
    node.addInput("condition", "BOOLEAN", {widget: {name: "condition"}});
    changed = true;
  }
  for (const input of states) {
    if (!node.inputs.some(p => p.name === input.name)) { node.addInput(input.name, "*"); changed = true; }
    const target = node.inputs.find(p => p.name === input.name);
    const label = `处理完成数据${lane(input, "states") + 1}`;
    if (target.label !== label) { target.label = label; changed = true; }
    const type = upstream(start, input).output?.type || "*";
    if (target.type !== type) { target.type = type; changed = true; }
  }
  for (const widget of node.widgets || []) {
    if (["condition", "operation"].includes(widget.name) && widget.hidden !== !start) {
      widget.hidden = !start;
      changed = true;
    }
  }
  return reconcileOutputs(node, states.map(input => ({
    name: `处理完成数据${lane(input, "states") + 1}`, type: upstream(start, input).output?.type || "*",
  }))) || changed;
}

function sync(graph) {
  const nodes = (graph?._nodes || []).filter(n => [START, END].includes(kind(n)));
  for (let pass = 0; pass <= nodes.length; pass++) {
    let changed = false;
    for (const node of nodes) {
      const updated = kind(node) === START ? updateStart(node) : updateEnd(node);
      if (updated) {
        const size = node.computeSize();
        node.setSize([Math.max(node.size[0], size[0]), size[1]]);
        node.setDirtyCanvas(true, true);
      }
      changed = updated || changed;
    }
    if (!changed) break;
  }
}

function schedule(graph) {
  if (!graph || pending.has(graph)) return;
  pending.add(graph);
  queueMicrotask(() => { pending.delete(graph); sync(graph); });
}

function tree(graph) {
  sync(graph);
  for (const node of graph?._nodes || []) if (node.subgraph) tree(node.subgraph);
}

app.registerExtension({
  name: "liuxinyu.PacketReturn",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (![START, END].includes(nodeData.name)) return;
    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (data) {
      // ComfyNode.configure overlays output names/types by schema index. Our
      // saved outputs are compact, so seed that layout before the overlay;
      // otherwise packet sockets become unused state sockets and lose cables.
      if (data.outputs) this.outputs = data.outputs.map(({links, ...output}) => ({...output}));
      return configure.apply(this, arguments);
    };
    if (nodeData.name !== END) return;
    // The server still uses Autogrow to accept state inputs. On the canvas,
    // this group belongs to the paired Start, so it has no independent spare.
    for (const section of ["required", "optional"]) {
      if (nodeData.input?.[section]) delete nodeData.input[section].states;
    }
  },
  setup() {
    const original = app.graphToPrompt;
    app.graphToPrompt = async function (graph = app.rootGraph || app.graph, ...args) {
      tree(graph);
      return original.call(this, graph, ...args);
    };
  },
  nodeCreated(node) {
    if (![START, END].includes(kind(node))) return;
    const connect = node.onConnectInput;
    node.onConnectInput = function (slot, type, output, source, sourceSlot) {
      if (kind(this) === END && this.inputs[slot]?.name === "handle" && (kind(source) !== START || sourceSlot !== 0)) return false;
      return connect?.apply(this, arguments) ?? true;
    };
    for (const event of ["onAdded", "onConfigure", "onConnectionsChange", "onRemoved"]) {
      const original = node[event];
      node[event] = function (...args) {
        const graph = this.graph;
        const result = original?.apply(this, args);
        schedule(graph);
        return result;
      };
    }
    schedule(node.graph);
  },
  afterConfigureGraph() { tree(app.rootGraph || app.graph); },
});
