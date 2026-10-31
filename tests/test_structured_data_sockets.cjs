const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  let extension;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../structured_data.js'),'utf8')
    .replace(/^import .*;$/m,''), {app:{registerExtension(e){extension=e;}},queueMicrotask});
  const jsonTypes='DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL';
  const graph={links:new Map(),_nodes:[],getNodeById(id){return this._nodes.find(n=>n.id===id);}};
  let nextId=1;
  function node(type,inputs,outputs,widgets=[]) {
    const n={id:graph._nodes.length+1,comfyClass:type,graph,inputs,outputs,widgets,
      setDirtyCanvas(){},disconnectInput(slot){
        const id=this.inputs[slot].link;
        const link=graph.links.get(id);
        if(link){
          const output=graph.getNodeById(link.origin_id).outputs[link.origin_slot];
          output.links=output.links.filter(v=>v!==id);graph.links.delete(id);
        }
        this.inputs[slot].link=null;this.onConnectionsChange?.();
      }};
    graph._nodes.push(n);return n;
  }
  function connect(from,slot,to,target) {
    to.disconnectInput(target);
    const id=nextId++;graph.links.set(id,{id,origin_id:from.id,origin_slot:slot,target_id:to.id,target_slot:target});
    (from.outputs[slot].links??=[]).push(id);to.inputs[target].link=id;to.onConnectionsChange?.();return id;
  }
  const source=node('Source',[],[{name:'array',type:'ARRAY',links:[]},{name:'text',type:'STRING',links:[]}]);
  const transform=node('LiuxinyuStructuredTransform',[
    {name:'sources.data0',type:jsonTypes,link:null},{name:'sources.data1',type:jsonTypes,link:null},
    {name:'expression',type:'STRING',link:null},{name:'result_type',type:'COMBO',link:null}],
    [{name:'结果',type:jsonTypes,links:[]},{name:'执行成功',type:'BOOLEAN',links:[]},{name:'错误信息',type:'STRING',links:[]}],
    [{name:'expression',value:'data0'},{name:'result_type',value:'字典'}]);
  const sink=node('Sink',[{name:'dict',type:'DICT',link:null},{name:'array',type:'ARRAY',link:null},
    {name:'any',type:'*',link:null},{name:'status',type:'BOOLEAN',link:null}],[]);
  extension.nodeCreated(transform);
  const settle=async()=>{await Promise.resolve();await Promise.resolve();};
  await settle();
  assert.equal(transform.outputs[0].type,'DICT');
  assert.equal(transform.onConnectInput(0,'IMAGE'),false);
  assert.equal(transform.onConnectInput(0,'ARRAY'),true);
  assert.equal(transform.onConnectInput(3,'STRING'),false);
  assert.equal(transform.onConnectOutput(0,'ARRAY'),false);
  assert.equal(transform.onConnectOutput(0,'DICT'),true);
  connect(source,0,transform,0);await settle();
  assert.equal(transform.inputs[0].type,'ARRAY');
  assert.equal(transform.outputs[0].type,'DICT','Expression output must not follow input type');
  connect(source,1,transform,1);await settle();
  assert.equal(transform.inputs[1].type,'STRING');
  const dictLink=connect(transform,0,sink,0), anyLink=connect(transform,0,sink,2);
  const statusLink=connect(transform,1,sink,3);
  transform.widgets[1].value='数组';transform.widgets[1].callback('数组');await settle();
  assert.equal(transform.outputs[0].type,'ARRAY');
  assert.ok(!graph.links.has(dictLink));assert.ok(graph.links.has(anyLink));assert.ok(graph.links.has(statusLink));
  assert.equal(graph.links.get(anyLink).type,'ARRAY');
  assert.equal(transform.onConnectOutput(0,'DICT'),false);
  connect(transform,0,sink,1);await settle();
  const snapshot=JSON.stringify([...graph.links.values()]);
  for(let i=0;i<20;i++){transform.onConfigure();await settle();assert.equal(JSON.stringify([...graph.links.values()]),snapshot);}
  transform.disconnectInput(0);await settle();assert.equal(transform.inputs[0].type,jsonTypes);
  connect(source,0,transform,0);await settle();source.outputs[0].type='IMAGE';transform.onConfigure();await settle();
  assert.equal(transform.inputs[0].link,null);assert.equal(transform.inputs[0].type,jsonTypes);

  // Apply the extension to the actual saved subgraphs, preserving every cable.
  const workflow=JSON.parse(fs.readFileSync(path.resolve(__dirname,
    '../../../user/default/workflows/Fully Automated E-commerce Workflow/快速设计详情页.json'),'utf8'));
  let count=0;
  for(const saved of workflow.definitions.subgraphs){
    const targets=saved.nodes.filter(n=>n.type==='LiuxinyuStructuredTransform');
    if(!targets.length)continue;
    const g={links:new Map(saved.links.map(l=>[l.id,structuredClone(l)])),
      _nodes:structuredClone(saved.nodes),getNodeById(id){return this._nodes.find(n=>n.id===id);}};
    const cables=JSON.stringify([...g.links.values()]);
    for(const id of targets.map(n=>n.id)){
      const n=g.getNodeById(id);n.graph=g;n.comfyClass=n.type;n.setDirtyCanvas=()=>{};
      n.disconnectInput=()=>{throw Error('Saved valid connection was disconnected');};
      n.widgets=Object.entries(n.widgets_values_named).map(([name,value])=>({name,value}));
      extension.nodeCreated(n);await settle();
      assert.equal(n.outputs[0].type,'ARRAY');
      for(let i=0;i<20;i++){n.onConfigure();await settle();}
      count++;
    }
    assert.equal(JSON.stringify([...g.links.values()]),cables);
  }
  assert.equal(count,3);
  console.log('Typed JSONata: exact result/input ports, incompatible disconnection, and 20 saved configure cycles passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
