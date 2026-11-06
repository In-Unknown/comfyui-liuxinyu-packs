const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console, Uint8ClampedArray });
vm.runInContext(fs.readFileSync(path.join(root, 'canvas_background_layout.js'), 'utf8').replace(/export /g, '') +
  ';globalThis.math={squareLayout,mosaicLayout,affineLayout,validLayout,mergeable,createHierarchy,positionSeed,regionFamily,regionChildren,separationScore,electricalBlock};', context);
const math = context.math;

// Independent geometry checks, including all adjoining copies of the repeat period.
function check(layout, ratios) {
  assert(math.validLayout(layout, ratios));
  assert.deepEqual([...new Set(layout.tiles.map(t => t.image))].sort((a,b) => a-b), ratios.map((_,i) => i));
  const close = (a,b) => Math.abs(a-b) < 1e-9;
  let area = 0;
  for (const a of layout.tiles) {
    assert(Math.abs(a.width / a.height / ratios[a.image] - 1) < 1e-7);
    area += a.width*a.height;
    for (let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(const b of layout.tiles) {
      if(!dx&&!dy&&a===b) continue;
      const x=b.x+dx*layout.width,y=b.y+dy*layout.height;
      const overlapX=Math.min(a.x+a.width,x+b.width)-Math.max(a.x,x);
      const overlapY=Math.min(a.y+a.height,y+b.height)-Math.max(a.y,y);
      assert(!(overlapX>1e-7&&overlapY>1e-7),'Repeated tiles must not overlap');
      const vertical=close(a.x,x)&&close(a.width,b.width)&&(close(a.y+a.height,y)||close(y+b.height,a.y));
      const horizontal=close(a.y,y)&&close(a.height,b.height)&&(close(a.x+a.width,x)||close(x+b.width,a.x));
      assert(!vertical&&!horizontal,`No two tiles may form a rectangle, including repeat seams: ${JSON.stringify({a,b,ratios})}`);
    }
  }
  assert(Math.abs(area-layout.width*layout.height)<1e-6*Math.max(1,area),'No uncovered area');
}

const cases = [[16/9],[1,1],[2,.5],[16/9,3/4,1,.25],[.001,1000,1],Array(22).fill(1),Array.from({length:50},(_,i)=>(i+1)/10)];
let random=6381;
for(let trial=0;trial<30;trial++) {
  cases.push(Array.from({length:2+trial%10},()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return 10**(random/2**32*4-2);}));
}
for(const [seed,ratios] of cases.entries()) {
  const layout=math.mosaicLayout(ratios,seed+1);
  check(layout,ratios);
  check(math.affineLayout(ratios,ratios.map((_,i)=>i)),ratios);
  assert.equal(JSON.stringify(layout),JSON.stringify(math.mosaicLayout(ratios,seed+1)),'Reloads preserve layout');
}
assert.equal(new Set(math.squareLayout().map(t=>t.width)).size,21);
assert.throws(()=>math.mosaicLayout([0,1],1),/尺寸/);
assert.throws(()=>math.mosaicLayout([],1),/尺寸/);
assert.throws(()=>math.mosaicLayout([1e-20,1e20],1),/数值精度/,'Reject numerically degenerate fallback geometry');

function flattenRegion(hierarchy, column, row) {
  const result=[];
  function visit(family, seed, x, y, size) {
    const children=math.regionChildren(family,seed);
    if(children) children.forEach((child,index)=>visit(child.family,math.positionSeed(seed,family.id,index,3571),
      x+child.x*size*hierarchy.width,y+child.y*size,size*child.size));
    else result.push(...family.tiles.map(t=>({...t,x:x+t.x*size,y:y+t.y*size,width:t.width*size,height:t.height*size})));
  }
  const root=math.regionFamily(hierarchy,column,row);
  visit(root.family,root.seed,column*hierarchy.width,row,1);
  return result;
}

// A sweep keyed by opposite full edges independently catches two-tile rectangles.
function checkEdges(tiles) {
  const edges=new Map(),key=value=>Number(value.toFixed(9));
  for(const tile of tiles) {
    for(const [axis,position,a,b,sign] of [
      ['x',tile.x,tile.y,tile.y+tile.height,-1],['x',tile.x+tile.width,tile.y,tile.y+tile.height,1],
      ['y',tile.y,tile.x,tile.x+tile.width,-1],['y',tile.y+tile.height,tile.x,tile.x+tile.width,1],
    ]) {
      const id=[axis,position,a,b].map(v=>typeof v==='number'?key(v):v).join(':');
      assert(!edges.has(id)||edges.get(id)===sign,'Hierarchical and spatial seams cannot merge two images');
      edges.set(id,sign);
    }
  }
}

for(const ratios of [[1],[16/9,.75,1,.5]]) {
  const base=math.mosaicLayout(ratios,17),hierarchy=math.createHierarchy(base,2,17);
  assert.equal(hierarchy.depth,2);assert(hierarchy.families.length>1);
  assert(hierarchy.families.some(f=>f.variants.length>1),'Interior alternatives must vary geometry');
  const tiles=[];
  for(const [col,row] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
    const region=flattenRegion(hierarchy,col,row);tiles.push(...region);
    assert.equal(region.length,base.tiles.length*21*21);
    assert(Math.abs(region.reduce((sum,t)=>sum+t.width*t.height,0)-base.width)<1e-9);
    assert(region.every(t=>Math.abs(t.width/t.height/ratios[t.image]-1)<1e-8));
    assert.equal(JSON.stringify(region),JSON.stringify(flattenRegion(math.createHierarchy(base,2,17),col,row)),
      'Spatial addresses survive reload and do not depend on traversal order');
  }
  checkEdges(tiles);
  const signatures=new Set();
  for(let column=0;column<8;column++) {
    const region=flattenRegion(hierarchy,column,0);
    signatures.add(JSON.stringify(region.map(t=>[Number((t.x-column*hierarchy.width).toFixed(8)),t.y,t.width,t.height,t.image])));
  }
  assert(signatures.size>=6,'Different regions must not just repeat one motif');
  assert.notEqual(JSON.stringify(flattenRegion(hierarchy,0,0)),JSON.stringify(flattenRegion(math.createHierarchy(base,2,18),0,0)));
}

