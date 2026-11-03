import { app } from "../../scripts/app.js";

const SEND = "LiuxinyuVirtualOutput";
const RECEIVE = "LiuxinyuVirtualInput";
const TYPES = [SEND, RECEIVE];
const kind = node => node?.comfyClass || node?.type;
const keyOf = node => node.widgets?.find(w => w.name === "key")?.value || "";
const dataInput = (node, lane) => node.inputs?.find(port => port.name === `value${lane}`);
const cable = (graph, id) => graph?.links?.get?.(id) || graph?.links?.[id];
const isLink = value => Array.isArray(value) && value.length === 2 &&
  typeof value[0] === "string" && Number.isInteger(value[1]);
let pending = false;
let syncing = false;

function compatible(a, b) {
  if (!a || !b || a === "*" || b === "*") return true;
  if (globalThis.LiteGraph?.isValidConnection) return LiteGraph.isValidConnection(a, b);
  const left = String(a).split(",").map(t => t.trim());
  return String(b).split(",").some(t => left.includes(t.trim()));
}

function entries(root, path = [], parents = new Set()) {
  if (!root || parents.has(root)) return [];
  const result = [];
  for (const node of root._nodes || []) {
    const id = [...path, node.id].join(":");
    if (TYPES.includes(kind(node))) result.push({ node, id });
    if (node.subgraph) result.push(...entries(node.subgraph, [...path, node.id], new Set([...parents, root])));
  }
  return result;
}

function notify(message) {
  app.extensionManager.toast.add({ severity: "warn", summary: "虚拟连接", detail: message, life: 7000 });
}

function rejectDuplicate(node) {
  const key = keyOf(node);
  if (!key || !node.graph || kind(node) !== SEND) return;
  const other = entries(node.graph.rootGraph || app.rootGraph || node.graph)
    .find(e => e.node !== node && kind(e.node) === kind(node) && keyOf(e.node) === key);
  if (!other) return;
  node.widgets.find(w => w.name === "key").value = "";
  notify(`键“${key}”已有传入虚拟连接（${other.id}），已清空当前节点的键。`);
}

function inputSource(node, slot) {
  const link = cable(node.graph, dataInput(node, slot)?.link);
  if (!link) return null;
  const source = node.graph.getNodeById(link.origin_id);
  const port = link.origin_id === -10 ? node.graph.inputs?.[link.origin_slot] : source?.outputs?.[link.origin_slot];
  return { link, port };
}

function outputTargets(node, slot) {
  return (node.outputs?.[slot]?.links || []).map(id => {
    const link = cable(node.graph, id);
    if (!link) return null;
    const target = node.graph.getNodeById(link.target_id);
    const port = link.target_id === -20 ? node.graph.outputs?.[link.target_slot] : target?.inputs?.[link.target_slot];
    return { link, port, target };
  }).filter(Boolean);
}

function lastConnected(node) {
  let last = -1;
  if (kind(node) === SEND) {
    for (const port of node.inputs || []) {
      const match = /^value(\d+)$/.exec(port.name);
      if (match && port.link != null) last = Math.max(last, Number(match[1]));
    }
  } else node.outputs?.forEach((port, i) => { if (port.links?.length) last = i; });
  return last;
}

function resizePorts(node, count) {
  if (kind(node) === SEND) {
    let changed = false;
    // Native widget-backed inputs can include a hidden key slot. Only valueN
    // sockets are data lanes; keep the key widget's native serialization intact.
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      const match = /^value(\d+)$/.exec(node.inputs[i].name);
      if (match && Number(match[1]) >= count) { node.removeInput(i); changed = true; }
    }
    for (let i = 0; i < count; i++) {
      if (!dataInput(node, i)) { node.addInput(`value${i}`, "*"); changed = true; }
    }
    return changed;
  }
  const changed = node.outputs.length !== count;
  while (node.outputs.length > count) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < count) node.addOutput(`输出 ${node.outputs.length + 1}`, "*");
  return changed;
}

function setType(node, slot, type) {
  const send = kind(node) === SEND;
  const port = send ? dataInput(node, slot) : node.outputs[slot];
  const label = `${send ? "输入" : "输出"} ${slot + 1} · ${type === "*" ? "任意" : type}`;
  if (port.type === type && port.label === label) return false;
  port.type = type;
  port.label = label;
  if (!send) for (const { link, target, port: input } of outputTargets(node, slot)) {
    link.type = type;
    target?.onConnectionsChange?.(1, link.target_slot, true, link, input);
  }
  return true;
}

