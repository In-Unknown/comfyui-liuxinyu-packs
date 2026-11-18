const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const LiteGraph = { NODE_TITLE_HEIGHT: 30, NODE_WIDGET_HEIGHT: 20, NODE_SLOT_HEIGHT: 20, vueNodesMode: false,
  NODE_BOX_OUTLINE_COLOR: '#444', NODE_TEXT_COLOR: '#ddd' };
const context = vm.createContext({ console, LiteGraph, window: { devicePixelRatio: 1 } });
for (const file of ['activity_state.js', 'activity_view.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8').replace(/^export /gm, ''), context);
}
const { ActivityState, nodeView, drawingBounds, preferredWidth, visibleTiles } = vm.runInContext('({ActivityState,nodeView,drawingBounds,preferredWidth,visibleTiles})', context);
const state = new ActivityState();
const graph = { id: 'workflow-a' }, other = { id: 'workflow-b' };
assert.equal(state.start('job', graph), true);
assert.equal(state.start('job', graph), false, 'Duplicate start must not reopen the panel');
state.progress({ prompt_id: 'job', nodes: {
  'temp-loop-1': { state: 'running', display_node_id: '12:9' },
  'temp-loop-2': { state: 'running', display_node_id: '12:9' },
  '15': { state: 'running', display_node_id: '15' },
  '17': { state: 'finished', display_node_id: '17' },
}}, graph);
assert.deepEqual(Array.from(state.entries(graph), n => n.path), ['15', '12:9']);
assert.equal(state.entries(other).length, 0);
state.progress({ prompt_id: 'job', nodes: { 15: { state: 'running' }, 16: { state: 'running' } } }, other);
assert.deepEqual(Array.from(state.entries(graph), n => n.path), ['15', '16'], 'Progress cannot rebind an existing run to a switched workflow');
graph.id = 'reloaded'; assert.equal(state.entries(graph).length, 0); graph.id = 'workflow-a';
state.finish('job'); assert.equal(state.entries(graph).length, 0);
state.progress({prompt_id:'job',nodes:{99:{state:'running'}}},graph);
assert.equal(state.entries(graph).length,0,'Late progress cannot revive a finished run');
state.start('legacy',graph);
state.executing('12:9',graph);
assert.equal(state.entries(graph)[0].path,'12:9');
state.executing(null,graph); assert.equal(state.entries(graph).length,0);
state.progress({prompt_id:'legacy',nodes:{3:{state:'running'},4:{state:'running'}}},graph);
state.executing('3',graph); assert.equal(state.entries(graph).length,2,'Legacy single-node events cannot discard concurrent progress');

