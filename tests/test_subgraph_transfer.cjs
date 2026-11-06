const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path');
const bundle=process.argv[2];
if(!bundle)throw new Error('Pass the installed settingStore bundle path');
const source=fs.readFileSync(bundle,'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'Native test method markers must match');return source.slice(a,b);};
const native=between('function findLiveSubgraphIds(','function reorderInPlace(')+between('function unregisterAllLinkTopologies(','function inputHasLink(')+'class NativeGraph {'+between('removeNode(e){','getNodeById(e){')+between('_convertToSubgraphImpl(e){','unpackSubgraph(e,t){')+'};globalThis.NativeGraph=NativeGraph;';
const trace=[];const noop=()=>{};
class Rect extends Array{constructor(...v){super(...v)}}
const registry=new Map();let serial=10000;
function plain(id,type){return {id,type,inputs:[],outputs:[],pos:[0,0],size:[100,60],order:0,isSubgraphNode:()=>false,
 serialize(){return {id:this.id,type:this.type}},configure(s){this.id=s.id},computeSize(){return this.size},setSize(s){this.size=s},setPos(x,y){this.pos=[x,y]},_setConcreteSlots:noop,arrange:noop};}
function host(id,subgraph){return Object.assign(plain(id,subgraph.id),{subgraph,isSubgraphNode:()=>true});}
const context={console,structuredClone,globalThis:null,Al:class{},hc:Rect,Fr:{MidLeft:1,MidRight:2,Centre:4,Middle:8},rc:-10,ic:-20,
 createUuidv4:()=>`created-${++serial}`,createBounds:()=>[0,0,300,300],alignOutsideContainer:noop,alignToContainer:noop,
 getBoundaryLinks:()=>({boundaryLinks:[],boundaryFloatingLinks:[],internalLinks:[],boundaryInputLinks:[],boundaryOutputLinks:[]}),
 splitPositionables:set=>({nodes:[...set].filter(n=>!n.children),reroutes:[],groups:[]}),
 multiClone:nodes=>nodes.map(n=>n.serialize()),mapSubgraphInputsAndLinks:()=>[],mapSubgraphOutputsAndLinks:()=>[],groupResolvedByOutput:()=>new Map(),
 inputHasLink:()=>false,outputHasLinks:()=>false,
 visitGraphNodes:(g,fn)=>g._nodes.forEach(fn),fireNodeRemovalLifecycles:n=>trace.push(['remove-inner-nodes',n.length]),
 unregisterLinkTopology:link=>{trace.push(['DELETE-INNER-LINK',link.id]);link.graph.links.delete(link.id)},
 unregisterAllRerouteChains:noop,detachAllNodesFromStores:noop,graphScopeOf:g=>g.id,
 al:()=>({clearGraph:id=>trace.push(['clearGraph',id]),remove:noop}),ol:()=>({clear:noop}),detachGraphLayouts:noop,
 clearNodeOwnedStoreState:noop,detachNodeFromStores:noop,detachNodeLayout:noop,
 Z:{NODE_TITLE_HEIGHT:30,createNode(type){const g=registry.get(type);return g?host(++serial,g):plain(++serial,type)}},LGraph:{serialisedSchemaVersion:1}};
context.globalThis=context;vm.createContext(context);vm.runInContext(native,context);
function graph(id){const g=new context.NativeGraph();Object.assign(g,{id,state:{},revision:0,config:{},_nodes:[],_nodes_by_id:{},links:new Map(),floatingLinks:new Map(),reroutes:new Map(),subgraphs:new Map(),
 beforeChange:noop,afterChange:noop,events:{dispatch:noop},incrementVersion:noop,canvasAction:noop,setDirtyCanvas:noop,change:noop,updateExecutionOrder:noop,
 get nodes(){return this._nodes},remove(n){this.removeNode(n)},add(n){n.graph=this;this._nodes.push(n);this._nodes_by_id[n.id]=n;},
 createSubgraph(data){const next=graph(data.id);next.rootGraph=this.rootGraph;next.inputNode={arrange:noop,boundingRect:[0,0,75,100]};next.outputNode={arrange:noop,boundingRect:[0,0,75,100]};
 for(const s of data.nodes){const n=context.Z.createNode(s.type);n.configure(s);next.add(n);if(n.subgraph)this.rootGraph.subgraphs.set(n.subgraph.id,n.subgraph)}
 registry.set(next.id,next);this.rootGraph.subgraphs.set(next.id,next);return next;}});g.rootGraph=g;Object.defineProperty(g,'nodes',{get(){return this._nodes}});return g;}
function fixture(shared=false){trace.length=0;registry.clear();const root=graph('root');const groups=[];
 for(const [id,count] of [['prep',22],['validation',31]]){const g=graph(id);g.rootGraph=root;g.add(plain(++serial,'Tool'));
 for(let i=0;i<count;i++){const l={id:++serial,graph:g};g.links.set(l.id,l)}registry.set(id,g);root.subgraphs.set(id,g);groups.push(g);root.add(host(++serial,g));}
 const selected=new Set(root._nodes);if(shared)root.add(host(++serial,groups[0]));return {root,groups,selected};}
function run(shared){const {root,groups,selected}=fixture(shared);const before=groups.map(g=>g.links.size);root._convertToSubgraphImpl(selected);return {before,after:groups.map(g=>g.links.size),deleted:trace.filter(e=>e[0]==='DELETE-INNER-LINK').length,trace:[...trace]};}
const unique=run(false),shared=run(true);
assert.deepEqual(unique.before,[22,31]);assert.deepEqual(unique.after,[0,0]);assert.equal(unique.deleted,53);
assert.deepEqual(shared.after,[22,0]);

console.log('Native reproduction without extensions: [22,31] -> [0,0]; with another reference: [22,31] -> [22,0]');
context.app={registerExtension(extension){context.extension=extension;}};
context.LiteGraph={LGraph:context.NativeGraph};
vm.runInContext(fs.readFileSync(path.join(__dirname,'../subgraph_transfer.js'),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,''),context);
context.extension.setup();
const fixed=run(false);assert.deepEqual(fixed.after,[22,31]);assert.equal(fixed.deleted,0);
assert.deepEqual(run(true).after,[22,31]);
const wrapped=context.NativeGraph.prototype.removeNode;context.extension.setup();assert.equal(context.NativeGraph.prototype.removeNode,wrapped);
// Group-only selection expands to child nodes inside native conversion.
{
 const {root,groups,selected}=fixture();const group=new context.Al();group.children=selected;group.recomputeInsideNodes=noop;
 root._convertToSubgraphImpl(new Set([group]));assert.deepEqual(groups.map(g=>g.links.size),[22,31]);
}
// Real deletion must still release the whole tree, and moved hosts keep their own lifecycle.
{
 const {root,groups,selected}=fixture();let removed=0;for(const node of selected)node.onRemoved=()=>removed++;
 const descriptors=[...selected].map(n=>Object.getOwnPropertyDescriptor(n,'isSubgraphNode'));
 const result=root._convertToSubgraphImpl(selected);assert.equal(removed,2);
 [...selected].forEach((n,i)=>assert.deepEqual(Object.getOwnPropertyDescriptor(n,'isSubgraphNode'),descriptors[i]));
 root.removeNode(result.node);assert.deepEqual(groups.map(g=>g.links.size),[0,0]);assert.equal(root.subgraphs.size,0);
}
// Nested descendants survive moving the parent, not just the first child definition.
{
 const {root,groups,selected}=fixture();const first=[...selected][0];root._nodes.splice(root._nodes.indexOf(first),1);
 const parent=graph('parent');parent.rootGraph=root;parent.add(first);registry.set(parent.id,parent);root.subgraphs.set(parent.id,parent);
 const parentHost=host(++serial,parent);root.add(parentHost);
 root._convertToSubgraphImpl(new Set([parentHost]));assert.deepEqual(groups.map(g=>g.links.size),[22,31]);
}
// Conversion errors never leave the temporary transfer policy enabled.
{
 const {root,groups,selected}=fixture();root.createSubgraph=()=>{throw Error('synthetic conversion failure');};
 assert.throws(()=>root._convertToSubgraphImpl(selected),/synthetic conversion failure/);
 const replacement=host(++serial,groups[0]);root.add(replacement);root.removeNode(replacement);assert.equal(groups[0].links.size,0);
}
console.log('PASS: native nesting retains all 53 links, shared/group/deep nesting, host lifecycle, normal deletion and exception cleanup');
