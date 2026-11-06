const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clean = value => JSON.parse(JSON.stringify(value));
const LiteGraph = { NODE_SLOT_HEIGHT: 20, NODE_TITLE_HEIGHT: 30, NODE_WIDGET_HEIGHT: 20, vueNodesMode: false };
let extension;
const context = vm.createContext({
  app: { registerExtension(value) { extension = value; } }, LiteGraph, queueMicrotask,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../port_order.js'), 'utf8')
  .replace(/^import .*;$/m, '').replace(/^export /gm, '') + '\nglobalThis.testing = { entries, ordered, applyOrder, hoveredPort };', context);
const { entries, ordered, applyOrder } = context.testing;
const PROPERTY = 'liuxinyu_port_order';

class Slot {
  constructor(name, extra = {}) { Object.assign(this, { name, type: '*', boundingRect: [0, 0, 20, 20] }, extra); }
  get isWidgetInputSlot() { return !!this.widget; }
}
class Node {
  constructor() {
    this.inputs = [new Slot('a', {link: 11}), new Slot('b', {link: 12}),
      new Slot('prompt', {widget: {name: 'prompt'}, link: 13})];
    this.outputs = [new Slot('result', {links: [20], slot_index: 0}), new Slot('round', {links: [21], slot_index: 101})];
    this.widgets = [{name: 'prompt', y: 0}];
    this.flags = {}; this.properties = {}; this.pos = [100, 200]; this.size = [300, 100];
    this.events = []; this.id = 1;
    this.graph = {
      beforeChange: () => this.events.push('before'), afterChange: () => this.events.push('after'),
      change: () => this.events.push('change'), setDirtyCanvas() {},
    };
  }
  getSlotInPosition(x,y) {
    for(const [side,input] of [['inputs',true],['outputs',false]]) {
      for(let i=0;i<this[side].length;i++) {
        const p=input?this.getInputPos(i):this.getOutputPos(i);
        if(Math.abs(p[0]-x)<=10 && Math.abs(p[1]-y)<=10) return {[input?'input':'output']:this[side][i],slot:i};
      }
    }
    return null;
  }
  getInputOnPos([x,y]) {
    return this.inputs.find((slot,i)=>{ const p=this.getInputPos(i);const width=20+(slot.name.length||3)*7;
      return x>=p[0]-10&&x<p[0]-10+width&&y>=p[1]-10&&y<p[1]+10; });
  }
  getOutputOnPos([x,y]) {
    return this.outputs.find((slot,i)=>{const p=this.getOutputPos(i);return x>=p[0]-10&&x<p[0]+30&&y>=p[1]-10&&y<p[1]+10;});
  }
  getInputPos(index) { return this.slotPosition(index, true); }
  getOutputPos(index) { return this.slotPosition(index, false); }
  slotPosition(index, input) {
    if (this.flags.collapsed) return [this.pos[0] + (input ? 0 : this.size[0]), this.pos[1] - 15];
    const slots = input ? this.inputs : this.outputs;
    const slot = slots[index];
    const normal = slots.filter(p => !p.pos && !(input && p.widget));
    const p = slot.pos || [input ? 10 : this.size[0] - 9, (normal.indexOf(slot) + .7) * 20];
    return [this.pos[0] + p[0], this.pos[1] + p[1]];
  }
  _measureSlot(slot, index, input) {
    const pos = input ? this.getInputPos(index) : this.getOutputPos(index);
    slot.boundingRect = [pos[0] - 10, pos[1] - 10, slot.widget ? 15 : 20, 20];
  }
  _arrangeWidgets(bottom) {
    let height=this.widgets_start_y ?? bottom + 2;
    this.getLayoutWidgets().forEach(w => {
      w.y=height;
      const layout=w.computeLayoutSize?.(this);
      w.computedHeight=layout ? Math.max(layout.minHeight,Math.min(layout.maxHeight ?? Infinity,this.size[1]-height)) : (w.computeSize?.()[1] ?? 20)+4;
      height+=w.computedHeight;
    });
    if (height > this.size[1]) { this.size[1] = height; this.arrange(); }
  }
  arrange() {
    let bottom = 0;
    for (const side of ['inputs', 'outputs']) this[side].forEach((p, i) => {
      if (side === 'inputs' && p.widget) return;
      this._measureSlot(p, i, side === 'inputs');
      bottom = Math.max(bottom, p.boundingRect[1] + 20 - this.pos[1]);
    });
    this._arrangeWidgets(bottom);
    this.inputs.forEach((p, i) => {
      if (p.widget) { p.pos = [10, this.widgets.find(w => w.name === p.widget.name).y + 10]; this._measureSlot(p, i, true); }
    });
    return 17;
  }
  drawSlots() { return this.inputs.map(p => p.isWidgetInputSlot); }
  serializeFromStoreState() {
    return clean({inputs: this.inputs.map(p => ({name:p.name, link:p.link, widget:p.widget, pos:p.widget ? undefined : p.pos})),
      outputs: this.outputs.map(p => ({name:p.name, links:p.links, slot_index:p.slot_index, pos:p.pos})),
      properties: this.properties});
  }
  onConfigure() { return 31; }
  getExtraMenuOptions(canvas, options) { options.push({content:'Existing'}); return [{content:'Returned'}]; }
  setDirtyCanvas() {}
  get _concreteInputs() { return this.inputs; }
  get _concreteOutputs() { return this.outputs; }
  get bodyHeight() { return this.size[1]; }
  getLayoutWidgets() { return this.widgets; }
  setSize(size) { this.size=size; this.arrange(); }
}

// Old automatic layout wrote an order even for a primitive with one socket per
// side. That record must not move its value widget beside the output label.
{
  const primitive=new Node();
  primitive.inputs=[new Slot('value',{widget:{name:'value'}})];
  primitive.outputs=[new Slot('INT',{links:[20]})];
  primitive.widgets=[{name:'value',value:1,width:260},{name:'control_after_generate',value:'fixed',width:260}];
  primitive.size=[270,82];
  primitive.arrange();
  const native=primitive.widgets.map(w=>({y:w.y,width:w.width,value:w.value}));
  const output=primitive.getOutputPos(0);
  primitive.properties[PROPERTY]={version:1,
    inputs:entries(primitive,'inputs').map(e=>e.key),outputs:entries(primitive,'outputs').map(e=>e.key)};
  extension.nodeCreated(primitive);
  for(let i=0;i<10;i++)primitive.arrange();
  assert.deepEqual(primitive.widgets.map(w=>({y:w.y,width:w.width,value:w.value})),native);
  assert.deepEqual(primitive.getOutputPos(0),output);
  assert.equal(primitive.outputs[0].links[0],20);
  assert.equal(primitive.size[1],82);
}

// Optional integration: use the installed frontend's actual coordinate and
// hit-test functions. No browser or bundled frontend modifications are needed.
if (process.argv[2]) {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  vm.runInContext('const Z = LiteGraph;\n' +
    'function getVueSlotPosition(node, index, input) { return node.slotPosition(index, input); }\n' +
    between('function isWidgetInputSlot(', 'function getVueSlotPosition(') +
    between('function getDefaultVerticalOutputs(', 'function useLayoutMutations(') +
    'function isInRectangle(x,y,left,top,width,height) { return x>=left && x<left+width && y>=top && y<top+height; }\n' +
    between('function getNodeInputOnPos(', 'function computeLegacyWidgetShadow(') +
    between('function getSlotLayout(', 'function getGraphSlotLayout(') +
    '\nglobalThis.native = { getSlotPosition, getSlotLayout, getNodeInputOnPos, getNodeOutputOnPos };', context);
  Node.prototype.getInputPos = function (i) { return context.native.getSlotPosition(this, i, true); };
  Node.prototype.getOutputPos = function (i) { return context.native.getSlotPosition(this, i, false); };
  Node.prototype.getInputOnPos = function(pos) { return context.native.getNodeInputOnPos(this,...pos)?.input; };
  Node.prototype.getOutputOnPos = function(pos) { return context.native.getNodeOutputOnPos(this,...pos)?.output; };
  context.Zc = {margin:15};
  vm.runInContext(between('function distributeSpace(', 'function truncateText('), context);
  context.createBounds = slots => {
    const bounds=slots.map(p=>p.boundingRect);
    const x=Math.min(...bounds.map(b=>b[0])),y=Math.min(...bounds.map(b=>b[1]));
    return [x,y,Math.max(...bounds.map(b=>b[0]+b[2]))-x,Math.max(...bounds.map(b=>b[1]+b[3]))-y];
  };
  vm.runInContext('globalThis.NativeLayout = class {\n' +
    between('_measureSlot(e,t,n){','_getMouseOverSlot(e){') +
    between('_arrangeWidgets(e){','drawProgressBar(e){') + '\n};', context);
  for(const name of ['arrange','_measureSlot','_measureSlots','_arrangeWidgets','_arrangeWidgetInputSlots']) {
    Node.prototype[name]=context.NativeLayout.prototype[name];
  }
  console.log('Using installed native slot coordinates, hit-test bounds and layout methods');
}

const node = new Node();
extension.nodeCreated(node);
node.arrange();
const before = node.serializeFromStoreState();
const inputRefs = [...node.inputs], outputRefs = [...node.outputs];
const draft = {inputs: entries(node, 'inputs').map(e => e.key).reverse(), outputs: entries(node, 'outputs').map(e => e.key).reverse()};
applyOrder(node, draft);
assert.deepEqual(node.events, ['before', 'change', 'after']);
assert.deepEqual(node.inputs, inputRefs);
assert.deepEqual(node.outputs, outputRefs);
assert.deepEqual(clean(node.inputs.map((p,i) => node.getInputPos(i)[1])), [258, 238, 214]);
assert.deepEqual(clean(node.outputs.map((p,i) => node.getOutputPos(i)[1])), [234, 214]);
assert.equal(node.widgets[0].y + 10, node.inputs[2].pos[1], 'Widget travels with its own socket');
assert(node.widgets[0].width < node.size[0], 'Control leaves room for the output label on its new row');
assert.deepEqual(node.drawSlots(), [false, false, true], 'Widget socket retains native suppression of duplicate labels');
assert.equal(node.inputs[2].isWidgetInputSlot, true, 'Widget metadata restored after drawing');
assert.equal(node.inputs[2].boundingRect[2], 15);
if (context.native) {
  const hit = context.native.getSlotLayout(node, 2, true);
  assert.equal(hit.index, 2, 'Displayed top input still has original index 2');
  assert.equal(hit.position.y, 214);
}
const saved = node.serializeFromStoreState();
assert.deepEqual(saved.inputs, before.inputs, 'Serialized input identities and native positions unchanged');
assert.deepEqual(saved.outputs, before.outputs, 'Output indices, 101 round port, links and positions unchanged');
assert.equal(node.getInputPos(2)[1], 214, 'Serialization leaves sorted canvas restored');
const snapshot = JSON.stringify(saved);
for(let i=0;i<10;i++) { node.arrange(); assert.equal(JSON.stringify(node.serializeFromStoreState()), snapshot); }
node.inputs[0]=new Slot(node.inputs[0].name,{...node.inputs[0]});
node.outputs[0]=new Slot(node.outputs[0].name,{...node.outputs[0]});
assert.equal(JSON.stringify(node.serializeFromStoreState()), snapshot,'Concrete slot replacement preserves original layout serialization');
assert.equal(node.getInputPos(0)[1],258,'Replacement socket retains its visual position after serialization');
const arrangeBeforeSave=node.arrange;
node.arrange=()=>{ throw Error('Saving must not lay out or resize a node'); };
node.serializeFromStoreState(); node.arrange=arrangeBeforeSave;
node.size[0] = 420; node.arrange();
assert.equal(node.getOutputPos(1)[0], 511, 'Output anchor follows node width');
node.pos = [200, 300]; node.arrange();
assert.equal(node.getInputPos(2)[1], 314, 'Anchor follows node move');
node.flags.collapsed = true; node.arrange();
assert.equal(node.inputs[0].pos, undefined);
assert.equal(node.getInputPos(0)[1], 285);
node.flags.collapsed = false; node.arrange();
assert.equal(node.getInputPos(2)[1], 314);

const clone = new Node(); clone.properties = clean(saved.properties); extension.nodeCreated(clone); clone.arrange();
assert.equal(clone.getInputPos(2)[1], 214, 'Saved order reloads on another instance');
assert.equal(clone.onConfigure({}), 31);
const untouched = new Node(); extension.nodeCreated(untouched); untouched.arrange();
assert.equal(untouched.getInputPos(0)[1], 214, 'Other instances retain defaults');
const menu = []; assert.equal(clone.getExtraMenuOptions(null,menu)[0].content,'Returned');
assert.deepEqual(menu.map(item=>item.content), ['Existing']);

clone.inputs.push(new Slot('new', {link: 99})); clone.arrange();
assert.equal(clone.getInputPos(3)[1], 278, 'New dynamic socket appends visually');
const oldB = clone.inputs.splice(1,1)[0]; clone.arrange();
assert.deepEqual(clean(ordered(clone,'inputs').map(e=>e.slot.name)),['prompt','a','new']);
clone.inputs.splice(1,0,oldB); clone.arrange();
assert.equal(clone.getInputPos(1)[1],238,'Reappearing dynamic socket restores preference');
const defaults = {};
applyOrder(clone, defaults);
assert.equal(clone.properties[PROPERTY],undefined);
assert.equal(clone.inputs[0].pos,undefined);
assert.equal(clone.getInputPos(0)[1],214);

const duplicates = new Node(); duplicates.outputs = [new Slot('value'), new Slot('value'),new Slot('value',{id:'stable'})];
assert.equal(new Set(entries(duplicates,'outputs').map(e=>e.key)).size,3);
const keys = entries(duplicates,'outputs').map(e=>e.key);
duplicates.outputs[2].name='renamed';
assert.equal(entries(duplicates,'outputs')[2].key,keys[2]);

const custom = new Node(); custom.inputs[0].pos = [30,90]; extension.nodeCreated(custom); custom.arrange();
applyOrder(custom, {inputs:entries(custom,'inputs').map(e=>e.key).reverse(),outputs:entries(custom,'outputs').map(e=>e.key)});
assert.deepEqual(custom.serializeFromStoreState().inputs[0].pos,[30,90]);
applyOrder(custom, {});
assert.deepEqual(custom.inputs[0].pos,[30,90]);

const nested = new Node(); const parent = new Node(); parent.subgraph = {_nodes:[nested]};
context.app.rootGraph = {_nodes:[parent]}; extension.afterConfigureGraph();
assert.notEqual(nested.arrange,Node.prototype.arrange); assert.notEqual(parent.arrange,Node.prototype.arrange);
const wrapped = nested.arrange; extension.nodeCreated(nested); assert.equal(nested.arrange,wrapped);
LiteGraph.vueNodesMode = true; node.arrange(); assert.equal(node.inputs[0].pos,undefined);
const disabledMenu=[]; node.getExtraMenuOptions(null,disabledMenu); assert.deepEqual(disabledMenu.map(item=>item.content),['Existing']);
LiteGraph.vueNodesMode = false; node.arrange(); assert.equal(node.getInputPos(2)[1],314);
console.log('PASS: layout, identity, serialization, persistence, dynamics, widgets, reset, nested graphs, mode guard');

const listeners={};
context.window={innerWidth:1200,innerHeight:800,addEventListener(name,fn,capture){listeners[name]=fn; if(name==='keydown') assert.equal(capture,true);}};
context.document={createElement(){return {style:{},setAttribute(){},offsetWidth:240,offsetHeight:28};},body:{append(element){this.hint=element;}}};
context.requestAnimationFrame=fn=>{fn();return 1;}; context.cancelAnimationFrame=()=>{};
extension.setup();
const keyboardNode=new Node(); extension.nodeCreated(keyboardNode); keyboardNode.arrange();
const canvas=context.app.canvas={canvas:{},node_over:keyboardNode,graph:keyboardNode.graph,
  selected_nodes:{1:keyboardNode},pointer:{isDown:false},linkConnector:{isConnecting:false}};
function hover(n,side,index) {
  canvas.node_over=n;canvas.graph=n.graph;
  canvas.graph_mouse=side==='inputs'?n.getInputPos(index):n.getOutputPos(index);
  n.mouseOver={inputId:side==='inputs'?index:-1,outputId:side==='outputs'?index:-1};
  listeners.pointermove({composedPath:()=>[canvas.canvas],clientX:500,clientY:400});
}
function press(key,extra={}) {
  const event={key,composedPath:()=>[],preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};
  listeners.keydown(event);return event;
}
hover(keyboardNode,'inputs',0);
assert.equal(context.document.body.hint.hidden,false);
assert.match(context.document.body.hint.textContent,/↑ \/ ↓/);
let event=press('ArrowDown'); assert(event.prevented&&event.stopped);
assert.deepEqual(clean(ordered(keyboardNode,'inputs').map(e=>e.slot.name)),['b','a','prompt']);
assert.equal(keyboardNode.mouseOver.inputId,1,'Highlight follows the socket now under the stationary pointer');
const snapshotAfterSwap=JSON.stringify(keyboardNode.properties);
press('ArrowDown',{repeat:true}); assert.equal(JSON.stringify(keyboardNode.properties),snapshotAfterSwap,'Held key does not bounce sockets back');
hover(keyboardNode,'inputs',0);press('ArrowUp');
assert.deepEqual(clean(ordered(keyboardNode,'inputs').map(e=>e.slot.name)),['a','b','prompt'],'Reverse key swaps back');
const beforeBoundary=keyboardNode.events.length;
hover(keyboardNode,'inputs',0); assert(press('ArrowUp').prevented);
assert.equal(keyboardNode.events.length,beforeBoundary,'At the top no change event is emitted');
hover(keyboardNode,'outputs',1); assert(press('ArrowDown').prevented);
assert.equal(keyboardNode.events.length,beforeBoundary,'At the bottom no change event is emitted');
press('ArrowUp');
assert.deepEqual(clean(ordered(keyboardNode,'outputs').map(e=>e.slot.name)),['round','result']);
assert.deepEqual(keyboardNode.outputs.map(p=>p.links),[[20],[21]],'Keyboard swaps retain real output links');
assert.equal(keyboardNode.outputs[1].slot_index,101);
for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true},
  {composedPath:()=>[{matches:()=>true}]},{composedPath:()=>[{isContentEditable:true}]}]) {
  assert.equal(press('ArrowUp',extra).prevented,undefined,'Editing and modified keys stay untouched');
}
assert.equal(press('ArrowLeft').prevented,undefined);
canvas.selected_nodes={}; hover(keyboardNode,'inputs',0);
assert.equal(context.document.body.hint.hidden,true);assert.equal(press('ArrowDown').prevented,undefined);
canvas.selected_nodes={1:keyboardNode};
for(const [object,key] of [[canvas,'read_only'],[canvas.pointer,'isDown'],[canvas.linkConnector,'isConnecting'],[keyboardNode.flags,'collapsed'],[LiteGraph,'vueNodesMode']]) {
  object[key]=true;assert.equal(press('ArrowDown').prevented,undefined);object[key]=false;
}
hover(keyboardNode,'inputs',0);keyboardNode.mouseOver.inputId=-1;
assert.equal(press('ArrowDown').prevented,undefined,'Only a natively highlighted port is eligible');
hover(keyboardNode,'inputs',0);canvas.graph_mouse=[999,999];keyboardNode.mouseOver.inputId=-1;
assert.equal(press('ArrowDown').prevented,undefined,'Hovering the body does not move ports');
hover(keyboardNode,'inputs',0);
listeners.pointermove({composedPath:()=>[{}],clientX:500,clientY:400});
assert.equal(context.document.body.hint.hidden,true);assert.equal(press('ArrowDown').prevented,undefined);
hover(keyboardNode,'inputs',0);listeners.blur();assert.equal(press('ArrowDown').prevented,undefined);
hover(keyboardNode,'inputs',0);listeners.pointerout({relatedTarget:null});assert.equal(press('ArrowDown').prevented,undefined);
const other=new Node();other.id=2;extension.nodeCreated(other);other.arrange();
canvas.selected_nodes={1:keyboardNode,2:other};hover(other,'inputs',0);
const firstBefore=JSON.stringify(keyboardNode.properties);press('ArrowDown');
assert.equal(JSON.stringify(keyboardNode.properties),firstBefore,'Multiple selection only changes hovered node');
assert.deepEqual(clean(ordered(other,'inputs').map(e=>e.slot.name)),['b','a','prompt']);
console.log('PASS: selected hovered ports, keyboard swaps, boundaries, tooltip, edit/drag guards and original menus');

