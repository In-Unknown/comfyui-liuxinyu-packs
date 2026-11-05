import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { entries } from "./port_order.js";
import { sourceMenuItems } from "./menu_source.js";

const PROPERTY = "liuxinyu_port_order";
let busy = false;

function notify(message) {
  if (app.extensionManager?.toast) {
    app.extensionManager.toast.add({ severity: "info", summary: "整理节点", detail: message, life: 7000 });
  } else {
    app.ui.dialog.show(message);
  }
}

function progressPanel(controller) {
  if (typeof document === "undefined") return { update() {}, close() {} };
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:20px;bottom:54px;z-index:10000;max-width:390px;padding:14px 16px;border:1px solid #617789;border-radius:8px;background:#202a34;color:#eef5fa;box-shadow:0 4px 16px #0006;font:13px/1.6 sans-serif;white-space:pre-line";
  const text = document.createElement("div");
  text.setAttribute("role", "status");
  text.setAttribute("aria-live", "polite");
  const button = document.createElement("button");
  button.textContent = "取消整理";
  button.style.cssText = "margin-top:8px;padding:4px 12px;border:1px solid #8a9cac;border-radius:4px;background:#35495a;color:white;cursor:pointer";
  button.onclick = () => { controller.abort("user"); box.remove(); };
  box.append(text, button);
  document.body.append(box);
  return {
    update(message) { text.textContent = message; },
    close() { box.remove(); },
  };
}

function counts(value) {
  return value ? `交叉 ${value.crossings}，穿框 ${value.nodeIntersections}，重叠 ${value.overlaps}` : "";
}

function describeConflicts(conflicts = []) {
  const edge = e => `${e.source}→${e.target}`;
  return conflicts.slice(0, 3).map(c => c.kind === "crossing" ? `${edge(c.edges[0])} 与 ${edge(c.edges[1])} 交叉` :
    c.kind === "throughNode" ? `${edge(c.edge)} 穿过节点 ${c.node}` : `节点 ${c.nodes.join("、")} 重叠`).join("；");
}

function searchProgress(value) {
  if (value.stage === "topology") return `整理节点：正在检查拓扑\n${value.nodes} 个节点，${value.edges} 条内部连接`;
  if (value.stage === "nonplanar") return "连接拓扑无法消除全部交叉，继续搜索可改善的布局…";
  if (value.stage === "compact") return `正在压缩当前最佳候选并复核…\n${counts(value.best)}\n已尝试 ${value.trials} 个布局，用时 ${value.elapsed} 秒`;
  if (value.stage === "align") return `正在对齐主链和支线中心，并检查交叉与遮挡…\n已尝试 ${value.trials} 个布局，用时 ${value.elapsed} 秒`;
  return `正在搜索布局 · ${value.elapsed} 秒 · 已尝试 ${value.trials} 个\n原布局：${counts(value.before)}\n当前最好：${counts(value.best)}`;
}

function selection() {
  return Object.values(app.canvas?.selected_nodes || {}).filter(n => n.graph === app.canvas.graph);
}

function snapshot(graph, chosen) {
  const selected = new Set(chosen.map(n => n.id));
  const nodes = (graph._nodes || []).map(node => {
    const size = Array.from(node.renderingSize || node.size);
    const pos = Array.from(node.pos);
    const widgets = node.getLayoutWidgets?.() || [];
    const widgetByName = new Map(widgets.map(w => [w.name, w]));
    const used = new Set();
    const record = { id: String(node.id), pos, size, selected: selected.has(node.id),
      titleHeight: LiteGraph.NODE_TITLE_HEIGHT, startY: node.constructor.slot_start_y || 0 };
    for (const side of ["inputs", "outputs"]) {
      record[side] = entries(node, side).map(({ slot, index, key }) => {
        const input = side === "inputs";
        const p = input ? node.getInputPos(index) : node.getOutputPos(index);
        const widget = input && slot.widget && widgetByName.get(slot.widget.name);
        if (widget) used.add(widget);
        if (slot.dir && slot.dir !== (input ? LiteGraph.LEFT : LiteGraph.RIGHT)) {
          throw new Error("当前整理支持左右方向的端口；画布中存在其他方向的连线端口。");
        }
        return { key, x: p[0]-pos[0], y: p[1]-pos[1],
          height: widget ? Math.max(20, widget.computedHeight ?? LiteGraph.NODE_WIDGET_HEIGHT+4) : 20 };
      });
    }
    record.freeHeight = widgets.filter(w => !used.has(w)).reduce((h, w) => h + Math.max(20, w.computedHeight ?? LiteGraph.NODE_WIDGET_HEIGHT+4), 0);
    return record;
  });
  // Subgraph boundary sockets use absolute coordinates and remain fixed.
  for (const [boundary, side] of [[graph.inputNode, "outputs"], [graph.outputNode, "inputs"]]) {
    if (!boundary) continue;
    const pos = Array.from(boundary.pos);
    nodes.push({ id: String(boundary.id), pos, size: Array.from(boundary.size), selected: false,
      titleHeight: 0, inputs: [], outputs: [],
      [side]: boundary.slots.map(s => ({ x: s.pos[0]-pos[0], y: s.pos[1]-pos[1] })) });
  }
  const edges = Array.from(graph.links.values()).map(link => {
    if (link.parentId != null) throw new Error("当前画布包含连线转接点，请先移除转接点或在不含转接点的子图内整理。");
    return { id: String(link.id), source: String(link.origin_id), target: String(link.target_id),
      output: link.origin_slot, input: link.target_slot };
  });
  return { nodes, edges };
}