function sync(root) {
  if (!root || syncing || app.configuringGraph) return;
  syncing = true;
  try {
    const nodes = [...new Set(entries(root).map(e => e.node))];
    const pairs = new Map();
    for (const node of nodes) {
      const keyPort = node.inputs?.find(port => port.name === "key");
      if (keyPort) {
        keyPort.type = "STRING";
        if (/^输入 \d+ ·/.test(keyPort.label || "")) delete keyPort.label;
      }
      const key = keyOf(node);
      if (!key) {
        if (resizePorts(node, 0)) {
          node.setSize(node.computeSize());
          node.setDirtyCanvas(true, true);
        }
        continue;
      }
      if (!pairs.has(key)) pairs.set(key, { receivers: [] });
      const pair = pairs.get(key);
      // Edited/copied nodes are handled by rejectDuplicate. A malformed saved
      // graph keeps its data and is rejected explicitly at submission.
      if (kind(node) === RECEIVE) pair.receivers.push(node);
      else if (!pair.send) pair.send = node;
    }
    for (let pass = 0; pass <= nodes.length; pass++) {
      let changed = false;
      for (const { send, receivers } of pairs.values()) {
        const endpoints = [send, ...receivers].filter(Boolean);
        let count = Math.max(...endpoints.map(lastConnected)) + 2;
        let resized = false;
        for (const node of endpoints) resized = resizePorts(node, count) || resized;
        // Remove a lane only after the sender and every receiver release it.
        // Native slot removal updates real link indices before we renumber lanes.
        for (let i = count - 2; i >= 0; i--) {
          if (send && dataInput(send, i)?.link != null) continue;
          if (receivers.some(receive => receive.outputs[i]?.links?.length)) continue;
          if (send) {
            send.removeInput(send.inputs.indexOf(dataInput(send, i)));
            for (let j = i + 1; j < count; j++) dataInput(send, j).name = `value${j - 1}`;
          }
          for (const receive of receivers) {
            receive.removeOutput(i);
            for (let j = i; j < receive.outputs.length; j++) receive.outputs[j].name = `输出 ${j + 1}`;
          }
          count--;
          resized = true;
        }
        for (let i = 0; i < count; i++) {
          const actual = send && inputSource(send, i)?.port?.type;
          const targets = receivers.flatMap(receive => outputTargets(receive, i));
          const demanded = targets.map(t => t.port?.type).find(t => t && t !== "*");
          const type = actual && actual !== "*" ? actual : demanded || "*";
          for (const node of endpoints) resized = setType(node, i, type) || resized;
        }
        if (resized) for (const node of endpoints) {
          const size = node.computeSize();
          node.setSize([Math.max(node.size[0], size[0]), size[1]]);
          node.setDirtyCanvas(true, true);
        }
        changed = resized || changed;
      }
      if (!changed) break;
    }
  } finally { syncing = false; }
}

function schedule() {
  if (pending || syncing) return;
  pending = true;
  queueMicrotask(() => { pending = false; sync(app.rootGraph || app.graph); });
}

function validateCanvas(root) {
  const pairs = new Map();
  for (const entry of entries(root)) {
    const { node, id } = entry;
    if ([2, 4].includes(node.mode)) continue;
    const key = keyOf(node);
    if (!key) continue;
    if (!pairs.has(key)) pairs.set(key, { receivers: [] });
    const pair = pairs.get(key);
    if (kind(node) === RECEIVE) pair.receivers.push(entry);
    else {
      if (pair.send) throw new Error(`虚拟连接键“${key}”重复：${pair.send.id} 与 ${id} 都是传入虚拟连接。每个键只能有一个传入端，包括复用子图中的实例。`);
      pair.send = entry;
    }
  }
  for (const [key, { send, receivers }] of pairs) for (const receive of receivers) {
    for (let i = 0; i < receive.node.outputs.length; i++) {
      const targets = outputTargets(receive.node, i);
      if (!targets.length) continue;
      if (!send) throw new Error(`键“${key}”的传出虚拟连接 ${receive.id} 未找到传入虚拟连接。`);
      const source = inputSource(send.node, i);
      if (!source?.port) throw new Error(`键“${key}”第 ${i + 1} 路缺少有效输入：传出虚拟连接 ${receive.id} 的输出 ${i + 1} 已连接下游，但传入虚拟连接 ${send.id} 的对应输入未连接或上游接口不存在。请连接输入 ${i + 1}，或断开该路传出连接。`);
      const sourceType = source.port?.type || "*";
      const receiveType = receive.node.outputs[i].type;
      if (!compatible(sourceType, receiveType) || targets.some(t => !compatible(sourceType, t.port?.type))) {
        throw new Error(`键“${key}”第 ${i + 1} 路类型不匹配（传出节点 ${receive.id}）：发送 ${sourceType}，接收 ${receiveType}，下游要求 ${targets.map(t => t.port?.type || "*").join(" / ")}。`);
      }
    }
  }
}