// Run the installed frontend's actual draw/layout methods, not a copied implementation.
const mapPath = process.argv[2];
assert(mapPath, 'Pass the installed settingStore source map');
const sourceMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
function method(file, name) {
  const index = sourceMap.sources.findIndex(p => p.endsWith('/' + file));
  assert(index >= 0, file);
  const source = stripTypeScriptTypes(sourceMap.sourcesContent[index], { mode: 'transform', disableExperimentalWarning: true });
  const start = source.indexOf('\n    ' + name + '(');
  assert(start >= 0, name);
  const end = source.indexOf('\n    }', start + 1) + 6;
  assert(end > start, name);
  return vm.runInContext('(class {' + source.slice(start, end) + '}).prototype.' + name, context);
}
context.distributeSpace = (space, requests) => requests.map(r => r.minSize);
context.NullGraphError = Error;
context.temp_vec2 = new Float32Array(2);
context.RenderShape = { BOX: 1, ROUND: 2, CARD: 3, CIRCLE: 4 };
let calls = [];
const source = {
  id: 9, graph, pos: [400, 600], size: [220, 100], flags: { collapsed: true },
  _state: { flags: { collapsed: true }, properties: { keep: 1 } },
  title: 'A complete node', widgets: [
    { name: 'model', value: 'gpt-6-astra', y: 0, computedHeight: 24, options: {} },
    { name: 'stream_output', value: '', element: {}, y: 24, computedHeight: 40, options: { onDraw() { throw Error('Must not move the live DOM'); } } },
  ],
  inputs: [{ name: 'image', boundingRect: [390, 610, 20, 20] }], outputs: [],
  get renderingSize() { return this.size; }, get bodyHeight() { return this.size[1]; },
  getLayoutWidgets() { return this.widgets; },
  _setConcreteSlots() { this._concreteInputs = this.inputs; this._concreteOutputs = this.outputs; },
  _measureSlots() { this.inputs[0].boundingRect[0] = this.pos[0]; return [0, 0, this.size[0], 22]; },
  _arrangeWidgetInputSlots() {},
  _arrangeWidgets: method('LGraphNode.ts', '_arrangeWidgets'),
  arrange: method('LGraphNode.ts', 'arrange'),
  setSize() { throw Error('Live geometry must never be resized'); },
  drawBadges(ctx) { calls.push('badges'); ctx.fillText('Original name', 0, -55); ctx.fillText('ID: 9', 0, this.size[1] + 22); },
  onDrawForeground() { calls.push('custom-foreground'); },
  drawSlots() { calls.push('slots'); },
};
const before = JSON.stringify({ size: source.size, pos: source.pos, flags: source.flags, inputs: source.inputs, widgets: source.widgets });
const view = nodeView(source, 480, new Map([[source.widgets[1], 650]]));
assert.equal(view.size[0], 480);
assert(view.size[1] > 650, 'Full DOM contents must expand the mirror');
assert.equal(view.flags.collapsed, false, 'The mirror shows the full node');
assert.equal(JSON.stringify({ size: source.size, pos: source.pos, flags: source.flags, inputs: source.inputs, widgets: source.widgets }), before);
assert.equal(view.widgets[1].element, undefined);
assert.equal({...view.inputs[0]}.name,'image','Plain slot conversion retains enumerable schema fields');
assert.equal({...view.widgets[0]}.name,'model','Plain widget conversion retains enumerable schema fields');
view.widgets[1].draw();

const ctx = {
  canvas: {}, font: '14px sans-serif', globalAlpha: 1, textAlign: 'left',
  getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  measureText: text => ({ width: String(text).length * 8 }),
  save() {}, restore() {}, fillText() {}, rect() {}, roundRect() {}, fillRect() {}, strokeRect() {},
  moveTo() {}, lineTo() {}, arc() {}, beginPath() {}, clip() {},
};
const renderer = {
  low_quality: false, render_shadows: false, ds: { scale: 1 }, linkConnector: { renderLinks: [] },
  getNodeModeAlpha: () => 1, drawNodeShape: () => calls.push('shape'),
  drawNodeWidgets: () => calls.push('widgets'), drawNode: method('LGraphCanvas.ts', 'drawNode'),
};
const bounds = drawingBounds(ctx, () => renderer.drawNode(view, ctx), [0, -30, 480, view.size[1]]);
assert.deepEqual(calls, ['shape', 'badges', 'custom-foreground', 'slots', 'widgets']);
assert(bounds[1] <= -69 && bounds[3] > view.size[1] + 22, 'Top/bottom badges must be included');
source.drawBadges = ctx => ctx.fillText('A future label', -40, -100);
const later = nodeView(source, 480);
const laterBounds = drawingBounds(ctx, () => renderer.drawNode(later, ctx), [0, -30, 480, later.size[1]]);
assert(laterBounds[0] <= -40 && laterBounds[1] <= -114, 'Future draw hooks are read from the live node');
assert.equal(source.flags.collapsed, true);
Object.setPrototypeOf(source, { arrange: source.arrange });
source.arrange = () => { throw Error('Instance wrapper closes over live geometry'); };
source.strokeStyles = { running() { assert.equal(this, source); return { color: 'yellow' }; } };
source.inputs[0]._widget = source.widgets[1];
const isolated = nodeView(source, 500, new Map([[source.widgets[1], 800]]));
assert.equal(isolated.inputs[0]._widget, isolated.widgets[1]);
assert.equal(isolated.strokeStyles.running().color,'yellow','Execution hooks retain real graph/node identity');
const legacy={size:[200,80],pos:[10,10],flags:{},inputs:[],outputs:[],widgets:[{name:'text',element:{},y:0},{name:'amount',value:1,y:0}]};
const legacyView=nodeView(legacy,400,new Map([[legacy.widgets[0],300]]));
assert(legacyView.widgets[1].y>=300 && legacyView.size[1]>=328,'Old LiteGraph without arrange() still allocates expanded widgets');
assert(preferredWidth({ title: 'X'.repeat(100), widgets: [], inputs: [], outputs: [] }, ctx) >= 800);
const tiles = visibleTiles(200000,400000,{left:180000,right:180800,top:210000,bottom:211000});
assert(tiles.length>0 && tiles.length<=4,'Raster allocation is limited to the viewport even for huge content');
assert(tiles.every(tile=>tile.width<=1024 && tile.height<=1024));