const mixed=new Node();mixed.id=3;mixed.inputs.unshift(mixed.inputs.pop());extension.nodeCreated(mixed);mixed.arrange();
canvas.selected_nodes={3:mixed};hover(mixed,'inputs',1);
const mixedBefore=mixed.events.length;press('ArrowUp');assert.equal(mixed.events.length,mixedBefore,'Native widget position, not raw slot index, determines top');
hover(mixed,'inputs',0);press('ArrowUp');
assert.deepEqual(clean(ordered(mixed,'inputs').map(e=>e.slot.name)),['a','prompt','b']);
hover(mixed,'inputs',0);press('ArrowUp');
assert.deepEqual(clean(ordered(mixed,'inputs').map(e=>e.slot.name)),['prompt','a','b']);
assert.equal(mixed.getInputPos(0)[1],214,'Moving a widget input to the top keeps the explicit order even when equal to raw schema');
const outputsOnly=new Node();outputsOnly.id=4;extension.nodeCreated(outputsOnly);outputsOnly.arrange();
canvas.selected_nodes={4:outputsOnly};hover(outputsOnly,'outputs',1);press('ArrowUp');
assert.equal(outputsOnly.properties[PROPERTY].inputs,undefined,'Output swap does not activate custom input layout');
console.log('PASS: neighbors follow visible positions, widget inputs can reach top, opposite side remains unchanged');

