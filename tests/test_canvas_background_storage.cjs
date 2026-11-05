const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'liuxinyu-background-'));
  try {
    let failure = null, uploads = 0;
    const writes = [];
    const api = { async fetchApi(url, options = {}) {
      assert.equal(options.cache, 'no-store');
      const relative = decodeURIComponent(url.slice('/userdata/'.length));
      assert(relative.startsWith('liuxinyu/canvas-background/'));
      const target = path.join(directory, relative);
      if (options.method === 'POST') {
        writes.push(relative);
        if (failure === 'all' || (failure === 'config' && relative.endsWith('.json'))) return {
          ok:false,status:507,statusText:'Insufficient Storage',text:async()=>'{"error":"disk full"}',headers:new Headers({'x-request-id':'test-write-507'}) };
        await fs.mkdir(path.dirname(target), { recursive: true });
        const data = typeof options.body === 'string' ? options.body : Buffer.from(await options.body.arrayBuffer());
        await fs.writeFile(target + '.tmp', data); await fs.rename(target + '.tmp', target);
        if (!relative.endsWith('.json')) uploads++;
      }
      try {
        const data = await fs.readFile(target);
        return { ok: true, status: 200, json: async () => JSON.parse(data), blob: async () => new Blob([data], {type:'image/webp'}) };
      } catch (error) { if(error.code === 'ENOENT') return {ok:false,status:404}; throw error; }
    } };
    const source = (await fs.readFile(path.join(__dirname, '../canvas_background_storage.js'), 'utf8')).replace(/export /g, '');
    const factory = (overrides = {}) => {
      const context = vm.createContext({crypto:crypto.webcrypto,Uint8Array,AbortController,setTimeout,clearTimeout,...overrides});
      vm.runInContext(source + ';globalThis.factory=createBackgroundStore;', context);
      return context.factory;
    };
    const image = new Blob(['test image bytes'], {type:'image/webp'});
    const legacy = {settings:{opacity:.74,gridOpacity:0,levels:10,spatial:false},records:[{name:'测试图片.png',ratio:16/9,blob:image}]};
    let reads = 0;
    const store = factory()(api, async () => { reads++; return legacy; });
    const migrated = await store.load();
    assert.equal(migrated.needsMigration,true); assert.equal(reads,1);
    await store.save(migrated);
    const config = path.join(directory, 'liuxinyu/canvas-background/background.json');
    const manifest = JSON.parse(await fs.readFile(config, 'utf8'));
    const copied = await fs.readFile(path.join(path.dirname(config), manifest.records[0].file));
    assert.equal(copied.toString(),await image.text()); assert.equal(manifest.records[0].name,'测试图片.png');
    await store.save({...migrated,settings:{...legacy.settings,opacity:.2}});
    assert.equal(uploads,1,'Settings changes reuse image copies');
    // A new module instance has no browser or in-memory state: restore from disk alone.
    const restarted = factory()(api, async () => { throw Error('Browser storage must not be needed'); });
    const restored = await restarted.load();
    assert.equal(restored.settings.opacity,.2); assert.equal(restored.settings.gridOpacity,0); assert.equal(restored.settings.levels,10);
    assert.equal(await restored.records[0].blob.text(),await image.text());
    await restarted.save(restored); assert.equal(uploads,1,'Restored copies are not uploaded again');
    const good = await fs.readFile(config,'utf8');
    const changed = {...restored,records:[{...legacy.records[0],blob:new Blob(['new image'])}]};
    failure='all'; await assert.rejects(store.save(changed),error=>{
      assert.match(error.message,/保存失败/);assert.match(error.message,/HTTP：507 Insufficient Storage/);
      assert.match(error.message,/disk full/);assert.match(error.message,/test-write-507/);assert.match(error.message,/POST \/userdata\//);
      assert.match(error.message,/图片.*测试图片/);assert.match(error.message,/耗时/);return true;
    });
    const failedImagePath=writes.at(-1);
    assert.equal(await fs.readFile(config,'utf8'),good,'Image failure preserves previous manifest');
    failure='config'; await assert.rejects(store.save(changed),/保存失败/);
    assert.equal(writes.at(-2),failedImagePath,'Retry uses the same file path after an ambiguous upload failure');
    assert.equal(await fs.readFile(config,'utf8'),good,'Manifest failure preserves previous settings');
    failure=null; await store.save(changed);
    await store.save({...restored,records:[]}); assert.equal((await restarted.load()).records.length,0);
    assert.equal((await fs.readFile(path.join(path.dirname(config),manifest.records[0].file))).toString(),await image.text(),'Clear never deletes original or saved copies');
    await fs.writeFile(config,JSON.stringify({...manifest,records:[{...manifest.records[0],file:'../outside.webp'}]}));
    await assert.rejects(restarted.load(),/记录无效/);
    const offline=factory()({fetchApi:async()=>{throw new TypeError('Failed to fetch');}},async()=>null);
    await assert.rejects(offline.save({records:[],settings:{}}),error=>{
      assert.match(error.message,/未收到响应/);assert.match(error.message,/Failed to fetch/);assert.match(error.message,/background.json/);return true;
    });
    const timeout=factory({setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){}})({
      fetchApi:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))
    },async()=>null);
    await assert.rejects(timeout.save({records:[],settings:{}}),/请求已超时并取消/);
    console.log('PASS: disk image copies and manifest, browser migration, fresh-instance restore, no duplicate uploads, failed writes preserve config, retry, clear and invalid paths');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('liuxinyu-background-'));
    await fs.rm(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
