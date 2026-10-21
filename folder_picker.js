import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Adapter for the installed ComfyUI frontend 1.53.6 issue panel.
const previewErrorBridge = import("/assets/settingStore-DDHzGrHr.js")
  .then(({ Ot: useExecutionErrorStore, bs: getExecutionIdByNode }) => ({
    store: useExecutionErrorStore(), getExecutionIdByNode,
  }))
  .catch((error) => {
    console.error("[SaveImageToPath] 无法连接工作流问题面板", error);
    return null;
  });

const SAVE_IMAGE_NODE = "SaveImageToAbsolutePath";
const LOAD_PATH_NODE = "LoadPath";
const BATCH_NODE = "SaveSelectedFromBatch";

let batchStyleInjected = false;

function injectBatchStyles() {
  if (batchStyleInjected) return;
  batchStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.sitp-batch-grid {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: transparent;
}
.sitp-batch-inner {
  display: grid;
  gap: 0;
  box-sizing: border-box;
}
.sitp-batch-cell {
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
  cursor: pointer;
  background: transparent;
}
.sitp-batch-cell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}
.sitp-batch-cell .sitp-batch-tint {
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-sizing: border-box;
  background: rgba(76, 175, 80, 0);
  border: 0 solid rgba(76, 175, 80, 0);
  transition: background-color 60ms linear, border-width 60ms linear;
}
.sitp-batch-cell.sitp-selected .sitp-batch-tint {
  background: rgba(76, 175, 80, 0.35);
  border: 3px solid rgba(76, 175, 80, 0.95);
}
.sitp-batch-cell .sitp-batch-check {
  position: absolute;
  left: 6px;
  top: 6px;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  border: 1.5px solid rgba(255, 255, 255, 0.9);
  color: #fff;
  font: 700 14px/20px sans-serif;
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 60ms linear;
}
.sitp-batch-cell.sitp-selected .sitp-batch-check {
  opacity: 1;
  background: rgba(76, 175, 80, 0.95);
}
`;
  document.head.appendChild(style);
}

app.registerExtension({
  name: "SaveImageToPath.FolderPicker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== BATCH_NODE) return;

    // 节点执行后：按 ui.images 的实际文件名渲染和保存，可包含多个批次。
    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (result) {
      // 拿走 images 再交给核心，核心不会创建 canvas 预览 widget
      let coreResult = result;
      if (result && result.images) {
        coreResult = { ...result, images: undefined };
      }
      const r = originalOnExecuted ? originalOnExecuted.call(this, coreResult) : undefined;
      try {
        onBatchExecuted(this, result);
      } catch (e) {
        console.error("[SaveImageToPath] onBatchExecuted failed:", e);
      }
      return r;
    };
  },

  async nodeCreated(node) {
    if (node.comfyClass === SAVE_IMAGE_NODE) {
      setupFolderPicker(node);
    } else if (node.comfyClass === "LoadImageBatchFromPath") {
      setupImageBatchPicker(node);
      setupPathPreview(node);
    } else if (node.comfyClass === LOAD_PATH_NODE || node.comfyClass === "LoadImageFromPath") {
      setupFilePicker(node);
      setupPathPreview(node);
    } else if (node.comfyClass === "LiuxinyuLoadTextFile") {
      setupFilePicker(node);
    } else if (node.comfyClass === BATCH_NODE) {
      setupFolderPicker(node);
      setupBatchSelector(node);
    }
  },
});

function setupPathPreview(node) {
  const path = node.widgets?.find((w) => w.name === "path");
  if (!path || path.__pathPreview) return;
  path.__pathPreview = true;
  const session = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  let revision = 0;
  let removed = false;
  let timer;
  let controller;
  let outputKey;
  let ownedOutput;
  let previewErrorNodeId;
  let previewErrorGraph;
  const errorType = `liuxinyu_path_preview_${session}`;
  const reportPreviewError = async (message, version) => {
    const bridge = await previewErrorBridge;
    if (version !== revision) return;
    if (!bridge) {
      if (message) app.extensionManager.toast.add({ severity: "error", summary: "路径预览检查失败", detail: message });
      return;
    }
    const { store, getExecutionIdByNode } = bridge;
    const id = removed ? previewErrorNodeId : getExecutionIdByNode(app.rootGraph, node);
    if (!id || (removed && previewErrorGraph !== app.rootGraph)) return;
    if (message) {
      previewErrorNodeId = id;
      previewErrorGraph = app.rootGraph;
    }
    const errors = { ...(store.lastNodeErrors || {}) };
    const previous = errors[id];
    const retained = (previous?.errors || []).filter((error) => error.type !== errorType);
    if (message) retained.push({
      type: errorType,
      message: "图像路径检查失败",
      details: message,
      extra_info: { input_name: "path" },
    });
    if (retained.length) {
      errors[id] = { ...previous, class_type: node.comfyClass, dependent_outputs: previous?.dependent_outputs || [], errors: retained };
    } else if (previous) {
      delete errors[id];
    }
    store.recordNodeErrors(errors);
    node.setDirtyCanvas(true, true);
  };
  const pendingImages = new Set();
  const locator = () => node.graph?.isRootGraph === false ? `${node.graph.id}:${node.id}` : String(node.id);
  const releaseOutput = () => {
    if (outputKey && app.nodeOutputs[outputKey] === ownedOutput) delete app.nodeOutputs[outputKey];
  };
  const clear = () => {
    releaseOutput();
    node.imgs = [];
    node.images = [];
    if (!removed && node.graph) {
      outputKey = locator();
      ownedOutput = { images: node.images };
      app.nodeOutputs = { ...app.nodeOutputs, [outputKey]: ownedOutput };
    }
    node.imageIndex = null;
    const index = node.widgets.findIndex((w) => w.name === "$$canvas-image-preview");
    if (index !== -1) {
      node.widgets[index].onRemove?.();
      node.widgets.splice(index, 1);
    }
    node.setDirtyCanvas(true, true);
  };
  const notify = (message, severity = "error") => {
    app.extensionManager?.toast?.add({ severity, summary: "路径预览", detail: message, life: 6000 });
    console.warn(`[SaveImageToPath] ${message}`);
  };
  const dimensions = () => {
    if (node.comfyClass !== "LoadImageBatchFromPath") return {};
    const names = ["target_width", "target_height"];
    const linked = names.map((name) => node.inputs?.some((input) => input.name === name && input.link != null));
    return {
      dimensions_pending: linked.some(Boolean),
      target_width: Number(node.widgets?.find((widget) => widget.name === names[0])?.value ?? 0),
      target_height: Number(node.widgets?.find((widget) => widget.name === names[1])?.value ?? 0),
    };
  };
  const request = (value, version, options = {}) => api.fetchApi("/save_image_to_path/preview_path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, revision: version, kind: node.comfyClass, path: value, clear: removed, ...dimensions() }),
    ...options,
  });
  const loadImage = (meta) => new Promise((resolve, reject) => {
    const image = new Image();
    const cancel = () => { image.src = ""; finish(new Error("预览已取消")); };
    const timeout = setTimeout(() => finish(new Error("预览图片加载超时")), 15000);
    const finish = (error) => {
      clearTimeout(timeout);
      pendingImages.delete(cancel);
      image.onload = image.onerror = null;
      if (error) reject(error); else resolve(image);
    };
    pendingImages.add(cancel);
    image.onload = () => finish();
    image.onerror = () => finish(new Error("无法加载临时预览图片"));
    image.src = api.apiURL(`/view?${new URLSearchParams(meta)}`);
  });
  const refresh = () => {
    if (removed) return;
    const version = ++revision;
    const value = String(path.value ?? "");
    clearTimeout(timer);
    controller?.abort();
    for (const cancel of pendingImages) cancel();
    clear();
    if (node.inputs?.some((input) => input.name === "path" && input.link != null)) {
      // A connected path is evaluated upstream; do not validate a stale widget value.
      void reportPreviewError(null, version);
      return;
    }
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const response = await request(value, version, { signal: controller.signal });
        const data = await response.json();
        if (removed || version !== revision) return;
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        if (data.stale) return;
        const metas = data.images || [];
        const images = await Promise.all(metas.map(loadImage));
        if (removed || version !== revision || String(path.value ?? "") !== value) return;
        // The official draw handler creates its native ImagePreviewWidget from
        // imgs. Preload with a revision guard: core's async loader has no guard.
        ownedOutput = { images: metas };
        outputKey = locator();
        node.images = metas;
        node.imgs = images;
        node.imageIndex = null;
        node.previewMediaType = "image";
        node.animatedImages = false;
        app.nodeOutputs = { ...app.nodeOutputs, [outputKey]: ownedOutput };
        node.setDirtyCanvas(true, true);
        await reportPreviewError(null, version);
        if (data.warning) notify(data.warning, "warn");
      } catch (error) {
        if (removed || version !== revision || error.name === "AbortError") return;
        clear();
        await reportPreviewError(error.message, version);
      }
    }, 180);
  };
  const callback = path.callback;
  path.callback = function (...args) {
    try { return callback?.apply(this, args); } finally { refresh(); }
  };
  if (node.comfyClass === "LoadImageBatchFromPath") {
    for (const widget of node.widgets.filter((item) => ["target_width", "target_height"].includes(item.name))) {
      const callback = widget.callback;
      widget.callback = function (...args) {
        try { return callback?.apply(this, args); } finally { refresh(); }
      };
    }
    const connectionsChanged = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = connectionsChanged?.apply(this, args);
      queueMicrotask(refresh);
      return result;
    };
  }
  const configure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configure?.apply(this, args);
    refresh();
    return result;
  };
  const onRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    removed = true;
    ++revision;
    void reportPreviewError(null, revision);
    clearTimeout(timer);
    controller?.abort();
    for (const cancel of pendingImages) cancel();
    clear();
    void request("", revision, { keepalive: true }).catch(() => {});
    return onRemoved?.apply(this, args);
  };
  refresh();
}

function setupFolderPicker(node) {
  const folder = node.widgets?.find((w) => w.name === "folder");
  if (!folder || folder.__saveImageToPathFolderPicker) return;
  folder.__saveImageToPathFolderPicker = true;

  const button = node.addWidget(
    "button",
    "选择文件夹",
    "save_image_to_path_select_folder",
    async () => {
      await openFolderPicker(folder);
    },
    {
      serialize: false,
      canvasOnly: true,
    },
  );

  const widgets = node.widgets;
  const folderIndex = widgets.indexOf(folder);
  const buttonIndex = widgets.indexOf(button);
  if (folderIndex >= 0 && buttonIndex >= 0 && buttonIndex !== folderIndex + 1) {
    widgets.splice(buttonIndex, 1);
    widgets.splice(folderIndex + 1, 0, button);
  }

  button.label = "选择文件夹";
  node.setDirtyCanvas(true, true);
}

function setupImageBatchPicker(node) {
  const path = node.widgets?.find((w) => w.name === "path");
  if (!path || path.__imageBatchPicker) return;
  path.__imageBatchPicker = true;

  node.addWidget("button", "选择图片（多选）", "select_images", async () => {
    try {
      const query = new URLSearchParams({ path: String(path.value ?? "") });
      const response = await fetch(`/save_image_to_path/select_images?${query}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (!Array.isArray(data.paths) || !data.paths.length) return;
      const value = data.paths.map((item) => `"${item.replaceAll('"', '""')}"`).join(",");
      path.value = value;
      path.callback?.(value);
      node.setDirtyCanvas(true, true);
    } catch (error) {
      console.error("[SaveImageToPath] Image picker failed:", error);
    }
  }, { serialize: false, canvasOnly: true });
  node.addWidget("button", "选择文件夹", "select_image_folder", async () => {
    await openFolderPicker(path);
  }, { serialize: false, canvasOnly: true });
  node.setDirtyCanvas(true, true);
}

