import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { createAnalysisInfo } from "./function_grid_info.js";

const PORT_RE = /^(min|max|step|precision|terms)\d+$/;
const FIELDS = [["min", "最小值", "0"], ["max", "最大值", "1"],
  ["step", "间隔", "0.1"], ["precision", "小数位数", "2"]];
function readConfig(storage) {
  try {
    const value = JSON.parse(storage.value || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function specsFor(description, stored) {
  const specs = [];
  description.variables.forEach((name, index) => {
    for (const [field, label, fallback] of FIELDS) {
      specs.push({ key: `axis:${name}:${field}`, name: `${field}${index + 1}`, variable: name, field,
        label: `${name} ${label}`, value: String(stored.axes?.[name]?.[field] ?? fallback),
        type: field === "precision" ? "INT,STRING" : "FLOAT,INT,STRING" });
    }
  });
  description.series.filter(item => item.infinite).forEach((item, index) => {
    specs.push({ key: `series:${item.name}`, name: `terms${index + 1}`, variable: item.name, field: "terms",
      label: `${item.name} 运行项数`, value: String(stored.series?.[item.name] ?? "5000"), type: "INT,STRING" });
  });
  return specs;
}

function setupFunctionGrid(node) {
  const expression = node.widgets?.find(widget => widget.name === "expression");
  const storage = node.widgets?.find(widget => widget.name === "axes_json");
  if (!expression || !storage || node._liuxinyuSeriesInstalled) return;
  node._liuxinyuSeriesInstalled = true;
  storage.type = "hidden";
  storage.computeSize = () => [0, -4];
  storage.draw = () => {};
  function removeStorageSocket() {
    for (let index = node.inputs.length - 1; index >= 0; index--) {
      const input = node.inputs[index];
      if (input.name !== "axes_json") continue;
      const connected = node.isInputConnected ? node.isInputConnected(index) : input.link != null;
      if (connected) {
        // Preserve an existing legacy configuration wire, but give it a real
        // socket row instead of anchoring it to the zero-height hidden widget.
        delete input.widget; input._widget = undefined; delete input.pos;
        input.label = "采样配置（旧版连线）";
      } else node.removeInput(index);
    }
  }
  // Initial schema sockets have no restored links yet. Saved sockets are
  // migrated separately, after graph loading has restored all link indices.
  removeStorageSocket();
  let timer, controller, removed = false, generation = 0, requestId;
  let specs = [], description = null, status = "等待解析表达式。", analysis = null;
  let warningSignature = "";
  const info = createAnalysisInfo(node, app);
  function renderCard() { info.update(status, analysis); }
  function setStatus(text) { status = text; renderCard(); node.setDirtyCanvas(true, true); }
  function syncConfig() {
    const stored = readConfig(storage);
    const axes = { ...(stored.axes || {}) }, series = { ...(stored.series || {}) };
    for (const spec of specs) {
      const widget = node.widgets.find(widget => widget._seriesKey === spec.key);
      if (!widget) continue;
      if (spec.field === "terms") series[spec.variable] = String(widget.value);
      else axes[spec.variable] = { ...(axes[spec.variable] || {}), [spec.field]: String(widget.value) };
    }
    storage.value = JSON.stringify({ ...stored, axes, series,
      order: description?.variables || stored.order || Object.keys(axes),
      series_order: description?.series.filter(item => item.infinite).map(item => item.name) || stored.series_order || [] });
  }
  function rebuild(next, restoring = false) {
    if (!restoring) syncConfig();
    const stored = readConfig(storage);
    // Recover semantic identities for serialized sockets before renumbering.
    for (const port of [...node.inputs, ...node.widgets]) {
      if (port._seriesKey || !PORT_RE.test(port.name)) continue;
      const [, field, number] = /^(min|max|step|precision|terms)(\d+)$/.exec(port.name);
      const names = field === "terms" ? stored.series_order || [] : stored.order || Object.keys(stored.axes || {});
      const name = names[Number(number) - 1];
      if (name) port._seriesKey = field === "terms" ? `series:${name}` : `axis:${name}:${field}`;
    }
    specs = specsFor(next, stored);
    const wanted = new Set(specs.map(spec => spec.key));
    for (let index = node.inputs.length - 1; index >= 0; index--) {
      if (PORT_RE.test(node.inputs[index].name) && !wanted.has(node.inputs[index]._seriesKey)) node.removeInput(index);
    }
    for (const widget of [...node.widgets]) {
      if (PORT_RE.test(widget.name) && !wanted.has(widget._seriesKey)) node.removeWidget(widget);
    }
    for (const spec of specs) {
      let widget = node.widgets.find(widget => widget._seriesKey === spec.key);
      if (widget && widget.type !== "text") { node.removeWidget(widget); widget = null; }
      if (!widget) {
        widget = ComfyWidgets.STRING(node, spec.name, ["STRING", { default: spec.value, multiline: false }], app).widget;
        const callback = widget.callback;
        widget.callback = function (...args) { const result = callback?.apply(this, args); syncConfig(); schedule(false); return result; };
      }
      widget._seriesKey = spec.key; widget.name = spec.name; widget.label = spec.label; widget.serialize = false;
      if (restoring) widget.value = spec.value;
      widget.options = { ...widget.options, serialize: false };
      let input = node.inputs.find(input => input._seriesKey === spec.key);
      if (!input) input = node.addInput(spec.name, spec.type);
      input._seriesKey = spec.key; input.name = spec.name; input.type = spec.type; input.label = spec.label;
      input.widget = { name: spec.name }; input.alwaysVisible = true;
    }
    const dynamicWidgets = specs.map(spec => node.widgets.find(widget => widget._seriesKey === spec.key));
    node.widgets = [...node.widgets.filter(widget => !PORT_RE.test(widget.name)), ...dynamicWidgets];
    description = next; syncConfig();
    node.setSize?.([node.size[0], Math.max(node.size[1], node.computeSize()[1])]);
    if (node.graph) {
      node._setConcreteSlots?.();
      node.arrange?.();
    }
    node.setDirtyCanvas(true, true);
  }
  function warn(result) {
    const groups = new Map();
    for (const item of (result.series || []).filter(item => item.infinite)) {
      const divergentRegion = item.regions?.some(region => region.convergence === "确定发散" && region.condition !== "EmptySet");
      const kind = item.convergence === "确定发散" || divergentRegion ? "error" : item.convergence === "确定收敛" ? "success" : "warn";
      const formula = item.series_expression || `∑(${item.name}=${item.start ?? "起点"} to ∞) (${item.term || expression.value})`;
      const proof = item.properties?.["证明状态"] || item.proof?.map(step => `${step.method}：${step.detail}`).join("；") || item.failure?.reason || "分析步骤正在处理中";
      const conclusion = kind === "error" ? (divergentRegion ? "在报告列出的发散参数区域内严格发散。" : "根据上述证明，严格发散。")
        : kind === "success" ? `根据上述证明严格收敛。${item.proof_scope || ""}` : "当前条件下收敛性无法唯一确定，其有可能不收敛！";
      const detail = `级数 ${formula}\n${proof}\n${conclusion}${item.incomplete ? `\n停止原因：${item.incomplete}` : ""}`;
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(detail);
    }
    const signature = JSON.stringify([expression.value, readConfig(storage), [...groups]]);
    if (signature !== warningSignature) for (const [severity, details] of groups) {
      app.extensionManager.toast.add({ severity,
        summary: { error: "存在发散级数", warn: "存在不确定收敛性的级数", success: "确定收敛的级数" }[severity],
        detail: details.join("\n\n"), life: severity === "success" ? 10000 : 30000 });
    }
    warningSignature = signature;
  }
  async function inspectAndAnalyze(rebuildPorts) {
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const current = ++generation, text = String(expression.value ?? "");
    requestId = `${node.id}:${Date.now()}:${current}`;
    analysis = null; setStatus("正在解析公式与索引作用域…");
    const post = async (path, body) => {
      const response = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "分析请求失败");
      return result;
    };
    try {
      if (rebuildPorts || !description) {
        const parsed = await post("/liuxinyu/function_grid/inspect", { expression: text });
        if (removed || current !== generation) return;
        rebuild(parsed);
      }
      syncConfig(); setStatus("正在进行符号收敛证明与严格余项分析…");
      const result = await post("/liuxinyu/function_grid/analyze", { expression: text, axes_json: storage.value, request_id: requestId, client_id: api.clientId });
      if (removed || current !== generation) return;
      analysis = result;
      setStatus(result.complete ? "分析完成，点击 i 查看属性与证明。" : "分析部分完成，点击 i 查看阶段进度及停止位置。"); warn(result);
    } catch (error) {
      if (error.name !== "AbortError" && current === generation && !removed) setStatus(`分析未完成：${error.message}`);
    }
  }
  function schedule(rebuildPorts = true) {
    clearTimeout(timer); controller?.abort(); generation++; requestId = null; analysis = null;
    setStatus("输入已改变，等待分析…"); timer = setTimeout(() => inspectAndAnalyze(rebuildPorts), 450);
  }
  const onAnalysis = event => {
    const data = event.detail;
    if (data.expression !== String(expression.value ?? "")) return;
    if (data.request_id ? data.request_id !== requestId : String(data.node_id) !== String(node.id)) return;
    if (data.kind === "progress") setStatus(`${data.name ? data.name + "：" : ""}${data.stage}`);
    if (data.kind === "report") {
      analysis ||= { series: [] }; analysis.series = [...analysis.series.filter(item => item.name !== data.report.name), data.report]; renderCard();
    }
    if (data.kind === "complete") { analysis = data.analysis; setStatus(analysis.summary || "点击 i 查看分析进度。"); warn(analysis); }
    if (data.kind === "warning") app.extensionManager.toast.add({ severity: "warn", summary: "函数数值输出", detail: data.message, life: 12000 });
  };
  api.addEventListener("liuxinyu.function.analysis", onAnalysis);
  const callback = expression.callback;
  expression.callback = function (...args) { const result = callback?.apply(this, args); schedule(); return result; };
  const configured = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configured?.apply(this, args);
    if (this.outputs?.length === 2) this.addOutput("高精度数列", "ARRAY");
    if (this.outputs?.[0]) {
      this.outputs[0].name = "值执行列表";
      this.outputs[0].label = "值执行列表";
    }
    // Restored sockets need their widgets for layout/hit testing before the
    // debounced backend inspection returns. Use the saved semantic order.
    const stored = readConfig(storage);
    if (Array.isArray(stored.order) && stored.order.every(name => typeof name === "string")) {
      rebuild({ variables: stored.order,
        series: (stored.series_order || []).map(name => ({ name, infinite: true })) }, true);
    }
    schedule(); return result;
  };
  const graphConfigured = node.onAfterGraphConfigured;
  node.onAfterGraphConfigured = function (...args) {
    const result = graphConfigured?.apply(this, args);
    removeStorageSocket();
    if (this.graph) {
      this._setConcreteSlots?.();
      this.arrange?.();
    }
    this.setDirtyCanvas(true, true);
    return result;
  };
  const serialize = node.onSerialize;
  node.onSerialize = function (...args) { syncConfig(); return serialize?.apply(this, args); };
  const executed = node.onExecuted;
  node.onExecuted = function (message, ...args) {
    const result = executed?.call(this, message, ...args);
    if (message.liuxinyu_series_analysis?.[0]) { analysis = message.liuxinyu_series_analysis[0]; setStatus("分析完成，点击 i 查看。"); warn(analysis); }
    return result;
  };
  const onRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    removed = true; clearTimeout(timer); controller?.abort(); info.destroy(); api.removeEventListener("liuxinyu.function.analysis", onAnalysis);
    return onRemoved?.apply(this, args);
  };
  schedule();
}

app.registerExtension({
  name: "liuxinyu.FunctionGrid",
  async setup() {
    // Replace a previously cached help response before the native info panel opens.
    try {
      const response = await fetch(api.fileURL("/extensions/comfyui-liuxinyu-packs/docs/LiuxinyuFunctionGrid.md"), { cache: "reload" });
      await response.text();
    } catch (error) { console.warn("[liuxinyu] 节点帮助预刷新失败，下次打开信息面板时会重试。", error); }
  },
  nodeCreated(node) { if (node.comfyClass === "LiuxinyuFunctionGrid") setupFunctionGrid(node); },
});
