import { app } from "../../scripts/app.js";

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

    // 节点执行后：拿到 ui.images（temp 预览文件）和 session_id，渲染 DOM 网格
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
    } else if (node.comfyClass === LOAD_PATH_NODE) {
      setupFilePicker(node);
    } else if (node.comfyClass === BATCH_NODE) {
      setupFolderPicker(node);
      setupBatchSelector(node);
    }
  },
});

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
    sessionId: null,
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
  let sessionId = result?.session_id;
  // 防御：某些环节可能把 session_id 字符串拆成字符数组，join 回字符串
  if (Array.isArray(sessionId)) sessionId = sessionId.join("");
  if (typeof sessionId !== "string") sessionId = sessionId ? String(sessionId) : "";
  const metas = result?.images;
  if (!sessionId || !Array.isArray(metas)) return;

  state.sessionId = sessionId;
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
      if (!state.sessionId) return;
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
  if (!state.sessionId) {
    console.warn("[SaveImageToPath] no session_id, 请先执行节点");
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

  console.log("[SaveImageToPath] save_selected request:", {
    session_id: state.sessionId,
    indices,
    folder,
    filename,
  });

  try {
    const response = await fetch("/save_image_to_path/save_selected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        indices,
        folder,
        filename,
      }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    // 保存成功：清空选中状态与 selection 输入框
    state.selected.clear();
    state.container
      ?.querySelectorAll(".sitp-batch-cell.sitp-selected")
      .forEach((el) => el.classList.remove("sitp-selected"));
    syncSelectionWidget(node, "");
    updateButtonLabel(node);
    if (data.message) {
      console.log("[SaveImageToPath] " + data.message);
    }
  } catch (e) {
    console.error("[SaveImageToPath] save_selected failed:", e);
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