function setupFilePicker(node) {
  const path = node.widgets?.find((w) => w.name === "path");
  if (!path || path.__saveImageToPathFilePicker) return;
  path.__saveImageToPathFilePicker = true;

  const button = node.addWidget(
    "button",
    "选择文件",
    "save_image_to_path_select_file",
    async () => {
      await openFilePicker(path);
    },
    {
      serialize: false,
      canvasOnly: true,
    },
  );

  const widgets = node.widgets;
  const pathIndex = widgets.indexOf(path);
  const buttonIndex = widgets.indexOf(button);
  if (pathIndex >= 0 && buttonIndex >= 0 && buttonIndex !== pathIndex + 1) {
    widgets.splice(buttonIndex, 1);
    widgets.splice(pathIndex + 1, 0, button);
  }

  button.label = "选择文件";
  node.setDirtyCanvas(true, true);
}

// --- SaveSelectedFromBatch: DOM 网格预览 + 点选 + 保存按钮 ---

function setupBatchSelector(node) {
  if (node.__saveImageToPathBatchSetup) return;
  node.__saveImageToPathBatchSetup = true;

  injectBatchStyles();

  const state = {
    imageMetas: [],
    selected: new Set(),
    button: null,
    container: null,
    inner: null,
    domWidget: null,
    ro: null,
  };
  node._batchState = state;

  // 保存按钮（canvas button widget，和其他节点按钮一致）
  const button = node.addWidget(
    "button",
    "保存所选(0)",
    "save_image_to_path_save_selected",
    async () => {
      await saveSelectedFromBatch(node);
    },
    {
      serialize: false,
      canvasOnly: true,
    },
  );
  state.button = button;

  // DOM 网格容器：挂到节点上的官方 DOM widget 槽位，内部完全用普通 HTML/CSS 布局
  const container = document.createElement("div");
  container.className = "sitp-batch-grid";
  state.container = container;

  const domWidget = node.addDOMWidget("sitp_batch_preview", "custom", container, {
    hideOnZoom: false,
    getMinHeight: () => 220,
  });
  // 注意：addDOMWidget 不会把 options.serialize 挂到实例上，
  // 必须手动设置，否则保存工作流时会多写一个空串占位导致加载时值错位。
  domWidget.serialize = false;
  state.domWidget = domWidget;

  // 槽位顺序：folder / 选择文件夹 / filename / 保存所选 / selection / 预览网格
  moveWidgetAfter(node, button, "filename");
  moveWidgetAfter(node, domWidget, "selection");

  // 容器尺寸变化时重新布局（debounce：选中/取消选中瞬间核心会改变节点边框，
  // 导致 container 尺寸连续跳变，直接 relayout 会捕获过渡态尺寸）
  let relayoutRaf = null;
  const scheduleRelayout = () => {
    if (relayoutRaf) cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(() => {
      relayoutRaf = null;
      try {
        relayoutBatchGrid(node);
      } catch (e) {
        console.error("[SaveImageToPath] relayout failed:", e);
      }
    });
  };
  state.ro = new ResizeObserver(scheduleRelayout);
  state.ro.observe(container);
  // 同时观察父元素：container.style.width 被显式设置后会脱离 100% 约束，
  // 节点缩窄时 container 自身不变化、ResizeObserver 不触发。
  // 观察父元素可捕获父元素尺寸变化，重新读取 node.size[0] 并更新 container 宽度。
  if (container.parentElement) {
    state.ro.observe(container.parentElement);
  }

  // 选中/取消选中时，核心改变节点边框导致 DOM widget 区域尺寸变化。
  // 在下一帧（边框已稳定）再触发一次 relayout，确保使用最终尺寸。
  const origOnSelected = node.onSelected;
  node.onSelected = function () {
    origOnSelected?.call(this);
    scheduleRelayout();
  };
  const origOnDeselected = node.onDeselected;
  node.onDeselected = function () {
    origOnDeselected?.call(this);
    scheduleRelayout();
  };

  // 在 DOM 区域滚轮应转发给画布（缩放/平移），而不是被吞掉
  forwardCanvasGestures(container);

  // 阻止核心创建 canvas 图片预览 widget（$$canvas-image-preview）。
  // 核心流程：dispatch 把 result 写入 store.nodeOutputs → useNodeImage 异步加载
  // 图片 → 设置 node.imgs → showCanvasImagePreview 检查 node.imgs?.length 创建
  // ImagePreviewWidget。strip result.images 无效，因为 store 在 onExecuted 之前已写入。
  // 这里 hijack node.imgs 的 setter，让核心永远拿到空数组，从而既不创建 widget，
  // 也不渲染 canvas 图片。SaveSelectedFromBatch 没有 IMAGE 输出，不会被下游 GLSL
  // 节点读取 node.imgs，所以 hijack 是安全的。
  let imgsValue = [];
  try {
    Object.defineProperty(node, "imgs", {
      get: () => imgsValue,
      set: () => {},
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    console.warn("[SaveImageToPath] hijack node.imgs failed:", e);
  }

  node.setDirtyCanvas(true, true);
}

function moveWidgetAfter(node, widget, afterWidgetName) {
  const widgets = node.widgets;
  const target = widgets.findIndex((w) => w.name === afterWidgetName);
  const from = widgets.indexOf(widget);
  if (target >= 0 && from >= 0 && from !== target + 1) {
    widgets.splice(from, 1);
    widgets.splice(target + 1, 0, widget);
  }
}

function onBatchExecuted(node, result) {
  const state = node._batchState;
  if (!state) return;
  const metas = result?.images;
  if (!Array.isArray(metas)) return;

  state.imageMetas = metas;
  state.selected.clear();
  syncSelectionWidget(node, "");
  updateButtonLabel(node);

  renderBatchCells(node, metas);
  relayoutBatchGrid(node);
}

function renderBatchCells(node, metas) {
  const state = node._batchState;
  const container = state.container;
  container.replaceChildren();

  // 内层容器：固定宽高，承载图片排列；外层 flex 居中内层
  const inner = document.createElement("div");
  inner.className = "sitp-batch-inner";
  state.inner = inner;

  metas.forEach((meta, i) => {
    const cell = document.createElement("div");
    cell.className = "sitp-batch-cell";
    cell.dataset.index = String(i);

    const img = document.createElement("img");
    img.alt = `preview ${i + 1}`;
    img.src = buildViewUrl(meta);
    img.onerror = () => {
      console.error("[SaveImageToPath] preview load failed:", meta);
    };
    img.onload = () => {
      relayoutBatchGrid(node);
    };

    const tint = document.createElement("div");
    tint.className = "sitp-batch-tint";
    const check = document.createElement("div");
    check.className = "sitp-batch-check";
    check.textContent = "✓";

    cell.appendChild(img);
    cell.appendChild(tint);
    cell.appendChild(check);

    cell.addEventListener("click", () => {
      if (state.selected.has(i)) {
        state.selected.delete(i);
        cell.classList.remove("sitp-selected");
      } else {
        state.selected.add(i);
        cell.classList.add("sitp-selected");
      }
      syncSelectionWidget(
        node,
        Array.from(state.selected)
          .sort((a, b) => a - b)
          .join(","),
      );
      updateButtonLabel(node);
    });

    inner.appendChild(cell);
  });

  container.appendChild(inner);
}

function buildViewUrl(meta) {
  const params = new URLSearchParams();
  params.set("filename", meta.filename ?? "");
  if (meta.subfolder) params.set("subfolder", meta.subfolder);
  if (meta.type) params.set("type", meta.type);
  return `/view?${params.toString()}`;
}

// 排布函数（数学形式化）：把 N 张同尺寸图片无缝排进 W×H 画板，输出 (s, m, n)。
//   s: 每张图片的等比缩放因子；m: 每行个数；n: 行数（n = N/m）。
// 记号：画板比例 R = W/H，图片比例 r = w0/h0，比例比 R/r = p/q（互质整数比）。
// 分支一（完美无缝填满）：若存在正整数 k 使 N = k²·p·q，
//   则 m = k·p，n = k·q，s = W/(m·w0) = H/(n·h0)，整体正好 W×H 无缝无留白。
// 分支二（非完美填满）：枚举 N 的所有正因子 m（n = N/m），
//   外轮廓比例 S(m) = (m/n)·r = (m²/N)·r，
//   对数误差 d(m) = |ln(S(m)/R)|，
//   排序键 φ(m) = (d(m), |m-n|, -m)：误差小优先 → 网格接近正方形 → m 大（行优先）。
//   s = min(W/(m*·w0), H/(n*·h0))，一边贴边，另一边由外层 flex 居中留白。
function gcdInt(a, b) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function computeBatchLayout(N, W, H, w0, h0) {
  // 比例比 R/r = (W·h0)/(H·w0)，整数约分成互质 p/q
  const num = W * h0;
  const den = H * w0;
  const g = gcdInt(num, den) || 1;
  const p = num / g;
  const q = den / g;
  const pq = p * q;

  // 分支一：完美无缝填满 N = k²·p·q
  if (N % pq === 0) {
    const k = Math.sqrt(N / pq);
    if (Number.isInteger(k)) {
      const m = k * p;
      const n = k * q;
      return { s: W / (m * w0), m, n };
    }
  }

  // 分支二：枚举 N 的因子，选 φ(m) 最小者
  const r = w0 / h0;
  const R = W / H;
  const EPS = 1e-9;
  let best = null;
  for (let m = 1; m <= N; m++) {
    if (N % m !== 0) continue;
    const n = N / m;
    const d = Math.abs(Math.log((m * m * r) / N / R));
    const diff = Math.abs(m - n);
    if (
      !best ||
      d < best.d - EPS ||
      (d <= best.d + EPS &&
        (diff < best.diff || (diff === best.diff && m > best.m)))
    ) {
      best = { m, n, d, diff };
    }
  }
  const m = best.m;
  const n = best.n;
  return { s: Math.min(W / (m * w0), H / (n * h0)), m, n };
}

function relayoutBatchGrid(node) {
  const state = node._batchState;
  if (!state || !state.container || !state.inner) return;
  const container = state.container;
  const inner = state.inner;
  const count = state.imageMetas.length;
  if (!count) return;

  // 画板宽度：不能用 container.clientWidth —— ComfyUI 核心在节点选中时
  // 会把 DOM widget 从"全宽预览"切换到"标准编辑宽度"（~205px），导致布局跳变。
  // 改用 node.size[0] - 20（左右各 10px margin），这个值不随选中状态变化。
  const W = Math.max(0, (node.size?.[0] ?? 0) - 20);
  const H = container.clientHeight;
  if (!W || !H) return;

  // 强制容器宽度 = 节点宽度，覆盖核心在选中时缩窄 DOM widget 的行为。
  // 父元素 overflow 为 visible，不会裁剪溢出部分。
  container.style.width = W + "px";

  // 批次图片尺寸必定相同（同一 [B,H,W,C] tensor），取第一张已加载的原始尺寸
  const imgs = inner.querySelectorAll(".sitp-batch-cell img");
  let w0 = 0;
  let h0 = 0;
  for (const img of imgs) {
    if (img.naturalWidth && img.naturalHeight) {
      w0 = img.naturalWidth;
      h0 = img.naturalHeight;
      break;
    }
  }
  // 还没加载完，img.onload 会再次触发
  if (!w0 || !h0) return;

  const { s, m, n } = computeBatchLayout(count, W, H, w0, h0);

  // 取整避免亚像素导致 grid 溢出
  const cellW = Math.floor(w0 * s);
  const cellH = Math.floor(h0 * s);
  const cells = inner.querySelectorAll(".sitp-batch-cell");
  cells.forEach((cell) => {
    cell.style.width = `${cellW}px`;
    cell.style.height = `${cellH}px`;
  });

  // Grid 精确控制行列数，不会因亚像素意外换行
  inner.style.gridTemplateColumns = `repeat(${m}, ${cellW}px)`;
  inner.style.gridTemplateRows = `repeat(${n}, ${cellH}px)`;
  inner.style.width = `${m * cellW}px`;
  inner.style.height = `${n * cellH}px`;
  app.graph?.setDirtyCanvas(true, true);
}

function forwardCanvasGestures(el) {
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      app.canvas?.processMouseWheel?.(e);
    },
    { passive: false },
  );
  el.addEventListener("pointerdown", (e) => {
    // 中键平移交给画布
    if (e.button === 1) {
      e.preventDefault();
      app.canvas?.processMouseDown?.(e);
    }
  });
}

