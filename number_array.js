import { app } from "../../scripts/app.js";

// V3 accept_all_inputs handles arbitrary socket counts; native Autogrow caps at 100.
function updateNumberInputs(node) {
  const inputs = node.inputs;
  // Keep interior gaps so disconnecting a cable never moves the other inputs.
  while (inputs.length > 1 && inputs.at(-1).link == null && inputs.at(-2).link == null) {
    node.removeInput(inputs.length - 1);
  }
  if (!inputs.length || inputs.at(-1).link != null) {
    const index = inputs.length ? Number(inputs.at(-1).name.slice(6)) + 1 : 0;
    node.addInput(`number${index}`, "FLOAT,INT");
  }
  for (const input of inputs) {
    input.label = `数值 ${Number(input.name.slice(6)) + 1}`;
  }
  const minimum = node.computeSize();
  node.setSize([Math.max(node.size[0], minimum[0]), Math.max(node.size[1], minimum[1])]);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.NumberArray",
  nodeCreated(node) {
    if (node.comfyClass !== "LiuxinyuNumberArray") return;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        updateNumberInputs(node);
      });
    };
    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      if (args[0] === 1) schedule();
      return result;
    };
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      schedule();
      return result;
    };
    schedule();
  },
});
