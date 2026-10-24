import { app } from "../../scripts/app.js";

const MAX_SOCKETS = 100;
const ROUND_NAME = "当前轮次";

function updatePacketSockets(node) {
  const isStart = node.comfyClass === "LiuxinyuPacketStart";
  const inputOffset = isStart ? 0 : 1;
  const outputOffset = isStart ? 1 : 0;
  // Keep the round output last visually, while its API index stays fixed at 101.
  const roundIndex = isStart ? node.outputs.findIndex(output => output.name === ROUND_NAME) : -1;
  const roundOutput = roundIndex >= 0 ? node.outputs.splice(roundIndex, 1)[0] : null;
  let lastUsed = -1;
  node.inputs.slice(inputOffset).forEach((input, index) => {
    if (input.link != null) lastUsed = Math.max(lastUsed, index);
  });
  node.outputs.slice(outputOffset).forEach((output, index) => {
    if (output.links?.length) lastUsed = Math.max(lastUsed, index);
  });
  const count = Math.min(MAX_SOCKETS, lastUsed + 2);
  while (node.outputs.length > count + outputOffset) node.removeOutput(node.outputs.length - 1);
  while (node.inputs.length > count + inputOffset) node.removeInput(node.inputs.length - 1);
  while (node.inputs.length < count + inputOffset) {
    node.addInput(`value${node.inputs.length - inputOffset}`, "*");
  }
  while (node.outputs.length < count + outputOffset) {
    node.addOutput(`输出 ${node.outputs.length - outputOffset + 1}`, "*");
  }
  if (isStart) {
    if (roundOutput) node.outputs.push(roundOutput);
    else node.addOutput(ROUND_NAME, "INT");
    const round = node.outputs.at(-1);
    for (const linkId of round.links || []) {
      const link = node.graph?.links?.[linkId];
      if (link) link.origin_slot = node.outputs.length - 1;
    }
  }
  node.inputs.slice(inputOffset).forEach((input, index) => { input.label = `输入 ${index + 1}`; });
  const minimum = node.computeSize();
  node.setSize([Math.max(node.size[0], minimum[0]), minimum[1]]);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.PacketTasks",
  setup() {
    const original = app.graphToPrompt;
    app.graphToPrompt = async function (...args) {
      const result = await original.apply(this, args);
      const roundSlots = new Map((result.workflow.nodes || [])
        .filter(node => node.type === "LiuxinyuPacketStart")
        .map(node => [String(node.id), node.outputs.findIndex(output => output.name === ROUND_NAME)]));
      for (const node of Object.values(result.output)) {
        for (const input of Object.values(node.inputs)) {
          if (Array.isArray(input) && input.length === 2 &&
              roundSlots.get(String(input[0])) === input[1]) input[1] = MAX_SOCKETS + 1;
        }
      }
      return result;
    };
  },
  nodeCreated(node) {
    if (!["LiuxinyuPacketStart", "LiuxinyuPacketEnd"].includes(node.comfyClass)) return;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; updatePacketSockets(node); });
    };
    for (const event of ["onConnectionsChange", "onConfigure"]) {
      const original = node[event];
      node[event] = function (...args) {
        const result = original?.apply(this, args);
        schedule();
        return result;
      };
    }
    schedule();
  },
});