function layoutFingerprint(graph, chosen) {
  // Viewport scale/offset and widget values do not describe canvas geometry.
  // In particular graph.serialize().extra.ds changes while zooming or panning.
  const data = snapshot(graph, chosen);
  const states = (graph._nodes || []).map(n => [String(n.id), n.type, !!n.flags?.collapsed,
    !!(n.pinned || n.flags?.pinned), n.properties?.[PROPERTY] || null]);
  return JSON.stringify([data, states], (key, value) =>
    typeof value === "number" ? Math.round(value*1000)/1000 : value);
}

function copyPortOrder(order) {
  if (order == null) return undefined;
  // Node properties (including nested arrays) may be Vue reactive proxies.
  // Copy this feature's plain data fields rather than structuredClone a proxy.
  const copy = { version: order.version };
  for (const side of ["inputs", "outputs"]) {
    if (Array.isArray(order[side])) copy[side] = Array.from(order[side]);
  }
  return copy;
}

function checkpoint(nodes) {
  return nodes.map(node => ({ node, pos: Array.from(node.pos), size: Array.from(node.size),
    property: copyPortOrder(node.properties?.[PROPERTY]) }));
}

function restore(saved) {
  for (const { node, pos, size, property } of saved) {
    node.properties ||= {};
    if (property === undefined) delete node.properties[PROPERTY];
    else node.properties[PROPERTY] = copyPortOrder(property);
    node.pos = [...pos];
    node.setSize([...size]);
    node.arrange();
  }
}

function apply(nodes, plan) {
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  if (plan.length !== nodes.length || new Set(plan.map(p => p.id)).size !== nodes.length) {
    throw new Error("整理结果与所选节点不匹配。");
  }
  for (const item of plan) {
    const node = byId.get(item.id);
    if (!node || item.pos.length !== 2 || !item.pos.every(Number.isFinite)) throw new Error("整理结果坐标无效。");
    const order = { version: 1 };
    for (const side of ["inputs", "outputs"]) {
      const list = entries(node, side);
      const indices = item[side];
      if (indices.length !== list.length || new Set(indices).size !== list.length ||
          indices.some(i => !Number.isInteger(i) || i < 0 || i >= list.length)) throw new Error("整理结果端口不匹配。");
      if (list.length) order[side] = indices.map(i => list[i].key);
    }
    node.properties ||= {};
    if (order.inputs || order.outputs) node.properties[PROPERTY] = order;
    else delete node.properties[PROPERTY];
    node.pos = [...item.pos];
    node.arrange();
  }
}

async function request(data, controller, onProgress = () => {}) {
  const timer = setTimeout(() => controller.abort("timeout"), data.stream ? 90000 : 30000);
  try {
    const response = await api.fetchApi("/liuxinyu/layout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data), signal: controller.signal,
    });
    if (response.status === 404) throw new Error("请重启 ComfyUI 后端加载整理接口，再刷新页面。");
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message || "整理请求失败。");
    }
    if (!response.headers?.get("Content-Type")?.includes("ndjson")) return await response.json();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result;
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const item = JSON.parse(line);
          if (item.event === "progress") onProgress(item.data);
          if (item.event === "error") throw new Error(item.data.message);
          if (item.event === "result") result = item.data;
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
    if (!result) throw new Error("整理连接中断，未收到完整结果，画布保持原样。");
    return result;
  } finally { clearTimeout(timer); }
}

