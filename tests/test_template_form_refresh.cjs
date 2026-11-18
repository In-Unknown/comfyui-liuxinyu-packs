const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../template_form_refresh.js'),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');
function harness(){
  const node={id:4},handlers=new Map(),queued=[];
  const original={output:{'10:4':{class_type:'LiuxinyuTemplateForm',inputs:{schema:['3',0],form_state:'old'}},'3':{class_type:'ReadFile',inputs:{path:'fixture'}},'6':{class_type:'Downstream',inputs:{data:['10:4',0]}}}};
  const h={node,original,handlers,queued,history:{},queue:{queue_running:[[0,'p']],queue_pending:[]}};
  const api={addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n),
    async queuePrompt(...args){queued.push(args);return {prompt_id:'p'};},
    async fetchApi(url){return {ok:true,json:async()=>url==='/queue'?h.queue:h.history};}};
  const app={rootGraph:{id:'workflow'},graphToPrompt:async()=>structuredClone(original)};
  const context=vm.createContext({api,app,findNodes:()=>[{node,path:'10:4'}],setTimeout,clearTimeout});vm.runInContext(source,context);
  return Object.assign(h,{context});
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('nested target uses only linked Schema input and leaves live serialized source unchanged',async()=>{
  const h=harness(),job=await h.context.queueTemplateRefresh(h.node),call=h.queued[0];
  assert.equal(job.target,'10:4');assert.equal(call[1].output['10:4'].class_type,'LiuxinyuTemplateSchemaCache');
  assert.deepEqual(JSON.parse(JSON.stringify(call[1].output['10:4'].inputs)),{schema:['3',0]});
  assert.deepEqual(JSON.parse(JSON.stringify(call[2])),{partialExecutionTargets:['10:4']});
  assert.equal(h.original.output['10:4'].class_type,'LiuxinyuTemplateForm');
  h.original.output['10:4'].inputs.schema='literal';await assert.rejects(h.context.queueTemplateRefresh(h.node),/连接 JSON Schema/);
});
test('history result survives missed events and cached execution; listeners are removed',async()=>{
  const h=harness();h.history={p:{status:{status_str:'success'},outputs:{'10:4':{lxy_template_schema:[{type:'string'}]}}}};
  assert.equal((await h.context.waitTemplateRefresh({prompt_id:'p',target:'10:4'})).type,'string');assert.equal(h.handlers.size,0);
});
test('transport errors retain a recoverable job and clean up listeners',async()=>{
  const h=harness();h.context.api.fetchApi=async()=>{throw Error('offline');};
  await assert.rejects(h.context.waitTemplateRefresh({prompt_id:'p',target:'10:4'}),error=>error.refreshRecoverable===true&&/offline/.test(error.message));
  assert.equal(h.handlers.size,0);
});
test('running task resolves on success and reports upstream errors, cancellation and multiple schemas',async()=>{
  const h=harness(),job={prompt_id:'p',target:'10:4'},waiting=h.context.waitTemplateRefresh(job);await flush();
  h.history={p:{status:{status_str:'success'},outputs:{'10:4':{lxy_template_schema:[true]}}}};
  h.handlers.get('execution_success')({detail:{prompt_id:'p'}});assert.equal(await waiting,true);
  h.history.p.status={status_str:'error',messages:[['execution_error',{node_id:'3',exception_message:'file missing'}]]};
  await assert.rejects(h.context.waitTemplateRefresh(job),/上游节点 3：file missing/);
  h.history={};h.queue={queue_running:[],queue_pending:[]};await assert.rejects(h.context.waitTemplateRefresh(job),/取消/);
  h.history={p:{status:{status_str:'success'},outputs:{'10:4':{lxy_template_schema:[true,true]}}}};
  await assert.rejects(h.context.waitTemplateRefresh(job),/唯一模板/);assert.equal(h.handlers.size,0);
});