const labelNode=new Node();labelNode.id=5;labelNode.inputs[0].name='absolute_path';extension.nodeCreated(labelNode);labelNode.arrange();
canvas.selected_nodes={5:labelNode};hover(labelNode,'inputs',0);
canvas.graph_mouse=[labelNode.getInputPos(0)[0]+45,labelNode.getInputPos(0)[1]];
assert.equal(labelNode.getSlotInPosition(...canvas.graph_mouse),null,'Label is outside the old socket-only hit box');
assert.equal(labelNode.getInputOnPos(canvas.graph_mouse),labelNode.inputs[0],'Native hit testing highlights this label');
listeners.pointermove({composedPath:()=>[canvas.canvas],clientX:500,clientY:400});
assert.equal(context.document.body.hint.hidden,false,'Hint follows native label hover outside socket box');
assert(press('ArrowDown').prevented,'Arrow works on native label hover');
assert.deepEqual(clean(ordered(labelNode,'inputs').map(e=>e.slot.name)),['b','absolute_path','prompt']);
canvas.graph_mouse=labelNode.getInputPos(1);labelNode.mouseOver.inputId=1;
canvas.pointer.isDown=true;listeners.pointerdown();assert.equal(context.document.body.hint.hidden,true);
canvas.pointer.isDown=false;listeners.pointerup();assert.equal(context.document.body.hint.hidden,false,'Click release refreshes hint without another mouse move');
console.log('PASS: native label hover regression and selection-release hint refresh');