let extension;
const calls=[], notices=[];
function gridPixels(transparent=false) {
  const data=new Uint8ClampedArray(100*100*4);
  for(let y=0;y<100;y++) for(let x=0;x<100;x++) {
    const major=x<2||y<2,minor=x%10===0||y%10===0;
    const color=major?20:minor?25:34;
    data.set([color,color,color,transparent?(major||minor?128:0):255],4*(y*100+x));
  }
  return data;
}
const ctx = {
  canvas:{width:1000,height:800}, globalAlpha:1, globalCompositeOperation:'source-over',
  matrix:{a:1,b:0,c:0,d:1,e:0,f:0},stack:[],
  save(){this.stack.push({alpha:this.globalAlpha,op:this.globalCompositeOperation,matrix:{...this.matrix},fill:this.fillStyle});},
  restore(){const saved=this.stack.pop();if(saved){this.globalAlpha=saved.alpha;this.globalCompositeOperation=saved.op;this.matrix=saved.matrix;this.fillStyle=saved.fill;}},
  clearRect(){calls.push(['clear']);},
  setTransform(a,b,c,d,e,f){this.matrix={a,b,c,d,e,f};calls.push(['transform',a,b,c,d,e,f]);},
  getTransform(){return {...this.matrix};},
  fillRect(...args){calls.push(['fill',this.globalCompositeOperation,this.globalAlpha,this.fillStyle,...args]);},
  drawImage(...args){calls.push(['image',this.globalCompositeOperation,this.globalAlpha,...args]);},
  createPattern(image){return {image,setTransform(matrix){this.matrix=matrix;}};},
  getImageData(x,y,width,height){return {data:width===100&&height===100?gridPixels():new Uint8ClampedArray([34,34,34,255])};},
  putImageData(){}, beginPath(){this.rects=[];},rect(...args){this.rects.push(args);},clip(){},strokeRect(){},
  fill(){calls.push(['path-fill',this.globalCompositeOperation,this.globalAlpha,this.fillStyle,this.rects.map(r=>[...r]),{...this.matrix}]);},
};
const elements=[],windowListeners=new Map(),documentListeners=new Map();
let clock=0,timerId=0;
const timers=new Map();
const schedule=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:clock+delay});return id;};
const advance=ms=>{clock+=ms;for(const [id,timer] of [...timers]) if(timer.at<=clock){timers.delete(id);timer.fn();}};
const mockWindow={devicePixelRatio:2,innerWidth:1280,innerHeight:800,
  addEventListener(type,fn){windowListeners.set(type,fn);},removeEventListener(type){windowListeners.delete(type);}};
