import { app } from "../../scripts/app.js";

// A margin-free DOM preview covers the native bottom resize corners.
export function enablePreviewResize(node, widget) {
  const container = widget.element;
  container.style.position = "relative";

  // LiteGraph checks widgets before resize corners, even for forwarded events.
  const getWidgetOnPos = node.getWidgetOnPos;
  node.getWidgetOnPos = function (x, y, ...args) {
    const hit = getWidgetOnPos.call(this, x, y, ...args);
    return hit === widget && this.findResizeDirection(x, y) ? undefined : hit;
  };

  for (const [side, cursor] of [["left", "nesw-resize"], ["right", "nwse-resize"]]) {
    const handle = document.createElement("div");
    handle.className = "liuxinyu-preview-resize";
    handle.style.cssText = `position:absolute; bottom:0; ${side}:0; width:15px; height:15px; z-index:20; cursor:${cursor}; touch-action:none;`;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      // Native pointer capture carries the rest of the drag to the canvas,
      // preserving its minimum size, zoom, snapping and undo behavior.
      app.canvas.canvas.dispatchEvent(new PointerEvent("pointerdown", event));
    });
    container.appendChild(handle);
  }
}
