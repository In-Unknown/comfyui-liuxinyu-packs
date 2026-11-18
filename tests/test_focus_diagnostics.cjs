const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function events() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type,new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    emit(type, event={}) { for (const fn of handlers.get(type) || []) fn(event); },
  };
}
let calls = 0, now = 1000, receiver, args;
class Element {
  focus(...values) { calls++; receiver=this; args=values; if (this.fail) throw new Error('native failure'); return 19; }
}
class Dialog { showModal() { calls++; return 27; } }
const document = {...events(), hidden:false, hasFocus:()=>!document.hidden, activeElement:null};
const window = {...events(), focus(){ calls++; return 23; }, HTMLDialogElement:Dialog};
const context = vm.createContext({window, document, HTMLElement:Element, performance:{now:()=>now}, Date, Error, Reflect, Blob, URL, setTimeout});
const native=Element.prototype.focus, windowFocus=window.focus, modal=Dialog.prototype.showModal;
vm.runInContext(fs.readFileSync(path.join(__dirname,'../focus_diagnostics.js'),'utf8').replace('export function','function'),context);
assert.equal(Element.prototype.focus,native,'Import must not enable tracing');
const trace=vm.runInContext('startFocusTrace()',context);
assert.equal(trace,vm.runInContext('startFocusTrace()',context),'Repeated start is idempotent');
let received=0;
const unsubscribe=trace.subscribe(()=>{received++;});
trace.subscribe(()=>{throw Error('sink failed');});
const own={focus:native,tagName:'CANVAS'};
trace.watch(own,'focus','canvas.focus');const ownWrapper=own.focus;
trace.watch(own,'focus','canvas.focus');assert.equal(own.focus,ownWrapper);
assert.equal(own.focus(),19);assert.equal(received,1);unsubscribe();
const input = new Element(); Object.assign(input,{tagName:'INPUT',id:'example',className:'value',value:'SECRET_TEXT'});
const options={preventScroll:true};
assert.equal(input.focus(options),19); assert.equal(receiver,input); assert.equal(args[0],options);
window.emit('blur',{target:window,relatedTarget:null,isTrusted:true});
assert.equal(input.focus(),19,'A suspected focus request must still execute');
let report=trace.report();
assert(report.records.at(-1).suspicious);
assert.match(report.records.at(-1).stack,/test_focus_diagnostics/);
document.hidden=true; assert.equal(window.focus(),23); assert.equal(new Dialog().showModal(),27);
input.fail=true; assert.throws(()=>input.focus(),/native failure/); input.fail=false;
window.emit('keydown',{target:input,key:'SECRET_KEY',isTrusted:true});
assert(!JSON.stringify(trace.report()).includes('SECRET'));
for(let i=0;i<1600;i++) input.focus();
assert.equal(trace.report().records.length,1500,'Bound memory use');
trace.mark(); assert.equal(trace.report().records.at(-1).kind,'user-reported-incident');
trace.stop();
assert.equal(Element.prototype.focus,native);assert.equal(window.focus,windowFocus);assert.equal(Dialog.prototype.showModal,modal);
assert.equal(own.focus,native);
const count=trace.report().records.length;window.emit('blur');input.focus();assert.equal(trace.report().records.length,count);
const trace2=vm.runInContext('startFocusTrace()',context);
const later=()=>123;Element.prototype.focus=later;trace2.stop();
assert.equal(Element.prototype.focus,later,'Stopping must not overwrite a later extension');
console.log('PASS: opt-in, same return/throw/receiver/arguments, suspicious stacks, bounded records, no values/keys, stop restores hooks and preserves later wrappers');
