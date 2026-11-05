const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const layoutSource = fs.readFileSync(path.join(root, 'canvas_background_layout.js'), 'utf8').replace(/export /g, '');
const context = vm.createContext({});
vm.runInContext(layoutSource + ';globalThis.math={mosaicLayout,electricalBlock,separationScore,regionFamily,regionChildren};',context);
const math = context.math;

function sharedLength(tiles) {
  let length = 0;
  for (const a of tiles) for (const b of tiles) if(a !== b && a.image === b.image) {
    if(Math.abs(a.x+a.width-b.x)<1e-9) length += Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
    if(Math.abs(a.y+a.height-b.y)<1e-9) length += Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
  }
  return length;
}

for (const ratios of [Array(6).fill(1),[16/9,.75,1,.5,1.4,1.2]]) {
  const previous=math.electricalBlock(ratios,Array.from({length:21},(_,i)=>i%ratios.length));
  const optimized=math.mosaicLayout(ratios,17);
  assert(sharedLength(optimized.tiles)<sharedLength(previous.tiles),'Independent edge measurement must show less same-image adjacency');
  assert(math.separationScore(optimized)<math.separationScore(previous));
  console.log('Same-image shared edges:',sharedLength(previous.tiles).toFixed(6),'->',sharedLength(optimized.tiles).toFixed(6));
}

// Execute the actual browser worker handler in a real background thread, with a
// small WorkerGlobalScope adapter. No DOM or browser automation is involved.
const workerSource=fs.readFileSync(path.join(root,'canvas_background_worker.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
const worker=new Worker(`
 const {parentPort,workerData}=require('node:worker_threads'),vm=require('node:vm');
 class WorkerGlobalScope {}
 const self=new WorkerGlobalScope();self.postMessage=value=>parentPort.postMessage(value);
 vm.runInNewContext(workerData.layoutSource+String.fromCharCode(10)+workerData.workerSource,{self,WorkerGlobalScope});
 parentPort.on('message',data=>self.onmessage({data}));
`,{eval:true,workerData:{layoutSource,workerSource}});
const compute=data=>new Promise((resolve,reject)=>{
  worker.once('message',resolve);worker.once('error',reject);worker.postMessage(data);
});

function auditHierarchy(hierarchy,ratios) {
  const seen=new Set();let deepest=0;
  function visit(family) {
    if(seen.has(family.id)) return;seen.add(family.id);deepest=Math.max(deepest,family.depth);
    if(family.tiles) {
      for(const t of family.tiles) assert(Math.abs(t.width/t.height/ratios[t.image]-1)<1e-7);
      return;
    }
    for(const children of family.variants) {
      assert.equal(children.length,21);
      assert(Math.abs(children.reduce((sum,c)=>sum+c.size*c.size,0)-1)<1e-12);
      for(const a of children) {
        assert(a.family.depth<family.depth);
        for(const b of children) if(a!==b) {
          const side=Math.abs(a.x+a.size-b.x)<1e-10?['right','left',a.y,b.y]:
            Math.abs(a.y+a.size-b.y)<1e-10?['bottom','top',a.x,b.x]:null;
          if(!side) continue;
          const starts=new Map(b.family.edges[side[1]].map(([lo,hi])=>[
            (side[3]+lo*b.size).toFixed(11),(side[3]+hi*b.size).toFixed(11)]));
          for(const [lo,hi] of a.family.edges[side[0]]) assert.notEqual(starts.get((side[2]+lo*a.size).toFixed(11)),(side[2]+hi*a.size).toFixed(11),'Nested seams never merge two leaf images');
        }
        visit(a.family);
      }
    }
  }
  hierarchy.families.forEach(visit);
  assert.equal(deepest,10);assert(seen.size<100,'Family definitions stay compact at depth 10');
  assert(hierarchy.families.every(f=>Object.values(f.edges).every(edge=>edge.length<1000)));
  const points=[[-3,-2],[0,0],[1,1],[100,-47]];
  const snapshot=points.map(([x,y])=>math.regionFamily(hierarchy,x,y).family.id);
  for(let i=0;i<700;i++) math.regionFamily(hierarchy,i,-i);
  assert(hierarchy.regions.size<=512);
  assert.deepEqual(points.map(([x,y])=>math.regionFamily(hierarchy,x,y).family.id),snapshot,'Region assignment survives eviction and arbitrary visitation');
}

function compactFamilies(hierarchy) {
  const records=new Map();
  function visit(family) {
    if(records.has(family.id)) return;
    records.set(family.id,{id:family.id,depth:family.depth,edges:family.edges,tiles:family.tiles,
      variants:family.variants?.map(children=>children.map(c=>({x:c.x,y:c.y,size:c.size,family:c.family.id})))});
    family.variants?.forEach(children=>children.forEach(c=>visit(c.family)));
  }
  hierarchy.families.forEach(visit);
  return [...records.values()].sort((a,b)=>a.id-b.id);
}

(async()=>{
  try {
    const ratios=[16/9,.75,1,.5,1.4,1.2];
    const result=await compute({ratios,levels:10,seed:17});assert(!result.error,result.error);
    assert.equal(result.hierarchy.depth,10);auditHierarchy(result.hierarchy,ratios);
    const second=await compute({ratios,levels:10,seed:17});
    assert.deepEqual(second.layout,result.layout);assert.deepEqual(compactFamilies(second.hierarchy),compactFamilies(result.hierarchy));
    assert((await compute({ratios:[0],levels:10,seed:17})).error);
    console.log('PASS: same-image separation, real worker, 10-level coverage/proportions/seams, bounded definitions, deterministic spatial choices and worker errors');
  } finally {await worker.terminate();}
})().catch(error=>{console.error(error);process.exitCode=1;});
