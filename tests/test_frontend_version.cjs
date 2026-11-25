const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../frontend_version.js'),'utf8').replace(/^import .*;\r?$/gm,'');
function page(version,storage=new Map(),failSetting=false){
  const handlers={},requests=[],warnings=[],settings=[];let count=0;
  vm.runInNewContext(source,{version,console,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    window:{location:{reload(){assert.deepEqual(settings.at(-1),['Comfy.Window.UnloadConfirmation',false]);count++;}}},app:{ui:{settings:{async setSettingValueAsync(key,value){if(failSetting)throw new Error('save failed');settings.push([key,value]);}}},registerExtension:e=>e.setup(),extensionManager:{toast:{add:e=>warnings.push(e)}}},
    api:{clientId:'page',addEventListener:(k,v)=>handlers[k]=v,fetchApi:async(u,o)=>{requests.push(JSON.parse(o.body));return {ok:true,json:async()=>({reload:false,version})};}}});
  return {handlers,requests,warnings,settings,get count(){return count;},storage};
}
test('reports loaded version, targets one reload and prevents a reload loop',async()=>{
  const p=page('old');assert.equal(p.requests[0].version,'old');
  p.handlers['liuxinyu.frontend_reload']({detail:{version:'old'}});assert.equal(p.count,0);
  p.handlers['liuxinyu.frontend_reload']({detail:{version:'new'}});
  await p.handlers['liuxinyu.frontend_reload']({detail:{version:'new'}});assert.equal(p.count,1);
  const stale=page('old',p.storage);stale.handlers['liuxinyu.frontend_reload']({detail:{version:'new'}});assert.equal(stale.count,0);assert.equal(stale.warnings.length,1);
  const fresh=page('new',p.storage);assert.equal(p.storage.size,0);
  await fresh.handlers['liuxinyu.frontend_reload']({detail:{version:'next'}});assert.equal(fresh.count,1);
});

test('setting failure keeps the page and does not consume the reload attempt',async()=>{
  const p=page('old',new Map(),true);
  await p.handlers['liuxinyu.frontend_reload']({detail:{version:'new'}});
  assert.equal(p.count,0);assert.equal(p.storage.size,0);
  const retry=page('old',p.storage);
  await retry.handlers['liuxinyu.frontend_reload']({detail:{version:'new'}});
  assert.equal(retry.count,1);
});
