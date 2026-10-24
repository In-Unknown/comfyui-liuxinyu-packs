import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { layoutThumbnailRows } from "./thumbnail_grid.js";
import { enablePreviewResize } from "./preview_resize.js";
import { PreviewTiles, previewURL } from "./long_preview_tiles.js";
import { PreviewZoom, beginPreviewZoom, queueSharpPreview, cancelSharpPreview } from "./smooth_preview.js";

const NODE_TYPE = "LiuxinyuPreviewLongImage";
const WIDE_RATIO = 16 / 9;
const TALL_RATIO = 9 / 16;

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
      node._llpTallDir = "从上到下";
      node._llpViewMode = "grid";
      node._llpIndex = 0;
      let hideUITimer = null;
      let currentRatio = 1;
      let removed = false;
      let visible = true;
      let layoutFrame = 0;
      let paintFrame = 0;
      let gridImages = [];
      let lastGridLayout = "";
      let lastCanvasView = "";
      let singleGeometry = null;

      const container = document.createElement("div");
      container.style.cssText = "width:100%; height:100%; position:relative; display:flex; flex-direction:column; overflow:hidden; contain:layout paint;";

      // --- 网格视图 ---
      const gridView = document.createElement("div");
      gridView.style.cssText = "flex:1; min-width:0; min-height:0; display:flex; align-items:flex-start; justify-content:center; overflow:hidden;";
      // 网格模式下，滚轮事件穿透给底层画布用于缩放
      gridView.addEventListener("wheel", (e) => {
        if (node._llpViewMode !== "grid") return;
        e.preventDefault();
        e.stopPropagation();
        beginPreviewZoom(app);
        app.canvas?.processMouseWheel?.(e);
      }, { passive: false });
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid; gap:0; flex:none;";
      gridView.appendChild(grid);

      // --- 单图视图 ---
      const singleView = document.createElement("div");
      singleView.style.cssText = "position:absolute; inset:0; display:none; flex-direction:column;";
      
      const singleScroll = document.createElement("div");
      singleScroll.className = "llp-scroll";
      singleScroll.style.cssText = "flex:1; min-width:0; min-height:0; overflow:auto; display:block; position:relative; scrollbar-width:none; -ms-overflow-style:none;";
      
      const style = document.createElement("style");
      style.textContent = `.llp-scroll::-webkit-scrollbar { display: none !important; }`;
      document.head.appendChild(style);

      // 内容超出时从边缘滚动，能完整显示时在可用空间内居中。
      const singleContent = document.createElement("div");
      singleContent.style.cssText = "display:flex; align-items:center; justify-content:center;";
      const singleSurface = document.createElement("div");
      singleSurface.style.cssText = "position:relative; flex:none; overflow:hidden;";
      const singleImg = document.createElement("img");
      singleImg.alt = "";
      singleImg.decoding = "async";
      singleImg.draggable = false;
      singleImg.style.cssText = "display:block; width:100%; height:100%; max-width:none; max-height:none; pointer-events:none;";
      singleSurface.appendChild(singleImg);
      singleContent.appendChild(singleSurface);
      singleScroll.appendChild(singleContent);
      const tiles = new PreviewTiles(singleSurface, api, singleImg);

      // 四向遮罩
      const maskTop = document.createElement("div");
      maskTop.style.cssText = "position:absolute; top:0; left:0; right:0; height:40px; pointer-events:none; opacity:0; background:linear-gradient(to bottom, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskBottom = document.createElement("div");
      maskBottom.style.cssText = "position:absolute; bottom:0; left:0; right:0; height:40px; pointer-events:none; opacity:0; background:linear-gradient(to top, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskLeft = document.createElement("div");
      maskLeft.style.cssText = "position:absolute; top:0; left:0; bottom:0; width:40px; pointer-events:none; opacity:0; background:linear-gradient(to right, rgba(0,0,0,0.8), transparent); z-index:5;";
      const maskRight = document.createElement("div");
      maskRight.style.cssText = "position:absolute; top:0; right:0; bottom:0; width:40px; pointer-events:none; opacity:0; background:linear-gradient(to left, rgba(0,0,0,0.8), transparent); z-index:5;";

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
        margin: 0,
        getMinHeight: () => 300,
        onDraw: () => { if (widget) widget.width = undefined; onCanvasDraw(); },
        afterResize: () => { if (widget) { widget.width = undefined; scheduleLayout(); } }
      });
      widget.serialize = false;
      enablePreviewResize(node, widget);
      let lastObservedSize = "";
      const resizeObserver = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!width || !height) return;
        const key = `${width}/${height}`;
        if (key !== lastObservedSize) { lastObservedSize = key; scheduleLayout(); }
      });
      resizeObserver.observe(container);
      const visibilityObserver = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) { scheduleLayout(); schedulePaint(); }
      });
      visibilityObserver.observe(container);

      // This node owns its DOM preview. The default background handler would also
      // load every full PNG into Image objects, even though node.imgs is suppressed.
      node.onDrawBackground = onCanvasDraw;

      const interaction = new PreviewZoom(app, {
        onStart: () => {
          tiles.showOverview();
          for (const entry of gridImages) {
            cancelSharpPreview(entry);
            const { img, low } = entry;
            img.style.display = "none";
            low.style.display = "block";
          }
        },
        onEnd: schedulePaint,
      });

      function onCanvasDraw() {
        interaction.draw(String(node.pos));
        const saved = app.nodeOutputs?.[node.id];
        if (saved?.images && saved !== node._llpCanvasOutput) {
          node._llpCanvasOutput = saved;
          node.onExecuted(saved);
        }
        if (node._llpViewMode === "single") {
          const view = `${node.pos}/${widget?.y}/${app.canvas?.visible_area}`;
          if (view !== lastCanvasView) { lastCanvasView = view; schedulePaint(); }
        }
      }

      function visibleGeometry() {
        const area = app.canvas?.visible_area;
        if (!area || !node.pos || !Number.isFinite(widget?.y)) return singleGeometry;
        const x = node.pos[0] + (widget.margin || 0);
        const y = node.pos[1] + widget.y + (widget.margin || 0);
        return { ...singleGeometry, clip: {
          left: Math.max(0, area[0] - x), top: Math.max(0, area[1] - y),
          right: Math.min(singleGeometry.viewportWidth, area[0] + area[2] - x),
          bottom: Math.min(singleGeometry.viewportHeight, area[1] + area[3] - y),
        } };
      }

      function scheduleLayout() {
        if (removed || layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          if (visible) relayout();
        });
      }

      function schedulePaint() {
        if (removed || paintFrame) return;
        paintFrame = requestAnimationFrame(() => {
          paintFrame = 0;
          if (!visible) return;
          if (node._llpViewMode === "single") {
            updateMasks();
            if (!interaction.lowQuality && singleGeometry) tiles.render(node._llpItems[node._llpIndex], visibleGeometry(),
              singleScroll.scrollLeft, singleScroll.scrollTop, interaction.zoom, window.devicePixelRatio || 1);
          } else if (!interaction.lowQuality) {
            for (const entry of gridImages) {
              const { cell, img, low, meta } = entry;
              const width = parseFloat(cell.style.width);
              if (!(width > 0)) continue;
              const thumbnails = meta.display?.thumbnails;
              const density = width * interaction.zoom * (window.devicePixelRatio || 1);
              let thumbnail = thumbnails?.find(thumb => thumb.width >= density) || thumbnails?.at(-1);
              const [originalWidth, originalHeight] = meta.preview_size || [];
              const cropWidth = Math.min(originalWidth, originalHeight * WIDE_RATIO);
              // Old results only have 192/768 previews; use their original when
              // needed. New results include a native-size cropped thumbnail.
              if (thumbnail && thumbnail.width < density && thumbnail.width < cropWidth - 1) thumbnail = null;
              const url = previewURL(api, meta, thumbnail?.filename || meta.filename);
              entry.wantsSharp = url !== entry.lowURL;
              if (url === entry.lowURL) {
                img.style.display = "none";
                low.style.display = "block";
                continue;
              }
              if (entry.url === url && entry.ready && img.style.display === "block") continue;
              queueSharpPreview(entry, cell, gridView, app.canvas?.canvas, () => {
                if (removed || interaction.lowQuality || !gridImages.includes(entry)) return;
                if (url !== entry.url) {
                  entry.url = url;
                  entry.ready = false;
                  img.style.display = "none";
                  low.style.display = "block";
                  entry.resolveLoad?.();
                  const loaded = new Promise(resolve => { entry.resolveLoad = resolve; });
                  img.src = url;
                  return loaded;
                }
                if (entry.ready) {
                  low.style.display = "none";
                  img.style.display = "block";
                }
              });
            }
          }
        });
      }

      function relayout() {
        if (node._llpViewMode === "single") relayoutSingleImage();
        else relayoutGrid();
      }

      function getVirtualSize(w, h) {
        const ratio = w / h;
        if (ratio < TALL_RATIO) return { vw: w, vh: w / TALL_RATIO };
        if (ratio > WIDE_RATIO) return { vw: h * WIDE_RATIO, vh: h };
        return { vw: w, vh: h };
      }

      function relayoutGrid() {
        if (node._llpViewMode !== "grid" || node._llpItems.length === 0) return;
        const bounds = getComputedStyle(gridView);
        const W = parseFloat(bounds.width);
        const H = parseFloat(bounds.height);
        if (!W || !H) return;
        const key = `${W}/${H}`;
        if (lastGridLayout === key) return;

        const sizes = gridImages.map(({ low, meta }) => {
          const [width, height] = meta.preview_size || [low.naturalWidth, low.naturalHeight];
          const { vw, vh } = getVirtualSize(width, height);
          return { naturalWidth: vw, naturalHeight: vh };
        });
        const layout = layoutThumbnailRows(grid, sizes, W, H);
        if (!layout) return;
        lastGridLayout = key;
        gridImages.forEach(({ low }) => {
          low.parentElement.style.width = "100%";
          low.parentElement.style.height = "100%";
        });
        schedulePaint();
      }

      function updateMasks() {
        if (node._llpViewMode !== "single") return;
        if (!singleGeometry) return;
        const maxScrollTop = Math.max(0, singleGeometry.height - singleGeometry.viewportHeight);
        const maxScrollLeft = Math.max(0, singleGeometry.width - singleGeometry.viewportWidth);
        
        maskTop.style.opacity = maxScrollTop > 1 && singleScroll.scrollTop > 1 ? "1" : "0";
        maskBottom.style.opacity = maxScrollTop > 1 && singleScroll.scrollTop < maxScrollTop - 1 ? "1" : "0";
        maskLeft.style.opacity = maxScrollLeft > 1 && singleScroll.scrollLeft > 1 ? "1" : "0";
        maskRight.style.opacity = maxScrollLeft > 1 && singleScroll.scrollLeft < maxScrollLeft - 1 ? "1" : "0";
      }

      function relayoutSingleImage(resetScroll = false) {
        if (node._llpViewMode !== "single") return;
        const W = singleScroll.clientWidth;
        const H = singleScroll.clientHeight;
        if (!W || !H) return;
        const meta = node._llpItems[node._llpIndex];
        const [w, h] = meta?.preview_size || [singleImg.naturalWidth, singleImg.naturalHeight];
        if (!w || !h) return;
        if (!resetScroll && singleGeometry?.viewportWidth === W && singleGeometry?.viewportHeight === H) {
          schedulePaint();
          return;
        }
        currentRatio = w / h;
        const wide = currentRatio > WIDE_RATIO;
        const tall = currentRatio < TALL_RATIO;
        const oldMaxX = singleGeometry ? singleGeometry.width - singleGeometry.viewportWidth : 0;
        const oldMaxY = singleGeometry ? singleGeometry.height - singleGeometry.viewportHeight : 0;
        const x = !resetScroll && oldMaxX > 0 ? singleScroll.scrollLeft / oldMaxX : Number(node._llpScrollDir === "从右向左");
        const y = !resetScroll && oldMaxY > 0 ? singleScroll.scrollTop / oldMaxY : Number(node._llpTallDir === "从下到上");

        // 普通图片完整等比显示；超长图片只沿长边滚动，另一边铺满容器。
        const scale = wide ? H / h : tall ? W / w : Math.min(W / w, H / h);
        const width = w * scale;
        const height = h * scale;
        singleSurface.style.width = `${width}px`;
        singleSurface.style.height = `${height}px`;
        singleContent.style.width = `${Math.max(W, width)}px`;
        singleContent.style.height = `${Math.max(H, height)}px`;
        singleScroll.style.overflowX = wide ? "auto" : "hidden";
        singleScroll.style.overflowY = tall ? "auto" : "hidden";
        singleGeometry = { width, height, viewportWidth: W, viewportHeight: H, scale };
        singleScroll.scrollLeft = x * Math.max(0, width - W);
        singleScroll.scrollTop = y * Math.max(0, height - H);
        updateMasks();
        schedulePaint();
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
        schedulePaint();
      }

      function updateSingleImage() {
        const meta = node._llpItems[node._llpIndex];
        if (!meta) return;
        indicator.textContent = `${node._llpIndex + 1}/${node._llpItems.length}`;
        tiles.clear();
        singleGeometry = null;
        singleImg.style.visibility = "hidden";
        singleImg.onload = () => {
          if (removed) return;
          if (!meta.preview_size) meta.preview_size = [singleImg.naturalWidth, singleImg.naturalHeight];
          relayoutSingleImage();
          singleImg.style.visibility = "visible";
          showUI();
        };
        const overview = meta.display?.levels?.at(-1)?.filename || meta.filename;
        singleImg.src = previewURL(api, meta, overview);
        relayoutSingleImage(true);
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

      singleScroll.addEventListener("scroll", schedulePaint, { passive: true });
      singleView.addEventListener("mousemove", () => showUI());

      // 仅在大图模式下拦截滚轮
      singleView.addEventListener("wheel", (e) => {
        if (node._llpViewMode !== "single") return;
        e.stopPropagation();
        e.preventDefault();
        
        // 超宽图滚动左右，超高图滚动上下，方向由对应参数决定
        if (currentRatio > WIDE_RATIO) {
          if (node._llpScrollDir === "从右向左") {
            singleScroll.scrollLeft -= e.deltaY;
          } else {
            singleScroll.scrollLeft += e.deltaY;
          }
        } else if (currentRatio < TALL_RATIO) {
          if (node._llpTallDir === "从下到上") {
            singleScroll.scrollTop -= e.deltaY;
          } else {
            singleScroll.scrollTop += e.deltaY;
          }
        } else {
          beginPreviewZoom(app);
          app.canvas?.processMouseWheel?.(e);
        }
        
        schedulePaint();
        showUI();
      }, { passive: false });

      const origOnExecuted = node.onExecuted;
      node.onExecuted = function (message) {
        origOnExecuted?.apply(this, arguments);
        if (!message?.images) return;

        const signature = JSON.stringify([
          message.images.map((meta) => [meta.filename, meta.subfolder, meta.type]),
          message.scroll_direction, message.tall_scroll_direction,
        ]);
        if (node._llpResultSignature === signature) return;
        node._llpResultSignature = signature;
        node._llpItems = message.images;
        node._llpScrollDir = message.scroll_direction?.[0] || "从左向右";
        node._llpTallDir = message.tall_scroll_direction?.[0] || "从上到下";
        lastGridLayout = "";
        clearGridImages();
        grid.replaceChildren();
        tiles.clear();
        singleGeometry = null;
        singleImg.onload = null;
        singleImg.removeAttribute("src");

        if (node._llpItems.length === 0) {
          node._llpViewMode = "grid";
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

        node._llpItems.forEach((meta, index) => {
          const cell = document.createElement("div");
          cell.className = "llp-cell";
          cell.style.cssText = "position:relative; min-width:0; min-height:0; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;";

          const thumbnail = document.createElement("div");
          thumbnail.style.cssText = "position:relative; overflow:hidden; max-width:100%; max-height:100%; flex:none;";

          const img = document.createElement("img");
          img.alt = "";
          img.decoding = "async";
          img.draggable = false;
          img.style.cssText = "position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:none; pointer-events:none;";
          const low = document.createElement("img");
          low.alt = "";
          low.decoding = "async";
          low.draggable = false;
          low.style.cssText = "width:100%; height:100%; object-fit:contain; display:block; pointer-events:none;";
          const entry = { cell, img, low, meta, ready: false, url: null };
          gridImages.push(entry);

          const mask = document.createElement("div");
          mask.style.cssText = "position:absolute; pointer-events:none; display:none;";

          thumbnail.appendChild(low);
          thumbnail.appendChild(img);
          thumbnail.appendChild(mask);
          cell.appendChild(thumbnail);

          const handleClick = (e) => {
            e.preventDefault();
            enterViewMode(index);
          };

          cell.addEventListener("click", handleClick);
          grid.appendChild(cell);

          const configureThumbnail = () => {
            const [w, h] = meta.preview_size || [low.naturalWidth, low.naturalHeight];
            if (!w || !h) return;
            const ratio = w / h;

            // 缩略图渐变：严格按照虚拟比例截断
            if (ratio < TALL_RATIO) {
              img.style.objectFit = "cover";
              mask.style.display = "block";
              mask.style.left = "0";
              mask.style.right = "0";
              if (node._llpTallDir === "从下到上") {
                img.style.objectPosition = "bottom";
                mask.style.top = "0";
                mask.style.bottom = "auto";
                mask.style.height = "40%";
                mask.style.background = "linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%)";
              } else {
                img.style.objectPosition = "top";
                mask.style.top = "auto";
                mask.style.bottom = "0";
                mask.style.height = "40%";
                mask.style.background = "linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)";
              }
            } else if (ratio > WIDE_RATIO) {
              img.style.objectFit = "cover";
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
            low.style.objectFit = img.style.objectFit;
            low.style.objectPosition = img.style.objectPosition;
          };
          configureThumbnail();
          low.onload = () => {
            if (removed || !gridImages.includes(entry)) return;
            configureThumbnail();
            if (!meta.preview_size) scheduleLayout();
          };
          img.onload = () => {
            entry.resolveLoad?.(); entry.resolveLoad = null;
            // Restored outputs may wrap metadata in new objects on each read.
            // The local entry owns this load, independent of those wrappers.
            if (removed || !gridImages.includes(entry)) return;
            entry.ready = true;
            if (!interaction.lowQuality && entry.wantsSharp) {
              // Only one image paints, including when the source has transparency.
              low.style.display = "none";
              img.style.display = "block";
            }
          };
          img.onerror = () => { entry.resolveLoad?.(); entry.resolveLoad = null; };
          entry.lowURL = previewURL(api, meta, meta.display?.thumbnails?.[0]?.filename || meta.filename);
          low.src = entry.lowURL;
        });
        scheduleLayout();
      };

      function clearGridImages() {
        for (const entry of gridImages) {
          cancelSharpPreview(entry);
          entry.resolveLoad?.(); entry.resolveLoad = null;
          const { img, low } = entry;
          img.onload = img.onerror = low.onload = null;
          img.removeAttribute("src");
          low.removeAttribute("src");
        }
        gridImages = [];
      }

      const origOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        removed = true;
        interaction.dispose();
        document.removeEventListener("keydown", onKeyDown);
        resizeObserver.disconnect();
        visibilityObserver.disconnect();
        clearTimeout(hideUITimer);
        cancelAnimationFrame(layoutFrame);
        cancelAnimationFrame(paintFrame);
        tiles.clear();
        clearGridImages();
        singleImg.onload = null;
        singleImg.removeAttribute("src");
        style.remove();
        origOnRemoved?.apply(this, arguments);
      };
    };
  }
});