const rowsNode=new Node();rowsNode.size=[400,320];
rowsNode.inputs=[new Slot('path'),new Slot('relative',{widget:{name:'relative'}}),new Slot('template',{widget:{name:'template'}})];
rowsNode.widgets=[{name:'relative',value:'docs/example.md',width:220,last_y:999,computeSize:()=>[220,20]},
  {name:'template',value:'{a}\n{b}',last_y:999,computeSize:()=>[300,80]},
  {name:'option',value:42,computeSize:()=>[300,20]}];
const originalWidgets=[...rowsNode.widgets];const originalInputs=[...rowsNode.inputs];
extension.nodeCreated(rowsNode);rowsNode.arrange();
const reverseRows=entries(rowsNode,'inputs').map(e=>e.key).reverse();
applyOrder(rowsNode,{inputs:reverseRows});
assert.deepEqual(rowsNode.widgets,originalWidgets,'Visual row order never reorders serialized widget values');
assert.deepEqual(rowsNode.inputs,originalInputs,'Input identity order stays unchanged');
for(const i of [1,2]) {
  const widget=rowsNode.widgets.find(w=>w.name===rowsNode.inputs[i].widget.name);
  assert.equal(rowsNode.getInputPos(i)[1]-rowsNode.pos[1],widget.y+10);
  assert.equal(widget.last_y,widget.y,'Mouse hit region follows moved control');
}
assert(rowsNode.getInputPos(1)[1]>=rowsNode.widgets[1].y+rowsNode.widgets[1].computedHeight+rowsNode.pos[1]);
assert(rowsNode.getInputPos(0)[1]>rowsNode.getInputPos(1)[1]);
assert(rowsNode.widgets[2].y>rowsNode.getInputPos(0)[1]-rowsNode.pos[1],'Unbound controls follow reordered input rows');
assert.equal(rowsNode.inputs[2].isWidgetInputSlot,true,'No duplicated standalone widget label');
const geometry=()=>JSON.stringify({height:rowsNode.size[1],widgets:rowsNode.widgets.map(w=>[w.y,w.width]),inputs:rowsNode.inputs.map((p,i)=>rowsNode.getInputPos(i))});
const stable=geometry();
for(let i=0;i<10;i++) {rowsNode.arrange();rowsNode.serializeFromStoreState();assert.equal(geometry(),stable,'No cumulative size or position drift');}
const savedRows=rowsNode.serializeFromStoreState();
applyOrder(rowsNode,{});assert.equal(rowsNode.widgets[0].width,220,'Reset preserves custom widget width');
rowsNode.properties=clean(savedRows.properties);rowsNode.onConfigure({});rowsNode.arrange();assert.equal(geometry(),stable,'Saved settings restore whole control rows');
assert.deepEqual(rowsNode.widgets.map(w=>w.value),['docs/example.md','{a}\n{b}',42]);
console.log('PASS: whole widget rows, multiline height, hit regions, values, restore and stable repeated layout');

// Note's flexible editor fills the native body. Old layout records include empty
// port arrays, which must not activate the custom input row padding.
for(const outputCount of [0,1]) {
  const note=new Node();note.inputs=[];note.outputs=outputCount?[new Slot('text')]:[];
  note.size=[400,320];
  note.widgets=[{name:'text',value:'Note content',computeLayoutSize:()=>({minHeight:60,maxHeight:Infinity})}];
  note.properties[PROPERTY]={version:1,inputs:[],outputs:entries(note,'outputs').map(e=>e.key)};
  extension.nodeCreated(note);
  for(let i=0;i<100;i++) {
    note.arrange();note.serializeFromStoreState();
    assert.equal(note.size[1],320,'Empty input ordering must not grow a flexible Note on every layout');
  }
  note.size[1]=160;
  for(let i=0;i<10;i++) note.arrange();
  assert.equal(note.size[1],160,'Manually shrinking an affected Note remains stable');
  assert.equal(note.widgets[0].value,'Note content');
}
console.log('PASS: flexible Notes with saved empty orders retain height across repeated layout and manual resize');

class Bounds extends Array {
  containsXy(x,y) {return x>=this[0]&&x<this[0]+this[2]&&y>=this[1]&&y<this[1]+this[3];}
}
class BoundarySlot {
  constructor(id,name,input) {Object.assign(this,{id,name,input,pos:[0,0],boundingRect:new Bounds(0,0,0,20),linkIds:[id+'-link']});}
  measure(){return [this.name.length*7+20,20];}
  arrange([x,y,w,h]) {this.boundingRect.splice(0,4,this.input?x-w:x,y,w,h);this.pos=[x+(this.input?-h/2:h/2),y+h/2];}
  onPointerMove(e){this.isPointerOver=this.boundingRect.containsXy(e.canvasX,e.canvasY);}
}
class Boundary {
  static minWidth=100;static roundedRadius=14;
  constructor(graph,side){this.subgraph=graph;this.side=side;this.boundingRect=new Bounds(side==='inputs'?0:600,0,128,108);this.emptySlot=new BoundarySlot('empty','',side==='inputs');}
  get slots(){return this.subgraph[this.side];}
  get allSlots(){return [...this.slots,this.emptySlot];}
  get slotAnchorX(){return this.boundingRect[0]+(this.side==='inputs'?this.boundingRect[2]-14:14);}
  get size(){return this.boundingRect.slice(2);}
  set size(value){this.boundingRect[2]=value[0];this.boundingRect[3]=value[1];}
  arrange(){let y=this.boundingRect[1]+14,w=100;for(const s of this.allSlots){const [width,height]=s.measure();s.arrange([this.slotAnchorX,y,width,height]);y+=height;w=Math.max(w,width);}this.size=[w+28,y-this.boundingRect[1]+14];}
  getSlotInPosition(x,y){return this.allSlots.find(s=>s.boundingRect.containsXy(x,y));}
  onPointerEnter(){this.isPointerOver=true;}
  onPointerLeave(){this.isPointerOver=false;for(const slot of this.slots)slot.isPointerOver=false;}
  onPointerMove(e){for(const slot of this.allSlots)slot.onPointerMove(e);}
}
if(process.argv[2]) {
  const source=fs.readFileSync(process.argv[2],'utf8');
  const base=source.slice(source.indexOf('class SubgraphIONodeBase'),source.indexOf('SubgraphInputNode=class'));
  const slice=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
  const Native=vm.runInNewContext('class Native {'+
    slice(base,'arrange(){','draw(e,t,n,r){')+
    slice(base,'getSlotInPosition(','handleSlotDoubleClick(')+
    slice(base,'onPointerMove(','onPointerEnter(){')+'};Native',
    {SubgraphIONodeBase:Boundary,zr:{SubgraphIoNode:1,Nothing:0,SubgraphIoSlot:2}});
  for(const name of ['arrange','getSlotInPosition','onPointerMove'])Boundary.prototype[name]=Native.prototype[name];
  for(const [name,next,input] of [['SubgraphInput=class','EmptySubgraphInput=class',true],['SubgraphOutput=class','EmptySubgraphOutput=class',false]]) {
    const text=source.slice(source.indexOf(name),source.indexOf(next));
    const SlotNative=vm.runInNewContext('class Native {'+slice(text,'arrange(e){','isValidTarget(')+'};Native');
    const old=BoundarySlot.prototype.arrange;
    BoundarySlot.prototype.arrange=function(...args){return this.input===input?SlotNative.prototype.arrange.apply(this,args):old.apply(this,args);};
  }
  console.log('Using installed native subgraph boundary layout, input/output anchors and label hit tests');
}
const root={_nodes:[],beforeChange(){},change(){},afterChange(){}};
function subgraph() {
  const g={_nodes:[],rootGraph:root,extra:{other:'kept'},events:[],setDirtyCanvas(){},
    beforeChange(){this.events.push('before');},change(){this.events.push('change');},afterChange(){this.events.push('after');}};
  for(const side of ['inputs','outputs'])g[side]=['one','two','three'].map((n,i)=>new BoundarySlot(side+i,n,side==='inputs'));
  g.inputNode=new Boundary(g,'inputs');g.outputNode=new Boundary(g,'outputs');
  return g;
}
function host(g,id) {
  const n=new Node();n.id=id;n.graph=root;n.subgraph=g;n.widgets=[];
  for(const side of ['inputs','outputs'])n[side]=g[side].map((s,i)=>new Slot(s.name,
    side==='inputs'?{_subgraphSlot:s,link:100+i}:{links:[200+i]}));
  extension.nodeCreated(n);n.arrange();return n;
}
const sg=subgraph(), h1=host(sg,101),h2=host(sg,102);
root._nodes=[h1,{subgraph:{_nodes:[h2]}}];context.app.rootGraph=root;
extension.afterConfigureGraph();
const topology=()=>JSON.stringify({inputs:sg.inputs.map(s=>[s.id,s.linkIds]),outputs:sg.outputs.map(s=>[s.id,s.linkIds]),
  hosts:[h1,h2].map(h=>[h.inputs.map(s=>[s.name,s.link]),h.outputs.map(s=>[s.name,s.links])])});
