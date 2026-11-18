const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  const source = fs.readFileSync(path.join(__dirname, '../folder_picker.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/const previewErrorBridge = import\([\s\S]*?\n  \}\);/, 'const previewErrorBridge = Promise.resolve(null);');
  vm.runInNewContext(source, { app: { registerExtension(e) { extension = e; } }, console });
  const saver = (type, id) => ({ type, size: [300, 372], inputs: [
    { name: 'folder', type: 'STRING', link: null }, { name: 'image', type: 'IMAGE', link: id }
  ], widgets_values: ['same', 'test.jpg'] });
  const first = saver('SaveImageToAbsolutePath', 10);
  const nested = saver('SaveSelectedFromBatch', 20);
  const other = saver('OtherNode', 30);
  const graph = { nodes: [first, other], definitions: { subgraphs: [{ nodes: [nested] }] } };
  const expected = structuredClone(graph);
  expected.nodes[0].inputs[1].type = 'IMAGE,IMAGE_BYTES';
  expected.definitions.subgraphs[0].nodes[0].inputs[1].type = 'IMAGE,IMAGE_BYTES';
  extension.beforeConfigureGraph(graph);
  assert.deepEqual(graph, expected, 'Only the saved image port type changes; links, sizes, ordering and values remain');
  extension.beforeConfigureGraph(graph);
  assert.deepEqual(graph, expected, 'Migration is idempotent');
  const loader = { comfyClass: 'LiuxinyuLoadFileBytes', widgets: [{name: 'path', value: 'C:/file.bin'}],
    addWidget(type, name, value, callback, options) {
      const widget = {type, name, value, callback, options}; this.widgets.push(widget); return widget;
    }, setDirtyCanvas() {} };
  await extension.nodeCreated(loader);
  await extension.nodeCreated(loader);
  assert.equal(loader.widgets.length, 2, 'One picker button, no duplicate');
  assert.equal(loader.widgets[1].options.serialize, false, 'Button does not become workflow state');
  assert.equal(loader.widgets[1].liuxinyuInputName, 'path');
  console.log('PASS: nested saved input migration, preserved links/layout, idempotence, byte file picker');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
