const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const file = fs.readFileSync(path.join(__dirname, '../execution_resume.js'), 'utf8');
const map = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const source = map.sourcesContent[map.sources.findIndex(name => name.endsWith('/executionStore.ts'))];
assert(source, 'Installed frontend executionStore source');

function nativeFunction(name, context) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }', start) + 4;
  assert(start >= 0 && end > start);
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end), {mode:'transform'}), context);
  return context[name];
}

function harness() {
  const listeners = new Map(), emitted = [], restored = [];
  const root = {id:'workflow'};
  let resolveQueue;
  const api = {clientId:'browser', addEventListener(name,fn) {
    if(!listeners.has(name)) listeners.set(name,[]); listeners.get(name).push(fn);
  }, dispatchEvent(event) {emitted.push(event.detail);fire(event.type,event.detail);},
    fetchApi() {return new Promise(resolve=>{resolveQueue=resolve;});} };
  function fire(type,detail) {for(const fn of listeners.get(type)||[]) fn({detail});}
  const context=vm.createContext({console,api,CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},
    nodeProgressStates:{value:{}},nodeProgressStatesByJob:{value:{}},activeJob:{value:undefined},activeJobId:{value:null},
    _executingNodeProgress:{value:null},executingNodeId:{value:null},
    progressCoalescer:{cancel(){}},progressStateCoalescer:{cancel(){}},
    useNodeOutputStore:()=>({revokePreviewsByExecutionId(){}}),tryNormalizeNodeExecutionId:id=>id,evictOldProgressJobs(){},
  });
  const handleExecuting=nativeFunction('handleExecuting',context);
  const applyProgressState=nativeFunction('applyProgressState',context);
  api.addEventListener('executing',handleExecuting);
  api.addEventListener('progress_state',({detail})=>applyProgressState(detail));
  vm.runInContext(file.replace(/^export /gm,''),context);
  const recovery=context.installExecutionResume(api,()=>root,(...args)=>restored.push(args),error=>{throw error;});
  return {api,root,fire,emitted,restored,recovery,context,
    queue(entries=[[0,'job',{}, {client_id:'browser',extra_pnginfo:{workflow:{id:'workflow'}}}]]) {
      resolveQueue({ok:true,json:async()=>({queue_running:entries})});
    }};
}
async function settle() {await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
  const h=harness();
  h.fire('executing','247:235');
  assert.equal(Object.keys(h.context.nodeProgressStates.value).length,0,'Actual native executing handler does not restore progress on refresh');
  const start=h.recovery.start();h.queue();await start;
  assert.equal(h.context.nodeProgressStates.value['247:235'].state,'running','Confirmed reconnect node reaches the native progress store');
  assert.equal(h.emitted.length,1);assert.equal(h.restored[0][0],'job');
  await h.recovery.restore();assert.equal(h.emitted.length,1,'No duplicate recovery events');
  const full={prompt_id:'job',nodes:{'247:235':{display_node_id:'247:235',state:'running',value:1,max:5},'190':{display_node_id:'190',state:'running',value:0,max:1}}};
  h.fire('progress_state',full);h.fire('executing','247:235');await settle();
  assert.equal(Object.keys(h.context.nodeProgressStates.value).length,2,'Complete concurrent snapshot wins over legacy single-node replay');
  assert.equal(h.emitted.length,1);

  const race=harness();race.fire('executing','235');const pending=race.recovery.start();
  race.fire('progress_state',full);race.queue();await pending;
  assert.equal(race.emitted.length,0,'In-flight queue response cannot overwrite newer complete progress');
  assert.equal(race.restored[0][2],full,'Snapshot captured before setup is available to the activity list');

  const switched=harness();switched.root.id='different';switched.fire('executing','235');
  const switchedStart=switched.recovery.start();switched.queue();await switchedStart;
  assert.equal(switched.emitted.length,0,'Do not apply progress to a different workflow');
  switched.root.id='workflow';await switched.recovery.restore();assert.equal(switched.emitted.length,1);
  switched.fire('executing',null);assert.equal(Object.keys(switched.context.nodeProgressStates.value).length,0,'End replay clears fallback progress');

  const ended=harness();ended.fire('executing','235');const ending=ended.recovery.start();
  ended.fire('execution_success',{prompt_id:'job'});ended.queue();await ending;
  assert.equal(ended.emitted.length,0,'Completed task cannot be revived by stale queue response');
  const other=harness();other.fire('executing','235');const otherStart=other.recovery.start();
  other.queue([[0,'job',{}, {client_id:'other',extra_pnginfo:{workflow:{id:'workflow'}}}]]);await otherStart;
  assert.equal(other.emitted.length,0,'Other client jobs cannot be borrowed');
  console.log('PASS: installed native reconnect gap reproduced; early capture, native progress restore, complete snapshot precedence, workflow/client isolation and end races');
})().catch(error=>{console.error(error);process.exitCode=1;});