const originalTopology=topology();
const visible=slots=>[...slots].sort((a,b)=>a.pos[1]-b.pos[1]).map(s=>s.id);
function hoverBoundary(panel,index){
  canvas.graph=panel.subgraph;canvas.selected_nodes={};canvas.node_over=h1;
  const s=index==='empty'?panel.emptySlot:panel.slots[index];
  canvas.graph_mouse=[s.boundingRect[0]+s.boundingRect[2]/2,s.pos[1]];
  listeners.pointermove({composedPath:()=>[canvas.canvas],clientX:500,clientY:400});
}
for(const side of ['inputs','outputs']) {
  const panel=side==='inputs'?sg.inputNode:sg.outputNode;
  hoverBoundary(panel,1);assert.equal(context.document.body.hint.hidden,false);
  assert.match(context.document.body.hint.textContent,/子图内外同步/);
  const before=sg.events.length;assert(press('ArrowUp').prevented);
  assert.deepEqual(sg.events.slice(before),['before','change','after'],'Boundary edit has one undo transaction');
  assert.deepEqual(visible(sg[side]),[side+'1',side+'0',side+'2']);
  for(const h of [h1,h2])assert.deepEqual(clean(ordered(h,side).map(e=>e.slot.name)),['two','one','three'],'All hosts, including nested instances, follow internal order');
  assert.equal(panel.getSlotInPosition(...canvas.graph_mouse),sg[side][0],'Hit target follows the row now under the pointer');
  assert.equal(sg[side][0].isPointerOver,true,'Native hover updates without moving the pointer');
  const key=side==='inputs'?'getInputPos':'getOutputPos';
  assert(h2[key](1)[1]<h2[key](0)[1]);
  const emptyY=panel.emptySlot.pos[1];
  hoverBoundary(panel,'empty');assert.equal(context.document.body.hint.hidden,true);assert.equal(press('ArrowUp').prevented,undefined);
  assert.equal(panel.emptySlot.pos[1],emptyY,'Grey add socket stays last');
  canvas.selected_nodes={101:h1};hover(h1,side,2);assert(press('ArrowUp').prevented);
  assert.deepEqual(visible(sg[side]),[side+'1',side+'2',side+'0'],'External arrow updates the boundary');
  assert(h2[key](2)[1]<h2[key](0)[1],'Sibling instance updates after external arrow');
  assert.equal(topology(),originalTopology,'Link indices and raw slot arrays are unchanged in both directions');
}
assert.equal(sg.extra.other,'kept');
const savedExtra=clean(sg.extra), savedH1=clean(h1.properties);
const restored=subgraph();restored.extra=clean(savedExtra);
const fresh=host(restored,103);fresh.properties=clean(savedH1);
root._nodes.push(fresh);extension.afterConfigureGraph();
for(const side of ['inputs','outputs'])assert.deepEqual(visible(restored[side]),[side+'1',side+'2',side+'0'],'Shared order survives save/reload');
const added=host(sg,104);root._nodes.push(added);
assert.deepEqual(clean(ordered(added,'outputs').map(e=>e.slot.name)),['two','three','one'],'A new instance uses the shared order');
sg.outputs[1].name='renamed';h1.outputs[1].name='renamed';h2.outputs[1].name='renamed';
h1.arrange();sg.outputNode.arrange();
assert.equal(ordered(h1,'outputs')[0].slot.name,'renamed','Boundary UUID keeps order across rename');
const originalSize=clean(sg.outputNode.size);
for(let i=0;i<100;i++){sg.outputNode.arrange();h1.arrange();h1.serializeFromStoreState();}
assert.deepEqual(clean(sg.outputNode.size),originalSize,'Boundary height is stable over repeated layout');
assert.deepEqual(visible(sg.outputs),['outputs1','outputs2','outputs0']);
sg.outputs.push(new BoundarySlot('outputs3','new',false));h1.outputs.push(new Slot('new',{links:[]}));
sg.outputNode.arrange();h1.arrange();
assert.deepEqual(visible(sg.outputs),['outputs1','outputs2','outputs0','outputs3']);
assert.deepEqual(clean(ordered(h1,'outputs').map(e=>e.slot.name)),['renamed','three','one','new']);
sg.outputs.splice(1,1);h1.outputs.splice(1,1);sg.outputNode.arrange();h1.arrange();
assert.deepEqual(visible(sg.outputs),['outputs2','outputs0','outputs3'],'Removed slot is skipped without reassigning identities');
for(const [obj,key] of [[canvas,'read_only'],[canvas.pointer,'isDown'],[canvas.linkConnector,'isConnecting'],[LiteGraph,'vueNodesMode']]) {
  hoverBoundary(sg.inputNode,0);obj[key]=true;assert.equal(press('ArrowUp').prevented,undefined);obj[key]=false;
}
hoverBoundary(sg.inputNode,1);
assert.equal(press('ArrowDown',{composedPath:()=>[{isContentEditable:true}]}).prevented,undefined);
assert.equal(press('ArrowDown',{ctrlKey:true}).prevented,undefined);
const single=subgraph();single.inputs.length=1;single.inputNode.arrange();hoverBoundary(single.inputNode,0);
assert.equal(press('ArrowDown').prevented,undefined,'A single boundary port has no neighbor');
// Native undo restores the serialized shared record, then calls afterConfigureGraph.
delete restored.extra[PROPERTY];fresh.properties={};extension.afterConfigureGraph();
assert.deepEqual(visible(restored.outputs),['outputs0','outputs1','outputs2']);
restored.extra=clean(savedExtra);extension.afterConfigureGraph();
assert.deepEqual(visible(restored.outputs),['outputs1','outputs2','outputs0']);
const resetHost=host(subgraph(),105);root._nodes.push(resetHost);
applyOrder(resetHost,{outputs:entries(resetHost,'outputs').map(e=>e.key).reverse()});
assert.equal(resetHost.subgraph.extra[PROPERTY].inputs,null,'Output-only swap does not activate input widget layout');
applyOrder(resetHost,{});
assert.equal(resetHost.outputs[0].pos,undefined,'Reset restores native positions');
console.log('PASS: boundary arrows without selection, bidirectional shared order, nested/new instances, stable IDs, save/undo, grey socket and unchanged connections');