async function arrangeSelected() {
  if (busy) return;
  const canvas = app.canvas;
  const graph = canvas?.graph;
  const chosen = selection();
  if (chosen.length < 2 || chosen.length > 40) { notify("请一次选择 2～40 个节点。"); return; }
  if (canvas.read_only || LiteGraph.vueNodesMode || canvas.links_render_mode !== LiteGraph.SPLINE_LINK) {
    notify("请使用可编辑的经典画布和样条曲线连线模式。"); return;
  }
  if (chosen.some(n => n.flags?.collapsed || n.pinned || n.flags?.pinned || n.horizontal || !n.arrange || !n._measureSlot)) {
    notify("请先展开、取消固定所选节点，并使用标准左右端口布局。"); return;
  }
  busy = true;
  const controller = new AbortController();
  const status = progressPanel(controller);
  try {
    const data = snapshot(graph, chosen);
    const fingerprint = layoutFingerprint(graph, chosen);
    const unchanged = () => canvas.graph === graph && app.canvas === canvas &&
      !canvas.read_only && !LiteGraph.vueNodesMode && canvas.links_render_mode === LiteGraph.SPLINE_LINK &&
      layoutFingerprint(graph, chosen) === fingerprint;
    status.update("正在读取节点布局并检查拓扑…\n可继续缩放、平移画布。");
    const plan = await request({ ...data, stream: true, seed: Date.now() }, controller,
      value => status.update(searchProgress(value)));
    if (controller.signal.aborted || plan.status === "cancelled") { notify("已取消整理，画布保持原样。"); return; }
    if (!unchanged()) { notify("计算期间工作流已变化，本次结果未应用，请重新整理。"); return; }
    if (plan.status !== "ok") {
      const detail = plan.checks ? `\n尝试 ${plan.trials} 个布局，用时 ${plan.elapsed} 秒；最好结果：${counts(plan.checks)}。\n${describeConflicts(plan.conflicts)}` : "";
      notify((plan.message || "本次没有找到比现状更好的布局，画布保持原样。")+detail);
      return;
    }
    const saved = checkpoint(chosen);
    let measured;
    // Synchronous trial: measure native widget/socket layout, restore before yielding.
    try {
      apply(chosen, plan.nodes);
      measured = snapshot(graph, chosen);
    } finally { restore(saved); }
    status.update("候选布局已找到，正在复核实际端口与控件位置…");
    const result = await request({ ...measured, verify: true, baseline: data }, controller);
    if (controller.signal.aborted) { notify("已取消整理，画布保持原样。"); return; }
    if (!unchanged()) { notify("计算期间工作流已变化，本次结果未应用，请重新整理。"); return; }
    if (result.status !== "ok") { notify(`按实际端口位置复核后，没有优于原布局，画布保持原样。\n${counts(result.checks)}\n${describeConflicts(result.conflicts)}`); return; }
    graph.beforeChange();
    try {
      apply(chosen, plan.nodes);
      graph.change();
    } catch (error) {
      restore(saved);
      throw error;
    } finally { graph.afterChange(); canvas.setDirty(true, true); }
    const checks = result.checks || plan.checks;
    const remaining = checks && Object.values(checks).some(v => v > 0);
    notify(`已整理 ${chosen.length} 个节点：${counts(result.before || plan.before)} → ${counts(checks)}。\n`+
      (remaining ? `已采用本次找到的改善方案，仍有剩余冲突。${describeConflicts(result.conflicts || plan.conflicts)}\n` : "")+
      `已尝试 ${plan.trials} 个布局，用时 ${plan.elapsed} 秒；可撤销、保存。`);
  } catch (error) {
    notify(controller.signal.aborted ? (controller.signal.reason === "user" ? "已取消整理，画布保持原样。" : "整理请求超时，画布保持原样。") : error.message);
  } finally { controller.abort(); status.close(); busy = false; }
}

function menu() {
  return selection().length >= 2 ? sourceMenuItems([{ content: busy ? "整理节点（计算中）" : "整理节点", disabled: busy,
    callback: () => { void arrangeSelected(); } }]) : [];
}

app.registerExtension({
  name: "liuxinyu.GraphLayout",
  getCanvasMenuItems: menu,
  getNodeMenuItems: menu,
});