// Sorted ports retain old explicit X positions even on nodes without ordinary widgets.
const ports={size:[220,100],pos:[400,600],flags:{},inputs:[],widgets:[],outputs:[
  {name:'result',pos:[211,55],boundingRect:[601,645,20,20]},
  {name:'round',pos:[211,25],boundingRect:[601,615,20,20]}],
  getOutputPos(i){const slot=this.outputs[i];return [this.pos[0]+(slot.pos?.[0]??this.size[0]-9),this.pos[1]+(slot.pos?.[1]??(i+1)*20)];},
  _measureSlot(slot,i){const p=this.getOutputPos(i);slot.boundingRect=[p[0]-10,p[1]-10,20,20];}
};
const portsBefore=JSON.stringify(ports);
for(const width of [360,700,1100]) {
  const mirror=nodeView(ports,width);
  for(let repeat=0;repeat<3;repeat++) {
    mirror.arrange();
    assert.equal(mirror.getOutputPos(0)[0],width-9,'Output remains anchored to the new right edge');
    assert.equal(mirror.getOutputPos(0)[1],55,'Visual row order is preserved without widgets');
    assert.equal(mirror.getOutputPos(1)[1],25);
    assert.equal(mirror.outputs[0].boundingRect[0],width-19,'Drawn slot bounds follow the new position');
  }
}
assert.equal(JSON.stringify(ports),portsBefore,'Mirror layout never moves live ports');
const oldPorts={...ports,getOutputPos:undefined,_measureSlot:undefined,getConnectionPos(input,index){return ports.getOutputPos.call(this,index);}};
assert.equal(nodeView(oldPorts,700).getConnectionPos(false,0)[0],691,'Older getConnectionPos API keeps the same right anchor');