const portExtension=extension;
context.registerMenuItem=()=>{}; // Menu registration is covered by test_menu_order.cjs.
vm.runInContext(fs.readFileSync(path.join(__dirname,'../graph_layout.js'),'utf8')
  .replace(/^import .*;\r?$/gm,'').replace('const PROPERTY = "liuxinyu_port_order";','')+
  '\nglobalThis.layoutHelpers = {checkpoint,apply,restore};',context);
extension=portExtension;
const layout=context.layoutHelpers;
const trialGraph=subgraph(),trialHost=host(trialGraph,201),trialPeer=host(trialGraph,202);
root._nodes=[trialHost,trialPeer];
const trialState=()=>JSON.stringify({extra:trialGraph.extra,hosts:[trialHost,trialPeer].map(h=>({properties:h.properties,size:h.size,pos:h.pos,
  inputY:h.inputs.map((s,i)=>h.getInputPos(i)[1]),outputY:h.outputs.map((s,i)=>h.getOutputPos(i)[1])})),
  inputs:visible(trialGraph.inputs),outputs:visible(trialGraph.outputs)});
extension.afterConfigureGraph();
const candidate=[{id:'201',pos:[800,200],inputs:[2,0,1],outputs:[1,2,0]}];
for(const initial of [null,{outputs:entries(trialHost,'outputs').map(e=>e.key).reverse()}]) {
  if(initial)applyOrder(trialHost,initial);
  const saved=layout.checkpoint([trialHost]),before=trialState();
  assert.equal(saved.length,2,'Trial checkpoints include sibling instances affected by shared order');
  layout.apply([trialHost],candidate);
  assert.deepEqual(visible(trialGraph.inputs),['inputs2','inputs0','inputs1']);
  assert(trialPeer.getOutputPos(1)[1]<trialPeer.getOutputPos(0)[1]);
  layout.restore(saved);
  assert.equal(trialState(),before,'Trial rollback restores both sides and sibling dimensions, including prior shared order');
}
context.BoundaryFixture=Boundary;
vm.runInContext('installBoundaryLayout(BoundaryFixture.prototype)',context);
const later=subgraph();later.extra[PROPERTY]={version:1,outputs:entries(later,'outputs').map(e=>e.key).reverse()};
later.outputNode.arrange();
assert.deepEqual(visible(later.outputs),['outputs2','outputs1','outputs0'],'Prototype hook covers boundaries created after setup');
console.log('PASS: automatic layout shared-order trial/rollback and newly created boundary prototype hook');

// Exercise the shared multiline extension against actual native layout and the
// port-order wrapper together; either extension may be registered first.
vm.runInContext('(function(){'+fs.readFileSync(path.join(__dirname,'../multiline_collapse.js'),'utf8')
  .replace(/^import .*;\r?$/gm,'')+'})()',context);
