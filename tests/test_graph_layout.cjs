const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const extensions = [];
const messages = [];
const events = [];
let handler;
const LiteGraph = {NODE_SLOT_HEIGHT:20,NODE_WIDGET_HEIGHT:20,NODE_TITLE_HEIGHT:30,LEFT:3,RIGHT:4,SPLINE_LINK:2};
const app = {registerExtension(e) {extensions.push(e);}, extensionManager:{toast:{add(m) {messages.push(m.detail);}}}};
const context = vm.createContext({app,LiteGraph,console,structuredClone,queueMicrotask,AbortController,TextDecoder,setTimeout,clearTimeout,
  api:{fetchApi:async (...args)=>handler(...args)}});
const source = name => fs.readFileSync(path.join(__dirname,'..',name),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');
vm.runInContext(source('port_order.js'),context);
vm.runInContext(source('menu_order.js'),context);
vm.runInContext(source('menu_source.js'),context);
vm.runInContext(source('graph_layout.js').replace('const PROPERTY = "liuxinyu_port_order";','')+
  '\nglobalThis.layoutTest = {snapshot,apply,restore,checkpoint,arrangeSelected,layoutFingerprint,request,rankedChoices};',context);
const helpers = context.layoutTest;
const graph = {_nodes:[],links:new Map(),beforeChange(){events.push('before');},afterChange(){events.push('after');},change(){events.push('change');},
  extra:{ds:{scale:1,offset:[0,0]}},
  serialize(){return {extra:structuredClone(this.extra),nodes:this._nodes.map(n=>({id:n.id,pos:[...n.pos],size:[...n.size],properties:clone(n.properties),
    inputs:n.inputs.map(s=>({name:s.name,link:s.link})),outputs:n.outputs.map(s=>({name:s.name,links:s.links}))})),links:[...this.links.values()]};}};
class Node {
  constructor(id,x) {
    this.id=id;this.pos=[x,0];this.size=[200,80];this.properties={};this.flags={};this.graph=graph;
    this.inputs=[{name:'a',link:null},{name:'b',link:null}];this.outputs=[{name:'out',links:[]}];
  }
  _measureSlot() {}
  getInputPos(i){const p=this.inputs[i].pos||[10,14+i*20];return [this.pos[0]+p[0],this.pos[1]+p[1]];}
  getOutputPos(i){const p=this.outputs[i].pos||[this.size[0]-9,14+i*20];return [this.pos[0]+p[0],this.pos[1]+p[1]];}
  getLayoutWidgets(){return [];}
  arrange(){}
  setSize(s){this.size=[...s];}
  setDirtyCanvas(){}
  serializeFromStoreState(){return {};}
}
const a=new Node(1,0), b=new Node(2,400), outside=new Node(3,-400);
{
  const compound=new Node(100,0);
  const header={name:'header',computedHeight:24},editor={name:'text',computedHeight:140};
  const storage={name:'storage',computedHeight:0},button={name:'add',computedHeight:24};
  compound.inputs=[{name:'text',widget:{name:'text'},_widget:header}];
  compound.getLayoutWidgets=()=>[storage,header,editor,button];
  const g={_nodes:[compound],links:new Map()};
  let record=helpers.snapshot(g,[compound]).nodes[0];
  assert.equal(record.inputs[0].height,164,'Layout search measures the whole header/editor group');
  assert.equal(record.freeHeight,24,'Header is not counted again as a free control; hidden storage takes zero height');
  compound.getLayoutWidgets=()=>[storage,header,button];
  record=helpers.snapshot(g,[compound]).nodes[0];
  assert.equal(record.inputs[0].height,24,'Connected editor leaves its header as the complete row');
  assert.equal(record.freeHeight,24);
  button.liuxinyuInputName='text';
  record=helpers.snapshot(g,[compound]).nodes[0];
  assert.equal(record.inputs[0].height,48,'Attached button belongs to the input group even when its editor is hidden');
  assert.equal(record.freeHeight,0,'Attached button is not counted twice');
  compound.constructor.slot_start_y=28;
  compound.getInputPos=()=>[10,14];compound.getPortOrderOutputAnchor=()=>compound.inputs[0];
  record=helpers.snapshot(g,[compound]).nodes[0];
  assert.equal(record.inputTop,4,'Snapshot reports the real top widget row above ordinary socket start');
  assert.equal(record.outputs[0].inputAnchor,0,'Output row following an input has an explicit anchor');
  delete compound.constructor.slot_start_y;
}
graph._nodes=[a,b,outside];
graph.links.set(1,{id:1,origin_id:1,origin_slot:0,target_id:2,target_slot:1});
a.outputs[0].links=[1];b.inputs[1].link=1;
const portExtension = extensions.find(e=>e.name==='liuxinyu.PortOrder');
for(const n of graph._nodes)portExtension.nodeCreated(n);
app.canvas={graph,selected_nodes:{1:a,2:b},links_render_mode:2,setDirty(){}};
const clone = x=>JSON.parse(JSON.stringify(x));
const proxyCache=new WeakMap();
function reactive(value) {
  if (!value || typeof value!=='object') return value;
  if (!proxyCache.has(value)) proxyCache.set(value,new Proxy(value,{
    get(target,key,receiver){return reactive(Reflect.get(target,key,receiver));},
  }));
  return proxyCache.get(value);
}
const plan={status:'ok',nodes:[{id:'1',pos:[0,100],inputs:[1,0],outputs:[0]},
  {id:'2',pos:[500,100],inputs:[1,0],outputs:[0]}]};

(async()=>{
  const styles=[];
  context.document={getElementById:id=>styles.find(s=>s.id===id),createElement:tag=>({tag}),head:{append:s=>styles.push(s)}};
  const sourceExtension=extensions.find(e=>e.name==='liuxinyu.MenuSource');
  sourceExtension.setup();sourceExtension.setup();
  assert.equal(styles.length,1,'shared menu styles are installed once');
  const original={content:'entry',className:'existing',disabled:true,callback(){return 42;}};
  const marked=context.sourceMenuItems([original,null]);
  assert.equal(original.className,'existing','do not mutate existing menu items');
  assert.equal(marked[0].className,'existing liuxinyu-menu-source');
  assert.equal(marked[0].callback,original.callback);assert.equal(marked[0].callback(),42);
  assert.equal(marked[0].disabled,true);assert.equal(marked[1],null);
  delete context.document;
  const before=clone(graph.serialize());
  const saved=helpers.checkpoint([a,b]);
  helpers.apply([a,b],plan.nodes);
  assert.equal(a.inputs[0].name,'a');assert.equal(b.inputs[1].link,1);
  assert.deepEqual(clone(outside.pos),[-400,0]);
  assert(a.getInputPos(1)[1]<a.getInputPos(0)[1]);
  helpers.restore(saved);
  assert.deepEqual(clone(graph.serialize()),before);
  const note=new Node(754,900);note.inputs=[];note.outputs=[];
  note.properties={userNote:true,liuxinyu_port_order:{version:1,inputs:[],outputs:[]}};
  portExtension.nodeCreated(note);
  const noteState=helpers.checkpoint([note]);
  const notePlan=[{id:'754',pos:[1000,100],inputs:[],outputs:[]}];
  helpers.apply([note],notePlan);
  assert.deepEqual(clone(note.properties),{userNote:true},'Notes get no empty port order; unrelated properties remain');
  assert.deepEqual(clone(note.size),[200,80]);
  helpers.restore(noteState);
  assert.deepEqual(clone(note.properties.liuxinyu_port_order),{version:1,inputs:[],outputs:[]},'Trial restore preserves old properties');
  helpers.apply([note],notePlan);
  assert.equal(note.properties.liuxinyu_port_order,undefined,'Repeated layout does not recreate empty orders');
  const json=helpers.snapshot(graph,[a,b]);
  assert.equal(json.nodes.filter(n=>n.selected).length,2);
  assert.equal(json.nodes[2].selected,false);
  assert(!JSON.stringify(json).includes('widgets_values'));
  let requests=0;
  handler=async(url,opts)=>{
    assert.equal(url,'/liuxinyu/layout');requests++;
    const data=JSON.parse(opts.body);
    assert.deepEqual(clone(graph.serialize()),before,'trial geometry restored before verification request');
    return {ok:true,json:async()=>data.verify?{status:'ok'}:plan};
  };
  await helpers.arrangeSelected();
  assert.equal(requests,2);
  assert.deepEqual(events,['before','change','after']);
  assert.deepEqual(clone(a.pos),[0,100]);
  assert.deepEqual(clone(outside.pos),[-400,0]);
  assert(messages.at(-1).includes('本次仅找到 1 个'),'single candidate explicitly explains the absence of a chooser');
  assert.deepEqual(clone([...graph.links.values()]),before.links);
  // ComfyUI exposes existing properties and nested order arrays through proxies.
  // A first run with no order property did not exercise this browser case.
  for (const n of [a,b]) n.properties=reactive(n.properties);
  assert.throws(()=>structuredClone(a.properties.liuxinyu_port_order),{name:'DataCloneError'});
  const sorted=clone(graph.serialize());
  const orderedCheckpoint=helpers.checkpoint([a,b]);
  a.properties.liuxinyu_port_order.inputs.reverse();
  assert.notDeepEqual(clone(a.properties.liuxinyu_port_order),clone(orderedCheckpoint[0].property),'checkpoint must not alias nested arrays');
  helpers.restore(orderedCheckpoint);
  assert.deepEqual(clone(graph.serialize()),sorted);
  events.length=0;
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?{status:'ok'}:plan});
  for(let i=0;i<2;i++) {
    await helpers.arrangeSelected();
    assert.deepEqual(clone(graph.serialize()),sorted,'repeated layout with reactive orders remains stable');
    assert(messages.at(-1).includes('已整理'));
  }
  assert.equal(events.length,6);
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?{status:'not_found'}:plan});
  await helpers.arrangeSelected();
  assert.deepEqual(clone(graph.serialize()),sorted,'failed trial restores reactive orders');
  helpers.restore(saved);events.length=0;
  let phase=0;
  handler=async()=>{
    graph.extra.ds={scale:.63,offset:[300,-200]};
    return {ok:true,json:async()=>++phase===1?plan:{status:'ok'}};
  };
  await helpers.arrangeSelected();
  assert.deepEqual(events,['before','change','after'],'zoom/pan must not discard a result');
  assert.equal(graph.extra.ds.scale,.63);
  helpers.restore(saved);events.length=0;graph.extra=structuredClone(before.extra);
  phase=0;
  handler=async()=>{a.properties.userEdit='keep';return {ok:true,json:async()=>++phase===1?plan:{status:'ok'}};};
  await helpers.arrangeSelected();
  assert.equal(a.properties.userEdit,'keep');assert.equal(events.length,3,'unrelated properties should be retained without discarding layout');
  helpers.restore(saved);events.length=0;
  delete a.properties.userEdit;
  handler=async()=>{a.pos[0]+=30;return {ok:true,json:async()=>plan};};
  await helpers.arrangeSelected();
  assert.equal(a.pos[0],30);assert.equal(events.length,0);
  assert(messages.at(-1).includes('已变化'));
  helpers.restore(saved);
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?{status:'not_found'}:plan});
  await helpers.arrangeSelected();
  assert.deepEqual(clone(graph.serialize()),before);assert.equal(events.length,0);
  handler=async()=>{throw new Error('offline');};
  await helpers.arrangeSelected();
  assert.deepEqual(clone(graph.serialize()),before);
  const baseline=clone(helpers.snapshot(graph,[a,b]));
  const partialPlan={...plan,partial:true,before:{crossings:5,nodeIntersections:0,overlaps:0},
    checks:{crossings:2,nodeIntersections:0,overlaps:0}};
  const measuredChecks={crossings:3,nodeIntersections:0,overlaps:0};
  handler=async(url,opts)=>{
    const data=JSON.parse(opts.body);
    if(data.verify) {
      assert.deepEqual(data.baseline,baseline,'compare measured geometry with the original snapshot');
      assert.deepEqual(clone(graph.serialize()),before,'restore trial before comparison');
    }
    return {ok:true,json:async()=>data.verify?{status:'ok',checks:measuredChecks,before:partialPlan.before}:partialPlan};
  };
  events.length=0;
  await helpers.arrangeSelected();
  assert.equal(events.length,3,'apply an imperfect but verified improvement in one undo transaction');
  assert(messages.at(-1).includes('交叉 3'),'report actual measured conflicts, not predicted counts');
  assert(messages.at(-1).includes('仍有剩余冲突'));
  assert(!messages.at(-1).includes('全部为 0'));
  helpers.restore(saved);events.length=0;
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?
    {status:'not_improved',checks:partialPlan.before}:partialPlan});
  await helpers.arrangeSelected();
  assert.deepEqual(clone(graph.serialize()),before);
  assert.equal(events.length,0,'reject a predicted improvement that fails actual comparison');
  assert(messages.at(-1).includes('没有优于原布局'));
  requests=0;
  handler=async()=>{requests++;return {ok:true,json:async()=>({status:'not_improved',message:'没有改善'})};};
  await helpers.arrangeSelected();
  assert.equal(requests,1);
  assert.deepEqual(clone(graph.serialize()),before);
  const ext=extensions.find(e=>e.name==='liuxinyu.MenuSource');
  assert.equal(ext.getCanvasMenuItems()[0].content,'整理节点');
  assert.equal(ext.getNodeMenuItems()[0].content,'整理节点');
  assert.equal(ext.getCanvasMenuItems()[0].className,'liuxinyu-menu-source');
  assert.equal(ext.getNodeMenuItems()[0].className,'liuxinyu-menu-source');
  graph.inputNode={id:-10,pos:[-200,-50],size:[100,100],slots:[{pos:[-114,-20]}]};
  const boundary=helpers.snapshot(graph,[a,b]).nodes.at(-1);
  assert.deepEqual(clone(boundary.outputs),[{x:86,y:30}]);assert.equal(boundary.selected,false);
  const wire=Buffer.from(JSON.stringify({event:'progress',data:{stage:'topology',message:'正在检查'}})+'\n'+JSON.stringify({event:'result',data:{status:'ok'}})+'\n');
  let cursor=0,seen=0;
  handler=async()=>({ok:true,headers:{get:()=> 'application/x-ndjson'},body:{getReader:()=>({
    async read(){if(cursor>=wire.length)return {done:true};const value=wire.subarray(cursor,cursor+3);cursor+=3;return {value,done:false};},releaseLock(){}})}});
  const streamed=await helpers.request({stream:true},new AbortController(),v=>{assert.equal(v.message,'正在检查');seen++;});
  assert.equal(streamed.status,'ok');assert.equal(seen,1);
  delete graph.inputNode;
  const panels=[];
  context.document={body:{append(element){panels.push(element);}},createElement(tag){return {
    tag,style:{},children:[],setAttribute(){},append(...items){this.children.push(...items);},remove(){this.removed=true;},
  };}};
  handler=async()=>{
    panels.at(-1).children[1].onclick();
    return {ok:true,json:async()=>plan};
  };
  await helpers.arrangeSelected();
  assert.equal(events.length,0);
  assert.deepEqual(clone(graph.serialize()),before);
  assert.equal(panels.at(-1).removed,true);
  assert(messages.at(-1).includes('已取消'));
  const timers=new Set();
  context.setInterval=callback=>{timers.add(callback);return callback;};
  context.clearInterval=callback=>timers.delete(callback);
  context.window={innerWidth:1200,innerHeight:900};
  context.document.createElement=tag=>({
    tag,style:{},children:[],attributes:{},
    setAttribute(key,value){this.attributes[key]=value;},
    append(...items){this.children.push(...items);},remove(){this.removed=true;},
    getBoundingClientRect(){return {left:900,top:600};},setPointerCapture(id){this.pointer=id;},
  });
  const otherPlan=clone(plan.nodes);
  otherPlan[0].pos=[0,-100];otherPlan[1].pos=[500,-100];
  otherPlan[0].inputs=[0,1];
  const tiedPlan={...plan,candidates:[{nodes:plan.nodes},{nodes:otherPlan}]};
  const zero={crossings:0,nodeIntersections:0,overlaps:0};
  let verifyCount=0;
  handler=async(url,opts)=>{
    const payload=JSON.parse(opts.body);
    if(payload.verify){verifyCount++;assert.deepEqual(clone(graph.serialize()),before,'each trial restored before yielding');}
    return {ok:true,json:async()=>payload.verify?{status:'ok',checks:zero,cost:100}:tiedPlan};
  };
  events.length=0;
  await helpers.arrangeSelected();
  assert.equal(verifyCount,2);
  const picker=panels.at(-1),header=picker.children[0],options=picker.children[1].children;
  assert.equal(picker.attributes.role,'region');
  assert.equal(picker.attributes['aria-modal'],undefined);
  assert.equal(options.length,3);
  assert.equal(options[0].textContent,'方案 1（推荐）');
  assert.equal(options[1].textContent,'方案 2（↓0.0%）');
  assert(options[1].title.includes('分数越低越好'));
  assert.equal(options[0].attributes['aria-pressed'],'true');
  assert.deepEqual(clone(a.pos),[0,100],'default candidate is immediately displayed');
  assert.equal(events.length,3);
  let focusPrevented=false;
  options[1].onpointerdown({preventDefault(){focusPrevented=true;}});
  assert(focusPrevented,'clicking a choice preserves canvas focus');
  assert.equal(options[1].tabIndex,-1);
  assert.equal(options[1].onkeydown,undefined,'no keyboard interception');
  options[1].onclick();
  assert.deepEqual(clone(a.pos),[0,-100]);
  assert.equal(options[1].attributes['aria-pressed'],'true');
  assert.equal(events.length,6,'switch uses a closed native undo transaction');
  assert.equal(b.inputs[1].link,1);
  assert.deepEqual(clone([...graph.links.values()]),before.links);
  options[0].onclick();
  assert.deepEqual(clone(a.pos),[0,100]);
  assert.deepEqual(clone(a.size),[200,80],'repeated previews do not accumulate size');
  header.onpointerdown({button:0,pointerId:4,clientX:920,clientY:615,preventDefault(){}});
  header.onpointermove({pointerId:4,clientX:720,clientY:415});
  assert.equal(picker.style.left,'700px');assert.equal(picker.style.top,'400px');
  header.onpointerup();
  header.onpointermove({pointerId:4,clientX:320,clientY:115});
  assert.equal(picker.style.left,'700px','drag ends on pointer release');
  graph.extra.ds={scale:.6,offset:[200,50]};
  for(const tick of timers)tick();
  assert(!picker.removed,'zoom and pan retain candidate chooser');
  const applied=clone(graph.serialize());
  const eventCount=events.length;
  options.at(-1).onclick();
  assert(picker.removed);assert.equal(timers.size,0);
  assert.deepEqual(clone(graph.serialize()),applied,'confirm retains current layout');
  assert.equal(events.length,eventCount,'confirm adds no empty undo entry');
  helpers.restore(saved);graph.extra=structuredClone(before.extra);events.length=0;
  await helpers.arrangeSelected();
  const stale=panels.at(-1);
  a.pos[0]=75;
  for(const tick of timers)tick();
  assert(stale.removed,'editing or undo invalidates alternatives');
  assert.equal(a.pos[0],75,'invalidation never rolls back user edits');
  assert.equal(timers.size,0);
  helpers.restore(saved);events.length=0;
  await helpers.arrangeSelected();
  const switchedGraph=panels.at(-1);
  app.canvas.graph={};
  for(const tick of timers)tick();
  assert(switchedGraph.removed,'changing workflow or subgraph dismisses chooser');
  app.canvas.graph=graph;
  helpers.restore(saved);events.length=0;
  await helpers.arrangeSelected();
  const rebuiltPicker=panels.at(-1);
  graph._nodes[0]=Object.assign(Object.create(Object.getPrototypeOf(a)),a);
  for(const tick of timers)tick();
  assert(rebuiltPicker.removed,'reloaded node instances invalidate old handles even with identical geometry');
  graph._nodes[0]=a;
  helpers.restore(saved);events.length=0;
  const actualDifferent=[{nodes:plan.nodes,result:{checks:zero,cost:100}},
    {nodes:otherPlan,result:{checks:zero,cost:115}},
    {nodes:otherPlan,result:{checks:zero,cost:115.1}},
    {nodes:otherPlan,result:{checks:{...zero,crossings:1},cost:1}}];
  assert.equal(helpers.rankedChoices(actualDifferent).length,2,'actual measurements decide equivalence');
  const reverseRanked=helpers.rankedChoices([...actualDifferent].reverse());
  assert.equal(reverseRanked[0].result.cost,100,'rank by score regardless of candidate arrival order');
  assert.equal(reverseRanked[1].result.cost,115,'keep a genuinely different score within the allowed range');
  assert.equal(helpers.rankedChoices(Array(8).fill(actualDifferent[0])).length,5);
  verifyCount=0;
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?
    {status:'ok',checks:zero,cost:++verifyCount===1?100:120}:tiedPlan});
  await helpers.arrangeSelected();
  assert.equal(timers.size,0,'one actual best choice does not open a chooser');
  assert.deepEqual(clone(a.pos),[0,100]);
  assert(messages.at(-1).includes('搜索保留 2 个候选，实际端口复核后仅保留 1 个'));
  const fixedChoice={nodes:plan.nodes,preservesPortOrder:true,result:{checks:zero,cost:150}};
  assert.equal(helpers.rankedChoices([actualDifferent[0],fixedChoice])[0],fixedChoice,
    'actual zero-conflict fixed-order plan outranks a cheaper reordered plan');
  helpers.restore(saved);events.length=0;
  const keepPlan={status:'ok',preservesPortOrder:true,nodes:clone(plan.nodes)};
  keepPlan.nodes.forEach(n=>{n.inputs=[0,1];});
  const keepProperties=[clone(a.properties),clone(b.properties)];
  handler=async(url,opts)=>({ok:true,json:async()=>JSON.parse(opts.body).verify?
    {status:'ok',checks:zero,cost:100}:keepPlan});
  await helpers.arrangeSelected();
  assert.deepEqual([clone(a.properties),clone(b.properties)],keepProperties,'position-only layout does not write port order properties');
  assert.deepEqual(clone([...graph.links.values()]),before.links);
  assert.equal(events.length,3);
  assert(messages.at(-1).includes('已保留原端口顺序'));
  assert.throws(()=>helpers.apply([a,b],plan.nodes,true),/端口顺序/,'reject a falsely labelled fixed-order plan');
  console.log('PASS: menu, original ports, outside nodes, trial restore, undo transaction, zoom/pan, harmless properties, actual movement, failed verification, network failure, fixed boundaries, chunked UTF-8 progress, cancel panel');
  console.log('PASS: tied candidate verification, instant switching, focus preservation, draggable nonmodal chooser, confirm, invalidation and cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
