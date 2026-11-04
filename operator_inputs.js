import { app } from "../../scripts/app.js";

const UNARY = { LiuxinyuBooleanOperator: "not", LiuxinyuBitwiseOperator: "~" };
const COMPARISON_LABELS = {
  "==": "等于", "!=": "不等于", "<": "小于", "<=": "小于或等于",
  ">": "大于", ">=": "大于或等于", "is": "同一对象", "is not": "不是同一对象",
  "in": "属于", "not in": "不属于",
};

function refresh(node) {
  const operation = node.widgets?.find(w => w.name === "operation")?.value;
  if (operation == null) return;
  const index = node.inputs?.findIndex(p => p.name === "b") ?? -1;
  if (operation === UNARY[node.comfyClass]) {
    if (index >= 0) node.removeInput(index);
  } else if (index < 0) {
    node.addInput("b", "*", { label: "B", localized_name: "B", shape: 7 });
  }
  const minimum = node.computeSize();
  node.setSize([Math.max(node.size[0], minimum[0]), Math.max(node.size[1], minimum[1])]);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.OperatorInputs",
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuCompare") {
      const migrate = () => {
        const widget = node.widgets?.find(w => w.name === "operation");
        if (widget && COMPARISON_LABELS[widget.value]) widget.value = COMPARISON_LABELS[widget.value];
      };
      const onConfigure = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = onConfigure?.apply(this, args);
        migrate();
        queueMicrotask(migrate);
        return result;
      };
      migrate();
      queueMicrotask(migrate);
      return;
    }
    if (!Object.hasOwn(UNARY, node.comfyClass)) return;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; refresh(node); });
    };
    const widget = node.widgets?.find(w => w.name === "operation");
    if (widget) {
      const callback = widget.callback;
      widget.callback = function (...args) {
        const result = callback?.apply(this, args);
        schedule();
        return result;
      };
    }
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      schedule();
      return result;
    };
    schedule();
  },
});
