import { app } from "../../scripts/app.js";

function setupRules(node) {
  const setting = node.widgets?.find((widget) => widget.name === "exclude_same_index");
  if (!setting) return;
  let boxes = [];

  function readRules() {
    return String(setting.value ?? "").split(/[;；]/)
      .map((rule) => [...new Set(rule.split(/[,，]/).map((name) => name.trim()).filter(Boolean))]);
  }

  // Autogrow sockets have qualified internal names; labels display t1, t2, ...
  function parameterName(input) {
    const label = input.renderingLabel || input.label || input.localized_name || input.name;
    return /^t[1-9]\d*$/.test(label) ? label : null;
  }

  const drawSlots = node.drawSlots;
  node.drawSlots = function (ctx, options) {
    const result = drawSlots.call(this, ctx, options);
    boxes = [];
    if (this.flags.collapsed || options.lowQuality) return result;
    const selected = new Set(readRules()[0]);
    const slots = (this.inputs ?? []).map((input, index) => ({ input, index, name: parameterName(input) }))
      .filter((slot) => slot.name);
    ctx.save();
    const x = Math.max(38, ...slots.map(({ input, index }) => {
      const pos = this.getInputPos(index);
      const labelEnd = pos[0] - this.pos[0] + 10 + ctx.measureText(input.renderingLabel || input.label || input.name).width;
      const bounds = input.boundingRect;
      const hitEnd = bounds ? bounds[0] + bounds[2] - this.pos[0] : 0;
      return Math.max(labelEnd, hitEnd) + 7;
    }));
    for (const { index, name } of slots) {
      const pos = this.getInputPos(index);
      const y = pos[1] - this.pos[1] - 6;
      const connected = this.isInputConnected(index);
      const checked = selected.has(name);
      ctx.globalAlpha = connected || checked ? 1 : 0.35;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = checked ? "#39774a" : "#303030";
      ctx.strokeStyle = checked ? "#8ddd9d" : "#888";
      ctx.beginPath();
      ctx.roundRect(x, y, 12, 12, 2);
      ctx.fill();
      ctx.stroke();
      if (checked) {
        ctx.strokeStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(x + 2.5, y + 6);
        ctx.lineTo(x + 5, y + 9);
        ctx.lineTo(x + 10, y + 3);
        ctx.stroke();
      }
      boxes.push({ name, x, y, enabled: connected || checked });
    }
    ctx.restore();
    return result;
  };

  const mouseDown = node.onMouseDown;
  node.onMouseDown = function (event, pos, canvas) {
    if (!this.flags.collapsed && event.button === 0) {
      const box = boxes.find(({ x, y }) => pos[0] >= x - 2 && pos[0] <= x + 14 && pos[1] >= y - 2 && pos[1] <= y + 14);
      if (box) {
        if (!box.enabled) return true;
        const rules = readRules();
        const selected = new Set(rules[0]);
        if (selected.has(box.name)) selected.delete(box.name);
        else selected.add(box.name);
        rules[0] = [...selected].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        this.graph?.beforeChange();
        // Keep later rules intact, including the empty first rule when unchecked.
        setting.value = rules.map((rule) => rule.join(",")).join("; ");
        setting.callback?.(setting.value);
        this.graph?.afterChange();
        this.setDirtyCanvas(true, true);
        return true;
      }
    }
    return mouseDown?.call(this, event, pos, canvas);
  };

  const callback = setting.callback;
  setting.callback = function (...args) {
    const result = callback?.apply(this, args);
    node.setDirtyCanvas(true, true);
    return result;
  };
  setting.options = { ...setting.options, tooltip: "勾选输入旁的小方框可编辑第一组同位去重规则。多组规则可在此输入，用分号分隔，例如 t1,t2; t3,t4。" };

  const configure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configure?.apply(this, args);
    // Remove the height saved for the previous DOM panel.
    requestAnimationFrame(() => {
      this.setSize([this.size[0], this.computeSize()[1]]);
      this.setDirtyCanvas(true, true);
    });
    return result;
  };
}

app.registerExtension({
  name: "liuxinyu.StringCombinationRules",
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuStringCombinations") setupRules(node);
  },
});