function syncSelectionWidget(node, value) {
  const w = node.widgets?.find((x) => x.name === "selection");
  if (!w) return;
  w.value = value;
  w.callback?.(value);
}

function updateButtonLabel(node) {
  const state = node._batchState;
  if (!state || !state.button) return;
  const text = `保存所选(${state.selected.size})`;
  // canvas button widget 显示的文字取自 name
  state.button.name = text;
  state.button.label = text;
  node.setDirtyCanvas(true, true);
}

async function saveSelectedFromBatch(node) {
  const state = node._batchState;
  if (!state) return;
  if (!state.imageMetas.length) {
    console.warn("[SaveImageToPath] 请先执行节点生成预览");
    return;
  }
  if (!state.selected.size) {
    console.warn("[SaveImageToPath] 没有选中任何图片");
    return;
  }
  const folderWidget = node.widgets?.find((w) => w.name === "folder");
  const filenameWidget = node.widgets?.find((w) => w.name === "filename");
  const folder = (folderWidget?.value ?? "").toString().trim();
  const filename = (filenameWidget?.value ?? "").toString().trim();
  const indices = Array.from(state.selected).sort((a, b) => a - b);
  const metas = state.imageMetas;

  try {
    const response = await fetch("/save_image_to_path/save_selected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview_files: metas.map((meta) => meta.filename),
        indices,
        folder,
        filename,
      }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    // Only clear selections successfully saved from this preview snapshot.
    if (state.imageMetas === metas) {
      const skipped = new Set(data.skipped || []);
      for (const index of indices) {
        if (!skipped.has(index)) state.selected.delete(index);
      }
      state.container?.querySelectorAll(".sitp-batch-cell").forEach((el) => {
        el.classList.toggle("sitp-selected", state.selected.has(Number(el.dataset.index)));
      });
      syncSelectionWidget(node, Array.from(state.selected).sort((a, b) => a - b).join(","));
      updateButtonLabel(node);
    }
    if (data.message) {
      console.log("[SaveImageToPath] " + data.message);
      app.extensionManager.toast.add({ severity: data.skipped?.length ? "warn" : "success", summary: "保存所选", detail: data.message, life: 6000 });
    }
  } catch (e) {
    console.error("[SaveImageToPath] save_selected failed:", e);
    app.extensionManager.toast.add({ severity: "error", summary: "保存所选失败", detail: e.message });
  }
}

async function openFolderPicker(folderWidget) {
  try {
    const currentFolder = typeof folderWidget.value === "string" ? folderWidget.value.trim() : "";
    const query = currentFolder ? `?folder=${encodeURIComponent(currentFolder)}` : "";
    const response = await fetch(`/save_image_to_path/select_folder${query}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!data.folder) return;

    folderWidget.value = data.folder;
    folderWidget.callback?.(data.folder);
    app.graph?.setDirtyCanvas(true, true);
  } catch (error) {
    console.error("[SaveImageToPath] Folder picker failed:", error);
  }
}

async function openFilePicker(pathWidget) {
  try {
    const currentPath = typeof pathWidget.value === "string" ? pathWidget.value.trim() : "";
    const query = currentPath ? `?path=${encodeURIComponent(currentPath)}` : "";
    const response = await fetch(`/save_image_to_path/select_file${query}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!data.path) return;

    pathWidget.value = data.path;
    pathWidget.callback?.(data.path);
    app.graph?.setDirtyCanvas(true, true);
  } catch (error) {
    console.error("[SaveImageToPath] File picker failed:", error);
  }
}
