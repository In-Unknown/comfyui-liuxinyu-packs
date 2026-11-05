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
    this.widgets.forEach(w => {
      w.y=height;
      w.computedHeight=w.computeLayoutSize ? Math.max(w.computeLayoutSize(this).minHeight,this.size[1]-height) : (w.computeSize?.()[1] ?? 20)+4;
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
