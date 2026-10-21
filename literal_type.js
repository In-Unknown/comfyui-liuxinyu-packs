import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "liuxinyu.LiteralType",
  nodeCreated(node) {
    if (node.comfyClass !== "LiuxinyuStringToLiteral") return;
    let label = "类型：等待运行";
    node.addCustomWidget({
      name: "literal_type", type: "literal_type", serialize: false,
      computeSize: () => [0, 28],
      draw(ctx, owner, width, y) {
        ctx.save();
        ctx.fillStyle = "#aaa";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, width / 2, y + 18, Math.max(1, width - 20));
        ctx.restore();
      },
    });
    const executed = node.onExecuted;
    node.onExecuted = function (message) {
      const result = executed?.apply(this, arguments);
      if (Array.isArray(message?.liuxinyu_literal_type)) {
        label = `类型：${[...new Set(message.liuxinyu_literal_type)].join(" / ")}`;
        this.setDirtyCanvas(true, true);
      }
      return result;
    };
  },
});
