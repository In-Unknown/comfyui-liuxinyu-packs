import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const MAX_BLOCKS = 100;
const BLOCK_HEIGHT = 164;

function setupBlocks(node) {
  const storage = node.widgets.find((widget) => widget.name === "blocks_json");
  storage.type = "hidden";
  storage.computeSize = () => [0, -4];
  storage.draw = () => {};
  let blocks = [""];
  let restoring = false;
  const fields = [];
  node.widgets_start_y = 0;

  function saveBlocks() {
    if (restoring) return;
    blocks = fields.map(({ text }) => text.value);
    storage.value = JSON.stringify(blocks);
    storage.callback?.(storage.value);
  }

  function syncConnections() {
    fields.forEach(({ text }, index) => {
      const connected = node.isInputConnected(index);
      text.element.readOnly = connected;
      text.element.title = connected ? "已连接上游；输出使用上游文本，框内文字保留。" : `文本${index + 1}`;
    });
  }

  function syncPorts() {
    // Only the add button grows this group. Unplugging must not shift outputs.
    if (node.comfyDynamic?.autogrow) delete node.comfyDynamic.autogrow.texts;
    while (node.inputs.length > blocks.length) node.removeInput(node.inputs.length - 1);
    while (node.inputs.length < blocks.length) {
      node.addInput(`texts.text${node.inputs.length + 1}`, "STRING", { shape: 7 });
    }
    while (node.outputs.length > blocks.length) node.removeOutput(node.outputs.length - 1);
    while (node.outputs.length < blocks.length) node.addOutput(`文本${node.outputs.length + 1}`, "STRING");
    fields.forEach(({ text, header }, index) => {
      const input = node.inputs[index];
      input.label = `文本${index + 1}`;
      input.widget = { name: text.name };
      // Native widget-backed sockets use the header row for their position.
      input._widget = header;
      input.alwaysVisible = true;
      node.outputs[index].label = `字符串${index + 1}`;
    });
    syncConnections();
  }

  function addField(index, value) {
    const header = node.addCustomWidget({
      name: `block_header_${index + 1}`, type: "multiline_header", serialize: false,
      computeSize: () => [0, 20],
      draw(ctx, _owner, _width, y) {
        ctx.save();
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#aaa";
        ctx.textAlign = "left";
        ctx.fillText(`文本${index + 1}`, 26, y + 15);
        ctx.restore();
      },
    });
    const { widget: text } = ComfyWidgets.STRING(node, `texts.text${index + 1}`,
      ["STRING", { multiline: true, default: value, placeholder: `文本${index + 1}` }], app);
    text.serialize = false;
    text.options.serialize = false;
    text.options.getMinHeight = () => 140;
    text.options.getMaxHeight = () => 140;
    text.value = value;
    const previous = text.callback;
    text.callback = function (...args) {
      const result = previous?.apply(this, args);
      saveBlocks();
      return result;
    };
    fields.push({ text, header });
  }

  const button = node.addWidget("button", "+ 添加下一个输入框", null, () => {
    if (fields.length >= MAX_BLOCKS) return;
    node.graph?.beforeChange();
    addField(fields.length, "");
    saveBlocks();
    syncPorts();
    moveButtonLast();
    node.setSize([node.size[0], blocks.length * BLOCK_HEIGHT + 34]);
    node.graph?.afterChange();
    node.setDirtyCanvas(true, true);
  }, { serialize: false, canvasOnly: true });
  button.serialize = false;

  function moveButtonLast() {
    const index = node.widgets.indexOf(button);
    if (index >= 0) node.widgets.splice(index, 1);
    node.widgets.push(button);
    button.name = fields.length >= MAX_BLOCKS ? "已达到 100 块" : "+ 添加下一个输入框";
  }

  function restore() {
    restoring = true;
    try {
    const stored = JSON.parse(storage.value || '[""]');
    blocks = Array.isArray(stored) && stored.length ? stored : [""];
    while (fields.length > blocks.length) {
      const { text, header } = fields.pop();
      node.removeWidget(text);
      node.removeWidget(header);
    }
    for (let index = 0; index < blocks.length; index++) {
      if (index >= fields.length) addField(index, blocks[index]);
      else fields[index].text.value = blocks[index];
    }
    syncPorts();
    moveButtonLast();
    node.widgets_start_y = 0;
    node.setSize([Math.max(400, node.size[0]), blocks.length * BLOCK_HEIGHT + 34]);
    } finally {
      restoring = false;
    }
  }

  const arrange = node.arrange;
  node.arrange = function (...args) {
    const result = arrange.apply(this, args);
    fields.forEach(({ header }, index) => {
      const output = this.outputs[index];
      if (!output) return;
      const x = this.size[0] - 10;
      const y = header.y + 10;
      output.pos = [x, y];
      // Drawing, link endpoints and hit testing share this output position.
      if (output.boundingRect) {
        output.boundingRect[0] = this.pos[0] + x - 10;
        output.boundingRect[1] = this.pos[1] + y - 10;
        output.boundingRect[2] = output.boundingRect[3] = 20;
      }
    });
    return result;
  };
  const configured = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = configured?.apply(this, args);
    restore();
    return result;
  };
  const connection = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = connection?.apply(this, args);
    queueMicrotask(syncConnections);
    return result;
  };
  restore();
}

app.registerExtension({
  name: "liuxinyu.DynamicMultilineText",
  nodeCreated(node) {
    if (node.comfyClass === "LiuxinyuDynamicMultilineText") setupBlocks(node);
  },
});