const collapseExtension=extension;extension=portExtension;
class MultilineNode extends Node {
  constructor(type) {
    super();this.comfyClass=type;this.size=[360,500];
    this.inputs=[new Slot('check'),new Slot('prompt',{widget:{name:'prompt'}}),new Slot('system',{widget:{name:'system'}})];
    this.widgets=['prompt','system'].map(name=>({name,type:'customtext',value:name+' preserved',element:{tagName:'TEXTAREA'},
      computeLayoutSize(){return {minHeight:160,maxHeight:160,minWidth:0};}}));
    this.widgets.push({name:'option',value:3,computeSize(){return [100,20];}});
  }
  isInputConnected(i){return this.inputs[i]?.link!=null;}
  isWidgetVisible(w){return !w.hidden;}
  getLayoutWidgets(){return this.widgets.filter(w=>!w.hidden);}
  getWidgetFromSlot(input){return this.widgets.find(w=>w.name===input?.widget?.name);}
  computeSize(){return [360,54+this.getLayoutWidgets().reduce((h,w)=>h+(w.computeSize?w.computeSize()[1]:w.computeLayoutSize().minHeight)+4,0)];}
}
if(process.argv[2]) {
  const source=fs.readFileSync(process.argv[2],'utf8'),start=source.indexOf('computeSize(e){');
  context.Jl={_measureText:text=>String(text).length*7};
  Object.assign(LiteGraph,{NODE_TEXT_SIZE:14,NODE_WIDTH:140});
  Object.assign(context.Zc,{arrowMargin:3,arrowWidth:8,minValueWidth:20});
  vm.runInContext('globalThis.NativeSize = class {'+source.slice(start,source.indexOf('inResizeCorner(',start))+'}',context);
  MultilineNode.prototype.computeSize=context.NativeSize.prototype.computeSize;
}
(async()=>{
  for(const first of ['port','collapse']) {
    const n=new MultilineNode('LiuxinyuTextFromTemplate');
    n.size=[400,376];
    n.inputs=[new Slot('strings.t1'),new Slot('parameters',{link:4}),new Slot('template',{widget:{name:'template'}})];
    n.outputs=[new Slot('strings')];
    n.widgets=[{name:'template',type:'customtext',value:'preserved',element:{tagName:'TEXTAREA'},
      computeLayoutSize(){return {minHeight:50,minWidth:0};}}];
    // Native configure has assigned public slots, but the first measure pass has
    // not yet rebuilt the concrete cache used by native arrange().
    Object.defineProperty(n,'_concreteInputs',{value:[],writable:true});
    Object.defineProperty(n,'_concreteOutputs',{value:[],writable:true});
    n._setConcreteSlots=function(){this._concreteInputs=this.inputs;this._concreteOutputs=this.outputs;};
    n.properties[PROPERTY]={version:1,inputs:[entries(n,'inputs')[1].key,entries(n,'inputs')[0].key,entries(n,'inputs')[2].key],outputs:entries(n,'outputs').map(e=>e.key)};
    for(const ext of first==='port'?[portExtension,collapseExtension]:[collapseExtension,portExtension])ext.nodeCreated(n);
    await Promise.resolve();
    for(let i=0;i<4;i++){
      n._concreteInputs=[];n._concreteOutputs=[];
      n.onConfigure();await Promise.resolve();n.arrange();
      assert.equal(n.size[1],376,'Configure with an empty native slot cache must retain the saved height');
      assert.equal(n.widgets[0].value,'preserved');
      assert(n.widgets[0].y+n.widgets[0].computedHeight<=376,'Editor remains inside the saved node bounds');
    }
  }
  console.log('PASS: sorted flexible textarea retains saved height before native slot caches are rebuilt');
})().catch(error=>{console.error(error);process.exitCode=1;});
(async()=>{
  for(const first of ['port','collapse'])for(const type of ['LiuxinyuTextFromTemplate','LiuxinyuSaveTextFile','llm_remote_reply','LLMHarnessBooleanReturn','subgraph']) {
    const n=new MultilineNode(type);
    if(type==='subgraph'){
      n.subgraph=subgraph();n.subgraph.inputs=n.inputs.map((s,i)=>new BoundarySlot('shared-'+i,s.name,true));
      n.inputs.forEach((s,i)=>{s._subgraphSlot=n.subgraph.inputs[i];s._widget=n.getWidgetFromSlot(s);});
    }
    for(const ext of first==='port'?[portExtension,collapseExtension]:[collapseExtension,portExtension])ext.nodeCreated(n);
    await Promise.resolve();
    n.setSize([360,n.computeSize()[1]]);n.arrange();const expanded=n.size[1];
    const originalValues=n.widgets.map(w=>w.value);
    n.inputs[1].link=40;n.onConnectionsChange();await Promise.resolve();
    assert(n.size[1]<expanded,'Connecting one editor removes its height');
    assert(n.getInputPos(2)[1]-n.getInputPos(1)[1]<=24,'Collapsed editor leaves only a compact socket row');
    assert.equal(n.widgets[1].hidden,false,'Unconnected editor remains visible');
    const oneConnected=n.size[1];n.inputs[2].link=41;n.onConnectionsChange();await Promise.resolve();
    assert(n.size[1]<oneConnected,'Second editor independently releases height');
    const compact=n.size[1],drawn=[];n.drawSlots({save(){},restore(){},fillText(...args){drawn.push(args);}});
    assert.deepEqual(drawn.map(v=>v[0]),['prompt','system'],'Hidden editors retain their port labels');
    assert(drawn.every(v=>v[2]<compact),'Port labels remain inside the compact node');
    applyOrder(n,{inputs:entries(n,'inputs').map(e=>e.key).reverse()});
    const sorted=n.size[1];
    for(let i=0;i<100;i++){n.arrange();n.serializeFromStoreState();assert.equal(n.size[1],sorted,'Connected, sorted layouts do not grow repeatedly');}
    assert(n.getInputPos(2)[1]<n.getInputPos(1)[1]);
    assert.equal(n.inputs[1].link,40);assert.equal(n.inputs[2].link,41);
    assert.deepEqual(n.widgets.map(w=>w.value),originalValues);
    n.inputs[1].link=null;n.onConnectionsChange();await Promise.resolve();
    assert(n.size[1]>sorted,'Unplug restores usable editing height under saved port ordering');
    assert.equal(n.widgets[0].hidden,false);assert.equal(n.widgets[1].hidden,true);
    const reopened=n.size[1];for(let i=0;i<20;i++){n.arrange();assert.equal(n.size[1],reopened);}
  }
  console.log('PASS: native multiline collapse + port sorting in both extension orders, harness/subgraph widgets, labels, stable sizes and values');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Actual compound text blocks: header + editor + paired output, with all three
// extensions installed. Run against the native methods above when supplied.
context.ComfyWidgets={STRING(node,name,[,options]){
  const widget={name,type:'customtext',value:options.default,options:{},element:{tagName:'TEXTAREA'},
    computeLayoutSize(){return {minHeight:this.options.getMinHeight(),maxHeight:this.options.getMaxHeight(),minWidth:0};}};
  node.widgets.push(widget);return {widget};
}};
vm.runInContext('(function(){'+fs.readFileSync(path.join(__dirname,'../dynamic_multiline.js'),'utf8')
  .replace(/^\uFEFF/,'').replace(/^import .*;\r?$/gm,'')+'})()',context);
const dynamicExtension=extension;extension=portExtension;
class BlockNode extends MultilineNode {
  constructor(){super('LiuxinyuDynamicMultilineText');this.inputs=[];this.outputs=[];
    this.widgets=[{name:'blocks_json',value:'["first","second","third","fourth"]'}];}
  addInput(name,type,options){this.inputs.push(new Slot(name,{type,link:null,...options}));}
  addOutput(name,type){this.outputs.push(new Slot(name,{type,links:[]}));}
  removeInput(i){this.inputs.splice(i,1);}
  removeOutput(i){this.outputs.splice(i,1);}
  addCustomWidget(w){this.widgets.push(w);return w;}
  addWidget(type,name,value,callback,options){return this.addCustomWidget({type,name,value,callback,options,computeSize:()=>[0,20]});}
  removeWidget(w){this.widgets.splice(this.widgets.indexOf(w),1);}
  getWidgetFromSlot(slot){return slot._widget||super.getWidgetFromSlot(slot);}
}
const editor=(n,i)=>n.widgets.find(w=>w.name===`texts.text${i+1}`);
const blockOrder=n=>n.inputs.map((s,i)=>i).sort((a,b)=>n.inputs[a]._widget.y-n.inputs[b]._widget.y);
function assertBlocks(n){
  for(const [i,input] of n.inputs.entries()){
    const header=input._widget,text=editor(n,i);
    assert.equal(text.width,undefined,'Adjacent output rows must not narrow a text editor');
    assert.equal(n.getInputPos(i)[1]-n.pos[1],header.y+10,'Socket stays on its own header');
    if(!text.hidden)assert.equal(text.y,header.y+header.computedHeight,'Editor immediately follows its header');
    if(!n.properties[PROPERTY]?.outputs)assert.equal(n.getOutputPos(i)[1]-n.pos[1],header.y+10,'Unsorted output follows its text block');
    const hit=n.getInputOnPos(n.getInputPos(i));assert.equal(hit,input,'Socket hit region follows the moved header');
  }
  const button=n.widgets.at(-1);
  assert(button.y>=Math.max(...n.inputs.map((s,i)=>editor(n,i).hidden?s._widget.y+s._widget.computedHeight:editor(n,i).y+editor(n,i).computedHeight)),
    'Add button stays below all whole blocks');
}
(async()=>{
  const orders=[[dynamicExtension,collapseExtension,portExtension],[portExtension,dynamicExtension,collapseExtension],
    [collapseExtension,portExtension,dynamicExtension],[collapseExtension,dynamicExtension,portExtension],
    [portExtension,collapseExtension,dynamicExtension],[dynamicExtension,portExtension,collapseExtension]];
  for(const sequence of orders){
    const n=new BlockNode();for(const ext of sequence)ext.nodeCreated(n);await Promise.resolve();n.arrange();
    const originals=n.inputs.slice(),outputs=n.outputs.slice(),values=n.widgets[0].value;
    const ys=n.outputs.map((s,i)=>n.getOutputPos(i)[1]);
    const outputKeys=entries(n,'outputs').map(e=>e.key);
    applyOrder(n,{outputs:[outputKeys[1],outputKeys[0],...outputKeys.slice(2)]});
    assert.deepEqual(n.outputs.map((s,i)=>n.getOutputPos(i)[1]),[ys[1],ys[0],ys[2],ys[3]],'Output-only swap preserves the other native block anchors');
    const keys=entries(n,'inputs').map(e=>e.key);
    applyOrder(n,{inputs:[keys[1],keys[0],keys[2],keys[3]]});
    assert.deepEqual(blockOrder(n),[1,0,2,3]);assertBlocks(n);
    n.inputs[0].link=50;n.inputs[2].link=52;n.onConnectionsChange();await Promise.resolve();assertBlocks(n);
    assert.equal(editor(n,0).hidden,true);assert.equal(editor(n,1).hidden,false);
    applyOrder(n,{inputs:[keys[1],keys[0],keys[2],keys[3]],outputs:[outputKeys[2],outputKeys[0],outputKeys[1],outputKeys[3]]});
    const outputOrder=()=>n.outputs.map((s,i)=>i).sort((a,b)=>n.getOutputPos(a)[1]-n.getOutputPos(b)[1]);
    assert.deepEqual(outputOrder(),[2,0,1,3]);assertBlocks(n);
    const size=n.size[1];for(let i=0;i<50;i++){n.arrange();n.serializeFromStoreState();assertBlocks(n);assert.equal(n.size[1],size);}
    n.inputs[0].link=null;n.onConnectionsChange();await Promise.resolve();assertBlocks(n);
    assert.deepEqual(n.inputs,originals);assert.deepEqual(n.outputs,outputs);assert.equal(n.widgets[0].value,values);
    n.widgets.at(-1).callback();await Promise.resolve();assert.equal(n.inputs.length,5);assertBlocks(n);
    const savedOrder=clean(n.properties[PROPERTY]),stored=n.widgets[0].value;
    const restored=new BlockNode();for(const ext of sequence)ext.nodeCreated(restored);await Promise.resolve();
    restored.properties[PROPERTY]=savedOrder;restored.widgets[0].value=stored;restored.onConfigure();await Promise.resolve();restored.arrange();
    assert.deepEqual(blockOrder(restored),[1,0,2,3,4]);assertBlocks(restored);
    assert.deepEqual(restored.outputs.map((s,i)=>i).sort((a,b)=>restored.getOutputPos(a)[1]-restored.getOutputPos(b)[1]),[2,0,1,3,4],
      'Independent output order survives saving and rebuilding text blocks');
    assert.equal(restored.widgets[0].value,stored);
  }
  console.log('PASS: real dynamic text + collapse + port order in six registration orders; compound rows, output anchors, connections, add, reload and stable height');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Use the actual picker extension; opening OS dialogs is not part of layout tests.
vm.runInContext('(function(){'+fs.readFileSync(path.join(__dirname,'../folder_picker.js'),'utf8')
  .replace(/^import .*;\r?$/gm,'')
  .replace(/const previewErrorBridge = import\([\s\S]*?\nconst SAVE_IMAGE_NODE/, 'const previewErrorBridge = Promise.resolve(null);\nconst SAVE_IMAGE_NODE')+
  ';globalThis.pickerTesting={setupImageBatchPicker};})()',context);
const pickerExtension=extension;extension=portExtension;
(async()=>{
  const cases=[['SaveImageToAbsolutePath','folder'],['LiuxinyuSaveTextFile','folder'],['LoadDirectory','path'],['MatchPath','directory'],['LiuxinyuLoadTextFile','path']];
  for(const [type,name] of cases)for(const sequence of [[pickerExtension,portExtension],[portExtension,pickerExtension]]){
    const n=new BlockNode();n.comfyClass=type;n.outputs=[];
    n.inputs=[new Slot('images'),...[name,'filename','overwrite'].map(name=>new Slot(name,{widget:{name}}))];
    n.widgets=[name,'filename','overwrite'].map(name=>({name,value:name+' value',computeSize:()=>[200,20]}));
    for(const ext of sequence)await ext.nodeCreated(n);
    n.arrange();const folder=n.widgets.find(w=>w.name===name),button=n.widgets.find(w=>w.type==='button');
    const before=n.serializeFromStoreState(),refs=n.widgets.slice();
    const keys=entries(n,'inputs').map(e=>e.key);
    applyOrder(n,{inputs:[keys[1],keys[0],keys[2],keys[3]]});
    assert.equal(button.y,folder.y+folder.computedHeight,'Folder picker stays directly below its folder input after moving the IMAGE port');
    assert(n.getInputPos(0)[1]-n.pos[1]>=button.y+button.computedHeight,'The image socket moves below the complete folder row');
    for(const order of [keys.slice().reverse(),[keys[1],keys[0],keys[2],keys[3]]]){
      applyOrder(n,{inputs:order});n.setSize([500,n.size[1]]);
      const size=n.size.slice();
      for(let i=0;i<25;i++){
        n.arrange();n.serializeFromStoreState();
        assert.equal(button.y,folder.y+folder.computedHeight);
        assert.deepEqual(n.size,size);
      }
    }
    assert.deepEqual(n.widgets,refs,'Controls are never reordered for serialization');
    applyOrder(n,{});assert.deepEqual(n.serializeFromStoreState(),before,'Reset returns to native slots without touching values');
  }
  console.log('PASS: actual folder/file pickers follow their inputs; registration order, resize, repeat, reset and serialization');
})().catch(error=>{console.error(error);process.exitCode=1;});

vm.runInContext('(function(){'+fs.readFileSync(path.join(__dirname,'../key_value_pairs.js'),'utf8')
  .replace(/^import .*;\r?$/gm,'')+'})()',context);
const keyExtension=extension;extension=portExtension;
class KeyNode extends Node {}
keyExtension.beforeRegisterNodeDef(KeyNode,{name:'LiuxinyuBuildKeyValuePairs'});
for(const sequence of [[keyExtension,portExtension],[portExtension,keyExtension]]){
  const n=new KeyNode();n.comfyClass='LiuxinyuBuildKeyValuePairs';
  n.inputs=[new Slot('value'),new Slot('key',{widget:{name:'key'}})];n.outputs=[new Slot('dictionary')];
  n.widgets=[{name:'key',value:'test',computeSize:()=>[300,20]}];
  for(const ext of sequence)ext.nodeCreated(n);
  n.arrange();const oldTop=n.getInputPos(1)[1];
  applyOrder(n,{inputs:entries(n,'inputs').map(e=>e.key)});
  assert.equal(n.getInputPos(0)[1],oldTop,'The value actually moves into the former top key row');
  assert(n.getInputPos(1)[1]>n.getInputPos(0)[1]);
}
console.log('PASS: custom key-first widget layout exchanges rows without introducing blank space above');

{
  const n=new Node();n.outputs=[];n.inputs=[new Slot('a',{widget:{name:'a'}}),new Slot('b',{widget:{name:'b'}})];
  const control=name=>({name,computeSize:()=>[200,20]});
  const a=control('a'),aux=control('auxiliary'),b=control('b');a.linkedWidgets=[aux];
  n.widgets=[a,aux,b];portExtension.nodeCreated(n);n.arrange();
  applyOrder(n,{inputs:entries(n,'inputs').map(e=>e.key).reverse()});
  assert.equal(aux.y,a.y+a.computedHeight,'Native linked auxiliary control travels with owner');
  assert.equal(context.inputWidgetGroup(n,n.inputs[0]).length,2);
  n.inputs.push(new Slot('auxiliary',{widget:{name:'auxiliary'}}));n.arrange();
  assert.equal(context.inputWidgetGroup(n,n.inputs[0]).length,1,'An auxiliary with its own input can be moved independently');
}

{
  const n=new BlockNode();n.comfyClass='LoadImageBatchFromPath';n.outputs=[];
  n.inputs=['path','target_width','target_height'].map(name=>new Slot(name,{widget:{name}}));
  n.widgets=n.inputs.map(s=>({name:s.name,value:s.name,computeSize:()=>[300,20]}));
  context.pickerTesting.setupImageBatchPicker(n);portExtension.nodeCreated(n);n.arrange();
  const pathWidget=n.widgets[0],buttons=n.widgets.filter(w=>w.type==='button');
  applyOrder(n,{inputs:entries(n,'inputs').map(e=>e.key).reverse()});
  assert.equal(buttons[0].y,pathWidget.y+pathWidget.computedHeight);
  assert.equal(buttons[1].y,buttons[0].y+buttons[0].computedHeight,'Both batch path picker buttons travel together');
}

{
  // Output-only swaps change label widths, though they occupy the same rows.
  const n=new Node();n.inputs=[];n.widgets_start_y=4;
  n.widgets=[{name:'custom',computeSize:()=>[300,20]}];
  n.outputs=[new Slot('x'),new Slot('A much longer output label')];
  portExtension.nodeCreated(n);n.arrange();const keys=entries(n,'outputs').map(e=>e.key);
  applyOrder(n,{outputs:keys});const narrowLabelWidth=n.widgets[0].width;
  assert(narrowLabelWidth>80,'The following label only touches control padding and must not shrink it');
  applyOrder(n,{outputs:keys.slice().reverse()});
  assert(n.widgets[0].width<narrowLabelWidth,'Output-only swap recalculates space for the new label');
  applyOrder(n,{});assert.equal(n.widgets[0].width,undefined,'Reset restores native width');
}
