const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = {registerExtension(value){this.extension=value;}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../multiline_collapse.js'),'utf8').replace(/^import .*;\r?$/gm,''),{app,queueMicrotask});
const extension=app.extension;
function text(name,height=140){return {name,type:'customtext',value:'saved text',element:{tagName:'TEXTAREA'},computeLayoutSize(){return {minHeight:height,maxHeight:height};}};}
function make(type='LiuxinyuTextFromTemplate') {
  const node={comfyClass:type,inputs:[],outputs:[],widgets:[],size:[300,320],pos:[0,0],graph:{},
    getWidgetFromSlot(input){return this.widgets.find(w=>w.name===input?.widget?.name);},
    getLayoutWidgets(){return this.widgets.filter(w=>!w.hidden);},
    isInputConnected(index){return this.inputs[index]?.link!=null;},
    computeSize(){return [300,20+this.widgets.filter(w=>!w.hidden).reduce((h,w)=>h+(w.computeSize?w.computeSize()[1]:w.computeLayoutSize().minHeight)+4,0)];},
    arrange(){let y=20;for(const w of this.getLayoutWidgets()){w.y=y;w.computedHeight=w.computeSize?w.computeSize()[1]+4:w.computeLayoutSize().minHeight;y+=w.computedHeight;}},
    setSize(size){this.size=size;this.arrange();},setDirtyCanvas(){},
  };
  node.widgets=[text('template',180)];node.inputs=[{name:'template',widget:{name:'template'},link:null}];return node;
}
async function main(){
  for(const type of ['LiuxinyuTextFromTemplate','RunCmd','llm_remote_reply','LLMHarnessBooleanReturn','LLMHarnessImageGenerate']) {
    const node=make(type);extension.nodeCreated(node);await Promise.resolve();
    const full=node.computeSize()[1];node.inputs[0].link=0;node.onConnectionsChange();await Promise.resolve();
    assert(node.size[1]<full);assert.equal(node.widgets[0].hidden,true);assert.equal(node.widgets[0].element.hidden,true);
    assert.equal(node.widgets[0].computeLayoutSize().minHeight,20);assert.equal(node.getLayoutWidgets().length,1);
    const compact=node.size[1];for(let i=0;i<100;i++)node.arrange();assert.equal(node.size[1],compact);
    node.inputs[0].link=null;node.onConnectionsChange();await Promise.resolve();
    assert.equal(node.size[1],full);assert.equal(node.widgets[0].element.hidden,false);assert.equal(node.widgets[0].value,'saved text');
    node.size[1]=600;node.onConnectionsChange();await Promise.resolve();assert.equal(node.size[1],600);
  }
  const node=make();let config=0,connection=0;
  node.onConfigure=()=>{config++;return 23;};node.onConnectionsChange=()=>{connection++;return 17;};
  extension.nodeCreated(node);await Promise.resolve();
  node.inputs=[{name:'t1',link:11},{name:'t2',link:12},{name:'template',widget:{name:'template'},link:null}];node.size[1]=50;
  assert.equal(node.onConfigure(),23);await Promise.resolve();assert.equal(node.widgets[0].hidden,false);assert(node.size[1]>=204);
  node.inputs[2].link=0;assert.equal(node.onConnectionsChange(),17);await Promise.resolve();assert(node.widgets[0].hidden);
  node.inputs.unshift({name:'t0',link:13});node.onConnectionsChange();await Promise.resolve();assert(node.widgets[0].hidden);
  node.inputs[3].link=null;node.onConnectionsChange();await Promise.resolve();assert.equal(node.widgets[0].hidden,false);
  assert.equal(config,1);assert.equal(connection,3);
  const replacement=text('template',120);node.widgets=[replacement];node.inputs[3].link=7;node.onConfigure();await Promise.resolve();
  assert.equal(replacement.computeLayoutSize().minHeight,20,'Replaced promoted widget is discovered');
  node.inputs=[];node.onConnectionsChange();await Promise.resolve();assert.equal(replacement.hidden,false);assert.equal(replacement.computeLayoutSize().minHeight,120);
  const legacy=make('RunCmd');legacy.widgets=[{name:'template',type:'customtext',value:'keep',computeSize(){return [250,120];}}];
  extension.nodeCreated(legacy);await Promise.resolve();legacy.inputs[0].link=8;legacy.onConnectionsChange();await Promise.resolve();
  assert.equal(legacy.widgets[0].computeSize()[1],16,'Legacy row adds its native 4px spacing');assert.equal(legacy.size[1],40);
  const sg=make('uuid');sg.subgraph={_nodes:[]};sg.inputs[0]._widget=sg.widgets[0];sg.inputs[0].link=9;
  app.rootGraph={_nodes:[sg]};extension.afterConfigureGraph();assert.equal(sg.widgets[0].hidden,true);assert(sg.size[1]<100);
  sg.size[1]=900;sg.onConfigure();await Promise.resolve();assert(sg.size[1]<100,'Saved connected blank height is removed on configure');
  const dynamic=make('LiuxinyuDynamicMultilineText');const header={name:'header',computeSize(){return [0,20];}};
  dynamic.widgets.unshift(header);dynamic.inputs[0]._widget=header;dynamic.inputs[0].link=9;
  extension.nodeCreated(dynamic);await Promise.resolve();assert.equal(dynamic.getLayoutWidgets().length,1,'Dedicated text-block header does not get a duplicate compact row');
  const unrelated=make('OtherPluginNode'),old=unrelated.arrange;extension.nodeCreated(unrelated);assert.equal(unrelated.arrange,old);
  const late=make();late.widgets=[];late.inputs=[];extension.nodeCreated(late);await Promise.resolve();
  late.widgets=[text('later')];late.inputs=[{name:'later',widget:{name:'later'},link:3}];late.arrange();assert(late.widgets[0].hidden,'Dynamically added multiline input collapses');
  console.log('PASS: multiline collapse for liuxinyu/harness/subgraphs, names after reordering, replacement/dynamic widgets, legacy sizes, original callbacks and stable height');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
