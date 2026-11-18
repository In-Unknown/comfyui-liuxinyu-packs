const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let extension;
const context=vm.createContext({app:{registerExtension:e=>extension=e}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../focus_monitor.js'),'utf8')
  .replace(/^import .*;\r?$/gm,'').replace('export function','function'),context);
const create=context.createFocusSink;
(async()=>{
  const sent=[];let fail=true;
  const sink=create(async body=>{if(fail)throw Error('offline');sent.push(body);},'page-one');
  for(let i=0;i<450;i++)sink.add({sequence:i,kind:'focus'});
  await sink.flush();assert.equal(sent.length,0);
  fail=false;await sink.flush();
  assert.equal(sent[0].session,'page-one');assert.equal(sent[0].dropped,50);
  assert.equal(sent[0].records.length,10);assert.equal(sent[0].records[0].sequence,50);
  await sink.flush();assert.equal(sent[1].records[0].sequence,60);assert.equal(sent[1].dropped,0);
  let release;const pending=create(()=>new Promise(r=>release=r),'page-two');
  pending.add({kind:'focus'});const first=pending.flush();await pending.flush();release();await first;
  let callback,uploads=0,timers=0;
  Object.assign(context,{crypto:{randomUUID:()=> 'auto-page'},startFocusTrace:cb=>{callback=cb;cb({kind:'trace-started'});return {mark(){}};},
    api:{fetchApi:async()=>{uploads++;return {ok:true};}},AbortSignal,setInterval:()=>{timers++;},
    window:{addEventListener(){}},document:{addEventListener(){}},navigator:{userActivation:{}},innerWidth:100,innerHeight:100});
  extension.setup();extension.setup();await new Promise(r=>setImmediate(r));
  assert.equal(timers,1);assert.equal(uploads,1);assert(context.window.comfyFocusTrace);
  console.log('PASS: bounded queue, batch retry/order, dropped counts, no concurrent uploads, automatic single setup and first upload');
})().catch(e=>{console.error(e);process.exitCode=1;});