const mockDocument={body:{append(){}},head:{append(){}},focused:true,hasFocus(){return this.focused;},
  getElementById(id){return elements.find(e=>e.id===id&&!e.removed);},
  querySelectorAll(selector){return elements.filter(e=>{
    for(let node=e;node;node=node.parent) if(node.removed) return false;
    if(selector==='dialog[open]') return e.tag==='dialog'&&e.open;
    if(selector==='[role="dialog"][aria-modal="true"]:not([hidden])') return e.attributes.role==='dialog'&&e.attributes['aria-modal']==='true'&&!e.hidden;
    if(selector==='[role="dialog"][data-state="open"]') return e.attributes.role==='dialog'&&e.attributes['data-state']==='open';
    if(selector==='.comfy-modal') return e.className==='comfy-modal';
    return e.tag===selector;
  });},
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
  addEventListener(type,fn){documentListeners.set(type,fn);},removeEventListener(type){documentListeners.delete(type);},
  createElement(type){
  if(type==='canvas') return {width:1,height:1,getContext(){return ctx;},toBlob(callback){callback({width:this.width,height:this.height});}};
  const element={tag:type,tagName:type.toUpperCase(),style:{},dataset:{},attributes:{},children:[],listeners:{},append(...children){
    this.children.push(...children);children.forEach(child=>{child.parent=this;});
  },
    replaceChildren(...children){this.children.forEach(child=>{child.parent=null;});this.children=[];this.append(...children);},
    contains(node){return node===this||this.children.some(child=>child.contains?.(node));},
    querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...(child.querySelectorAll?.(tag)||[])]);},
    querySelector(tag){return this.querySelectorAll(tag)[0]||null;},
    setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key];},
    addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];},
    show(){this.open=true;},showModal(){throw Error('The settings panel must not block the canvas');},
    focus(){mockDocument.activeElement=this;},select(){},remove(){this.removed=true;},setPointerCapture(id){this.pointerId=id;},
    getBoundingClientRect(){return {left:parseFloat(this.style.left)||0,top:parseFloat(this.style.top)||0,width:360,height:this.type==='range'?32:this.querySelector('div')?.hidden?48:600};},
    close(){this.open=false;this.listeners.close?.();},click(){if(!this.disabled)return this.onclick?.();}};
  elements.push(element);return element;
}};
const graphContainer=mockDocument.createElement('div');graphContainer.id='graph-canvas-container';
const graphTarget=mockDocument.createElement('div');graphTarget.id='graph-canvas';graphContainer.append(graphTarget);
const canvas = {
  canvas:ctx.canvas,bgcanvas:ctx.canvas,bgctx:ctx,graph:{_groups:[{}]},
  ds:{scale:1,offset:[4,9],toCanvasContext(context){
    const m=context.getTransform(),s=this.scale;
    context.setTransform(m.a*s,m.b*s,m.c*s,m.d*s,m.e+m.a*s*this.offset[0],m.f+m.d*s*this.offset[1]);
    calls.push(['world',s,...this.offset]);
  }},
  visible_area:[-100,-80,1000,800],clear_background:true,clear_background_color:'#222',background_image:'grid',
  editor_alpha:1,zoom_modify_alpha:true,
  drawGroups(){calls.push(['groups']);},drawConnections(){calls.push(['links']);},
  setDirty(){},
};
const blobs=new Map();let blobId=0;
const URL={createObjectURL(blob){const url=`blob:${blobId++}`;blobs.set(url,blob);return url;},revokeObjectURL(url){blobs.delete(url);}};
class MockImage {
  width=100;height=100;
  set src(value){this._src=value;const blob=blobs.get(value);if(blob){this.width=blob.width;this.height=blob.height;this.failed=blob.fail;}this.onload?.();}
  get src(){return this._src;}
  addEventListener(){}
  decode(){return this.failed?Promise.reject(Error('bad image')):Promise.resolve();}
}
const removedNotices=[];
const app={canvas,registerExtension(value){extension=value;},extensionManager:{toast:{add(value){notices.push(value);},remove(value){removedNotices.push(value);}}}};
let stored,failWrite=false,dbClosed=0,blockConfig=null,writeFailuresRemaining=0,writeAttempts=0;
const disk=new Map();let uploads=0;
const api={async fetchApi(url,options={}) {
  const name=decodeURIComponent(url.slice('/userdata/'.length));
  if(options.method==='POST') {
    writeAttempts++;
    if(blockConfig&&name.endsWith('background.json')) await blockConfig();
    if(failWrite||writeFailuresRemaining-->0) return {ok:false,status:507,statusText:'Insufficient Storage',text:async()=>'{"error":"disk full"}'};
    const value=typeof options.body==='string'?JSON.parse(options.body):structuredClone(options.body);
    disk.set(name,value);
    if(name.endsWith('background.json')) stored=value;else uploads++;
  }
  const value=disk.get(name);
  return {ok:value!==undefined,status:value===undefined?404:200,json:async()=>structuredClone(value),blob:async()=>structuredClone(value)};
}};
const indexedDB={open(){
  const request={result:{close(){dbClosed++;},transaction(){
    const transaction={objectStore(){return {
      get(){const result={result:undefined};queueMicrotask(()=>transaction.oncomplete());return result;},
      put(value){const result={};queueMicrotask(()=>{
        if(failWrite){transaction.error=Error('quota exceeded');transaction.onabort();}
        else{stored=structuredClone(value);transaction.oncomplete();}
      });return result;},
    };}};return transaction;
  }}};queueMicrotask(()=>request.onsuccess());return request;
}};
const scope=vm.createContext({app,api,crypto:require('node:crypto').webcrypto,document:mockDocument,window:mockWindow,Image:MockImage,indexedDB,URL,AbortController,
  setTimeout:schedule,clearTimeout:id=>timers.delete(id),
  Uint8ClampedArray,DOMMatrix:class {scale(...args){this.scaleValues=args;return this;}},
  ...math});
