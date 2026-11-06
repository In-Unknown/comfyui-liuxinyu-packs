import { app } from "../../scripts/app.js";
import { registerMenuItem } from "./menu_source.js";

function menu() {
  const canvas = app.canvas;
  if (!canvas?.ds) return null;
  return {
    content: "视窗回归原点",
    callback: () => {
      // Match native centerOnNode: canvas dimensions include device pixels.
      const scale = canvas.ds.scale * (window.devicePixelRatio || 1);
      canvas.ds.offset[0] = canvas.canvas.width / (2 * scale);
      canvas.ds.offset[1] = canvas.canvas.height / (2 * scale);
      canvas.setDirty(true, true);
    },
  };
}

registerMenuItem("viewport-origin", { canvas: menu, node: menu });
