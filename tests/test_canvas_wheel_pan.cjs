const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context=vm.createContext({app:{registerExtension(){}},window:{}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../canvas_wheel_pan.js'),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,''),context);
test('modifier wheel pans camera by axis and preserves zoom and unmodified events',()=>{
  let dirty=0;const canvas={canvas:{getBoundingClientRect:()=>({width:800,height:600})},ds:{offset:[0,0],scale:2},setDirty(){dirty++;}};
  const run=props=>{const e={target:canvas.canvas,deltaY:100,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...props};return [context.panCanvasWheel(canvas,e),e];};
  assert.equal(run({})[0],false);assert.equal(dirty,0);
  assert(run({shiftKey:true})[0]);assert.deepEqual(canvas.ds.offset,[0,-50]);
  assert(run({ctrlKey:true})[0]);assert.deepEqual(canvas.ds.offset,[-50,-50]);
  assert(run({ctrlKey:true,shiftKey:true,deltaY:-20})[0]);assert.deepEqual(canvas.ds.offset,[-40,-50]);
  assert(run({shiftKey:true,deltaY:0,deltaX:10})[0]);assert.equal(canvas.ds.offset[1],-55);
  assert(run({shiftKey:true,deltaY:1,deltaMode:1})[0]);assert.equal(canvas.ds.offset[1],-63);
  const [handled,e]=run({ctrlKey:true,deltaY:1,deltaMode:2});assert(handled&&e.prevented&&e.stopped);assert.equal(canvas.ds.offset[0],-440);
  assert.equal(run({shiftKey:true,target:{}})[0],false);assert.equal(run({ctrlKey:true,metaKey:true})[0],false);assert.equal(canvas.ds.scale,2);
});
