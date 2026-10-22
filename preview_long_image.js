import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "LiuxinyuPreviewLongImage";

function gcdInt(a, b) {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function computeBatchLayout(N, W, H, w0, h0) {
  const num = W * h0;
  const den = H * w0;
  const g = gcdInt(num, den) || 1;
  const p = num / g;
  const q = den / g;
  const pq = p * q;

  if (N % pq === 0) {
    const k = Math.sqrt(N / pq);
    if (Number.isInteger(k)) {
      const m = k * p;
      const n = k * q;
      return { s: W / (m * w0), m, n };
    }
  }

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

app.registerExtension({
  name: "Liuxinyu.PreviewLongImage",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      const node = this;

      let imgsValue = [];
      try {
        Object.defineProperty(node, "imgs", {
          get: () => imgsValue,
          set: () => {},
          configurable: true,
          enumerable: true,
        });
      } catch (e) {}

      node._llpItems = [];
      node._llpScrollDir = "从左向右";
      node._llpViewMode = "grid";
      node._llpIndex = 0;
      let hideUITimer = null;
      let currentRatio = 1;

      const container = document.createElement("div");
      container.style.cssText = "width:100%; height:100%; position:relative; display:flex; flex-direction:column; overflow:hidden;";

      // --- 网格视图 ---
      const gridView = document.createElement("div");
      // 恢复居中排布
      gridView.style.cssText = "flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden;";
      // 网格模式下，滚轮事件穿透给底层画布用于缩放
      gridView.addEventListener("wheel", (e) => {
        if (node._llpViewMode !== "grid") return;
        e.preventDefault();
        e.stopPropagation();
        app.canvas?.processMouseWheel?.(e);
      }, { passive: false });
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid; gap:0;";
      gridView.appendChild(grid);

      // --- 单图视图 ---
      const singleView = document.createElement("div");
      singleView.style.cssText = "position:absolute; inset:0; display:none; flex-direction:column;";
      
      const singleScroll = document.createElement("div");
      singleScroll.className = "llp-scroll";
      singleScroll.style.cssText = "flex:1; overflow:auto; display:block; position:relative; scrollbar-width:none; -ms-overflow-style:none;";
      
      const style = document.createElement("style");
      style.textContent = `.llp-scroll::-webkit-scrollbar { display: none !important; }`;
      document.head.appendChild(style);

      const singleImg = document.createElement("img");
      singleImg.style.cssText = "display:block;";
      singleScroll.appendChild(singleImg);

      // 四向遮罩
      const maskTop = document.createElement("div");
      maskTop.style.cssText = "position:absolute; top:0; left:0; right:0; height:40px; pointer-events:none; transition:opacity 0.2s; opacity:0; background:linear-gradient(to bottom, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskBottom = document.createElement("div");
      maskBottom.style.cssText = "position:absolute; bottom:0; left:0; right:0; height:40px; pointer-events:none; transition:opacity 0.2s; opacity:0; background:linear-gradient(to top, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskLeft = document.createElement("div");
      maskLeft.style.cssText = "position:absolute; top:0; left:0; bottom:0; width:40px; pointer-events:none; transition:opacity 0.2s; opacity:0; background:linear-gradient(to right, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskRight = document.createElement("div");
      maskRight.style.cssText = "position:absolute; top:0; right:0; bottom:0; width:40px; pointer-events:none; transition:opacity 0.2s; opacity:0; background:linear-gradient(to left, rgba(0,0,0,0.8), transparent); z-index:5;";

      singleView.appendChild(singleScroll);
      singleView.appendChild(maskTop);
      singleView.appendChild(maskBottom);
      singleView.appendChild(maskLeft);
      singleView.appendChild(maskRight);

      // UI 覆盖层
      const uiOverlay = document.createElement("div");
      uiOverlay.style.cssText = "position:absolute; inset:0; pointer-events:none; transition:opacity 0.3s; opacity:1; z-index:10;";

      const btnClose = document.createElement("div");
      btnClose.innerHTML = "✕";
      btnClose.style.cssText = "position:absolute; top:10px; right:10px; width:30px; height:30px; line-height:30px; text-align:center; background:rgba(0,0,0,0.6); color:#fff; border-radius:4px; cursor:pointer; pointer-events:auto; font-size:16px;";
      
      const indicator = document.createElement("div");
      indicator.style.cssText = "position:absolute; bottom:10px; right:10px; padding:4px 8px; background:rgba(0,0,0,0.6); color:#fff; border-radius:4px; font-size:12px; pointer-events:none;";

      uiOverlay.appendChild(btnClose);
      uiOverlay.appendChild(indicator);
      singleView.appendChild(uiOverlay);

      container.addEventListener("pointerdown", (e) => {
        // 阻止事件冒泡到画布：否则画布会把这次点击当成点击空白区域，从而取消节点的选中状态
        e.stopPropagation();
        if (e.button === 0 && app.canvas && typeof app.canvas.selectNode === "function") {
          app.canvas.selectNode(node);
        }
      });

      container.appendChild(gridView);
      container.appendChild(singleView);

      let widget;
      widget = node.addDOMWidget("long_preview", "custom", container, {
        hideOnZoom: false,
        getMinHeight: () => 300,
        onDraw: () => { if (widget) widget.width = undefined; },
        afterResize: () => { if (widget) { widget.width = undefined; relayoutGrid(); } }
      });
      widget.serialize = false;

      function getVirtualSize(w, h) {
        const ratio = w / h;
        const targetRatio = 16 / 9;
        if (ratio < 0.95) return { vw: 9, vh: 16 };
        if (ratio > 1.05) return { vw: 16, vh: 9 };
        return { vw: w, vh: h };
      }

      function relayoutGrid() {
        if (node._llpViewMode !== "grid" || node._llpItems.length === 0) return;
        const W = gridView.clientWidth;
        const H = gridView.clientHeight;
        if (!W || !H) return;

        const firstImg = grid.querySelector("img");
        if (!firstImg || !firstImg.naturalWidth) return;
        
        const { vw, vh } = getVirtualSize(firstImg.naturalWidth, firstImg.naturalHeight);
        const { s, m, n } = computeBatchLayout(node._llpItems.length, W, H, vw, vh);

        const cellW = Math.floor(vw * s);
        const cellH = Math.floor(vh * s);
        const cells = grid.querySelectorAll(".llp-cell");
        cells.forEach((cell) => {
          cell.style.width = `${cellW}px`;
          cell.style.height = `${cellH}px`;
        });

        grid.style.gridTemplateColumns = `repeat(${m}, ${cellW}px)`;
        grid.style.gridTemplateRows = `repeat(${n}, ${cellH}px)`;
      }

      function updateMasks() {
        if (node._llpViewMode !== "single") return;
        const maxScrollTop = singleScroll.scrollHeight - singleScroll.clientHeight;
        const maxScrollLeft = singleScroll.scrollWidth - singleScroll.clientWidth;
        
        maskTop.style.opacity = singleScroll.scrollTop > 5 ? "1" : "0";
        maskBottom.style.opacity = singleScroll.scrollTop < maxScrollTop - 5 ? "1" : "0";
        maskLeft.style.opacity = singleScroll.scrollLeft > 5 ? "1" : "0";
        maskRight.style.opacity = singleScroll.scrollLeft < maxScrollLeft - 5 ? "1" : "0";
      }

      function showUI() {
        uiOverlay.style.opacity = "1";
        clearTimeout(hideUITimer);
        hideUITimer = setTimeout(() => {
          uiOverlay.style.opacity = "0";
        }, 1500);
      }

      function enterViewMode(index) {
        node._llpViewMode = "single";
        node._llpIndex = index;
        gridView.style.display = "none";
        singleView.style.display = "flex";
        
        const isMulti = node._llpItems.length > 1;
        btnClose.style.display = isMulti ? "block" : "none";
        
        updateSingleImage();
      }

      function exitViewMode() {
        if (node._llpItems.length <= 1) return;
        node._llpViewMode = "grid";
        gridView.style.display = "flex";
        singleView.style.display = "none";
        relayoutGrid();
      }

      function updateSingleImage() {
        const meta = node._llpItems[node._llpIndex];
        if (!meta) return;
        indicator.textContent = `${node._llpIndex + 1}/${node._llpItems.length}`;
        
        singleImg.src = api.apiURL(`/view?filename=${encodeURIComponent(meta.filename)}&subfolder=${encodeURIComponent(meta.subfolder)}&type=${meta.type}&rand=${Date.now()}`);
        singleImg.onload = () => {
          const w = singleImg.naturalWidth;
          const h = singleImg.naturalHeight;
          currentRatio = w / h;
          
          // 大图模式：高度/宽度自适应，不拉伸
          if (currentRatio < 1) {
            singleImg.style.width = "100%";
            singleImg.style.height = "auto";
          } else if (currentRatio > 1) {
            singleImg.style.height = "100%";
            singleImg.style.width = "auto";
          } else {
            singleImg.style.width = "100%";
            singleImg.style.height = "100%";
          }
          
          singleScroll.scrollLeft = 0;
          singleScroll.scrollTop = 0;
          
          // 根据方向设置初始滚动位置
          if (node._llpScrollDir === "从右向左" && currentRatio > 1) {
            singleScroll.scrollLeft = singleScroll.scrollWidth - singleScroll.clientWidth;
          }
          
          updateMasks();
          showUI();
        };
      }

      btnClose.addEventListener("pointerdown", (e) => e.stopPropagation());
      btnClose.addEventListener("click", (e) => { e.stopPropagation(); exitViewMode(); });

      const onKeyDown = (e) => {
        if (node._llpViewMode !== "single") return;
        const isMulti = node._llpItems.length > 1;
        if (e.key === "Escape" && isMulti) {
          exitViewMode();
        } else if (e.key === "ArrowLeft" && isMulti) {
          node._llpIndex = (node._llpIndex - 1 + node._llpItems.length) % node._llpItems.length;
          updateSingleImage();
        } else if (e.key === "ArrowRight" && isMulti) {
          node._llpIndex = (node._llpIndex + 1) % node._llpItems.length;
          updateSingleImage();
        }
      };
      document.addEventListener("keydown", onKeyDown);

      singleScroll.addEventListener("scroll", () => updateMasks());
      singleView.addEventListener("mousemove", () => showUI());

      // 仅在大图模式下拦截滚轮
      singleView.addEventListener("wheel", (e) => {
        if (node._llpViewMode !== "single") return;
        e.stopPropagation();
        e.preventDefault();
        
        // 如果是超宽图，滚轮控制左右滚动；否则控制上下滚动
        if (currentRatio > 1) {
          if (node._llpScrollDir === "从右向左") {
            singleScroll.scrollLeft -= e.deltaY;
          } else {
            singleScroll.scrollLeft += e.deltaY;
          }
        } else {
          singleScroll.scrollTop += e.deltaY;
        }
        
        updateMasks();
        showUI();
      }, { passive: false });

      const origOnExecuted = node.onExecuted;
      node.onExecuted = function (message) {
        origOnExecuted?.apply(this, arguments);
        if (!message?.images) return;

        node._llpItems = message.images;
        node._llpScrollDir = message.scroll_direction?.[0] || "从左向右";
        
        if (node._llpItems.length === 0) {
          grid.replaceChildren();
          gridView.style.display = "flex";
          singleView.style.display = "none";
          return;
        }

        if (node._llpItems.length === 1) {
          enterViewMode(0);
          return;
        }

        // 强制先退回网格模式
        node._llpViewMode = "grid";
        gridView.style.display = "flex";
        singleView.style.display = "none";

        grid.replaceChildren();

        let loadedCount = 0;
        node._llpItems.forEach((meta, index) => {
          const cell = document.createElement("div");
          cell.className = "llp-cell";
          cell.style.cssText = "position:relative; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;";

          const img = document.createElement("img");
          img.src = api.apiURL(`/view?filename=${encodeURIComponent(meta.filename)}&subfolder=${encodeURIComponent(meta.subfolder)}&type=${meta.type}&rand=${Date.now()}`);
          img.style.cssText = "width:100%; height:100%; object-fit:cover; display:block; pointer-events:none;";

          const mask = document.createElement("div");
          mask.style.cssText = "position:absolute; pointer-events:none; display:none;";

          cell.appendChild(img);
          cell.appendChild(mask);

          const handleClick = (e) => {
            e.preventDefault();
            enterViewMode(index);
          };

          cell.addEventListener("click", handleClick);
          grid.appendChild(cell);

          img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            const ratio = w / h;

            // 缩略图渐变：严格按照虚拟比例截断
            if (ratio < 0.95) {
              img.style.objectPosition = "top";
              mask.style.display = "block";
              mask.style.left = "0";
              mask.style.right = "0";
              mask.style.bottom = "0";
              mask.style.height = "40%";
              mask.style.background = "linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)";
            } else if (ratio > 1.05) {
              if (node._llpScrollDir === "从右向左") {
                img.style.objectPosition = "right center";
                mask.style.display = "block";
                mask.style.top = "0";
                mask.style.bottom = "0";
                mask.style.left = "0";
                mask.style.width = "30%";
                mask.style.background = "linear-gradient(to right, rgba(0,0,0,0.8) 0%, transparent 100%)";
              } else {
                img.style.objectPosition = "left center";
                mask.style.display = "block";
                mask.style.top = "0";
                mask.style.bottom = "0";
                mask.style.right = "0";
                mask.style.width = "30%";
                mask.style.background = "linear-gradient(to left, rgba(0,0,0,0.8) 0%, transparent 100%)";
              }
            } else {
              img.style.objectPosition = "center";
              mask.style.display = "none";
            }

            loadedCount++;
            // 只有所有图片加载完毕后，才进行网格排版
            if (loadedCount === node._llpItems.length) {
              relayoutGrid();
            }
          };
        });
      };

      const origOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        document.removeEventListener("keydown", onKeyDown);
        origOnRemoved?.apply(this, arguments);
      };
    };
  }
});
