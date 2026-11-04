const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../operator_inputs.js'), 'utf8')
    .replace(/^import .*;$/m, ''), { app: { registerExtension(e) { extension = e; } }, queueMicrotask });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  for (const [kind, unary, binary, another] of [
    ['LiuxinyuBooleanOperator', 'not', 'and', 'or'],
    ['LiuxinyuBitwiseOperator', '~', '&', '|']
  ]) {
    let configured = 0, callbacks = 0;
    const disconnected = [];
    const widget = { name: 'operation', value: unary, callback() { callbacks++; return 17; } };
    const node = { comfyClass: kind, inputs: [{ name: 'a', type: '*', link: 10 }, { name: 'b', type: '*', link: null }],
      outputs: [{ name: '结果', type: '*', links: [100] }], widgets: [widget], size: [300, 120],
      onConfigure() { configured++; return 23; },
      removeInput(i) { if (this.inputs[i].link != null) disconnected.push(this.inputs[i].link); this.inputs.splice(i, 1); },
      addInput(name, type, extra) { this.inputs.push({ name, type, link: null, ...extra }); },
      computeSize() { return [220, 80]; }, setSize(s) { this.size = s; }, setDirtyCanvas() {} };
    extension.nodeCreated(node); await settle();
    assert.deepEqual(node.inputs.map(p => p.name), ['a']);
    widget.value = binary; assert.equal(widget.callback(), 17); await settle();
    assert.deepEqual(node.inputs.map(p => p.name), ['a', 'b']);
    node.inputs[1].link = 20;
    widget.value = another; widget.callback(); await settle();
    assert.equal(node.inputs[1].link, 20, 'Binary operator changes preserve B wiring');
    assert.equal(node.onConfigure({}), 23); await settle();
    assert.equal(node.inputs.length, 2, 'Reloading does not duplicate B');
    widget.value = unary; widget.callback(); await settle();
    assert.deepEqual(disconnected, [20]);
    assert.equal(node.inputs[0].link, 10, 'A stays connected');
    assert.deepEqual(node.outputs[0].links, [100], 'Result wiring is preserved');
    widget.value = binary; widget.callback(); await settle();
    assert.equal(node.inputs[1].link, null, 'Returning to binary requires a new B connection');
    // Saved binary settings arrive before the creation microtask is flushed.
    extension.nodeCreated({ ...node, inputs: [{ name: 'a', link: 10 }, { name: 'b', link: 30 }], widgets: [
      { name: 'operation', value: binary }
    ] });
    await settle();
    assert.equal(configured, 1);
    assert.equal(callbacks, 4);
  }
  const compare = { comfyClass: 'LiuxinyuCompare', widgets: [{name: 'operation', value: '等于'}],
    onConfigure() { return 29; } };
  extension.nodeCreated(compare);
  compare.widgets[0].value = 'is not';
  assert.equal(compare.onConfigure(), 29);
  await settle();
  assert.equal(compare.widgets[0].value, '不是同一对象');
  const unrelated = { comfyClass: 'OtherNode' };
  extension.nodeCreated(unrelated);
  assert.deepEqual(unrelated, { comfyClass: 'OtherNode' });
  console.log('PASS: unary/binary ports, preserved callbacks/wires, configure, unrelated nodes');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
