import { app } from "../../scripts/app.js";

const TYPES = {"字典": "DICT", "数组": "ARRAY", "字符串": "STRING", "整数": "INT",
  "浮点数": "FLOAT", "布尔值": "BOOLEAN", "空值": "NULL"};
const JSON_TYPES = Object.values(TYPES).join(",");
const getLink = (graph, id) => graph?.links?.get?.(id) || graph?.links?.[id];
function compatible(a, b) {
  if (a === "*" || b === "*") return true;
  return String(a).split(",").some(t => String(b).split(",").includes(t));
}
function refresh(node) {
  const output = node.outputs?.[0];
  const selected = TYPES[node.widgets?.find(w => w.name === "result_type")?.value] || "DICT";
  if (output && output.type !== selected) {
    output.type = selected;
    for (const id of [...(output.links || [])]) {
      const link = getLink(node.graph, id);
      if (!link) continue;
      const target = node.graph?.getNodeById?.(link.target_id);
      const input = target?.inputs?.[link.target_slot];
      if (input && !compatible(selected, input.type)) target.disconnectInput(link.target_slot);
      else {
        link.type = selected;
        target?.onConnectionsChange?.(1, link.target_slot, true, link, input);
      }
    }
  }
  if (output) output.label = `结果 · ${selected}`;
  for (const input of node.inputs || []) {
    if (!/^sources\.data\d+$/.test(input.name)) continue;
    const link = getLink(node.graph, input.link);
    const source = link && node.graph?.getNodeById?.(link.origin_id);
    const upstream = source?.outputs?.[link?.origin_slot]?.type;
    const allowed = upstream && upstream !== "*"
      ? String(upstream).split(",").filter(t => Object.values(TYPES).includes(t)).join(",") : JSON_TYPES;
    if (!allowed && link) {
      node.disconnectInput(node.inputs.indexOf(input));
      input.type = JSON_TYPES;
    } else input.type = allowed || JSON_TYPES;
    input.label = `${input.name.slice(8)} · ${input.type === JSON_TYPES ? "JSON" : input.type}`;
  }
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.StructuredDataTypes",
  nodeCreated(node) {
    if (node.comfyClass !== "LiuxinyuStructuredTransform") return;
    const widget = node.widgets?.find(w => w.name === "result_type");
    if (widget) {
      const original = widget.callback;
      widget.callback = function (...args) {
        const result = original?.apply(this, args);
        refresh(node);
        return result;
      };
    }
    const connectInput = node.onConnectInput;
    node.onConnectInput = function (slot, type) {
      if (this.inputs[slot]?.name === "result_type") return false;
      // A new source may replace the old source's concrete type.
      const allowed = /^sources\.data\d+$/.test(this.inputs[slot]?.name || "") ? JSON_TYPES : this.inputs[slot]?.type;
      if (!compatible(type, allowed)) return false;
      return connectInput?.apply(this, arguments) ?? true;
    };
    const connectOutput = node.onConnectOutput;
    node.onConnectOutput = function (slot, type) {
      const actual = slot === 0 ? TYPES[widget?.value] || "DICT" : this.outputs[slot]?.type;
      if (!compatible(actual, type)) return false;
      return connectOutput?.apply(this, arguments) ?? true;
    };
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {pending = false; refresh(node);});
    };
    for (const event of ["onAdded", "onConnectionsChange", "onConfigure"]) {
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
