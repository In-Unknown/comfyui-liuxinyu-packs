import { app } from "../../scripts/app.js";
import { installCanvasFocus } from "./canvas_viewport.js";

app.registerExtension({
  name: "liuxinyu.CanvasFocus",
  setup() { installCanvasFocus(app.canvas); },
  afterConfigureGraph() { installCanvasFocus(app.canvas); },
});
