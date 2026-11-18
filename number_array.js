import { app } from "../../scripts/app.js";

function commonMemberType(node, except = -1, candidate = "*") {
  let allowed = null;
  const accept = type => {
    const types = String(type || "*").split(",").map(value => value.trim());
    if (types.includes("*")) return;
    allowed = allowed === null ? types : allowed.filter(value => types.includes(value));
  };
  node.inputs.forEach((input, index) => {
    if (index === except) return;
    const link = node.getInputLink?.(index)
      || node.graph?.links?.get?.(input.link) || node.graph?.links?.[input.link];
    if (!link) return;
    const source = node.graph?.getNodeById?.(link.origin_id);
    accept(source?.outputs?.[link.origin_slot]?.type);
  });
  accept(candidate);
  return allowed === null ? "*" : allowed.join(",");
}

function refreshMemberTypes(node) {
  const type = commonMemberType(node);
  // Invalid imported graphs are rejected by backend validation; do not silently
  // remove their wires while loading or widen their types to accept more links.
  if (!type) return;
  for (const input of node.inputs) {
    input.type = type;
    input.label = `任意值 ${Number(input.name.slice(5)) + 1} · ${type === "*" ? "任意" : type}`;
  }
  node.setDirtyCanvas(true, true);
}

// V3 accept_all_inputs handles arbitrary socket counts; native Autogrow caps at 100.
function updateArrayInputs(node, prefix, type, label) {
  const inputs = node.inputs;
  // Keep interior gaps so disconnecting a cable never moves the other inputs.
  while (inputs.length > 1 && inputs.at(-1).link == null && inputs.at(-2).link == null) {
    node.removeInput(inputs.length - 1);
  }
  if (!inputs.length || inputs.at(-1).link != null) {
    const index = inputs.length ? Number(inputs.at(-1).name.slice(prefix.length)) + 1 : 0;
    node.addInput(`${prefix}${index}`, type);
  }
  for (const input of inputs) {
    input.label = `${label} ${Number(input.name.slice(prefix.length)) + 1}`;
  }
  if (node.comfyClass === "LiuxinyuAnyArray") refreshMemberTypes(node);
  const minimum = node.computeSize();
  node.setSize([Math.max(node.size[0], minimum[0]), Math.max(node.size[1], minimum[1])]);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.NumberArray",
  nodeCreated(node) {
    const config = {
      LiuxinyuNumberArray: ["number", "FLOAT,INT", "数值"],
      LiuxinyuAnyArray: ["value", "*", "任意值"],
    }[node.comfyClass];
    if (!config) return;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        updateArrayInputs(node, ...config);
      });
    };
    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      if (this.comfyClass === "LiuxinyuAnyArray" && args[0] === 1) {
        if (!app.configuringGraph && args[2] && !commonMemberType(this)) {
          this.disconnectInput(args[1]);
          return result;
        }
        refreshMemberTypes(this);
      }
      if (args[0] === 1) schedule();
      return result;
    };
    if (node.comfyClass === "LiuxinyuAnyArray") {
      const onConnectInput = node.onConnectInput;
      node.onConnectInput = function (slot, type, ...args) {
        if (!commonMemberType(this, slot, type)) return false;
        return onConnectInput?.call(this, slot, type, ...args) ?? true;
      };
    }
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      schedule();
      return result;
    };
    const graphConfigured = node.onAfterGraphConfigured;
    node.onAfterGraphConfigured = function (...args) {
      const result = graphConfigured?.apply(this, args);
      schedule();
      return result;
    };
    schedule();
  },
});
