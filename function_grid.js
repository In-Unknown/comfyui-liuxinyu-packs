import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const FIELDS = [
  ["min", "FLOAT", "最小值", { default: 0.0 }],
  ["max", "FLOAT", "最大值", { default: 1.0 }],
  ["step", "FLOAT", "间隔", { default: 0.1 }],
  ["precision", "INT", "小数位数", { default: 2, min: 0, max: 15, step: 1 }],
];
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sqrt", "abs", "ln", "log", "log10", "exp",
  "floor", "ceil", "round", "min", "max", "pow",
]);
const CONSTANTS = new Set(["pi", "e"]);
const NAME_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z_][A-Za-z0-9_]*/g;
const PORT_RE = /^(min|max|step|precision)\d+$/;

function extractVariables(expression) {
  const variables = [];
  const seen = new Set();
  for (const match of String(expression).matchAll(NAME_RE)) {
    const name = match[0];
    if (FUNCTIONS.has(name) || CONSTANTS.has(name) || seen.has(name)) continue;
    seen.add(name);
    variables.push(name);
  }
  return variables;
}

function setupFunctionGrid(node) {
  const expression = node.widgets?.find((widget) => widget.name === "expression");
  const storage = node.widgets?.find((widget) => widget.name === "axes_json");
  if (!expression || !storage) return;

  storage.type = "hidden";
  storage.computeSize = () => [0, -4];
  storage.draw = () => {};

  let timer = null;
  let removed = false;
  let restoring = false;
  let variables = [];

  function storedConfig() {
    try {
      const data = JSON.parse(storage.value || "{}");
      if (!data || typeof data !== "object" || Array.isArray(data)) return {};
      return data.axes && typeof data.axes === "object" && !Array.isArray(data.axes) ? data.axes : data;
    } catch {
      return {};
    }
  }

  function clearPorts() {
    for (let index = node.inputs.length - 1; index >= 0; index--) {
      if (PORT_RE.test(node.inputs[index].name)) node.removeInput(index);
    }
    for (let index = node.widgets.length - 1; index >= 0; index--) {
      const widget = node.widgets[index];
      if (PORT_RE.test(widget.name)) node.removeWidget(widget);
    }
  }

  function syncConfig() {
    if (restoring) return;
    const configs = {};
    variables.forEach((name, index) => {
      const number = index + 1;
      const entry = {};
      for (const [field] of FIELDS) {
        const widget = node.widgets.find((item) => item.name === `${field}${number}`);
        entry[field] = widget ? widget.value : undefined;
      }
      configs[name] = entry;
    });
    storage.value = JSON.stringify({ axes: configs });
    storage.callback?.(storage.value);
  }

  function sameVariables(next) {
    return next.length === variables.length && next.every((name, index) => name === variables[index]);
  }

  function rebuild(nextVariables) {
    if (sameVariables(nextVariables)) return;
    restoring = true;
    try {
      const saved = storedConfig();
      clearPorts();
      variables = nextVariables;
      variables.forEach((name, index) => {
        const number = index + 1;
        const config = saved[name] && typeof saved[name] === "object" ? saved[name] : {};
        for (const [field, type, label, options] of FIELDS) {
          const widgetName = `${field}${number}`;
          const spec = [type, { ...options, default: config[field] ?? options.default }];
          const { widget } = ComfyWidgets[type](node, widgetName, spec, app);
          widget.serialize = false;
          if (widget.options) widget.options.serialize = false;
          widget.label = `${name} ${label}`;
          const previous = widget.callback;
          widget.callback = function (...args) {
            const result = previous?.apply(this, args);
            syncConfig();
            return result;
          };
          const input = node.addInput(widgetName, type);
          input.label = `${name} ${label}`;
          input.widget = { name: widgetName };
          input.alwaysVisible = true;
        }
      });
      syncConfig();
    } finally {
      restoring = false;
    }
    node.setDirtyCanvas(true, true);
  }

  function applyExpression() {
    rebuild(extractVariables(expression.value ?? ""));
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(applyExpression, 250);
  }

  const callback = expression.callback;
  expression.callback = function (...args) {
    const result = callback?.apply(this, args);
    schedule();
    return result;
  };
  const configured = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configured?.apply(this, args);
    applyExpression();
    return result;
  };
  const onRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    removed = true;
    if (timer) clearTimeout(timer);
    return onRemoved?.apply(this, args);
  };
  applyExpression();
}

app.registerExtension({
  name: "liuxinyu.FunctionGrid",
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuFunctionGrid") setupFunctionGrid(node);
  },
});