for (const file of ['menu_order.js','menu_source.js']) {
  vm.runInContext(fs.readFileSync(path.join(root,file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,''),scope);
}
const menuExtension=extension;
let source=fs.readFileSync(path.join(root,'canvas_background.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
vm.runInContext(fs.readFileSync(path.join(root,'canvas_background_storage.js'),'utf8').replace(/export /g,''),scope);
vm.runInContext(source+';globalThis.background={gridProfile,drawVectorGrid,drawPictures,buildTexture,install,panelBounds,settings,storage,persist,current(){return {texture,settings,records,pictures,saveStatus};},flush(){return saveChain;},configure(value){texture=value;pictures=value.images;records=pictures.map((image,i)=>({name:`image${i}.png`,blob:{width:image.width,height:image.height},ratio:image.width/image.height}));}};',scope);
const background=scope.background;
const finishSaveRetries=async()=>{
  let done=false;
  const pending=background.flush().then(()=>{done=true;});
  const waits=[];
  for(let i=0;i<20&&!done;i++) {
    await new Promise(setImmediate);
    if(done) break;
    const next=Math.min(...[...timers.values()].map(timer=>timer.at));
    assert(Number.isFinite(next),'Pending save must have a scheduled retry');
    waits.push(next-clock);advance(next-clock);
  }
  assert(done,'Save must finish within the bounded retry count');await pending;return waits;
};
const profile=background.gridProfile(gridPixels(),100,100);
for(const lines of [profile.vertical,profile.horizontal]) {
  assert.deepEqual(Array.from(lines,l=>l.at),Array.from({length:10},(_,i)=>i*10));
  assert.equal(lines[0].width,2);assert.equal(lines[1].width,1);
  assert.equal(lines[0].color,'rgba(20,20,20,1)');assert.equal(lines[1].color,'rgba(25,25,25,1)');
}
const transparentProfile=background.gridProfile(gridPixels(true),100,100);
assert.equal(transparentProfile.vertical.length,10);
assert.equal(transparentProfile.vertical[0].color,`rgba(20,20,20,${128/255})`);
const solid=background.gridProfile(new Uint8ClampedArray(400).fill(255),10,10);
assert.equal(solid.vertical.length+solid.horizontal.length,0);
const gridCalls=()=>calls.filter(c=>c[0]==='fill'&&typeof c[3]==='string'&&/^rgba\((20|25),/.test(c[3]));
for(const dpr of [1,1.25,2]) for(const scale of [.5,.51,1,2,8]) {
  calls.length=0;
  const testCanvas={...canvas,ds:{scale},visible_area:[-1e7,-1e7,2e7,2e7]};
  const matrix=[dpr*scale,0,0,dpr*scale,-123.37,41.21];
  ctx.setTransform(...matrix);ctx.globalAlpha=.37;
  background.drawVectorGrid(ctx,testCanvas,profile,.6,dpr);
  const lines=gridCalls();
  assert.equal(lines.length>0,scale>.5);
  assert(lines.length<400,'Grid work is bounded by physical viewport, not world size');
  for(const line of lines) {
    assert(line.slice(4).every(Number.isInteger),'Line edges align to device pixels');
    const thickness=line[6]<line[7]?line[6]:line[7];
    assert([Math.max(1,Math.round(dpr)),Math.max(1,Math.round(2*dpr))].includes(thickness),'Zoom does not thicken grid lines');
    assert(Math.abs(line[2]-.6*(1-.5/scale))<1e-12);
  }
  if(scale===2&&dpr===2) assert(lines.some(line=>line[4]===Math.round(-123.37+40*4)),'Grid phase follows world transform');
  assert.equal(ctx.globalAlpha,.37);assert.deepEqual(Object.values(ctx.getTransform()),matrix);
  calls.length=0;background.drawVectorGrid(ctx,testCanvas,profile,0,dpr);assert.equal(calls.length,0);
}
ctx.globalAlpha=1;
const images=[{width:160,height:90},{width:75,height:100}],files=[{ratio:16/9},{ratio:.75}];
const texture=background.buildTexture(images,files);
assert(calls.filter(c=>c[0]==='image').every(c=>c.length===8),'Always draw complete source image; no source crop rectangle');
assert(texture.hierarchy,'Every background uses spatial variants');
const single=background.buildTexture([images[0]],[files[0]]);
assert(Math.abs(single.width/single.height-16/9)<1e-12);
background.configure(texture);

// Execute the installed frontend's actual drawBackCanvas body, not a replacement algorithm.
const bundlePath=process.argv[2];
assert(bundlePath,'Pass the installed settingStore bundle path to verify native integration');
const bundle=fs.readFileSync(bundlePath,'utf8');
// Run the installed frontend's modal gate and shortcut handler. A bubbling-only
// test missed that even dialog.show() makes ComfyUI reject all shortcuts.
const modalStart=bundle.indexOf('function hasOpenRekaDialog()'),modalEnd=bundle.indexOf('function clone$1(',modalStart);
assert(modalStart>=0&&modalEnd>modalStart,'Review modal detection when upgrading the frontend');
vm.runInContext(bundle.slice(modalStart,modalEnd),scope);
const servicePath=fs.readdirSync(path.dirname(bundlePath)).find(name=>/^keybindingService-.*\.js$/.test(name));
assert(servicePath,'Installed native keybinding service is required');
const service=fs.readFileSync(path.join(path.dirname(bundlePath),servicePath),'utf8');
const handlerStart=service.indexOf('async function keybindHandler('),handlerEnd=service.indexOf('function registerCoreKeybindings()',handlerStart);
assert(handlerStart>=0&&handlerEnd>handlerStart,'Review keybinding handler when upgrading the frontend');
const executed=[];
scope.nativeKeybindingDependencies={
  r:{fromEvent:e=>({key:e.key,ctrl:!!(e.ctrlKey||e.metaKey),isModifier:false,
    isReservedByTextInput:!(e.ctrlKey||e.metaKey||e.altKey)||(['a','c','v','x','z','y'].includes(e.key.toLowerCase())&&!e.altKey)})},
  c:{getKeybinding:combo=>({commandId:combo.key==='s'?'Comfy.SaveWorkflow':combo.key==='Enter'?'Comfy.QueuePrompt':'Test.CanvasShortcut',
    targetElementId:['Delete','b','z'].includes(combo.key)?'graph-canvas':undefined})},
  d:{dialogStack:[]},l:{execute:async command=>executed.push(command)},
};
vm.runInContext(`globalThis.nativeKeybind=(()=>{const {r,c,d,l}=nativeKeybindingDependencies;const n=isModalOpen;${service.slice(handlerStart,handlerEnd)}return keybindHandler;})();`,scope);
const start=bundle.indexOf('drawBackCanvas(e=!0,t,n=this.graph){'),end=bundle.indexOf('drawNode(e,t){',start);
assert(start>=0&&end>start,'Review native background rendering when upgrading the frontend');
canvas.drawBackCanvas=vm.runInContext('({'+bundle.slice(start,end)+'}).drawBackCanvas',scope);
const original=canvas.drawBackCanvas;
background.install(canvas);const wrapped=canvas.drawBackCanvas;background.install(canvas);assert.equal(canvas.drawBackCanvas,wrapped);
canvas.drawBackCanvas(); // Read theme grid geometry once.
for(const scale of [.1,.5,1,2]) {
  calls.length=0;canvas.ds.scale=scale;canvas.drawBackCanvas(true);
  assert.equal(canvas.background_image,'grid');assert.equal(canvas.clear_background_color,'#222');
  assert.equal(calls.filter(c=>c[0]==='groups').length,1);assert.equal(calls.filter(c=>c[0]==='links').length,1);
  const fills=calls.filter(c=>c[0]==='fill');
  const grid=gridCalls()[0];
  assert.equal(!!grid,scale>.5,'Preserve native grid zoom threshold');
  assert(fills.every(c=>c[1]==='destination-over'));
  assert.equal(fills.at(-1)[3],'#222','Base remains underneath images and grid');
  assert(calls.some(c=>c[0]==='image'&&c[1]==='destination-over'&&c[2]===.35));
}
background.settings.enabled=false;calls.length=0;canvas.drawBackCanvas();
assert(gridCalls().length>0,'Grid controls also work with image background disabled');
assert(!calls.some(c=>c[0]==='image'),'Disabling images does not disable vector grid');
background.settings.gridOpacity=0;calls.length=0;canvas.drawBackCanvas();assert.equal(gridCalls().length,0);
background.settings.gridOpacity=.4;calls.length=0;canvas.drawBackCanvas();assert.equal(gridCalls()[0][2],.4*.75);
canvas.zoom_modify_alpha=false;canvas.editor_alpha=.8;calls.length=0;canvas.drawBackCanvas();
assert.equal(gridCalls()[0][2],.4*.8);canvas.zoom_modify_alpha=true;canvas.editor_alpha=1;
background.settings.gridOpacity=1;
background.settings.enabled=true;
// The mask is underneath native groups and grid, but above pictures. One nonzero
// path fill applies the fade to the union, including overlapping/nested groups.
canvas.graph._groups=[{_bounding:[-20,-10,150,100]},{_bounding:new Float32Array([50,20,120,90])},{_bounding:[5000,5000,30,30]}];
for(const fade of [0,.65,1]) {
  background.settings.groupFade=fade;calls.length=0;canvas.drawBackCanvas();
  const masks=calls.filter(c=>c[0]==='path-fill');
  assert.equal(masks.length,fade>0?1:0);
  if(fade>0) {
    assert.equal(masks[0][1],'destination-over');assert.equal(masks[0][2],fade);assert.equal(masks[0][3],'#222');
    assert.deepEqual(masks[0][4],[[-20,-10,150,100],[50,20,120,90]]);
    assert.equal(masks[0][5].a,canvas.ds.scale*mockWindow.devicePixelRatio);
    assert(calls.indexOf(masks[0])>calls.findIndex(c=>c[0]==='groups'));
    assert(calls.indexOf(masks[0])>calls.findIndex(c=>c[0]==='fill'));
    assert(calls.indexOf(masks[0])<calls.findIndex(c=>c[0]==='image'));
  }
}
canvas.graph._groups[0]._bounding=[100,80,50,60];calls.length=0;canvas.drawBackCanvas();
assert.deepEqual(calls.find(c=>c[0]==='path-fill')[4][0],[100,80,50,60],'Fade follows moved and resized groups');
background.settings.enabled=false;calls.length=0;canvas.drawBackCanvas();assert(!calls.some(c=>c[0]==='path-fill'));
background.settings.enabled=true;background.settings.groupFade=.65;canvas.graph._groups=[{}];
calls.length=0;canvas.drawBackCanvas();assert(!calls.some(c=>c[0]==='path-fill'),'No valid visible group means no fade');
canvas.visible_area=[-1e7,-1e7,2e7,2e7];calls.length=0;canvas.drawBackCanvas();
assert.equal(calls.filter(c=>c[0]==='image').length,0,'Very large views use bounded pattern drawing');
assert(calls.filter(c=>c[0]==='fill').length<100,'Large world bounds must not enumerate infinite grid lines');
canvas.background_image=null;calls.length=0;canvas.drawBackCanvas();assert.equal(gridCalls().length,0);
canvas.background_image='grid';
const failureCanvas={...canvas,drawBackCanvas(){throw Error('native failure');}};
background.install(failureCanvas);
assert.throws(()=>failureCanvas.drawBackCanvas(),/native failure/);
assert.equal(failureCanvas.background_image,'grid');assert.equal(failureCanvas.clear_background_color,'#222');
const menu=menuExtension.getCanvasMenuItems();assert.equal(menu[0].className,'liuxinyu-menu-source');assert.match(menu[0].content,/画布背景/);
assert.equal(notices.length,0);

(async()=>{
  menu[0].callback();
  const dialog=elements.find(e=>e.className==='liuxinyu-bg-panel'),input=name=>dialog.querySelectorAll('input').find(e=>e.name===name);
  const action=text=>dialog.querySelectorAll('button').find(e=>e.textContent===text);
  assert.equal(dialog.tag,'div');assert.equal(dialog.getAttribute('role'),'region');
  assert(graphContainer.contains(dialog),'Canvas-scoped shortcuts include the floating panel');
  assert.equal(scope.isModalOpen(0),false,'Background settings must not activate the native modal gate');
  const nativeShortcut=async(target,shortcut)=>{
    const count=executed.length;
    await scope.nativeKeybind({...shortcut,composedPath:()=>[target],preventDefault(){},
      stopPropagation(){assert.fail('Shortcut propagation must remain native');}});
    return executed.length-count;
  };
  for(const target of [graphTarget,dialog,input('size'),input('size-value'),input('seed'),action('生成')]) {
    for(const shortcut of [{key:'s',ctrlKey:true},{key:'s',metaKey:true},{key:'Enter',ctrlKey:true},{key:'b',ctrlKey:true}])
      assert.equal(await nativeShortcut(target,shortcut),1,'Native service executes global and canvas-scoped shortcuts with the panel open');
  }
  assert.equal(await nativeShortcut(dialog,{key:'Delete'}),1);
  assert.equal(await nativeShortcut(dialog,{key:'z',ctrlKey:true}),1);
  assert.equal(await nativeShortcut(input('seed'),{key:'Delete'}),0,'Native text editing remains intact');
  const blockingDialog=mockDocument.createElement('dialog');blockingDialog.show();
  assert.equal(scope.isModalOpen(0),true,'Reproduce the previous failure with a nonmodal native dialog');
  assert.equal(await nativeShortcut(graphTarget,{key:'s',ctrlKey:true}),0,'The installed service blocks save while dialog[open] exists');
  blockingDialog.close();blockingDialog.remove();
  assert.equal(await nativeShortcut(graphTarget,{key:'s',ctrlKey:true}),1);
  assert.equal(action('撤销'),undefined);assert.equal(action('重做'),undefined);
  assert(!dialog.querySelectorAll('summary').some(e=>/使用提示/.test(e.textContent||'')));
  assert(!dialog.querySelectorAll('p').some(e=>/拖动标题|层数越高|滑块按比例/.test(e.textContent||'')));
  assert.equal(mockDocument.activeElement,dialog,'Opening the panel must not autofocus the title or a button');
  assert.equal(dialog.listeners.keydown,undefined,'The panel must not install a keyboard interceptor');
  assert.equal(action('重新随机布局'),undefined);assert.equal(action('按住对比'),undefined);
  for(const target of [dialog,input('size-value'),input('size'),input('seed'),action('生成')]) for(const shortcut of [
    {key:'z',ctrlKey:true},{key:'Z',ctrlKey:true,shiftKey:true},{key:'y',ctrlKey:true},
    {key:'z',metaKey:true},{key:'Z',metaKey:true,shiftKey:true},
    {key:'s',ctrlKey:true},{key:'s',metaKey:true},{key:'s',ctrlKey:true,shiftKey:true},
    {key:'Enter',ctrlKey:true},{key:'Enter',metaKey:true},{key:'f',ctrlKey:true},{key:'a',altKey:true},{key:'Delete'},
  ]) {
    const event={...shortcut,target,
      stopPropagation(){assert.fail('All keyboard shortcuts must bubble unchanged');},
      preventDefault(){assert.fail('The panel must not consume keyboard shortcuts');}};
    target.onkeydown?.(event);dialog.listeners.keydown?.(event);
  }
  const range=input('size'),size=input('size-value'),opacity=input('opacity-value'),gridOpacity=input('gridOpacity-value');
  assert(!dialog.querySelectorAll('button').some(e=>['−','＋','50%','100%','200%'].includes(e.textContent)));
  const editor=mockDocument.getElementById('liuxinyu-bg-size-editor');
  assert.equal(range.parent.children.find(e=>e.className==='liuxinyu-bg-ticks').children.length,3);
  for(const key of ['opacity','groupFade','gridOpacity','levels']) assert(!input(key).parent.children.some(e=>e.className==='liuxinyu-bg-ticks'),'Only image scaling has anchor dots');
  const groupFade=input('groupFade-value');assert.equal(groupFade.value,'65','Old settings use the default fade');
  input('groupFade').value='80';input('groupFade').oninput();input('groupFade').onchange();await background.flush();
  assert.equal(stored.settings.groupFade,.8,'Group fade is persisted');
  input('opacity').onpointerdown({button:0,pointerId:3});input('opacity').value='49';input('opacity').oninput();
  assert.equal(opacity.value,'49','Opacity dragging must not snap to scale anchors');
  input('opacity').onpointercancel();opacity.value='35';opacity.onchange();
  const thumb=()=>({clientX:16+328*Number(range.value)/1000,clientY:16,buttons:0});
  const wheelOn=(target,deltaY,deltaMode=0)=>target.listeners.wheel({deltaY,deltaMode,preventDefault(){},stopPropagation(){}});
  assert.equal(editor.hidden,true);
  range.onpointerenter({...thumb(),clientX:0});advance(1200);assert.equal(editor.hidden,true,'Hover away from thumb must not open the editor');
  range.onpointermove(thumb());advance(999);assert.equal(editor.hidden,true);
  advance(1);assert.equal(editor.hidden,false,'Thumb hover opens at one second');
  assert.notEqual(mockDocument.activeElement,size,'Mouse hover must not steal focus');
  range.onpointerleave({relatedTarget:size});assert.equal(editor.hidden,false,'Moving into the input bubble keeps it editable');
  size.focus();range.parent.onpointerleave();assert.equal(editor.hidden,true,'Leaving the slider and bubble hides immediately, even during editing');
  dialog.focus();
  range.onpointerdown({button:0,pointerId:4});range.onpointermove({...thumb(),buttons:1});assert.equal(editor.hidden,false,'Dragging shows the value immediately');
  range.parent.onpointerleave();assert.equal(editor.hidden,false,'Captured drag remains visible outside the control');
  const at=value=>Math.log(value/10)/Math.log(50)*1000;
  for(const anchor of [50,100,200]) {
    range.value=String(at(anchor)+5);range.oninput();
    assert.equal(Number(size.value),anchor,'Pointer drag snaps to marked scale anchors');
  }
  range.value=String(at(100)+40);range.oninput();assert.notEqual(Number(size.value),100,'Dragging beyond the snap zone releases the anchor');
  assert.equal(size.style.width,`${size.value.length}ch`,'Number uses its text width so value and unit can center together');
  range.onpointerup();assert.equal(editor.hidden,true,'Releasing hides immediately');advance(1200);assert.equal(editor.hidden,true);
  size.value='100';size.onchange();
  await wheelOn(range,-100);assert.equal(size.value,'101','Wheel can step away from an anchor without snapping back');
  await wheelOn(range,25);await wheelOn(range,25);await wheelOn(range,25);assert.equal(size.value,'101');
  await wheelOn(range,25);assert.equal(size.value,'100','Trackpad deltas accumulate before a step');
  await wheelOn(range,-3,1);assert.equal(size.value,'101','Line-mode wheel stepping is supported');
  size.value='100';size.onchange();
  range.onkeydown({key:'Enter',preventDefault(){}});assert.equal(editor.hidden,false);assert.equal(mockDocument.activeElement,size);
  assert.equal(scope.isModalOpen(0),false,'The numeric editor does not activate the modal gate either');
  size.onkeydown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(editor.hidden,true);assert(!dialog.removed);
  assert.equal(gridOpacity.value,'100');
  input('gridOpacity').value='0';input('gridOpacity').oninput();input('gridOpacity').onchange();
  await background.flush();assert.equal(stored.settings.gridOpacity,0);
  calls.length=0;canvas.drawBackCanvas();assert.equal(gridCalls().length,0,'Zero slider value removes grid');
  await wheelOn(input('gridOpacity'),-100);assert.equal(gridOpacity.value,'1');
  gridOpacity.value='40';gridOpacity.oninput();gridOpacity.onchange();await background.flush();
  assert.equal(stored.settings.gridOpacity,.4);assert.equal(stored.settings.opacity,.35);
  const initialWidth=texture.width;
  size.value='200';size.oninput();size.onchange();
  assert.equal(background.current().texture.width,initialWidth*2,'Size changes preserve proportions');
  size.value='50';size.oninput();size.onchange();
  await background.flush();
  assert.equal(stored.settings.size,900,'Writes retain latest settings');
  assert.equal((await background.storage()).settings.size,900,'Read restores saved state');
  assert.equal(uploads,2,'Changing controls reuses the on-disk image copies');
  let arrived,release;
  blockConfig=()=>new Promise(resolve=>{release=resolve;arrived();});
  let nextWrite=new Promise(resolve=>{arrived=resolve;});
  background.persist();await nextWrite;
  nextWrite=new Promise(resolve=>{arrived=resolve;});
  background.persist();release();await nextWrite;
  assert.equal(background.current().saveStatus,'','Queued and completed writes stay silent');
  blockConfig=null;release();await background.flush();assert.equal(background.current().saveStatus,'');
  size.value='';size.oninput();assert.equal(background.current().settings.size,900);size.onblur();assert.equal(size.value,'50');
  size.value='125';size.oninput();size.onchange();await background.flush();assert.equal(stored.settings.size,2250);
  opacity.value='73';opacity.oninput();opacity.onchange();await background.flush();assert.equal(stored.settings.opacity,.73);
  opacity.value='150';opacity.onchange();await background.flush();assert.equal(stored.settings.opacity,1);
  opacity.value='35';opacity.onchange();await background.flush();
  range.value='0';range.oninput();range.onchange();assert.equal(background.current().settings.size,180);
  range.value='1000';range.oninput();range.onchange();assert(Math.abs(background.current().settings.size-9000)<1e-8);
  size.value='100';size.oninput();size.onchange();
  calls.length=0;canvas.drawBackCanvas();assert.equal(gridCalls()[0][2],.4*.75);
  const seed=input('seed');assert.equal(seed.value,'1');
  seed.value='123456';await seed.onchange();await background.flush();
  assert.equal(stored.settings.seed,123456);
  const seededLayout=JSON.stringify(flattenRegion(background.current().texture.hierarchy,0,0));
  await action('生成').click();await background.flush();
  assert.notEqual(stored.settings.seed,123456);assert.equal(Number(seed.value),stored.settings.seed);
  seed.value='123456';await seed.onkeydown({key:'Enter'});await background.flush();
  assert.equal(JSON.stringify(flattenRegion(background.current().texture.hierarchy,0,0)),seededLayout,'Typing the saved seed restores the same layout');
  for(const invalid of ['', '-1', '1.5', '4294967296', '1e3']) {
    seed.value=invalid;await seed.onchange();assert.equal(seed.value,'123456');assert.equal(background.current().settings.seed,123456);
  }
  seed.value='0';await seed.onchange();assert.equal(background.current().settings.seed,0);
  seed.value='123456';await seed.onchange();
  range.onpointermove(thumb());advance(1000);windowListeners.get('blur')();assert.equal(editor.hidden,true);
  size.focus();range.parent.onpointerleave({relatedTarget:null});
  assert.equal(mockDocument.activeElement,size,'Leaving the browser must not request range focus even before hasFocus updates');
  mockDocument.focused=false;range.parent.onpointerleave({relatedTarget:dialog});
  assert.equal(mockDocument.activeElement,size,'An inactive window must not be reactivated by pointer leave');
  mockDocument.focused=true;mockDocument.hidden=true;range.parent.onpointerleave({relatedTarget:dialog});
  assert.equal(mockDocument.activeElement,size,'A hidden page must not request range focus');
  mockDocument.hidden=false;range.parent.onpointerleave({relatedTarget:dialog});
  assert.equal(mockDocument.activeElement,range,'Normal in-page pointer leave can restore slider focus');
  let stopped=0;dialog.listeners.wheel({stopPropagation(){stopped++;}});assert.equal(stopped,1);
  range.onpointermove(thumb());advance(1000);assert.equal(editor.hidden,false);
  action('收起').click();assert.equal(mockDocument.getElementById('liuxinyu-bg-body').hidden,true);assert.equal(editor.hidden,true);
  action('展开').click();assert.equal(mockDocument.getElementById('liuxinyu-bg-body').hidden,false);
  const handle=dialog.querySelector('h2');assert.equal(handle.textContent,'画布背景');
  assert.equal(handle.onclick,undefined);assert.equal(handle.onkeydown,undefined);assert.equal(handle.tabIndex,undefined);
  handle.onpointerdown({button:0,pointerId:7,clientX:100,clientY:100});
  handle.onpointermove({pointerId:7,clientX:-5000,clientY:-5000});assert.equal(dialog.style.left,'12px');assert.equal(dialog.style.top,'12px');
  handle.onpointerup({pointerId:7});assert.equal(dialog.style.left,'12px');
  mockWindow.innerWidth=500;mockWindow.innerHeight=700;windowListeners.get('resize')();assert(parseFloat(dialog.style.left)<=128);
  const file=input('background-images');
  file.files=[{name:'wide.jpg',width:640,height:360},{name:'portrait.png',width:600,height:800}];
  await file.onchange();await background.flush();
  assert.equal(stored.records.length,2,'Actual file-input handler must complete replacement');
  assert.equal(stored.records[0].ratio,16/9);assert.equal(stored.records[1].ratio,.75);
  const retained=background.current().texture;
  file.files=[{name:'bad.png',fail:true}];await file.onchange();
  assert.equal(background.current().texture,retained,'Decode failure keeps prior background');
  assert.equal(blobs.size,2,'Only the two live thumbnail URLs remain after failed decoding');
  await dialog.ondrop({dataTransfer:{files:[{name:'third.jpg',width:400,height:400}]},preventDefault(){},stopPropagation(){}});
  await background.flush();assert.equal(stored.records.length,3,'Dropping images appends atomically');
  const remove=dialog.querySelectorAll('button').find(e=>e.getAttribute('aria-label')==='移除 third.jpg');
  await remove.click();await background.flush();assert.equal(stored.records.length,2);
  assert.equal(input('spatial'),undefined,'Fixed-repeat selector was removed');
  const levels=input('levels-value');assert.equal(levels.max,10);
  levels.value='10';levels.oninput();await levels.onchange();await background.flush();
  assert.equal(background.current().texture.hierarchy.depth,10);
  assert.equal(stored.settings.levels,10);
  const deep=background.current().texture;
  for(const fraction of [0,.43,-.57]) {
    calls.length=0;
    background.drawPictures(ctx,deep,[fraction*deep.width,fraction*deep.height,1000,800],1);
    assert(calls.length<50000,'Depth-10 drawing must visit visible detail, not expand the entire hierarchy');
    assert(deep.thumbnailPixels<=4*1024*1024);assert(deep.thumbnails.size<=512);
  }
  let terminated=false;
  scope.Worker=class {
    postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'worker test failure'}}));}
    terminate(){terminated=true;}
  };
  levels.value='9';levels.oninput();await levels.onchange();
  assert(terminated);assert.equal(background.current().settings.levels,10);
  assert.equal(background.current().texture,deep,'Worker failure preserves the current layout');
  scope.Worker=undefined;
  levels.value='11';levels.oninput();assert.equal(background.current().settings.levels,10);
  levels.value='1.5';levels.oninput();assert.equal(background.current().settings.levels,10);
  levels.value='2';levels.oninput();await levels.onchange();await background.flush();
  const beforeReload=JSON.stringify(flattenRegion(background.current().texture.hierarchy,-3,2));
  await extension.setup();
  assert.equal(JSON.stringify(flattenRegion(background.current().texture.hierarchy,-3,2)),beforeReload);
  assert.equal(background.current().settings.spatial,undefined);
  assert.equal(background.current().settings.gridOpacity,.4,'Reload restores independent grid opacity');
  assert.equal(background.current().settings.groupFade,.8,'Reload restores group background fade');
  assert.equal(background.current().settings.seed,123456,'Reload preserves the visible seed');
  assert.equal(action('重试保存'),undefined,'Saving never asks for a manual retry');
  const saveError=elements.find(e=>e.className==='liuxinyu-bg-save-error'&&!e.removed);
  writeFailuresRemaining=3;let attemptsBefore=writeAttempts;
  background.persist();assert.deepEqual(await finishSaveRetries(),[500,1000,2000]);
  assert.equal(writeAttempts-attemptsBefore,4);assert.equal(notices.length,0);assert.equal(saveError.hidden,true);
  assert.equal(background.current().saveStatus,'','Automatic recovery has no success chatter');
  failWrite=true;attemptsBefore=writeAttempts;background.persist();
  assert.deepEqual(await finishSaveRetries(),[500,1000,2000,4000,8000,8000,8000]);
  assert.equal(writeAttempts-attemptsBefore,8);assert.equal(notices.length,1);
  assert.equal(notices[0].severity,'error');assert.match(notices[0].detail,/8 次尝试均失败/);
  assert.match(notices[0].detail,/POST \/userdata\//);assert.match(notices[0].detail,/507/);assert.match(notices[0].detail,/disk full/);
  assert.match(notices[0].detail,/第 8\/8 次/);assert.match(notices[0].detail,/设置/);assert.match(notices[0].detail,/图片/);
  assert.equal(saveError.hidden,false);assert.equal(saveError.textContent,notices[0].detail);
  failWrite=false;background.persist();await background.flush();
  assert.equal(notices.length,1,'Later recovery also stays silent');assert.equal(removedNotices[0],notices[0]);assert.equal(saveError.hidden,true);
  // A newer adjustment replaces an obsolete snapshot waiting to retry.
  writeFailuresRemaining=1;background.persist();await new Promise(setImmediate);
  background.current().settings.groupFade=.37;background.persist();await finishSaveRetries();
  assert.equal(stored.settings.groupFade,.37);assert.equal(notices.length,1,'Superseded failure never surfaces');
  await action('清空').click();await background.flush();
  assert.equal(stored.records.length,0);
  calls.length=0;canvas.drawBackCanvas();assert(gridCalls().length>0,'Grid works without selected images');
  file.files=[{name:'restored.jpg',width:640,height:360}];await file.onchange();await background.flush();
  assert.equal(stored.records.length,1,'Images can still be selected after clearing');
  action('×').click();
  assert.equal(blobs.size,0);assert.equal(windowListeners.size,0);
  assert.equal(documentListeners.size,0);
  assert.equal(timers.size,0,'Closing cancels every editor timer');
  menu[0].callback();const reopened=elements.filter(e=>e.className==='liuxinyu-bg-panel').at(-1);
  assert.equal(reopened.querySelector('details').open,false,'Existing photo collection starts collapsed');
  reopened.querySelectorAll('button').find(e=>e.textContent==='×').click();assert.equal(blobs.size,0);
  console.log(`PASS: ${cases.length} ratio groups and hierarchical geometry; vector grid, 10-level controls; drag/hover popup visibility, scale-only snapping, wheel steps; all keyboard shortcuts pass through; editable seed, random seed and exact layout restore, photos, disk reload and save retry`);
})().catch(error=>{console.error(error);process.exitCode=1;});
