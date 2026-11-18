const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  const app = {registerExtension(value) { extension = value; }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../number_array.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, ''), {app, queueMicrotask});
  const sources = new Map(), links = new Map();
  const node = {
    comfyClass: 'LiuxinyuAnyArray', inputs: [], outputs: [{type:'ARRAY'}], size:[300,100],
    graph: {links, getNodeById: id => sources.get(id)},
    addInput(name, type) { this.inputs.push({name, type, link:null}); },
    removeInput(i) { this.inputs.splice(i,1); },
    computeSize() { return [200, this.inputs.length * 20]; },
    setSize(size) { this.size = size; }, setDirtyCanvas() {},
    getInputLink(i) { return links.get(this.inputs[i]?.link); },
    disconnectInput(i) { links.delete(this.inputs[i].link); this.inputs[i].link=null; this.onConnectionsChange(1,i,false); },
  };
  let next = 0;
  function connect(index, type) {
    if (node.onConnectInput(index, type) === false) return false;
    const id = next++;
    sources.set(id, {outputs:[{type}]}); links.set(id, {origin_id:id, origin_slot:0});
    node.inputs[index].link = id; node.onConnectionsChange(1,index,true);
    return true;
  }
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  extension.nodeCreated(node); await settle();
  assert.equal(node.inputs[0].type, '*');
  assert.ok(connect(0,'INT')); await settle();
  assert.equal(node.inputs.length,2);
  assert.ok(node.inputs.every(input=>input.type==='INT'));
  assert.equal(connect(1,'FLOAT'),false);
  assert.equal(connect(1,'BOOLEAN'),false);
  assert.ok(connect(1,'INT')); await settle();
  node.disconnectInput(0); await settle();
  assert.equal(node.inputs[0].type,'INT','Remaining members retain the lock');
  assert.equal(connect(0,'STRING'),false);
  node.disconnectInput(1); await settle();
  assert.equal(node.inputs.length,1); assert.equal(node.inputs[0].type,'*');
  assert.ok(connect(0,'DICT')); await settle();
  for(let i=1;i<150;i++){ assert.ok(connect(i,'DICT')); await settle(); }
  assert.equal(node.inputs.length,151); assert.equal(node.inputs[150].type,'DICT');
  node.onConfigure(); node.onAfterGraphConfigured(); await settle();
  assert.equal(node.inputs[150].type,'DICT'); assert.equal(node.outputs[0].type,'ARRAY');
  const retainedLink = node.inputs[2].link;
  const changed = node.getInputLink(1); sources.get(changed.origin_id).outputs[0].type='ARRAY';
  node.onConnectionsChange(1,1,true); await settle();
  assert.equal(node.inputs[1].link,null,'Upstream type change removes the conflicting wire');
  assert.equal(node.inputs[2].link,retainedLink,'Interior gaps do not shift later members');
  for(let i=149;i>=0;i--)node.disconnectInput(i);
  await settle();
  assert.ok(connect(0,'*')); await settle();
  assert.ok(connect(1,'STRING')); await settle();
  assert.ok(node.inputs.every(input=>input.type==='STRING'));
  assert.equal(connect(2,'INT'),false);
  assert.equal(node.outputs[0].type,'ARRAY');
  console.log('PASS: type locking, reset, wildcard narrowing, 150 inputs, restored state and upstream changes');
}
main().catch(error => { console.error(error); process.exitCode=1; });
