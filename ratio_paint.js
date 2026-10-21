import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function findExecutionIds(graph, target, prefix = "", ancestors = new Set()) {
  if (ancestors.has(graph)) return [];
  const visited = new Set([...ancestors, graph]);
  const ids = [];
  for (const node of graph.nodes) {
    const id = `${prefix}${node.id}`;
    if (node === target) ids.push(id);
    if (node.isSubgraphNode?.() && node.subgraph) {
      ids.push(...findExecutionIds(node.subgraph, target, `${id}:`, visited));
    }
  }
  return ids;
}

async function refreshPreview(node) {
  const root = app.rootGraph;
  const ids = findExecutionIds(root, node);
  if (ids.length !== 1) throw new Error("无法确定节点的执行位置，请将节点放在主画布或独立子图中。");
  const id = ids[0];
  const prompt = await app.graphToPrompt(root);
  if (prompt.output[id]?.class_type !== "LiuxinyuRatioPaint") {
    throw new Error("节点已静音或被绕过，请先启用节点。");
  }
  const queued = await api.queuePrompt(0, prompt, { partialExecutionTargets: [id] });
  if (!queued.prompt_id) throw new Error("未能提交预览任务，请检查节点连接。");

  // History also includes cached outputs, so an unchanged upstream image is valid.
  let history;
  while (!history) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (app.rootGraph !== root || !node.graph) throw new Error("画布已切换或节点已移除，取消自动打开编辑器。");
    const response = await api.fetchApi(`/history/${encodeURIComponent(queued.prompt_id)}`);
    if (!response.ok) throw new Error("无法读取预览任务结果，请检查 ComfyUI 连接。");
    history = (await response.json())[queued.prompt_id];
    if (!history) {
      const queueResponse = await api.fetchApi("/queue");
      if (!queueResponse.ok) throw new Error("无法读取任务队列，请检查 ComfyUI 连接。");
      const queue = await queueResponse.json();
      const present = [...queue.queue_running, ...queue.queue_pending].some((entry) => entry[1] === queued.prompt_id);
      if (!present) {
        // Completion may have occurred between the history and queue requests.
        const finalResponse = await api.fetchApi(`/history/${encodeURIComponent(queued.prompt_id)}`);
        if (!finalResponse.ok) throw new Error("无法读取预览任务结果。");
        history = (await finalResponse.json())[queued.prompt_id];
        if (!history) throw new Error("预览任务已取消或移出队列。");
      }
    }
  }
  const output = history.outputs?.[id];
  if (history.status?.status_str !== "success" || !output?.editor_image?.[0]) {
    const failure = history.status?.messages?.find(([type]) => type === "execution_error");
    throw new Error(failure?.[1]?.exception_message || "预览执行失败或被中断，请查看执行错误。");
  }
  node.onExecuted(output);
  const ref = output.images[0];
  const preview = new Image();
  preview.src = api.apiURL(`/view?${new URLSearchParams(ref)}`);
  await preview.decode();
  if (app.rootGraph !== root || app.canvas.graph !== node.graph) {
    throw new Error("当前画布已切换，预览已更新，请返回节点后重新打开。");
  }
  node.imgs = [preview];
  node.imageIndex = 0;
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "liuxinyu.RatioPaint",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LiuxinyuRatioPaint") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated?.apply(this, arguments);
      const image = this.widgets.find((widget) => widget.name === "image");
      image.type = "hidden";
      image.computeSize = () => [0, -4];
      let refreshing = false;
      const button = this.addWidget("button", "打开遮罩编辑器", null, async () => {
        if (refreshing) return;
        refreshing = true;
        button.name = "正在更新预览…";
        this.setDirtyCanvas(true, true);
        try {
          await refreshPreview(this);
          app.canvas.deselectAllNodes();
          app.canvas.selectNode(this);
          await app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor");
        } catch (error) {
          app.extensionManager.toast.add({
            severity: "error", summary: "未能打开遮罩编辑器",
            detail: error.message || String(error), life: 6000,
          });
        } finally {
          refreshing = false;
          button.name = "打开遮罩编辑器";
          this.setDirtyCanvas(true, true);
        }
      }, { serialize: false });
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted?.apply(this, arguments);
      const image = this.widgets.find((widget) => widget.name === "image");
      // A save made while execution was in flight must remain the next input.
      if (message.editor_image?.[0] && image.value === message.editor_source?.[0]) {
        image.value = message.editor_image[0];
        this.properties.image = image.value;
        image.callback?.(image.value);
      }
      this.setDirtyCanvas(true, true);
      return result;
    };
  },
});
