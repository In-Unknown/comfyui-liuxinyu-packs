import { app } from "../../scripts/app.js";

// DynamicCombo currently overwrites child display_name with the internal key.
// Restore display labels from the schema; never rename serialized widget keys.
const TARGETS = new Set([
  "LiuxinyuEncodeImage", "LiuxinyuTranscodeImageBytes", "LiuxinyuDecodeImageBytes",
  "LiuxinyuLoadFileBytes", "LiuxinyuExtractImageBytes",
  "SaveImageToAbsolutePath", "SaveSelectedFromBatch",
]);
const definitions = new Map();
const installed = new WeakSet();
const compressionLabel = (value) => ({
  LZW: "字典压缩（LZW）", Deflate: "无损压缩（Deflate）",
}[value] ?? value);

function refreshLabels(node) {
  const definition = definitions.get(node.comfyClass);
  if (!definition) return;
  const specs = new Map();
  function collect(inputs, prefix = "") {
    for (const group of [inputs?.required, inputs?.optional]) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        const key = prefix + name;
        specs.set(key, spec);
        if (spec[0] === "COMFY_DYNAMICCOMBO_V3") {
          const selected = node.widgets?.find(widget => widget.name === key)?.value;
          const option = spec[1]?.options?.find(item => item.key === selected);
          if (option) collect(option.inputs, key + ".");
        }
      }
    }
  }
  collect(definition.input);
  let changed = false;
  for (const widget of node.widgets ?? []) {
    const spec = specs.get(widget.name);
    if (!spec) continue;
    const label = spec[1]?.display_name;
    if (label && widget.label !== label) { widget.label = label; changed = true; }
    if (spec[0] === "BOOLEAN") {
      widget.options ??= {};
      for (const [key, value] of [["on", "开启"], ["off", "关闭"]]) {
        if (widget.options[key] !== value) { widget.options[key] = value; changed = true; }
      }
    }
    if (widget.name === "format.compression" &&
        node.widgets?.find(item => item.name === "format")?.value === "TIFF") {
      widget.options ??= {};
      if (widget.options.getOptionLabel !== compressionLabel) {
        widget.options.getOptionLabel = compressionLabel;
        changed = true;
      }
    }
  }
  for (const input of node.inputs ?? []) {
    const label = specs.get(input.name)?.[1]?.display_name;
    if (!label) continue;
    if (input.label !== label) { input.label = label; changed = true; }
    if (input.localized_name !== label) { input.localized_name = label; changed = true; }
  }
  if (changed) node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "liuxinyu.ImageBytesLabels",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (TARGETS.has(nodeData.name)) definitions.set(nodeData.name, nodeData);
  },
  nodeCreated(node) {
    if (!TARGETS.has(node.comfyClass) || installed.has(node)) return;
    installed.add(node);
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; refreshLabels(node); });
    };
    // Format changes rebuild widgets even when value is restored without a callback.
    // Run after native code has finished assigning its English display labels.
    for (const method of ["addWidget", "addInput", "onConfigure"]) {
      const original = node[method];
      node[method] = function (...args) {
        const result = original?.apply(this, args);
        schedule();
        return result;
      };
    }
    refreshLabels(node);
    schedule();
  },
});
