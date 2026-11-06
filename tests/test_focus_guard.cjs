const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handlers = new Map();
const document = {hidden:false, focused:true, hasFocus(){return this.focused;},
  addEventListener(type,fn,capture){assert.equal(capture,true);handlers.set(type,fn);}};
let calls=0, extension;
const canvas={ownerDocument:document,focus(){calls++;return 19;}};
const app={canvas:{canvas},registerExtension(value){extension=value;}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../focus_guard.js'),'utf8').replace(/^import .*;\r?$/gm,''),{app,document});
extension.setup();const wrapper=canvas.focus;extension.setup();assert.equal(canvas.focus,wrapper);
const input={focus(){calls++;},matches(selector){assert.equal(selector,'.graphdialog input.value');return true;}};
function blur(handler, target=input){const event={target,stopImmediatePropagation(){this.stopped=true;}};handlers.get('blur')(event);if(!event.stopped)handler.call(target);return event;}
const nativeHandlers=[function(){this.focus();}];
let bundle;
if(process.argv[2]){
  bundle=fs.readFileSync(process.argv[2],'utf8');
  const matches=[...bundle.matchAll(/addEventListener\(`blur`,(function\(\)\{this\.focus\(\)\})\)/g)];
  assert.equal(matches.length,3,'Review native focus handlers when frontend changes');
  nativeHandlers.splice(0,1,...matches.map(m=>vm.runInNewContext('('+m[1]+')')));
}
for(const handler of nativeHandlers){
  document.focused=false;const before=calls;assert(blur(handler).stopped);assert.equal(calls,before);
  document.focused=true;assert.equal(blur(handler).stopped,undefined);assert.equal(calls,before+1);
}
document.focused=false;
assert.equal(blur(function(){calls++;},{matches:()=>false}).stopped,undefined,'Other blur events still run');
const before=calls;canvas.focus();assert.equal(calls,before);
document.focused=true;document.hidden=true;canvas.focus();assert.equal(calls,before);
document.hidden=false;assert.equal(canvas.focus(),19);assert.equal(calls,before+1);
if(bundle){
  const start=bundle.indexOf('showSearchBox(e,t){');
  const closeStart=bundle.indexOf('close(){',start),closeEnd=bundle.indexOf('}});c.className',closeStart);
  assert(closeStart>start&&closeEnd>closeStart);
  const timers=[];
  const close=vm.runInNewContext('({'+bundle.slice(closeStart,closeEnd+1)+'}).close',
    {r:{},a:canvas,o:{body:{style:{}}},c:{remove(){}},setTimeout:fn=>timers.push(fn)});
  document.focused=false;const count=calls;close.call({blur(){}});timers.forEach(fn=>fn());
  assert.equal(calls,count,'Both native immediate and delayed search-close focus calls are blocked in background');
}
console.log('PASS: native blur refocus and immediate/delayed canvas focus stay in background; normal editing and unrelated blur events remain active');
