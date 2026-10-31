import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "liuxinyu.KeyValuePairsLayout",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LiuxinyuBuildKeyValuePairs") return;
    // Reserve the first row for the key widget; value and output use the next row.
    nodeType.slot_start_y = LiteGraph.NODE_WIDGET_HEIGHT + 8;
  },
  nodeCreated(node) {
    if (node.comfyClass !== "LiuxinyuBuildKeyValuePairs") return;
    node.widgets_start_y = 4;
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      this.widgets_start_y = 4;
      return result;
    };
  },
});