// Navigation is the existing implementation; there is no post-navigation tab restoration.
// Real native socket placement for widget inputs in an unvisited subgraph.
context.isWidgetInputSlot = slot => !!slot.widget;
const slotSource = sourceMap.sourcesContent[sourceMap.sources.findIndex(p => p.endsWith('/slotCalculations.ts'))];
for (const name of ['getSlotPosition', 'calculateInputSlotPos', 'calculateInputSlotPosFromSlot', 'calculateOutputSlotPos', 'getDefaultVerticalOutputs']) {
  const start = slotSource.indexOf(`function ${name}(`), end = slotSource.indexOf('\n}', start) + 2;
  vm.runInContext(stripTypeScriptTypes(slotSource.slice(start, end), {mode:'transform'}), context);
}
class WidgetNode {
  constructor(type='ComfySwitchNode') {
    this.comfyClass=type; this.graph=graph; this.pos=[100,200]; this.size=[360,160]; this.flags={};
    this.inputs=[{name:'false',boundingRect:[0,0,20,20]},{name:'true',boundingRect:[0,0,20,20]},
      {name:'switch',widget:{name:'switch'},link:1,boundingRect:[0,0,20,20]}];
    this.outputs=[];this.widgets=[{name:'switch',value:false,y:0,computeSize:()=>[100,20]}];
  }
  getInputPos(i){return context.getSlotPosition(this,i,true);}
  getOutputPos(i){return context.getSlotPosition(this,i,false);}
  getLayoutWidgets(){return this.widgets.filter(w=>!w.hidden);}
  isWidgetVisible(w){return !w.hidden;}
  isInputConnected(i){return this.inputs[i].link!=null;}
  _setConcreteSlots(){this._concreteInputs=this.inputs;this._concreteOutputs=this.outputs;}
  _measureSlot(s,i,input){const p=input?this.getInputPos(i):this.getOutputPos(i);s.boundingRect=[p[0]-10,p[1]-10,20,20];}
  _measureSlots(){return [this.pos[0],this.pos[1],this.size[0],40];}
  computeSize(){return [360,160];}
  setSize(size){this.size=[...size];}
  setDirtyCanvas(){}
  drawSlots(){}
}
for(const name of ['arrange','_arrangeWidgets','_arrangeWidgetInputSlots'])WidgetNode.prototype[name]=method('LGraphNode.ts',name);
const unvisited=new WidgetNode();
assert(Math.abs(unvisited.getInputPos(2)[1]-unvisited.pos[1]+6)<.001,'Native unarranged widget socket is at -6px');
const originalUnvisited=JSON.stringify(unvisited);
const switchMirror=nodeView(unvisited,500);
assert.equal(switchMirror.inputs[2].pos[1],switchMirror.widgets[0].y+10,'Fresh mirror placement must not be overwritten by -6px');
assert(switchMirror.inputs[2].pos[1]>switchMirror.inputs[1].pos[1]);
assert.equal(switchMirror.widgets.length,1,'No duplicated boolean control');
assert.equal(JSON.stringify(unvisited),originalUnvisited);

let collapseExtension;
context.app={registerExtension(value){collapseExtension=value;}};
context.queueMicrotask=()=>{};
vm.runInContext(fs.readFileSync(path.join(root,'multiline_collapse.js'),'utf8').replace(/^import .*;\r?$/gm,''),context);
for(const type of ['llm_remote_reply','LLMHarnessBooleanReturn','LiuxinyuTextFromTemplate']) {
  const n=new WidgetNode(type);
  n.inputs=[{name:'prompt',localized_name:'提示词',widget:{name:'prompt'},link:1,boundingRect:[0,0,20,20]},
    {name:'system',localized_name:'系统提示词',widget:{name:'system'},link:2,boundingRect:[0,0,20,20]}];
  n.widgets=n.inputs.map(input=>({name:input.name,type:'customtext',options:{multiline:true},y:0,computeLayoutSize:()=>({minHeight:100})}));
  n._setConcreteSlots();collapseExtension.nodeCreated(n);n.arrange();
  const before=JSON.stringify(n), copy=nodeView(n,550);
  assert.equal(copy.getLayoutWidgets().length,2,'Hidden editors still reserve their compact socket rows in mirrors');
  const labels=[];copy.drawSlots({...ctx,fillText:(text,x,y)=>labels.push([text,x,y])});
  assert.deepEqual(labels.map(row=>row[0]),['提示词','系统提示词'],'Compact labels resolve copied input identities');
  assert.equal(copy.inputs[1].pos[1]-copy.inputs[0].pos[1],20);
  assert.equal(labels[0][2],copy.inputs[0].pos[1]+5);
  assert.equal(JSON.stringify(n),before,'Layout and label rendering cannot change the source');
}

const controller = fs.readFileSync(path.join(root, 'activity.js'), 'utf8');
assert.match(controller, /import \{ findNodes, revealNode \} from "\.\/node_find.js"/);
assert.match(controller, /void revealNode\(match\)\.catch\(report\)/);
assert(!/revealNode\(match\).*\.then/.test(controller));
console.log('PASS: concurrent execution/display IDs, stable order, workflow isolation, native layout/drawing, immutable live geometry, DOM height, future badges and shared navigation');
