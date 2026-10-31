const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  const app = {registerExtension(e) {extension = e;}, async graphToPrompt() {return {output: {}, workflow: {}};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packet_return.js'), 'utf8')
    .replace(/^import .*;$/m, ''), {app, queueMicrotask});
  const graph = {_nodes: [], links: new Map(), getNodeById(id) {return this._nodes.find(n => n.id === id);}};
  app.graph = graph;
  function make(type) {
    const node = {id: graph._nodes.length, type, graph, inputs: [], outputs: [], widgets: [], size: [300, 200],
      addInput(name, type, extra = {}) {
        const port = {name, type, ...extra};
        Object.defineProperty(port, 'link', {enumerable: true, get: () => [...graph.links.values()]
          .find(l => l.target_id === this.id && l.target_slot === this.inputs.indexOf(port))?.id ?? null});
        this.inputs.push(port);
      },
      addOutput(name, type) {
        const port = {name, type};
        Object.defineProperty(port, 'links', {enumerable: true, get: () => [...graph.links.values()]
          .filter(l => l.origin_id === this.id && l.origin_slot === this.outputs.indexOf(port)).map(l => l.id)});
        this.outputs.push(port);
      },
      disconnectInput(i) {
        const id = this.inputs[i]?.link;
        if (id != null) graph.links.delete(id);
        this.onConnectionsChange?.();
      },
      removeInput(i) {
        this.disconnectInput(i); this.inputs.splice(i, 1);
        for (const l of graph.links.values()) if (l.target_id === this.id && l.target_slot > i) l.target_slot--;
      },
      removeOutput(i) {
        for (const id of this.outputs[i].links) graph.links.delete(id);
        this.outputs.splice(i, 1);
        for (const l of graph.links.values()) if (l.origin_id === this.id && l.origin_slot > i) l.origin_slot--;
      },
      computeSize() {return this.size;}, setSize(value) {this.size = value;}, setDirtyCanvas() {},
    };
    graph._nodes.push(node);
    return node;
  }
  let next = 1;
  function connect(from, slot, to, name) {
    const index = to.inputs.findIndex(i => i.name === name);
    assert.ok(index >= 0, name);
    to.disconnectInput(index);
    const id = next++;
    graph.links.set(id, {id, origin_id: from.id, origin_slot: slot, target_id: to.id, target_slot: index});
    from.onConnectionsChange?.(); to.onConnectionsChange?.();
    return id;
  }
  const slot = (node, name) => node.outputs.findIndex(p => p.name === name);
  const names = node => node.outputs.map(p => p.name);
  const endData = node => node.inputs.filter(p => p.name.startsWith('states.')).map(p => p.name);
  const settle = async () => {await Promise.resolve(); await Promise.resolve();};
  const source = make('Source');
  for (const type of ['ARRAY','DICT','STRING','BOOLEAN']) source.addOutput(type,type);
  const start = make('LiuxinyuPacketReturnStart');
  start.addInput('states.state0', '*'); start.addInput('packets.packet0', '*');
  start.addOutput('分包回归条件','LIUXINYU_PACKET_RETURN');
  for (let i=0;i<100;i++) start.addOutput(`当前被处理数据${i+1}`,'*');
  for (let i=0;i<100;i++) start.addOutput(`当前分包数据${i+1}`,'*');
  start.addOutput('当前轮次数','*');
  const end = make('LiuxinyuPacketReturnEnd');
  const definition = {name:end.type,input:{required:{handle:[],condition:[],operation:[],states:['COMFY_AUTOGROW_V3']}}};
  extension.beforeRegisterNodeDef({},definition);
  assert.equal('states' in definition.input.required,false);
  end.addInput('handle','LIUXINYU_PACKET_RETURN');
  end.addInput('condition','BOOLEAN',{widget:{name:'condition'}});
  end.widgets = [{name:'condition',value:true},{name:'operation',value:'与'}];
  for (let i=0;i<100;i++) end.addOutput(`处理完成数据${i+1}`,'*');
  extension.nodeCreated(start); extension.nodeCreated(end); extension.setup();
  await settle();
  assert.deepEqual(names(start),['分包回归条件','当前轮次数']);
  assert.deepEqual(end.inputs.map(p=>p.name),['handle']);
  assert.equal(end.outputs.length,0); assert.ok(end.widgets.every(w=>w.hidden));

  connect(source,0,start,'packets.packet0'); connect(source,1,start,'states.state0');
  connect(start,0,end,'handle'); await settle();
  assert.deepEqual(names(start),['分包回归条件','当前被处理数据1','当前分包数据1','当前轮次数']);
  assert.deepEqual(endData(end),['states.state0']); assert.deepEqual(names(end),['处理完成数据1']);
  assert.ok(end.widgets.every(w=>!w.hidden));
  assert.equal(end.onConnectInput(0,'LIUXINYU_PACKET_RETURN',{},source,0),false);
  const feedback = connect(start,slot(start,'当前被处理数据1'),end,'states.state0');
  const condition = connect(source,3,end,'condition');
  const sink=make('Sink');sink.addInput('packet','*');sink.addInput('round','INT');sink.addInput('result','*');
  const packetLink=connect(start,slot(start,'当前分包数据1'),sink,'packet');
  const roundLink=connect(start,slot(start,'当前轮次数'),sink,'round');
  connect(end,0,sink,'result');await settle();

  // Native Autogrow owns input creation. Counts of the two groups are independent.
  start.addInput('states.state1','*');connect(source,2,start,'states.state1');await settle();
  assert.deepEqual(names(start),['分包回归条件','当前被处理数据1','当前被处理数据2','当前分包数据1','当前轮次数']);
  assert.deepEqual(endData(end),['states.state0','states.state1']);
  assert.equal(graph.links.get(packetLink).origin_slot,3);assert.equal(graph.links.get(roundLink).origin_slot,4);
  const second=connect(start,slot(start,'当前被处理数据2'),end,'states.state1');
  assert.equal(start.outputs[2].type,'STRING');assert.equal(end.outputs[1].type,'STRING');
  start.addInput('packets.packet1','*');connect(source,0,start,'packets.packet1');await settle();
  assert.equal(start.outputs.length,6);assert.equal(end.outputs.length,2);
  assert.equal(graph.links.get(roundLink).origin_slot,5);
  assert.equal(graph.links.get(feedback).origin_slot,1);assert.equal(graph.links.get(second).origin_slot,2);

  const snapshot=JSON.stringify([...graph.links.values()]);
  for (let i=0;i<20;i++) {
    extension.afterConfigureGraph();start.onConfigure();end.onConfigure();await settle();await app.graphToPrompt();
    assert.equal(JSON.stringify([...graph.links.values()]),snapshot);
    assert.equal(graph.links.get(condition).target_slot,end.inputs.findIndex(p=>p.name==='condition'));
  }
  start.disconnectInput(start.inputs.findIndex(p=>p.name==='states.state1'));await settle();
  assert.deepEqual(names(start),['分包回归条件','当前被处理数据1','当前分包数据1','当前分包数据2','当前轮次数']);
  assert.deepEqual(endData(end),['states.state0']);assert.equal(end.outputs.length,1);
  assert.equal(graph.links.has(second),false);assert.equal(graph.links.get(packetLink).origin_slot,2);
  start.disconnectInput(start.inputs.findIndex(p=>p.name==='packets.packet0'));await settle();
  assert.deepEqual(names(start),['分包回归条件','当前被处理数据1','当前分包数据2','当前轮次数']);
  assert.equal(graph.links.has(packetLink),false);assert.equal(graph.links.get(roundLink).origin_slot,3);
  end.disconnectInput(0);await settle();
  assert.deepEqual(end.inputs.map(p=>p.name),['handle']);assert.equal(end.outputs.length,0);
  assert.ok(end.widgets.every(w=>w.hidden));assert.equal(graph.links.has(feedback),false);
  connect(start,0,end,'handle');await settle();
  assert.deepEqual(endData(end),['states.state0']);assert.deepEqual(names(end),['处理完成数据1']);
  assert.equal(end.widgets[0].value,true);assert.equal(end.widgets[1].value,'与');
  console.log('Independent port counts, paired-only return sockets, growth/shrink, cable identity, condition wiring and 20 serialization cycles passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
