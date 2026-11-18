const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const schemaPath = process.argv[2];
  assert.ok(schemaPath, 'Pass an exported object_info JSON to test every real format branch');
  const definitions = JSON.parse(fs.readFileSync(schemaPath, 'utf8').replace(/^\uFEFF/, ''));
  let extension;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../image_bytes_labels.js'), 'utf8')
    .replace(/^import .*;$/gm, ''), { app: { registerExtension(e) { extension = e; } }, queueMicrotask });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  let checked = 0;
  for (const [id, definition] of Object.entries(definitions)) {
    extension.beforeRegisterNodeDef({}, { ...definition, name: id });
    let configured = 0;
    const node = { comfyClass: id, widgets: [], inputs: [], size: [370, 522],
      addWidget(type, name, value, callback, options = {}) {
        const widget = { type, name, value, callback, options }; this.widgets.push(widget); return widget;
      },
      addInput(name, type, options = {}) {
        const input = { name, type, ...options }; this.inputs.push(input); return input;
      },
      onConfigure() { configured++; return 23; }, setDirtyCanvas() {} };
    const add = (name, spec) => {
      const widget = node.addWidget(spec[0] === 'BOOLEAN' ? 'toggle' : 'number', name, spec[1]?.default, () => 17);
      widget.label = name.split('.').at(-1); // Native DynamicCombo's overwrite.
      node.addInput(name, spec[0], { link: 21, localized_name: widget.label });
      return widget;
    };
    for (const [name, spec] of Object.entries({...definition.input?.required, ...definition.input?.optional})) add(name, spec);
    extension.nodeCreated(node);
    const originalAdd = node.addWidget;
    extension.nodeCreated(node);
    assert.equal(node.addWidget, originalAdd, 'Do not wrap a node twice');
    const options = definition.input?.required?.format?.[1]?.options ?? [null];
    for (const option of [...options, ...options]) {
      node.widgets = node.widgets.filter(widget => !widget.name.startsWith('format.'));
      node.inputs = node.inputs.filter(input => !input.name.startsWith('format.'));
      const specs = { ...definition.input?.required, ...definition.input?.optional };
      if (option) {
        node.widgets.find(widget => widget.name === 'format').value = option.key;
        for (const [key, spec] of Object.entries({...option.inputs.required, ...option.inputs.optional})) {
          specs['format.' + key] = spec;
          add('format.' + key, spec);
        }
      }
      const values = node.widgets.map(widget => [widget.name, widget.value]);
      const links = node.inputs.map(input => [input.name, input.type, input.link]);
      assert.equal(node.onConfigure({}), 23);
      await settle();
      assert.deepEqual(node.widgets.map(widget => [widget.name, widget.value]), values);
      assert.deepEqual(node.inputs.map(input => [input.name, input.type, input.link]), links);
      assert.deepEqual(node.size, [370, 522], 'Labels must not resize the node');
      for (const widget of node.widgets) {
        const spec = specs[widget.name];
        assert.equal(widget.label, spec[1].display_name, `${id}/${option?.key}/${widget.name}`);
        assert.match(widget.label, /[\u4e00-\u9fff]/);
        assert.equal(widget.callback(), 17, 'Original callbacks are preserved');
        if (spec[0] === 'BOOLEAN') {
          assert.equal(widget.options.on, '开启'); assert.equal(widget.options.off, '关闭');
        }
        if (option?.key === 'TIFF' && widget.name === 'format.compression') {
          assert.equal(widget.options.getOptionLabel('LZW'), '字典压缩（LZW）');
          assert.equal(widget.options.getOptionLabel('Deflate'), '无损压缩（Deflate）');
          assert.equal(widget.options.getOptionLabel('无压缩'), '无压缩');
        }
      }
      checked++;
    }
    assert.ok(configured > 0);
  }
  const unrelated = {comfyClass: 'OtherNode'};
  extension.nodeCreated(unrelated);
  assert.deepEqual(unrelated, {comfyClass: 'OtherNode'});
  console.log(`PASS: ${checked} real-schema creation/switch/restore cases; Chinese labels/toggles; unchanged values/keys/links/sizes/callbacks`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
