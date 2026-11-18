import { centerCanvasOn } from "./canvas_viewport.js";
import { app } from "../../scripts/app.js";
import { registerMenuItem } from "./menu_source.js";

function menu() {
  const canvas = app.canvas;
  if (!canvas?.ds) return null;
  return {
    content: "视窗回归原点",
    callback: () => {
      centerCanvasOn(canvas, 0, 0);
    },
  };
}

registerMenuItem("viewport-origin", { canvas: menu, node: menu });