// Work on the flattened API graph: native subgraph boundaries, widgets and
// virtual nodes have already been resolved by ComfyUI at this point.
function compileConnections(output) {
  const pairs = new Map();
  for (const [id, node] of Object.entries(output)) {
    if (!TYPES.includes(node.class_type)) continue;
    const key = node.inputs.key || "";
    if (!key) continue;
    if (typeof key !== "string") throw new Error(`虚拟连接 ${id} 的键必须是文本控件值。`);
    if (!pairs.has(key)) pairs.set(key, {});
    const pair = pairs.get(key);
    if (node.class_type === SEND) {
      if (pair.send) throw new Error(`虚拟连接键“${key}”存在重复传入端：${pair.send}、${id}。`);
      pair.send = id;
    }
  }
  function resolve(value, seen = new Set()) {
    if (!isLink(value) || output[value[0]]?.class_type !== RECEIVE) return value;
    const token = `${value[0]}:${value[1]}`;
    if (seen.has(token)) throw new Error(`虚拟连接存在循环配对：${token}。`);
    const key = output[value[0]].inputs.key;
    const sender = pairs.get(key)?.send;
    if (!sender) throw new Error(`传出虚拟连接 ${value[0]} 的键“${key || ""}”没有配对发送端。`);
    const source = output[sender].inputs[`value${value[1]}`];
    if (source === undefined) throw new Error(`键“${key}”第 ${value[1] + 1} 路缺少输入：传出虚拟连接 ${value[0]} 的该路正在使用，但传入虚拟连接 ${sender} 的对应输入未连接。请连接输入 ${value[1] + 1}，或断开该路传出连接。`);
    return resolve(source, new Set([...seen, token]));
  }
  const result = {};
  for (const [id, node] of Object.entries(output)) {
    if (TYPES.includes(node.class_type)) continue;
    result[id] = { ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, value]) => [name, resolve(value)])) };
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`虚拟连接还原后形成执行依赖环，涉及节点 ${id}。请检查配对方向。`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const value of Object.values(result[id].inputs)) {
      if (isLink(value) && result[value[0]]) visit(value[0]);
    }
    visiting.delete(id); visited.add(id);
  }
  if (pairs.size) for (const id of Object.keys(result)) visit(id);
  return result;
}

app.registerExtension({
  name: "liuxinyu.VirtualConnections",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.includes(nodeData.name)) return;
    const configure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (data) {
      if (data.outputs) this.outputs = data.outputs.map(({ links, ...port }) => ({ ...port }));
      return configure.apply(this, arguments);
    };
  },
  setup() {
    const original = app.graphToPrompt;
    app.graphToPrompt = async function (graph = app.rootGraph || app.graph, ...args) {
      sync(graph);
      try {
        validateCanvas(graph);
        const result = await original.call(this, graph, ...args);
        result.output = compileConnections(result.output);
        return result;
      } catch (error) { notify(error.message); throw error; }
    };
  },
  nodeCreated(node) {
    if (!TYPES.includes(kind(node))) return;
    const widget = node.widgets.find(w => w.name === "key");
    const callback = widget.callback;
    widget.callback = function (...args) {
      const result = callback?.apply(this, args);
      rejectDuplicate(node);
      schedule();
      return result;
    };
    const input = node.onConnectInput;
    node.onConnectInput = function (slot, type, ...args) {
      if (!keyOf(this) || !compatible(type, this.inputs[slot]?.type)) return false;
      return input?.call(this, slot, type, ...args) ?? true;
    };
    const output = node.onConnectOutput;
    node.onConnectOutput = function (slot, type, ...args) {
      if (!keyOf(this) || !compatible(this.outputs[slot]?.type, type)) return false;
      return output?.call(this, slot, type, ...args) ?? true;
    };
    for (const event of ["onAdded", "onConfigure", "onConnectionsChange", "onRemoved"]) {
      const original = node[event];
      node[event] = function (...args) {
        const result = original?.apply(this, args);
        if (event === "onAdded" || event === "onConfigure") queueMicrotask(() => {
          if (!app.configuringGraph) rejectDuplicate(this);
          schedule();
        });
        else schedule();
        return result;
      };
    }
    schedule();
  },
  afterConfigureGraph() { schedule(); },
});
