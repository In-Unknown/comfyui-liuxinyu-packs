import { app } from "../../scripts/app.js";
import { sourceMenuItems } from "./menu_source.js";

function menu() {
  const canvas = app.canvas;
  if (!canvas?.ds) return [];
  return sourceMenuItems([{
    content: "视窗回归原点",
    callback: () => {
      canvas.ds.offset[0] = 0;
      canvas.ds.offset[1] = 0;
      canvas.setDirty(true, true);
    },
  }]);
}

app.registerExtension({
  name: "liuxinyu.ViewportOrigin",
  getCanvasMenuItems: menu,
  getNodeMenuItems: menu,
});
