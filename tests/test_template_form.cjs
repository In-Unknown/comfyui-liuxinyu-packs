const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');
const plain=value=>JSON.parse(JSON.stringify(value));
function context2d(){return {save(){},restore(){},translate(){},beginPath(){},closePath(){},roundRect(){},rect(){},fill(){},stroke(){},fillRect(){},strokeRect(){},fillText(){},clip(){},moveTo(){},lineTo(){},quadraticCurveTo(){},arc(){},setLineDash(){},
  measureText:text=>({width:String(text).length*7,actualBoundingBoxAscent:11,actualBoundingBoxDescent:3,fontBoundingBoxAscent:13,fontBoundingBoxDescent:3}),getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),createLinearGradient:()=>({addColorStop(){}})};}
function harness(){
  let document;class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.style={setProperty(key,value){this[key]=value;}};this.events={};this.className='';this.value='';this.scrollTop=0;this.attrs={};}
    append(...children){for(const child of children){child.parentNode=this;this.children.push(child);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){this.removed=true;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}
    contains(child){return child===this||this.children.some(c=>c.contains(child));}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    removeEventListener(name,fn){this.events[name]=(this.events[name]||[]).filter(f=>f!==fn);}
    setAttribute(name,value){this.attrs[name]=value;}
    get classList(){const self=this;return {add(name){self.className+=' '+name;},remove(name){self.className=self.className.split(' ').filter(s=>s!==name).join(' ');}};}
    querySelectorAll(selector){const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);return all.filter(c=>selector==='*'||selector==='button:not(:disabled)'?selector==='*'||c.tagName==='button'&&!c.disabled:selector.startsWith('.')?c.className.split(' ').includes(selector.slice(1)):c.tagName===selector);}
    querySelector(selector){return this.querySelectorAll(selector)[0];}
    focus(){document.activeElement=this;}select(){}getBoundingClientRect(){return {left:0,top:0,width:300,height:200};}
    getContext(){return context2d();}setPointerCapture(id){this.pointer=id;}hasPointerCapture(id){return this.pointer===id;}releasePointerCapture(){this.pointer=null;}
    fire(name,props={}){const event={target:this,currentTarget:this,preventDefault(){this.prevented=true;},stopPropagation(){},stopImmediatePropagation(){},...props};this['on'+name]?.(event);for(const fn of this.events[name]||[])fn(event);return event;}
  }
  const handlers=new Map(),requests=[],toasts=[],revealed=[],notices=[],forms=[],frames=new Map();let extension,live=[],frameId=0,inspect,activation;
  document=new Element('document');document.body=new Element('body');document.head=new Element('head');document.append(document.head,document.body);
  document.createElement=tag=>new Element(tag);document.getElementById=id=>document.querySelectorAll('*').find(e=>e.id===id);
  document.visibilityState='visible';document.hasFocus=()=>true;
  const canvas={width:800,height:1200,style:{},getBoundingClientRect:()=>({left:0,top:0,width:800,height:1200})};
  const app={rootGraph:{id:'root'},canvas:{canvas},registerExtension(value){extension=value;},extensionManager:{toast:{add(value){toasts.push(value);}}}};
  const context=vm.createContext({app,document,console,queueMicrotask,URL,forms,setTimeout,clearTimeout,requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);},window:{innerWidth:1200,innerHeight:900,focus(){}},
    Notification:class{static permission='granted';static async requestPermission(){return 'granted';}constructor(title,opts){notices.push(this);this.opts=opts;}close(){this.closed=true;this.onclose?.();}},
    revealNode:async match=>revealed.push(match.path),findNodes:()=>[],
    api:{clientId:'test-page',addEventListener(name,fn){handlers.set(name,fn);},async fetchApi(url,options={}){
      if(url.includes('/pending'))return {ok:true,json:async()=>({requests:live})};
      if(url.includes('/notification/'))return {ok:true,json:async()=>activation};
      const body=JSON.parse(options.body);requests.push({url,body});if(url.endsWith('/submit'))live=live.filter(e=>e.request_id!==body.request_id);
      if(url.endsWith('/inspect')&&inspect)return {ok:true,json:async()=>inspect(body)};
      return {ok:true,json:async()=>({schema:body.schema,errors:[]})};
    }},
  });
  vm.runInContext(['canvas_viewport.js','template_form_model.js','template_color_picker.js','template_form_popups.js','template_form_images.js','template_form_files.js','template_form_native.js'].map(source).join('\n')+'\nconst OriginalForm=NativeTemplateForm; NativeTemplateForm=class extends OriginalForm {constructor(...args){super(...args);forms.push(this);}};this.NativeForm=NativeTemplateForm;',context);
  vm.runInContext(['template_form_controller.js','template_form.js'].map(source).join('\n'),context);
  return {context,app,document,handlers,requests,toasts,revealed,notices,forms,frame(){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());},get extension(){return extension;},setLive(value){live=value;},setInspect(fn){inspect=fn;},setActivation(value){activation=value;}};
}
function node(){return {comfyClass:'LiuxinyuTemplateForm',widgets:[{name:'form_state',value:'{}'}],inputs:[{name:'schema',link:42},{name:'form_state',link:null}],outputs:[{name:'填写结果'}],size:[480,200],pos:[0,0],
  graph:{change(){},setDirtyCanvas(){},beforeChange(){},afterChange(){}},setDirtyCanvas(){},
  addCustomWidget(widget){assert.equal(widget.serialize,false);this.widgets.push(widget);return widget;},addDOMWidget(){throw Error('Persistent DOM overlays forbidden');},
  removeWidget(widget){widget.onRemove?.();this.widgets.splice(this.widgets.indexOf(widget),1);},removeInput(index){this.inputs.splice(index,1);},getLayoutWidgets(){return this.widgets.filter(w=>!w.hidden);},
  computeSize(){return [360,24+this.getLayoutWidgets().reduce((t,w)=>t+(w.computeSize?w.computeSize(this.size[0])[1]+4:w.computeLayoutSize?w.computeLayoutSize(this).minHeight:24),0)];},
  setSize(size){this.size=size;},arrange(){let y=24;for(const w of this.getLayoutWidgets()){w.y=y;w.computedHeight=w.computeSize?w.computeSize(this.size[0])[1]+4:w.computeLayoutSize?Math.max(w.computeLayoutSize(this).minHeight,this.size[1]-y):24;y+=w.computedHeight;}},
};}
function fixture(schema,value){const h=harness(),n=node(),changes=[];const view=new h.context.NativeForm(n,v=>changes.push(plain(v)));view.setData(schema,value);view.render();paint(view);return {...h,n,view,changes};}
function paint(view){view.widget.draw(context2d(),view.node,view.node.size[0],0);}
const target=(view,id)=>{paint(view);const t=view.targets.find(t=>t.id===id);assert(t,id);return t;};
const row=(view,path)=>view.rows.find(r=>r.path===path&&r.set&&r.kind!=='handle');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const inputOf=view=>view.popup.root.querySelector('input')||view.popup.root.querySelector('textarea');

test('semantic input menu clears incompatible text and survives saved controller reload',async()=>{
  const h=harness(),n=node(),schema=object({keys:{type:'object',additionalProperties:true}});
  n.widgets[0].value=JSON.stringify({schema,value:{keys:{photo:'input.png'}},confirmed:false});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];v.expanded.set('$/keys',true);v.render(v.chrome);
  let options,choose;v.menu=(_row,_rect,list,callback)=>{options=list;choose=callback;};
  target(v,'$/keys/photo:type').run();
  for(const name of ['图片','文件','日期','时间','日期时间','HEX 颜色'])assert(options.some(o=>o.label===name));
  choose('string:image');paint(v);
  assert.equal(row(v,'$/keys/photo').kind,'image');assert.equal(v.value.keys.photo,'');
  assert.equal(JSON.parse(n.widgets[0].value).input_types['$/keys/photo'],'image');
  const next=node();next.widgets[0].value=n.widgets[0].value;h.extension.nodeCreated(next);await flush();
  const restored=h.forms.at(-1);restored.expanded.set('$/keys',true);restored.render(restored.chrome);
  assert.equal(row(restored,'$/keys/photo').kind,'image');
  await restored.chrome.actions.find(a=>a.label==='校验').run();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/inspect')).at(-1).body.input_types['$/keys/photo'],'image');
  n.onRemoved();next.onRemoved();
});

test('schema-constrained string editor rejects impossible pattern characters and malformed dates as they are typed',()=>{
  const h=harness(),hex={type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},date={type:'string',format:'date'};
  assert.equal(h.context.acceptsSchemaInput(hex,'#3',''),true);
  assert.equal(h.context.acceptsSchemaInput(hex,'#GG',''),false);
  assert.equal(h.context.acceptsSchemaInput(hex,'#336699',''),true);
  assert.equal(h.context.acceptsSchemaInput(date,'2026-02-30',''),false);
  assert.equal(h.context.acceptsSchemaInput(date,'2026-02-2',''),true);
  assert.equal(h.context.acceptsSchemaInput(date,'2026-02-2','',true),false);
  assert.equal(h.context.acceptsSchemaInput(date,'0096-02-29','',true),true);
  assert.equal(h.context.acceptsSchemaInput(date,'0099-02-29','',true),false);
  const f=fixture(object({color:hex}),{color:''}),v=f.view;target(v,'$/color:value').run();const input=inputOf(v);
  input.value='#3';input.fire('input');assert.equal(input.value,'#3');
  input.value='#GG';input.fire('input');assert.equal(input.value,'#3');
  input.value='#336699';input.fire('input');input.fire('keydown',{key:'Enter'});assert.equal(v.value.color,'#336699');
  const dated=fixture(object({date}),{date:''}),dateView=dated.view;target(dateView,'$/date:value').run();const dateInput=inputOf(dateView);
  dateInput.value='2026-02-2';dateInput.fire('input');dateInput.fire('keydown',{key:'Enter'});assert.equal(dateView.value.date,'');assert(dateView.popup);
  dateInput.value='2026-02-28';dateInput.fire('input');dateInput.fire('keydown',{key:'Enter'});assert.equal(dateView.value.date,'2026-02-28');
});

test('dynamic object fields can be renamed without losing their values or nested view state',()=>{
  const f=fixture({type:'object',additionalProperties:{type:'object',additionalProperties:{type:'string'}}},{旧键:{子项:'值'}}),v=f.view;
  v.expanded.set('$/旧键',true);v.render();const member=row(v,'$/旧键');v.renameKey(member);
  const input=inputOf(v);input.value='新键';input.fire('keydown',{key:'Enter'});
  assert.deepEqual(plain(v.value),{'新键':{子项:'值'}});assert.equal(v.expanded.get('$/新键'),true);
});

test('new object list entries start expanded for direct field editing',()=>{
  const f=fixture(object({items:{type:'array',items:object({name:{type:'string'}})}}),{items:[{name:'existing'}]}),v=f.view;
  const list=row(v,'$/items'),width=f.n.size[0],before=f.n.size[1];v.resizeList(list,2);paint(v);assert.equal(v.expanded.get('$/items/1'),true);
  assert(row(v,'$/items/1/name'));assert(f.n.size[1]>before);assert.equal(f.n.size[0],width);
  for(const area of v.lists)assert(area.viewport.h>=area.total,`${area.path}: ${area.viewport.h} < ${area.total}`);
  v.resizeList(row(v,'$/items'),1);paint(v);assert(f.n.size[1]<before+60);assert.equal(f.n.size[0],width);
});

test('enum editor outside save is atomic and invalid drafts keep the menu open',()=>{
  const f=fixture({type:'object',additionalProperties:true},{key:'A'}),v=f.view;
  v.typeChoices.set('$/key','enum');v.fieldEnums.set('$/key',['A','B']);v.render();
  target(v,'$/key:value').run();const menu=v.popup;
  menu.root.querySelectorAll('.menu-option-action')[0].fire('click');const input=inputOf(v);
  input.value='B';menu.outside();assert.equal(v.popup,menu);assert.equal(v.value.key,'A');
  menu.root.querySelectorAll('.menu-item')[1].fire('click');assert.equal(v.value.key,'A');assert.equal(v.popup,menu);
  input.value='C';menu.outside();assert.equal(v.popup,null);assert.equal(v.value.key,'C');
  assert.deepEqual(plain(v.fieldEnums.get('$/key')),['C','B']);v.dispose();
});

test('adding enum options replaces the bottom row and reports errors only beside that editor',()=>{
  const f=fixture({type:'object',additionalProperties:true},{key:'A'}),v=f.view;
  v.typeChoices.set('$/key','enum');v.fieldEnums.set('$/key',['A']);v.render();
  target(v,'$/key:value').run();const menu=v.popup,status=v.chrome.status;
  const add=()=>menu.root.querySelectorAll('.menu-item').at(-1).fire('click');
  add();let input=inputOf(v);assert(input.className.includes('menu-add-editor'));assert.equal(input.parentNode,menu.root.children.at(-1));
  for(const text of ['A',' ']){input.value=text;input.fire('keydown',{key:'Enter'});assert.equal(v.popup,menu);assert(menu.root.querySelector('.menu-option-error').textContent);assert.equal(v.errors.size,0);assert.equal(v.chrome.status,status);}
  input.value='B';input.fire('input');assert.equal(menu.root.querySelector('.menu-option-error').textContent,'');input.fire('keydown',{key:'Enter'});
  assert.equal(v.popup,menu);assert.deepEqual(plain(v.fieldEnums.get('$/key')),['A','B']);assert.equal(v.value.key,'A');
  assert.deepEqual(menu.root.querySelectorAll('.menu-item').map(b=>b.textContent),['A','B','＋ 新增选项']);
  add();input=inputOf(v);input.value='C';input.fire('keydown',{key:'Escape'});assert.equal(v.popup,menu);assert.deepEqual(plain(v.fieldEnums.get('$/key')),['A','B']);assert(!inputOf(v));
  menu.root.querySelectorAll('.menu-option-action')[0].fire('click');input=inputOf(v);input.value='B';input.fire('keydown',{key:'Enter'});
  assert.equal(menu.root.querySelector('.menu-option-error').textContent,'选项已存在');assert.equal(v.errors.size,0);v.dispose();
});

test('renaming and list reindexing preserve file and image settings, clearing types removes descendants',()=>{
  const f=fixture({type:'object',additionalProperties:true},{old:{child:'A'},items:['a','b']}),v=f.view;
  f.n.properties={lxy_template_files:{'$/old/child':{name:'a.bin'},'$/items/0':{name:'first'},'$/items/1':{name:'second'}},lxy_template_image_modes:{'$/old/child':'base64'}};
  v.fieldEnums.set('$/old/child',['A']);v.fieldRequired.set('$/old/child',false);
  v.errors.set('$/unrelated','other field error');
  v.renameKey(row(v,'$/old'));const input=inputOf(v);input.value='new';input.fire('keydown',{key:'Enter'});
  assert.deepEqual(plain(f.n.properties.lxy_template_files['$/new/child']),{name:'a.bin'});
  assert.equal(f.n.properties.lxy_template_image_modes['$/new/child'],'base64');
  v.reindexListState('$/items',i=>1-i);assert.equal(f.n.properties.lxy_template_files['$/items/0'].name,'second');
  v.clearTypeChoices('$/new');assert(!v.fieldEnums.has('$/new/child'));assert(!v.fieldRequired.has('$/new/child'));
  assert(!f.n.properties.lxy_template_files['$/new/child']);assert(!f.n.properties.lxy_template_image_modes['$/new/child']);v.dispose();
});

test('double click renames scalar and container keys while presentation editable keys are stale',()=>{
  for(const value of ['text',{},[]]){
    const f=fixture(object({keys:{type:'object',properties:{fixed:{type:'string'}},'x-editableKeys':[],additionalProperties:true}}),{keys:{fixed:'fixed','1':value}}),v=f.view;
    v.expanded.set('$/keys',true);v.render();
    const label=target(v,'$/keys/1:label');
    v.point=()=>({x:label.rect.x+4,y:label.rect.y+10});
    v.doubleClickListener({target:v.canvas,preventDefault(){},stopImmediatePropagation(){}});
    assert(v.popup,'numeric key should open rename editor');
    const input=inputOf(v);input.value='renamed';input.fire('keydown',{key:'Enter'});
    assert.deepEqual(plain(v.value.keys.renamed),value);assert(!Object.hasOwn(v.value.keys,'1'));
    v.renameKey(row(v,'$/keys/fixed'));assert(!v.popup,'fixed key stays protected');v.dispose();
  }
});

test('same-size field edits and repeated renders do not resize the node',()=>{
  const f=fixture(object({name:{type:'string'}}),{name:'A'}),v=f.view;
  let resized=0;const setSize=f.n.setSize;f.n.setSize=function(size){resized++;setSize.call(this,size);};
  const field=row(v,'$/name');v.commit(field.path,field.set,'B');v.render(v.chrome);v.render(v.chrome);
  assert.equal(v.value.name,'B');assert.equal(resized,0);
  v.setData(object({name:{type:'string',title:'long field label '.repeat(20)}}),{name:'B'});v.render(v.chrome);
  assert(resized>0);v.dispose();
});

test('source rename migrates projected keys with each existing value intact',()=>{
  const schema=object({keys:{type:'object',additionalProperties:true},rows:{type:'array',items:{type:'object',properties:{old:{type:'object',additionalProperties:true}},'x-requiredPropertiesFrom':{pointer:'/keys'}}}});
  const f=fixture(schema,{keys:{old:{count:1}},rows:[{old:{count:9}},{old:{count:22}}]}),v=f.view;
  v.expanded.set('$/keys',true);v.render();v.renameKey(row(v,'$/keys/old'));
  const input=inputOf(v);input.value='new';input.fire('keydown',{key:'Enter'});
  assert.deepEqual(plain(v.value),{keys:{new:{count:1}},rows:[{new:{count:9}},{new:{count:22}}]});v.dispose();
});

test('projected objects cannot add remove or rename their structural fields',()=>{
  const f=fixture({type:'object',properties:{name:{type:'string'}},required:['name'],'x-requiredPropertiesFrom':{pointer:'/keys'},additionalProperties:true},{name:'value'}),v=f.view;
  assert.equal(v.tree.add,null);assert.equal(row(v,'$/name').optional,false);
  v.renameKey(row(v,'$/name'));assert.equal(v.popup,undefined);v.dispose();
});

test('editable fields show required checkbox default on, fixed and projected fields do not',()=>{
  const f=fixture({type:'object',properties:{fixed:{type:'string'}},additionalProperties:true},{fixed:'x',dynamic:'y'}),v=f.view;
  assert(!v.targets.some(t=>t.id==='$/fixed:required'));target(v,'$/dynamic:required').run();
  assert.equal(v.fieldRequired.get('$/dynamic'),false);assert.equal(v.value.dynamic,'y');
  target(v,'$/dynamic:required').run();assert.equal(v.fieldRequired.get('$/dynamic'),true);v.dispose();
});

test('dynamic enum keeps native dropdown rows and manages options through menu commands',()=>{
  const f=fixture({type:'object',additionalProperties:true},{key:'old'}),v=f.view;
  target(v,'$/key:type').run();v.popup.root.querySelectorAll('button').find(b=>b.textContent==='枚举').fire('click');
  assert.equal(v.typeChoices.get('$/key'),'enum');assert.equal(v.value.key,'');
  target(v,'$/key:value').run();
  let items=v.popup.root.querySelectorAll('.menu-item');
  assert.deepEqual(items.map(item=>item.textContent),['＋ 新增选项']);
  assert.equal(v.popup.root.querySelectorAll('.menu-option-action').length,0);
  items[0].fire('click');let input=inputOf(v);input.value='选项一';input.fire('keydown',{key:'Enter'});assert.equal(v.value.key,'选项一');
  items=v.popup.root.querySelectorAll('.menu-item');
  assert.deepEqual(items.map(item=>item.textContent),['选项一','＋ 新增选项']);
  assert.equal(items[0].attrs['aria-selected'],'true');
  assert.equal(items[0].parentNode.parentNode,v.popup.root);
  assert(v.popup.root.querySelectorAll('.menu-option-action').every(b=>b.innerHTML.includes('<svg')&&!b.textContent));
  v.popup.root.querySelectorAll('.menu-option-action')[0].fire('click');input=inputOf(v);input.value='修改后的选项';input.fire('keydown',{key:'Enter'});
  assert.deepEqual(plain(v.fieldEnums.get('$/key')),['修改后的选项']);assert.equal(v.value.key,'修改后的选项');
  assert(v.popup.root.className.includes('lxy-form-menu'));v.popup.root.querySelectorAll('.menu-option-action').find(b=>b.title==='删除').fire('click');assert.equal(v.value.key,'');assert.deepEqual(plain(v.fieldEnums.get('$/key')),[]);
  target(v,'$/key:type').run();v.popup.root.querySelectorAll('button').find(b=>b.textContent==='字符串').fire('click');
  assert.equal(row(v,'$/key').kind,'string');assert(!v.fieldEnums.has('$/key'));v.dispose();
});

test('enum metadata survives controller storage and inspection',async()=>{
  const h=harness(),n=node();n.widgets[0].value=JSON.stringify({schema:{type:'object',additionalProperties:true},value:{key:'A'},input_types:{'$/key':'enum'},field_enums:{'$/key':['A','B']}});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];assert.equal(row(v,'$/key').kind,'enum');assert.deepEqual(plain(v.fieldEnums.get('$/key')),['A','B']);
  await v.chrome.actions.find(a=>a.label==='校验').run();assert.deepEqual(plain(h.requests.filter(r=>r.url.endsWith('/inspect')).at(-1).body.field_enums),{'$/key':['A','B']});n.onRemoved();
});

test('editable enum reuses menu styling toggle and rejects invalid edits without changing options',()=>{
  const f=fixture({type:'object',additionalProperties:true},{key:'A'}),v=f.view;
  v.typeChoices.set('$/key','enum');v.fieldEnums.set('$/key',['A','B']);v.render();
  target(v,'$/key:value').run();
  assert(v.popup.root.className.includes('lxy-form-menu'));
  assert.equal(v.popup.triggerId,'$/key:value');assert.equal(v.popup.root.style.visibility,'hidden');
  target(v,'$/key:value').run();assert.equal(v.popup,null);
  const openEdit=()=>{if(!v.popup)target(v,'$/key:value').run();v.popup.root.querySelectorAll('.menu-option-action').find(b=>b.attrs['aria-label']==='修改：'+v.value.key).fire('click');return inputOf(v);};
  let input=openEdit();input.value='B';input.fire('keydown',{key:'Enter'});
  assert.equal(v.value.key,'A');assert.deepEqual(plain(v.fieldEnums.get('$/key')),['A','B']);assert.equal(input.attrs['aria-invalid'],'true');
  input.value='  ';input.fire('keydown',{key:'Enter'});assert.equal(v.value.key,'A');
  input.value='C';input.fire('keydown',{key:'Escape'});assert.equal(v.value.key,'A');
  v.popup.root.querySelectorAll('button').find(b=>b.textContent==='B').fire('click');assert.equal(v.value.key,'B');
  input=openEdit();input.value='C';input.fire('keydown',{key:'Enter'});assert.equal(v.value.key,'C');assert.deepEqual(plain(v.fieldEnums.get('$/key')),['A','C']);
  assert.equal(v.valueMinimum(row(v,'$/key')),Math.max(v.menuMinimum(['A','C'])+40*(14/12),v.menuMinimum(['＋ 新增选项'])));
  const menu=v.popup;v.popup.root.querySelectorAll('.menu-option-action').find(b=>b.attrs['aria-label']==='修改：A').fire('click');assert.equal(v.popup,menu);
  input=inputOf(v);input.value='D';input.fire('keydown',{key:'Enter'});assert.equal(v.value.key,'C');assert.deepEqual(plain(v.fieldEnums.get('$/key')),['D','C']);
  assert.equal(input.parentNode.className,'menu-option-row');
  const pick=v.popup.root.querySelectorAll('.menu-item')[0],icon=v.popup.root.querySelectorAll('.menu-option-action')[0];pick.fire('pointermove');assert(pick.className.includes('is-highlighted'));icon.fire('pointerenter');assert(!pick.className.includes('is-highlighted'));
  assert(v.popup.root.querySelectorAll('.menu-item').at(-1).className.includes('menu-add'));
  v.popup.root.querySelectorAll('.menu-option-action').find(b=>b.attrs['aria-label']==='删除：D').fire('click');assert.equal(v.value.key,'C');assert.deepEqual(plain(v.fieldEnums.get('$/key')),['C']);v.dispose();
});

test('required overrides survive saved controller reload and reach inspection',async()=>{
  const h=harness(),n=node(),schema={type:'object',additionalProperties:true};
  n.widgets[0].value=JSON.stringify({schema,value:{key:'value'},confirmed:false});h.extension.nodeCreated(n);await flush();
  const v=h.forms[0];target(v,'$/key:required').run();
  assert.equal(JSON.parse(n.widgets[0].value).field_required['$/key'],false);
  const next=node();next.widgets[0].value=n.widgets[0].value;h.extension.nodeCreated(next);await flush();
  const restored=h.forms.at(-1);assert.equal(restored.fieldRequired.get('$/key'),false);
  await restored.chrome.actions.find(a=>a.label==='校验').run();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/inspect')).at(-1).body.field_required['$/key'],false);
  n.onRemoved();next.onRemoved();
});

test('diagnostics scroll first while fitting form content stays fully visible',()=>{
  const f=fixture(object({items:{type:'array',items:{type:'string'}}}),{items:['a','b','c']}),v=f.view;
  v.chrome.errors=Array.from({length:77},(_,i)=>({path:'items',message:'错误 '+i}));v.layout(600,500);
  const content=v.lists.find(a=>a.path==='$/items'),errors=v.lists.find(a=>a.path==='@diagnostics');
  assert.equal(content.viewport.h,content.total);assert(errors.viewport.h>=72);assert(errors.total>errors.viewport.h);assert(v.height<=501);
  v.scroll.set('@diagnostics',200);v.layout(600,500);assert.equal(v.lists.find(a=>a.path==='@diagnostics').offset,200);
  v.layout(600,10000);assert.equal(v.lists.find(a=>a.path==='@diagnostics').total,v.lists.find(a=>a.path==='@diagnostics').viewport.h);v.dispose();
});

test('presented dynamic keys remain renameable and reject invalid property names',()=>{
  const f=fixture({type:'object',properties:{old:{type:'integer'}},'x-editableKeys':['old'],propertyNames:{pattern:'^[a-z]+$',minLength:3}}, {old:7}),v=f.view;
  v.renameKey(row(v,'$/old'));let input=inputOf(v);input.value='ab';input.fire('keydown',{key:'Enter'});
  assert.deepEqual(plain(v.value),{old:7});assert(v.popup);
  input.value='new';input.fire('keydown',{key:'Enter'});assert.deepEqual(plain(v.value),{new:7},v.chrome.status);v.dispose();
});

test('repeated fifth-item expansion keeps layout bounded across nested lists',()=>{
  const member=object({details:{type:'array',items:object({name:{type:'string'}})}});
  const f=fixture(object({items:{type:'array',items:member}}),{items:Array.from({length:20},()=>({details:Array.from({length:5},()=>({name:'value'}))}))}),v=f.view;
  for(let i=0;i<100;i++){v.expanded.set('$/items/4',i%2===0);v.render();paint(v);assert(Number.isFinite(v.height));assert(v.rows.length<1000);}
  v.dispose();
});

test('the fifth nested list object expands and lays out its descendants',()=>{
  const member=object({name:{type:'string'},details:{type:'array',items:object({value:{type:'string'}})}});
  const f=fixture(object({items:{type:'array',items:member}}),{items:Array.from({length:5},(_,i)=>({name:`item-${i}`,details:[{value:`value-${i}`}]}))}),v=f.view;
  v.expanded.set('$/items',true);v.expanded.set('$/items/4',true);v.expanded.set('$/items/4/details',true);v.expanded.set('$/items/4/details/0',true);v.render();paint(v);
  assert(row(v,'$/items/4/name'));assert(row(v,'$/items/4/details/0/value'));
});

test('date and color semantic selections retain their type selector and dedicated picker',()=>{
  for(const mode of ['date','time','date-time','color','file']){
    const {view}=fixture(object({value:true}),{value:'old value'});let choose;
    view.menu=(_row,_rect,_list,callback)=>choose=callback;
    target(view,'$/value:type').run();choose('string:'+mode);paint(view);assert.equal(view.value.value,'');
    assert(target(view,'$/value:type'));
    if(mode==='file')assert.equal(row(view,'$/value').kind,'file');
    else assert(target(view,'$/value:picker'));
    target(view,'$/value:type').run();choose('string');paint(view);
    assert.equal(row(view,'$/value').kind,'string');assert.equal(row(view,'$/value').schema.format,undefined);
    view.dispose();
  }
});

test('nested projected fields use a distinct recursive-projection marker',()=>{
  const source={type:'object',properties:{outer:{type:'object',additionalProperties:{type:'string'}}}},value={outer:{inner:{}}};
  const schema={type:'object',properties:{outer:{type:'object',properties:{inner:{type:'object',additionalProperties:{type:'string'},'x-requiredPropertiesFrom':{pointer:'/outer'}}},'x-requiredPropertiesFrom':{pointer:'/outer'}}}};
  const f=fixture(schema,value),v=f.view;v.expanded.set('$/outer/inner',true);v.render();paint(v);
  const nested=row(v,'$/outer/inner');assert.equal(nested.recursiveProjected,true);
  assert(v.targets.some(t=>t.id==='$/outer/inner:projection'&&t.hint.includes('递归投影')));
});

test('file auto mode uses original byte size and strict 512 KiB boundary',async()=>{
  const h=harness(),calls=[];h.context.FormData=FormData;
  h.context.FileReader=class{readAsDataURL(){this.result='data:application/octet-stream;base64,YWJj';this.onload();}};
  h.context.api.fetchApi=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({name:'report.pdf',subfolder:'template_form_files'})};};
  assert.equal(h.context.fileStorageMode(null,524287),'base64');assert.equal(h.context.fileStorageMode(null,524288),'link');
  assert.equal(h.context.fileStorageMode('link',0),'link');assert.equal(h.context.fileStorageMode('base64',900000),'base64');
  const small=await h.context.storeFormFile(new File(['abc'],'report.pdf'),null);
  assert.equal(small.value,'YWJj');assert.equal(small.display,'report.pdf');assert.equal(calls.length,0);
  const big=await h.context.storeFormFile(new File([new Uint8Array(524288)],'report.pdf'),null);
  assert.equal(big.value,'template_form_files/report.pdf');assert.equal(big.display,big.value);assert.equal(calls.length,1);
});

test('file field stays single line and accepts non-image clipboard files',()=>{
  const {view,document}=fixture(object({file:{type:'string','x-file':{}},note:{type:'string'}}),{file:'',note:''});
  assert.equal(row(view,'$/file').kind,'file');assert.equal(row(view,'$/file').height,24);
  const field=target(view,'$/file:file');view.hover=field.id;
  let received;view.setFile=(row,file)=>{received=file;};
  const file={name:'report.pdf',type:'application/pdf'};
  const event=document.fire('paste',{clipboardData:{items:[{kind:'file',type:file.type,getAsFile:()=>file}]}});
  assert(event.prevented);assert.equal(received,file);
  view.value.file='template_form_files/report.pdf';view.render();paint(view);
  assert.equal(row(view,'$/file').height,24);assert.equal(target(view,'$/file:file').hint,view.value.file);
});

test('image fields reserve layout space and target only image paste without changing normal strings',()=>{
  const {view,document}=fixture(object({photo:{type:'string','x-image':{source:'path'}},note:{type:'string'}}),{photo:'',note:''});
  const image=target(view,'$/photo:image'),note=target(view,'$/note:value');
  assert.equal(row(view,'$/photo').kind,'image');
  assert.equal(row(view,'$/note').kind,'string');
  assert(note.rect.y>=image.rect.y+image.rect.h+4);
  let received;view.setImageFile=(field,file)=>{received={path:field.path,file};};
  const file={type:'image/png'},clipboardData={items:[{kind:'file',type:'image/png',getAsFile:()=>file}]};
  const first=document.fire('paste',{clipboardData});assert(!first.prevented);assert(!received);
  view.hover=image.id;const second=document.fire('paste',{clipboardData});assert(second.prevented);assert.equal(received.path,'$/photo');
  received=null;document.fire('paste',{target:{tagName:'INPUT'},clipboardData});assert(!received);
  view.dispose();assert.equal(document.events.paste.length,0);
});

test('populated image header controls remain single-line above preview with matching menu anchor',()=>{
  const f=fixture(object({photo:{type:'string','x-image':{}}}),{photo:'image.png'}),v=f.view;
  const drawn=[],text=v.text.bind(v);v.text=(ctx,label,x,y,width,color,height,...rest)=>{drawn.push({label,y,height});return text(ctx,label,x,y,width,color,height,...rest);};
  const preview=target(v,'$/photo:image'),clear=target(v,'$/photo:image-clear'),mode=target(v,'$/photo:image-mode');
  for(const t of [clear,mode]){assert.equal(t.rect.h,20);assert(t.rect.y+t.rect.h<=preview.rect.y);assert.equal(v.hit({x:t.rect.x+5,y:t.rect.y+10}).id,t.id);}
  assert(drawn.some(x=>x.label==='清空'&&x.height===20));assert(drawn.some(x=>x.label==='自动'&&x.height===20));
  const anchor=v.anchor(mode.row,mode.rect)();assert.equal(anchor.height,20);mode.run();assert.equal(v.popup.triggerId,'$/photo:image-mode');
  v.popup.close();clear.run();paint(v);assert.equal(v.value.photo,'');assert(!v.targets.some(t=>t.id==='$/photo:image-clear'));v.dispose();
});

test('all editable value kinds rename by label double click and preserve values and metadata',()=>{
  const cases=[['text','hello'],['integer',2],['number',1.5],['boolean',true],['null',null],['object',{child:'value'}],['array',['value']],['enum','A'],['image','image.png'],['file','file.bin'],['date','2026-11-20'],['time','12:30:00Z'],['date-time','2026-11-20T12:30:00Z'],['color','#123456']];
  for(const [mode,value] of cases){
    const f=fixture(object({keys:{type:'object',additionalProperties:true}}),{keys:{'1':value}}),v=f.view,path='$/keys/1';
    if(!['text','object','array','null'].includes(mode))v.typeChoices.set(path,mode);
    if(mode==='enum')v.fieldEnums.set(path,['A','B']);
    v.fieldRequired.set(path,false);v.expanded.set('$/keys',true);v.render();
    const label=target(v,path+':label');v.point=()=>({x:label.rect.x+2,y:label.rect.y+10});
    v.doubleClickListener({target:v.canvas,preventDefault(){},stopImmediatePropagation(){}});
    assert(v.popup,mode+' rename opens');const input=inputOf(v);input.value='new/key~';input.fire('keydown',{key:'Enter'});
    assert(!Object.hasOwn(v.value.keys,'1'),mode);assert.deepEqual(plain(v.value.keys['new/key~']),value,mode);
    assert.equal(v.fieldRequired.get('$/keys/new~1key~0'),false,mode);
    if(mode==='enum')assert.deepEqual(plain(v.fieldEnums.get('$/keys/new~1key~0')),['A','B']);v.dispose();
  }
});

test('wheel hands remaining motion to outer lists and releases canvas zoom at both boundaries',()=>{
  const f=fixture({type:'array',items:{type:'string'}},[]),v=f.view;
  const rect={x:0,y:0,w:100,h:100};v.point=()=>({x:50,y:50});v.layout=()=>{};
  const outer={path:'outer',viewport:rect,total:500,offset:20},inner={path:'inner',viewport:rect,total:200,offset:90};
  v.lists=[outer,inner];
  const wheel=(deltaY,deltaMode=0)=>{let prevented=false;v.wheel({target:v.canvas,deltaY,deltaMode,preventDefault(){prevented=true;},stopImmediatePropagation(){}});return prevented;};
  assert(wheel(30));assert.equal(v.scroll.get('inner'),100);assert.equal(v.scroll.get('outer'),40);
  inner.offset=100;outer.offset=40;assert(wheel(20));assert.equal(v.scroll.get('outer'),60);
  inner.offset=0;outer.offset=60;assert(wheel(-20));assert.equal(v.scroll.get('outer'),40);
  inner.offset=5;outer.offset=40;assert(wheel(-10));assert.equal(v.scroll.get('inner'),0);assert.equal(v.scroll.get('outer'),35);
  inner.offset=outer.offset=0;assert.equal(wheel(-10),false);
  inner.offset=100;outer.offset=400;assert.equal(wheel(10),false);
  inner.offset=0;outer.offset=0;assert(wheel(1,1));assert.equal(v.scroll.get('inner'),16);
  assert(wheel(1,2));assert.equal(v.scroll.get('inner'),100);
  inner.clip={x:200,y:200,w:100,h:100};assert(wheel(20));assert.equal(v.scroll.get('outer'),20);v.dispose();
});

test('image conversion honors explicit source and refuses unsafe paths',()=>{
  const h=harness();h.context.api.apiURL=value=>value;h.context.URLSearchParams=URLSearchParams;h.context.window.location={href:'http://localhost:8188/'};
  const preview=(source,value,extra={})=>h.context.imagePreviewURL({'x-image':{source},...extra},value);
  assert.match(preview('path','template_form/a.png'),/filename=a.png.*subfolder=template_form/);
  assert.match(h.context.imageThumbnailURL({'x-image':{source:'path'}},'template_form/a.png'),/image\/thumbnail\?path=template_form%2Fa.png/);
  assert.equal(preview('url','https://example.com/a.png'),'https://example.com/a.png');
  assert.equal(preview('base64','YWJj',{contentMediaType:'image/jpeg'}),'data:image/jpeg;base64,YWJj');
  assert.equal(preview('data-url','data:image/png;base64,YWJj'),'data:image/png;base64,YWJj');
  assert.match(preview('path','C:\\images\\photo.png'),/template_form\/image\?path=C%3A%5Cimages%5Cphoto.png/);
  assert.throws(()=>preview('path','../secret.png'));
  assert.throws(()=>preview('url','javascript:alert(1)'));
  assert.throws(()=>preview('data-url','data:text/html;base64,YWJj'));
});

test('image input defaults depend on origin; explicit menu overrides both origins',()=>{
  const h=harness(),mode=h.context.imageInputMode;
  assert.equal(mode(null,'file'),'path');
  assert.equal(mode(null,'paste',false),'data-url');
  assert.equal(mode(null,'paste',true),'data-url');
  assert.equal(mode('link','paste',false),'path');
  assert.equal(mode('copy','file'),'copy');
  assert.equal(mode('base64','file'),'data-url');
  assert.equal(h.context.clipboardImageReference({getData:type=>type==='text/plain'?'https://example.com/a.png':''}),'https://example.com/a.png');
  assert.equal(h.context.clipboardImageReference({getData:()=>''}),'');
});

test('stale widget paint dimensions cannot push fields or footer outside the node after resume',()=>{
  const {view,n,document}=fixture(object({photo:{type:'string','x-image':{}},note:{type:'string'}}),{photo:'',note:''});
  view.render({actions:[{label:'校验',run(){}},{label:'复位到模板',run(){}}]});
  n.size=[480,300];view.widget.computedHeight=700;
  view.widget.draw(context2d(),n,900,24);
  assert.equal(view.width,480);
  for(const t of view.targets)assert(t.rect.x+t.rect.w<=480,t.id);
  const footer=view.rows.find(r=>r.kind==='footer');assert(footer.rect.y+footer.rect.h<=276);
  view.hover='$/photo:image';view.pressed='$/photo:image';
  document.fire('visibilitychange');assert.equal(view.hover,null);assert.equal(view.pressed,null);
  assert.deepEqual(plain(view.value),{photo:'',note:''});
  view.dispose();assert.equal(document.events.visibilitychange.length,0);
});

test('empty image is a normal row; populated image expands and clearing restores height',()=>{
  const {view}=fixture(object({photo:{type:'string','x-image':{}},note:{type:'string'}}),{photo:'',note:''});
  assert.equal(row(view,'$/photo').height,24);
  const menu=target(view,'$/photo:image-mode');menu.run();
  const options=view.popup.root.querySelectorAll('button');assert(options.some(button=>button.textContent==='Base64'));
  view.popup.close();view.value.photo='data:image/png;base64,YWJj';view.render();
  assert.equal(row(view,'$/photo').height,156);
  target(view,'$/photo:image-clear').run();
  assert.equal(view.value.photo,'');assert.equal(row(view,'$/photo').height,24);
});

test('image copy uploads while original path mode never uploads and Base64 stays embedded',async()=>{
  const h=harness(),calls=[];
  h.context.FormData=FormData;h.context.URLSearchParams=URLSearchParams;
  h.context.window.location={href:'http://localhost:8188/'};h.context.api.apiURL=value=>value;
  h.context.createImageBitmap=async()=>({close(){}});
  h.context.api.fetchApi=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({name:'photo (1).png',subfolder:'template_form'})};};
  const file=new Blob(['image'],{type:'image/png'});
  const convert=source=>h.context.imageFileValue({'x-image':{source},contentMediaType:'image/png'},file);
  assert.equal(await convert('copy'),'template_form/photo (1).png');
  assert.equal(calls[0].url,'/upload/image');assert.equal(calls[0].options.body.get('type'),'input');
  const url=new URL(await convert('url'));assert.equal(url.searchParams.get('filename'),'photo (1).png');
  h.context.FileReader=class{readAsDataURL(){this.result='data:image/png;base64,YWJj';this.onload();}};
  assert.equal(await convert('base64'),'YWJj');assert.equal(await convert('data-url'),'data:image/png;base64,YWJj');assert.equal(calls.length,2);
  await assert.rejects(()=>h.context.imageFileValue({'x-image':{source:'base64'},contentMediaType:'image/jpeg'},file),/contentMediaType/);
  await assert.rejects(()=>convert('path'),/系统文件选择器/);
  h.context.api.fetchApi=async()=>({ok:false,status:413});await assert.rejects(()=>convert('copy'),/413/);
});

test('single canvas member: labels and values align, slider stays on the number row; fold releases height',()=>{
  const schema=object({name:{type:'string'},count:{type:'integer',minimum:1,maximum:10},flag:{type:'boolean'},group:object({note:{type:'string'}})});
  const {view,n}=fixture(schema,{name:'demo',count:2,flag:true,group:{note:'nested'}});
  assert.equal(n.widgets.filter(w=>w.serialize===false).length,1);
  const number=target(view,'$/count:value'),slider=target(view,'$/count:slider');assert.equal(number.rect.y,slider.rect.y);
  assert.equal(target(view,'$/name:value').rect.x,target(view,'$/group/note:value').rect.x);
  const height=n.size[1];target(view,'$/group:fold').run();assert(n.size[1]<height);target(view,'$/group:fold').run();assert.equal(n.size[1],height);
  view.render();assert.equal(n.size[1],height);view.dispose();assert.equal(n.widgets.length,1);
});

test('drawing establishes text baselines and centers small icons and button captions',()=>{
  const {view}=fixture({type:'string'},'value'),ctx=context2d(),texts=[],points=[];
  ctx.textBaseline='top';ctx.textAlign='right';
  ctx.fillText=function(text,x,y){texts.push({text,x,y,baseline:this.textBaseline,align:this.textAlign});};
  ctx.moveTo=(x,y)=>points.push([x,y]);ctx.lineTo=(x,y)=>points.push([x,y]);
  view.button(ctx,{path:'$'},'small',{x:10,y:20,w:18,h:18},'+',()=>{});
  assert.deepEqual(points,[[15,29],[23,29],[19,25],[19,33]]);
  view.button(ctx,{path:'$'},'caption',{x:10,y:50,w:90,h:24},'确认',()=>{});
  assert.deepEqual(texts.at(-1),{text:'确认',x:55,y:66,baseline:'alphabetic',align:'center'});
  view.valueBox(ctx,{path:'$'},{x:10,y:80,w:90,h:24},'value',()=>{});
  assert.deepEqual(texts.at(-1),{text:'value',x:16,y:96,baseline:'alphabetic',align:'left'});
});

test('key/value leaders only occupy the label gap and add no hit regions',()=>{
  const {view}=fixture(object({name:{type:'string'}}),{name:'text'}),ctx=context2d(),lines=[],dashes=[];
  ctx.moveTo=(x,y)=>lines.push([x,y]);ctx.lineTo=(x,y)=>lines.push([x,y]);ctx.setLineDash=d=>dashes.push(d);
  const field=row(view,'$/name'),count=view.targets.length;view.drawRow(ctx,field);
  assert.deepEqual(plain(dashes),[[3,3]]);assert.equal(lines[0][1],field.rect.y+12);assert.equal(lines[1][1],field.rect.y+12);
  assert(lines[0][0]>view.labelStart(field)+ctx.measureText(field.label).width);assert(lines[1][0]<view.valueColumn);
  assert.equal(view.targets.length-count,2,'only label and value targets');
});

test('list peers interpolate, reverse without a jump, and settle after release',()=>{
  const f=fixture({type:'array',items:{type:'integer'}},[1,2,3]),v=f.view;
  const handle=target(v,'$:drag0'),cursor={eDown:{clientX:handle.rect.x+4,clientY:handle.rect.y+10}};
  v.pointerDown(cursor,f.app.canvas);cursor.onDrag({clientX:50,clientY:v.lists[0].viewport.y+v.lists[0].viewport.h-2});
  const entry=v.listMotion.entries.get(1),start=entry.start;
  assert.equal(v.motionOffset(1,start),0);assert(v.motionOffset(1,start+80)<0);assert(v.motionOffset(1,start+80)>entry.to);assert.equal(v.motionOffset(1,start+160),entry.to);
  entry.start=Date.now()-80;const before=v.motionOffset(1);v.animateList('$',new Map([[1,0]]));
  assert(Math.abs(v.motionOffset(1)-before)<2,'retarget from current visual position');
  cursor.onDragEnd();cursor.finally();assert.deepEqual(plain(v.value),[2,3,1]);
  assert(v.listMotion);for(const [index,e] of v.listMotion.entries)assert.equal(v.motionOffset(index,e.start+160),0);
  v.cancelGesture();assert.equal(v.listMotion,null);assert.equal(v.motionFrame,null);
});

test('fields share centers and right edges at different widths; menus reserve their arrow and sliders match the track',()=>{
  const f=fixture(object({name:{type:'string'},v:object({x:{type:'number'},y:{type:'number'},z:{type:'number'}}),n:{type:'number',minimum:0,maximum:1},e:{enum:['a very long menu value that must not overlap the arrow']}}),{name:'name',v:{x:1,y:2,z:3},n:.5,e:'a very long menu value that must not overlap the arrow'});
  for(const width of [360,480,720]){
    f.n.size[0]=width;f.view.render();
    const name=target(f.view,'$/name:value').rect,last=target(f.view,'$/v:axisz').rect,number=target(f.view,'$/n:value').rect;
    assert(Math.abs(last.x+last.w-name.x-name.w)<1e-8);assert.equal(number.x+number.w,name.x+name.w);
    const menu=target(f.view,'$/e:value'),ctx=context2d(),texts=[];ctx.fillText=(text,x,y)=>texts.push({text,x,y});f.view.drawRow(ctx,menu.row);
    const text=texts.at(-1);assert(text.x+ctx.measureText(text.text).width<=menu.rect.x+menu.rect.w-16*14/13);
    const slider=target(f.view,'$/n:slider'),c={eDown:{clientX:slider.rect.x+4,clientY:slider.rect.y+12}};
    f.view.pointerDown(c,f.app.canvas);c.onClick(c.eDown);assert.equal(f.view.value.n,0);
    const s=target(f.view,'$/n:slider'),d={eDown:{clientX:s.rect.x+s.rect.w-4,clientY:s.rect.y+12}};f.view.pointerDown(d,f.app.canvas);d.onClick(d.eDown);assert.equal(f.view.value.n,1);
  }
});

test('inline editor dimensions, text size and inset follow canvas zoom rather than a fixed minimum height',()=>{
  const f=fixture({type:'string'},'value');target(f.view,'$:value').run();
  for(const zoom of [.5,1,2]){
    f.view.matrix={a:zoom,b:0,c:0,d:zoom,e:100,f:100};f.frame();
    const style=f.view.popup.root.style;assert.equal(style.height,`${20*zoom}px`);assert.equal(style.transform,'none');assert.equal(Number.parseFloat(style.width),target(f.view,'$:value').rect.w*zoom);
  }
  const count=fixture({type:'array',items:{type:'string'}},[]);target(count.view,'$:count').run();
  for(const zoom of [.5,1,2]){
    count.view.matrix={a:zoom,b:0,c:0,d:zoom,e:0,f:0};count.frame();
    assert.equal(count.view.popup.root.style.height,`${20*zoom}px`);assert.equal(count.view.popup.root.style.transform,'none');
  }
});

test('Inspector ruler survives nested lists and optional controls; a list selection is one whole item',()=>{
  const member={type:'object',properties:{code:{type:'string'},note:{type:'string'},missing:{type:'string'}},required:['code'],additionalProperties:false};
  const f=fixture(object({name:{type:'string'},group:object({items:{type:'array',items:member}})}),{name:'top',group:{items:[{code:'a',note:'first'},{code:'b',note:'second'}]}});
  const v=f.view;v.expanded.set('$/group/items',true);v.expanded.set('$/group/items/0',true);v.expanded.set('$/group/items/1',true);v.selected.set('$/group/items',0);v.manualHeight=1000;
  for(const width of [360,480,720]){
    f.n.size[0]=width;v.render();
    const first=target(v,'$/name:value').rect;
    for(const path of ['$/group/items/0/code','$/group/items/0/note','$/group/items/1/code']){
      const value=target(v,path+':value').rect;assert.equal(value.x,first.x);assert(value.x+value.w<first.x+first.w);
      const label=target(v,path+':label').rect;assert(label.x+label.w<value.x);
    }
    const note=target(v,'$/group/items/0/note:value').rect,remove=target(v,'$/group/items/0/note:presence').rect;assert(remove.x>=note.x+note.w);assert(remove.x+remove.w<=width-18);
    const add=target(v,'$/group/items/0/missing:presence').rect;assert.equal(add.x,first.x);
    const selections=v.rows.filter(r=>r.kind==='listSelection');assert.equal(selections.length,2);assert.equal(selections[0].rect.y+selections[0].rect.h,selections[1].rect.y);
    assert(v.rows.some(r=>r.path==='$/group/items/1'&&r.label==='b'&&r.description.includes('元素 1')));
    const fills=[],ctx=context2d();ctx.fillRect=function(x,y,w,h){if(this.fillStyle==='#505050')fills.push({x,y,w,h});};v.draw(ctx);
    assert.equal(fills.length,1);assert.deepEqual(fills[0],plain(selections[0].rect));
    assert.equal(v.hit({x:add.x+4,y:add.y+4}).id,'$/group/items/0/missing:presence');
  }
});

test('menus match trigger width and scale, indicate the selected typed value and navigate without changing it',()=>{
  const f=fixture({enum:[1,'1',false]},false);target(f.view,'$:value').run();f.frame();
  const root=f.view.popup.root,buttons=root.querySelectorAll('button');assert(root.className.includes('lxy-form-menu'));
  assert(Math.abs(parseFloat(root.style.width)*(14/12)-target(f.view,'$:value').rect.w)<.01);assert.equal(root.style.transform,'scale('+14/12+')');assert.equal(buttons[2].attrs['aria-selected'],'true');assert.equal(f.document.activeElement,buttons[2]);
  root.fire('keydown',{key:'Home'});assert.equal(f.document.activeElement,buttons[0]);assert.equal(f.view.value,false);
  root.fire('keydown',{key:'End'});assert.equal(f.document.activeElement,buttons[2]);root.fire('keydown',{key:'ArrowDown'});assert.equal(f.document.activeElement,buttons[0]);
  buttons[0].fire('click');assert.equal(f.view.value,1);assert(!f.view.popup);
});

test('menu opener toggles after document capture without reopening, and other controls still open',()=>{
  const f=fixture(object({a:{enum:['a','b']},b:{enum:['c','d']}}),{a:'a',b:'c'}),v=f.view;
  function click(id){
    const t=target(v,id),event={target:v.canvas,clientX:t.rect.x+8,clientY:t.rect.y+10,button:0};
    f.document.fire('pointerdown',event);
    const cursor={eDown:event};v.pointerDown(cursor,f.app.canvas);cursor.onClick?.(event);cursor.finally?.();
  }
  click('$/a:value');const first=v.popup;assert(first);
  click('$/a:value');assert.equal(v.popup,null);assert(first.root.removed);
  click('$/a:value');assert(v.popup);
  click('$/b:value');assert.equal(v.popup.triggerId,'$/b:value');
  v.popup.root.fire('keydown',{key:'Escape'});assert.equal(v.popup,null);
  click('$/a:value');f.document.fire('pointerdown',{target:f.document.body,clientX:0,clientY:0});assert.equal(v.popup,null);
  assert.deepEqual(plain(v.value),{a:'a',b:'c'});
});

test('value hover does not inherit a previous native tooltip',()=>{
  const f=fixture(object({s:{type:'string',description:'explanation'}}),{s:'text'}),t=target(f.view,'$/s:value');
  f.app.canvas.canvas.title='stale';f.view.pointerMove({clientX:t.rect.x+3,clientY:t.rect.y+3,target:f.app.canvas.canvas});assert.equal(f.app.canvas.canvas.title,'');
});

test('four-component vector minimum width propagates to the node and preserves all axes in one row',()=>{
  const f=fixture(object({v:object({x:{type:'number'},y:{type:'number'},z:{type:'number'},w:{type:'number'}}),after:{type:'string'}}),{v:{x:1,y:2,z:3,w:4},after:'next'});
  f.n.size[0]=360;f.view.render();
  const x=target(f.view,'$/v:axisx').rect,y=target(f.view,'$/v:axisy').rect,z=target(f.view,'$/v:axisz').rect,w=target(f.view,'$/v:axisw').rect,after=target(f.view,'$/after:value').rect;
  assert(f.n.size[0]>=f.view.minWidth);assert.equal(x.y,z.y);assert.equal(y.y,w.y);assert(after.y>=w.y+w.h+2);assert.equal(w.x+w.w,after.x+after.w);
  f.n.size[0]=720;f.view.render();assert.equal(target(f.view,'$/v:axisx').rect.y,target(f.view,'$/v:axisw').rect.y);
});

test('value and type share surplus equally and nested container minima reach node layout',()=>{
  const f=fixture(object({field:true}),{field:'text'}),v=f.view;
  const value=()=>target(v,'$/field:value').rect,type=()=>target(v,'$/field:type').rect;
  const before=[value().w,type().w];f.n.size[0]+=300;v.render();
  assert(Math.abs((value().w-before[0])-(type().w-before[1]))<.001);
  assert(type().w>=v.typeMinimum(row(v,'$/field')));
  const nested=fixture(object({rows:{type:'array',items:{type:'array',items:object({field:true})}}}),{rows:[[{field:'text'}]]});
  nested.view.expanded.set('$/rows',true);nested.view.expanded.set('$/rows/0',true);nested.view.expanded.set('$/rows/0/0',true);
  nested.n.size=[100,1200];nested.view.render();
  const t=target(nested.view,'$/rows/0/0/field:type'),input=target(nested.view,'$/rows/0/0/field:value');
  assert(nested.view.minWidth>f.view.minWidth);
  assert(nested.n.size[0]>=nested.view.widget.computeLayoutSize(nested.n).minWidth);
  assert(t.rect.w>=nested.view.typeMinimum(row(nested.view,'$/rows/0/0/field')));
  assert(input.rect.w>=nested.view.valueMinimum(row(nested.view,'$/rows/0/0/field')));
  assert(input.rect.x+input.rect.w<=t.rect.x);
  assert(t.rect.x+t.rect.w<=t.clip.x+t.clip.w);
  const minimum=nested.view.minWidth;nested.view.expanded.set('$/rows',false);nested.view.render();assert.equal(nested.view.minWidth,minimum);
  v.dispose();nested.view.dispose();
});

test('dropdown trigger minimum fits the widest option and popup copies its actual width',()=>{
  const longest='这是一条需要完整显示且比当前值更长的选项';
  const f=fixture(object({choice:{type:'string',enum:['短',longest]}}),{choice:'短'}),v=f.view;
  const item=row(v,'$/choice'),minimum=v.valueMinimum(item);
  assert.equal(minimum,Math.ceil(v.textWidth(longest,'14px LxyInspectorInter, sans-serif')+27*14/12));
  assert(v.typeMinimum({types:['null']})<90); // No unrelated fixed 90px floor.
  f.n.size[0]=100;v.render();const trigger=target(v,'$/choice:value');
  assert(trigger.rect.w>=minimum);
  trigger.run();f.frame();
  const popupWidth=parseFloat(v.popup.root.style.width),scale=Number(v.popup.root.style.transform.match(/scale\(([^)]+)\)/)[1]);
  assert(Math.abs(popupWidth*scale-trigger.rect.w)<.001);
  v.dispose();
});

test('live editor anchors follow resizing and errors reserve a separate row without losing the draft',()=>{
  const f=fixture(object({n:{type:'integer'},s:{type:'string'}}),{n:3,s:'next'});target(f.view,'$/n:value').run();
  const input=inputOf(f.view);input.value='invalid';input.fire('keydown',{key:'Enter'});paint(f.view);
  const value=target(f.view,'$/n:value'),error=f.view.rows.find(r=>r.kind==='error'&&r.path==='$/n'),next=target(f.view,'$/s:value');
  assert(error.rect.y>=value.rect.y+value.rect.h);assert(next.rect.y>=error.rect.y+error.rect.h);assert.equal(input.value,'invalid');
  f.n.size[0]=600;f.view.render(f.view.chrome);paint(f.view);f.frame();
  const rect=target(f.view,'$/n:value').rect;assert.equal(f.view.popup.root.style.left,`${rect.x}px`);assert.equal(f.view.popup.root.style.width,`${rect.w}px`);assert.equal(input.value,'invalid');
});

test('nested section headers own only their header; count and removal win over the full header hit area',()=>{
  const f=fixture({type:'object',properties:{group:object({nested:{type:'array',items:{type:'number'}}})},additionalProperties:false},{group:{nested:[2]}}),v=f.view;
  v.expanded.set('$/group/nested',true);v.render();
  for(const id of ['$/group:presence','$/group/nested:count']){
    const t=target(v,id);assert.equal(v.hit({x:t.rect.x+t.rect.w/2,y:t.rect.y+12}).id,id);
  }
  const header=target(v,'$/group:fold').rect;assert.equal(v.hit({x:header.x+header.w-3,y:header.y+12}).id,'$/group:fold');
  const value=target(v,'$/group/nested/0:value');v.pointerMove({target:f.app.canvas.canvas,clientX:value.rect.x+4,clientY:value.rect.y+4});
  assert.equal(v.hover,value.id);assert(!v.selected.size);assert(!v.activeList);
  f.document.fire('pointermove',{target:f.document.body});assert.equal(v.hover,null);assert.equal(f.app.canvas.canvas.style.cursor,'');
});

test('nested list focus is local; outside clicks dim selection, disabled controls never click through',()=>{
  const f=fixture({type:'array',items:object({inner:{type:'array',items:{type:'number'},maxItems:2}})},[{inner:[1,2]},{inner:[2]}]),v=f.view;
  v.expanded.set('$/0',true);v.expanded.set('$/0/inner',true);v.selected.set('$',1);v.render();
  const t=target(v,'$/0/inner:drag1'),cursor={eDown:{clientX:t.rect.x+5,clientY:t.rect.y+10}};
  v.pointerDown(cursor,f.app.canvas);cursor.onClick(cursor.eDown);cursor.finally();
  assert.equal(v.activeList,'$/0/inner');assert.equal(v.selected.get('$'),1);assert.equal(v.selected.get('$/0/inner'),1);
  assert.deepEqual(plain(v.rows.filter(r=>r.kind==='listSelection'&&r.path==='$/0/inner').map(r=>r.index)),[0,1]);
  const highlighted=[],ctx=context2d();ctx.fillRect=function(x,y,w,h){if(this.fillStyle==='#2c5d87')highlighted.push({x,y,w,h});};v.draw(ctx);assert.equal(highlighted.length,1);
  const disabled=target(v,'$/0/inner:add-item'),d={eDown:{clientX:disabled.rect.x+4,clientY:disabled.rect.y+5}};
  assert.equal(v.hit(v.point(d.eDown)).kind,'disabled');v.pointerDown(d,f.app.canvas);assert(!d.onClick);assert.equal(v.activeList,'$/0/inner');
  f.document.fire('pointerdown',{target:f.document.body});assert.equal(v.activeList,null);assert.equal(v.selected.get('$/0/inner'),1);
});

test('spacing belongs to adjacent rows, so nested containers do not accumulate trailing gaps',()=>{
  const f=fixture(object({section:object({deep:object({a:{type:'string'},b:{type:'string'}})}),next:{type:'string'}}),{section:{deep:{a:'a',b:'b'}},next:'next'}),v=f.view;
  v.expanded.set('$/section/deep',true);v.render();
  const a=target(v,'$/section/deep/a:value').rect,b=target(v,'$/section/deep/b:value').rect,next=target(v,'$/next:value').rect;
  assert.equal(b.y-(a.y+a.h),8);assert.equal(next.y-(b.y+b.h),14);
  const deep=target(v,'$/section/deep:fold').rect;assert.equal(a.y-(deep.y+deep.h),6);
});

test('folding never moves its own header after a collapsed sibling, including nested lists',()=>{
  const f=fixture(object({first:object({x:{type:'string'}}),second:{type:'array',items:object({n:{type:'number'}})}}),{first:{x:'a'},second:[{n:1}]}),v=f.view;
  v.expanded.set('$/first',false);v.expanded.set('$/second',false);v.render();
  const original=plain(target(v,'$/second:fold').rect);
  for(let i=0;i<4;i++){target(v,'$/second:fold').run();assert.deepEqual(plain(target(v,'$/second:fold').rect),original);}
});

test('list footer is attached, shared and flat; its quantity text uses the inline editor inset',()=>{
  const f=fixture({type:'array',items:{type:'string'}},[]),v=f.view,ctx=context2d(),boxes=[],text=[];
  ctx.roundRect=(...args)=>boxes.push(args);ctx.fillText=(s,x,y)=>text.push({s,x,y});
  const footer=v.rows.find(r=>r.kind==='listFooter');v.drawRow(ctx,footer);assert.equal(boxes.length,0);
  const add=target(v,'$:add-item'),remove=target(v,'$:remove-item');assert.equal(add.rect.x+add.rect.w,remove.rect.x);assert.equal(remove.kind,'disabled');assert.equal(add.rect.y+add.rect.h/2,footer.rect.y+footer.rect.h/2);
  const header=target(v,'$:count');v.drawRow(ctx,header.row);assert(text.some(t=>t.s==='0'&&t.x===header.rect.x+6));
});

test('nested list borders, footers and controls stay in their parent with stable scrollbar space',()=>{
  const member=object({title:{type:'string'},children:{type:'array',items:{type:'integer'}},products:{type:'array',items:object({name:{type:'string'}})}});
  const f=fixture({type:'array',items:member},[{title:'Outer',children:[1,2],products:[{name:'Product'}]}]),v=f.view;
  const open=item=>{v.expanded.set(item.path,true);for(const child of item.children||[])open(child);};open(v.tree);v.render();
  const outer=v.lists[0],inner=v.lists.find(a=>a.path==='$/0/children');
  assert(inner.rect.x>outer.rect.x);assert(inner.rect.x+inner.rect.w<outer.rect.x+outer.rect.w);
  const outerAdd=target(v,'$:add-item').rect,innerAdd=target(v,'$/0/children:add-item').rect;
  assert(innerAdd.x<outerAdd.x);
  const value=target(v,'$/0/children/0:value').rect;assert(value.x+value.w<inner.viewport.x+inner.viewport.w-6);
  const original=plain(target(v,'$/0/children:count').rect);target(v,'$/0/children:fold').run();
  const collapsed=target(v,'$/0/children:count').rect;assert.deepEqual(plain(collapsed),original);
  const header=target(v,'$/0/children:fold').rect,c={eDown:{clientX:header.x+30,clientY:header.y+12}};
  v.pointerDown(c,f.app.canvas);c.onClick(c.eDown);c.finally();
  assert.equal(v.activeList,'$/0/children');assert(!v.selected.has('$'),'inner fold must not select the enclosing object');
  const paths=[],ctx=context2d();ctx.moveTo=(x,y)=>paths.push({x,y});
  v.drawRow(ctx,v.rows.find(r=>r.kind==='listBackground'&&r.path==='$'));
  assert.equal(paths[0].y,outer.viewport.y+.5,'outline starts below the title');
});

test('list capacity follows node space instead of screen height or a fixed maximum',()=>{
  const f=fixture({type:'array',items:{type:'integer'}},Array.from({length:60},(_,i)=>i)),v=f.view;
  v.manualHeight=4000;v.render();paint(v);
  const natural=v.lists[0].total;assert(natural>600);assert.equal(v.lists[0].viewport.h,natural);
  f.app.canvas.canvas.getBoundingClientRect=()=>({left:0,top:0,width:800,height:300});
  v.matrix={a:2,b:0,c:0,d:2,e:0,f:0};v.render();paint(v);assert.equal(v.lists[0].viewport.h,natural);
  f.n.size[1]=500;v.render();paint(v);const small=v.lists[0].viewport.h;
  assert(small<natural);assert(v.height<=v.widget.computedHeight+.25);
  v.scroll.set('$',100);paint(v);assert.equal(v.scroll.get('$'),100);v.render(v.chrome);paint(v);assert.equal(v.scroll.get('$'),100,'rerender preserves scrolling');
  f.n.size[1]=800;v.render();paint(v);assert(v.lists[0].viewport.h>small);
  f.n.size[1]=4000;v.render();paint(v);assert.equal(v.lists[0].viewport.h,natural);assert.equal(v.scroll.get('$'),0);
});

test('nested and sibling lists use available space and fully expand without overlap',()=>{
  const values=Array.from({length:30},(_,i)=>i);
  const f=fixture(object({a:{type:'array',items:{type:'array',items:{type:'integer'}}},b:{type:'array',items:{type:'integer'}}}),{a:[values],b:values}),v=f.view;
  for(const p of ['$/a','$/a/0','$/b'])v.expanded.set(p,true);
  v.manualHeight=800;v.render();paint(v);assert(v.lists.some(a=>a.viewport.h<a.total));assert(v.height<=v.widget.computedHeight+.25);
  f.n.size[1]=5000;v.render();paint(v);assert.equal(v.lists.length,3);
  for(const area of v.lists)assert.equal(area.viewport.h,area.total);
  const a=v.lists.find(a=>a.path==='$/a'),b=v.lists.find(a=>a.path==='$/b');
  assert(b.rect.y>=a.viewport.y+a.viewport.h+24);
});

test('object member names follow text values without changing identity, and field focus does not select a row',()=>{
  const f=fixture({type:'array',items:object({name:{type:'string'},n:{type:'integer'}})},[{name:'Named item',n:3}]),v=f.view;
  v.expanded.set('$/0',true);v.render();assert.equal(row(v,'$/0').label,'Named item');
  const t=target(v,'$/0/n:value'),cursor={eDown:{clientX:t.rect.x+4,clientY:t.rect.y+10}};
  v.pointerDown(cursor,f.app.canvas);cursor.onClick(cursor.eDown);cursor.finally();assert(!v.selected.size);assert.equal(v.activeList,null);v.popup.close();
  v.commit('$/0/name',row(v,'$/0/name').set,'Renamed');assert.equal(row(v,'$/0').label,'Renamed');assert(row(v,'$/0').description.includes('元素 0'));
  const handle=target(v,'$:drag0'),c={eDown:{clientX:handle.rect.x+5,clientY:handle.rect.y+10}};
  v.pointerDown(c,f.app.canvas);c.onClick(c.eDown);c.finally();assert.equal(v.selected.get('$'),0);assert.equal(v.activeList,'$');
});

test('nested optional and vector controls fit narrow parent lists without overlapping their actions',()=>{
  const vector={type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'},w:{type:'number'}},required:['x','y','z','w'],additionalProperties:false};
  const member={type:'object',properties:{name:{type:'string'},v:vector,choice:{type:['string','null']}},required:['name'],additionalProperties:false};
  const schema={type:'array',items:object({children:{type:'array',items:member}})},value=[{children:[{name:'nested',v:{x:1,y:2,z:3,w:4},choice:'value'}]}];
  const f=fixture(schema,value),v=f.view;
  const open=item=>{v.expanded.set(item.path,true);for(const c of item.children||[])open(c);};open(v.tree);
  for(const width of [360,480,720]){
    v.node.size[0]=width;v.render();paint(v);
    for(const t of v.targets.filter(t=>/:(value|axis.|type|presence|count)$/.test(t.id))){
      assert(t.rect.w>0,t.id);if(t.clip){assert(t.rect.x>=t.clip.x,t.id);assert(t.rect.x+t.rect.w<=t.clip.x+t.clip.w,t.id);}
    }
    const axes=v.targets.filter(t=>t.id.startsWith('$/0/children/0/v:axis'));
    assert.equal(axes.length,4);assert(axes.every(t=>t.rect.w>=20));
    const field=target(v,'$/0/children/0/choice:value').rect,menu=target(v,'$/0/children/0/choice:type').rect,remove=target(v,'$/0/children/0/choice:presence').rect;
    assert(field.x+field.w<=menu.x||menu.y+menu.h<=field.y);assert(menu.x+menu.w<=remove.x);
  }
});

test('inline input stays anchored at viewport edges while menus remain constrained',()=>{
  const f=fixture({type:'string'},'edge'),v=f.view;
  let t=target(v,'$:value');v.matrix={a:1,b:0,c:0,d:1,e:-230,f:-10};t.run();f.frame();
  const r=v.screenRect(t.rect),s=v.popup.root.style;
  assert.equal(s.left,`${r.left}px`);assert.equal(s.top,`${r.top}px`);assert(s.clipPath.startsWith('inset('));
  v.popup.close();t=target(v,'$:value');v.matrix={a:2,b:0,c:0,d:2,e:600,f:860};t.run();f.frame();
  const edge=v.screenRect(t.rect);assert.equal(v.popup.root.style.left,`${edge.left}px`);assert.equal(Number.parseFloat(v.popup.root.style.width),edge.width);
});

test('focused list keyboard navigation is scoped, cycles selection and never consumes text editing keys',()=>{
  const f=fixture({type:'array',items:{type:'integer'},minItems:1},[1,2,3]),v=f.view;
  v.activeList='$';v.selected.set('$',0);
  const key=k=>({key:k,preventDefault(){this.used=true;},stopImmediatePropagation(){}});
  v.key(key('ArrowUp'));assert.equal(v.selected.get('$'),2);v.key(key('ArrowDown'));assert.equal(v.selected.get('$'),0);
  v.key(key('Delete'));assert.deepEqual(plain(v.value),[2,3]);
  const typing=key('ArrowDown');typing.target={closest:()=>true};v.key(typing);assert(!typing.used);
  v.activeList=null;const outside=key('Delete');v.key(outside);assert(!outside.used);
});

test('reorder and removal carry nested expansion, scrolling and branch state with their array item',()=>{
  const f=fixture({type:'array',items:object({name:{type:'string'}})},[{name:'a'},{name:'b'}]),v=f.view;
  v.expanded.set('$/0',false);v.expanded.set('$/1',true);v.branches.set('$/0/choice',2);v.scroll.set('$/0/nested',42);
  v.reorder(v.lists[0],0,2);assert.equal(v.value[1].name,'a');assert.equal(v.expanded.get('$/1'),false);assert.equal(v.branches.get('$/1/choice'),2);assert.equal(v.scroll.get('$/1/nested'),42);
  v.selected.set('$',0);v.removeItem(v.lists[0]);assert.equal(v.value[0].name,'a');assert.equal(v.expanded.get('$/0'),false);assert.equal(v.branches.get('$/0/choice'),2);assert(!v.branches.has('$/1/choice'));
});

test('lists clip, scroll, add/remove and reorder whole typed values without changing hidden members',()=>{
  const {view,changes}=fixture({type:'array',items:{type:'integer'},minItems:1,maxItems:50},Array.from({length:40},(_,i)=>i));
  view.manualHeight=700;view.render();paint(view);assert(view.lists[0].viewport.h<view.lists[0].total);assert.equal(view.value.length,40);
  assert(!view.targets.some(t=>t.id==='$/39:value'));
  let prevented=false;view.wheel({clientX:50,clientY:150,deltaY:200,preventDefault(){prevented=true;},stopImmediatePropagation(){}});assert(prevented);assert.equal(view.scroll.get('$'),200);
  view.resizeList(view.lists[0],41);assert.equal(view.value.length,41);assert.equal(view.value[40],0);
  view.selected.set('$',1);view.removeItem(view.lists[0]);assert.equal(view.value.length,40);assert.equal(view.value[1],2);
  view.reorder(view.lists[0],0,3);assert.deepEqual(plain(view.value.slice(0,3)),[2,3,0]);assert.equal(changes.length,3);
  assert.throws(()=>view.resizeList(view.lists[0],51),/maxItems/);
  assert.throws(()=>view.resizeList(view.lists[0],0),/minItems/);
});

test('pointer reorder commits on release; Escape restores; slider gestures commit once',()=>{
  let f=fixture({type:'array',items:{type:'integer'}},[1,2,3]);let {view}=f;
  const drag=target(view,'$:drag0'),down={clientX:drag.rect.x+5,clientY:drag.rect.y+10},cursor={eDown:down};
  view.pointerDown(cursor,f.app.canvas);cursor.onDrag({clientX:50,clientY:view.lists[0].viewport.y+view.lists[0].viewport.h-4});assert.deepEqual(plain(view.value),[1,2,3]);
  cursor.onDragEnd();cursor.finally();assert.deepEqual(plain(view.value),[2,3,1]);assert.equal(f.changes.length,1);
  const t=target(view,'$:drag0'),c={eDown:{clientX:t.rect.x+5,clientY:t.rect.y+10}};view.pointerDown(c,f.app.canvas);c.onDrag({clientX:55,clientY:110});view.key({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});c.onDragEnd();assert.equal(f.changes.length,1);
  f=fixture({type:'number',minimum:0,maximum:1,multipleOf:.1},.2);view=f.view;
  const slide=target(view,'$:slider'),p={eDown:{clientX:slide.rect.x+5,clientY:slide.rect.y+5}};view.pointerDown(p,f.app.canvas);
  p.onDrag({clientX:slide.rect.x+slide.rect.w*.63,clientY:slide.rect.y+5});assert.equal(view.value,.6);assert.equal(f.changes.length,0);p.onDragEnd();p.finally();assert.equal(f.changes.length,1);assert.equal(view.value,.6);
});

test('inline edits preserve invalid drafts until correction or cancel; values, vectors and optional fields retain types',()=>{
  const {view}=fixture(object({n:{type:'integer'},v:object({x:{type:'number'},y:{type:'number'}}),e:{enum:[false,0,'0']}}),{n:3,v:{x:1,y:2},e:false});
  target(view,'$/n:value').run();let input=inputOf(view);input.value='bad';input.fire('keydown',{key:'Enter'});assert.equal(view.value.n,3);assert(view.errors.has('$/n'));
  input.value='4';input.fire('keydown',{key:'Enter'});assert.equal(view.value.n,4);assert(!view.popup);
  target(view,'$/v:axisx').run();input=inputOf(view);input.value='1.25';input.fire('keydown',{key:'Enter'});assert.equal(view.value.v.x,1.25);
  target(view,'$/e:value').run();view.popup.root.querySelectorAll('button')[1].fire('click');assert.equal(view.value.e,0);
  view.setData({type:'object',properties:{optional:{type:'string'}},additionalProperties:false},{});view.render();target(view,'$/optional:presence').run();assert.equal(view.value.optional,'');target(view,'$/optional:presence').run();assert(!Object.hasOwn(view.value,'optional'));
});

test('popup placement maps canvas device pixels, scale and translation; date values retain offsets and fractions',()=>{
  const {view,context,app}=fixture({type:'string',format:'date-time'},'2026-11-16T12:30:00.125+08:00');
  view.matrix={a:2,b:0,c:0,d:2,e:100,f:200};app.canvas.canvas.getBoundingClientRect=()=>({left:30,top:40,width:400,height:600});
  const screen=view.screenRect({x:10,y:20,w:50,h:24});assert.deepEqual(plain(screen),{left:90,top:160,width:50,height:24});assert.deepEqual(plain(view.point({clientX:90,clientY:160})),{x:10,y:20});
  const parts=context.dateParts('2026-11-16T12:30:00.125+08:00','date-time');assert.equal(context.dateValue(parts,'date-time'),'2026-11-16T12:30:00.125+08:00');
  assert.throws(()=>context.dateValue({...parts,date:'2026-02-29'},'date'),/不存在/);assert.equal(context.dateValue({...parts,date:'2028-02-29'},'date'),'2028-02-29');
  assert.throws(()=>context.dateValue({...parts,hour:'24'},'time'),/0–23/);
  paint(view);target(view,'$:picker').run();assert(view.popup.root.querySelector('.calendar'));view.popup.root.querySelectorAll('button').find(b=>b.textContent==='取消').fire('click');assert.equal(view.value,'2026-11-16T12:30:00.125+08:00');
});

test('multiline expansion preserves text and submit busy state survives editor cleanup',()=>{
  const f=fixture({type:'string'},'first'),view=f.view;target(view,'$:value').run();let input=inputOf(view);
  input.fire('keydown',{key:'Enter',shiftKey:true});input=inputOf(view);paint(view);f.frame();assert.equal(input.tagName,'textarea');assert.match(input.style.height,/calc\(100% - /);assert.equal(row(view,'$').rect.h,48);
  input.value='first\nsecond';input.fire('keydown',{key:'Enter',ctrlKey:true});assert.equal(view.value,'first\nsecond');
  target(view,'$:value').run();view.setBusy(true);assert.equal(view.busy,true);assert.equal(view.popup,null);
});

test('pasted multiline text expands inline and survives commit and repeated reopening',()=>{
  const f=fixture({type:'string'},'start'),v=f.view;
  target(v,'$:value').run();let input=inputOf(v);
  assert.equal(input.tagName,'textarea');
  input.value='第一行\n第二行\n\n最后一行';input.fire('input');f.frame();
  assert.equal(row(v,'$').rect.h,88);assert.equal(v.popup.inline,true);
  input.fire('keydown',{key:'Enter',ctrlKey:true});
  for(let i=0;i<3;i++){
    target(v,'$:value').run();input=inputOf(v);f.frame();
    assert.equal(input.tagName,'textarea');assert.equal(input.value,'第一行\n第二行\n\n最后一行');
    assert.equal(v.popup.inline,true);assert.match(input.style.height,/calc/);
    assert.equal(input.style.padding,'0 14px 0 0');assert.equal(input.style.whiteSpace,'pre-wrap');
    v.popup.outside();
  }
  assert.equal(v.value,'第一行\n第二行\n\n最后一行');v.dispose();
});

test('inline strings hide horizontal scrollbars before placement and after multiline transitions',()=>{
  const f=fixture({type:'string'},'long text '.repeat(80)),v=f.view;
  target(v,'$:value').run();const input=inputOf(v);
  assert.equal(input.style.overflowX,'hidden');assert.equal(input.style.overflowY,'hidden');
  f.frame();assert.equal(input.style.overflowY,'auto');
  input.value+='\nsecond';input.fire('input');paint(v);f.frame();
  assert.equal(input.style.overflowX,'hidden');assert.equal(input.style.overflowY,'auto');
  input.value='short';input.fire('input');paint(v);f.frame();
  assert.equal(input.style.overflowX,'hidden');assert.equal(input.style.overflowY,'hidden');
  v.dispose();
});

test('soft wraps grow string fields while only real newlines have display markers',()=>{
  const f=fixture({type:'string'},'abcdefghij'.repeat(18)+'\n\nend'),v=f.view;
  const narrow=row(v,'$').rect.h;assert(narrow>68);
  const lines=f.context.formStringLines('abcdef\r\n\nend',3,t=>t.length);
  assert.deepEqual(plain(lines),[{text:'abc',hardEnd:false},{text:'def',hardEnd:true},{text:'',hardEnd:true},{text:'end',hardEnd:false}]);
  f.n.size[0]+=1000;v.render();paint(v);assert(row(v,'$').rect.h<narrow);
  const original=v.value;target(v,'$:value').run();f.frame();const input=inputOf(v);
  assert.equal(input.wrap,'soft');assert.equal(input.style.whiteSpace,'pre-wrap');
  assert.equal(v.popup.root.querySelectorAll('span').filter(s=>s.textContent==='↵').length,2);
  v.popup.outside();assert.equal(v.value,original);v.dispose();
});

test('text height follows draft line count upward and downward and restores on cancel',()=>{
  const f=fixture({type:'string'},'one\ntwo'),v=f.view;
  assert.equal(row(v,'$').rect.h,48);target(v,'$:value').run();const input=inputOf(v);
  input.value=Array(15).fill('line').join('\n');input.fire('input');f.frame();paint(v);
  assert.equal(row(v,'$').rect.h,308);
  input.value='one\ntwo\nthree';input.fire('input');f.frame();paint(v);
  assert.equal(row(v,'$').rect.h,68);
  input.value='one';input.fire('input');f.frame();paint(v);assert.equal(row(v,'$').rect.h,24);
  v.popup.close();assert.equal(row(v,'$').rect.h,48);assert.equal(v.value,'one\ntwo');
  target(v,'$:value').run();const next=inputOf(v);next.value=Array(12).fill('row').join('\n');next.fire('input');v.popup.outside();
  assert.equal(row(v,'$').rect.h,248);target(v,'$:value').run();f.frame();assert.equal(row(v,'$').rect.h,248);v.dispose();
});

test('Shift Enter inserts a newline at the selection on first press and preserves format restrictions',()=>{
  const f=fixture({type:'string'},'abcd'),v=f.view;target(v,'$:value').run();
  const input=inputOf(v);input.selectionStart=1;input.selectionEnd=3;
  input.fire('keydown',{key:'Enter',shiftKey:true});assert.equal(input.value,'a\nd');
  input.fire('keydown',{key:'Enter',ctrlKey:true});assert.equal(v.value,'a\nd');v.dispose();
  const g=fixture({type:'string',pattern:'^[a-z]+$'},'abc');target(g.view,'$:value').run();
  const limited=inputOf(g.view);limited.fire('keydown',{key:'Enter',shiftKey:true});
  assert.equal(limited.value,'abc');g.view.dispose();
});

test('unambiguous oneOf data renders fields without reinitializing or exposing JSON',()=>{
  const {view}=fixture({oneOf:[object({width:{type:'integer'},height:{type:'integer'}}),{type:'string',enum:['auto']}]},{width:1080,height:1920});
  assert(!view.rows.some(r=>r.kind==='json'));assert(view.rows.some(r=>r.path==='$/width'));assert.equal(view.value.width,1080);
  target(view,'$:branch').run();view.popup.root.querySelectorAll('button')[0].fire('click');assert(!view.rows.some(r=>r.kind==='json'));assert(view.rows.some(r=>r.path==='$/width'));assert.equal(view.value.width,1080);
});

test('color recognition is explicit; color channels/HSV round-trip and popup cancel/apply are transactional',()=>{
  const {context,view}=fixture({type:'string',pattern:'^#[0-9A-Fa-f]{8}$'},'#4D99CCCC');
  assert.equal(context.colorDigits({type:'string',pattern:'^#[0-9A-Fa-f]{8}$'}),8);assert.equal(context.colorDigits({type:'string',format:'color'}),0);
  assert.equal(context.colorDigits({type:'string',pattern:'.*'}),0);
  assert.deepEqual(plain(context.colorRGBA('#4D99CCCC')),[77,153,204,204]);
  const hsv=context.rgbHSV([77,153,204]);assert.deepEqual(plain(context.hsvRGB(...hsv)),[77,153,204]);assert.equal(context.colorHex([77,153,204,204],6),'#4D99CC');
  target(view,'$:picker').run();let hex=view.popup.root.querySelectorAll('input').find(i=>i.ariaLabel==='HEX');hex.value='#FF000080';hex.fire('input');assert.equal(view.value,'#4D99CCCC');
  view.popup.root.querySelectorAll('button').find(b=>b.textContent==='取消').fire('click');assert.equal(view.value,'#4D99CCCC');
  target(view,'$:picker').run();hex=view.popup.root.querySelectorAll('input').find(i=>i.ariaLabel==='HEX');hex.value='#FF000080';hex.fire('input');view.popup.root.querySelectorAll('button').find(b=>b.textContent==='确定').fire('click');assert.equal(view.value,'#FF000080');
});

test('Photoshop picker color spaces round trip and Web colors quantize before confirmation',()=>{
  const {context,view}=fixture({type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},'#123456');
  for(const rgb of [[255,255,255],[0,0,0],[255,0,0],[12,140,232]]){
    const lab=context.pickerLab(rgb),back=context.pickerFromLab(lab);back.forEach((v,i)=>assert(Math.abs(v-rgb[i])<=1));
    assert.deepEqual(plain(context.pickerFromCMYK(context.pickerCMYK(rgb))),rgb);
  }
  target(view,'$:picker').run();const root=view.popup.root;
  for(const text of ['确定','取消','添加到色板','颜色库'])assert(root.querySelectorAll('button').some(b=>b.textContent===text));
  assert.deepEqual(root.querySelectorAll('canvas').map(c=>[c.width,c.height]),[[256,256],[19,256]]);
  const web=root.querySelectorAll('input').find(i=>i.ariaLabel==='只有 Web 颜色');web.checked=true;web.fire('change');
  root.querySelectorAll('button').find(b=>b.textContent==='确定').fire('click');assert.equal(view.value,'#003366');view.dispose();
});

test('Photoshop picker edits blue independently of brightness and retains original on cancel',()=>{
  const {view}=fixture({type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},'#112233');target(view,'$:picker').run();
  const root=view.popup.root,blue=root.querySelectorAll('input').find(i=>i.ariaLabel==='蓝');blue.value='255';blue.fire('input');
  assert.equal(root.querySelectorAll('input').find(i=>i.ariaLabel==='HEX').value,'1122ff');
  const radio=root.querySelectorAll('input').find(i=>i.ariaLabel==='选择Blue通道');radio.fire('change');
  root.querySelectorAll('button').find(b=>b.textContent==='取消').fire('click');assert.equal(view.value,'#112233');view.dispose();
});

test('named swatches persist and library returns without committing the form',async()=>{
  const f=fixture({type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},'#123456'),v=f.view;const stored=new Map();
  f.context.localStorage={getItem:k=>stored.get(k),setItem:(k,val)=>stored.set(k,val)};
  target(v,'$:picker').run();v.popup.root.querySelectorAll('button').find(b=>b.textContent==='添加到色板').fire('click');
  const name=v.popup.root.querySelectorAll('input').find(i=>i.ariaLabel==='色板名称');name.value='测试蓝';
  v.popup.root.querySelectorAll('button').find(b=>b.textContent==='确定').fire('click');
  assert.deepEqual(JSON.parse(stored.get('liuxinyu.colorSwatches')),[{name:'测试蓝',hex:'#123456'}]);
  v.popup.root.querySelectorAll('button').find(b=>b.textContent==='颜色库').fire('click');await flush();
  assert(v.popup.root.querySelectorAll('button').some(b=>b.title==='测试蓝'));
  v.popup.root.querySelectorAll('button').find(b=>b.textContent==='拾色器(P)').fire('click');assert.equal(v.value,'#123456');
  assert(v.popup.root.querySelectorAll('canvas').some(c=>c.width===256));v.dispose();
});

test('hue strip is a full spectrum even when current color is black',()=>{
  const f=fixture({type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},'#000000');const create=f.document.createElement;
  const images=[];f.document.createElement=tag=>{const el=create(tag);if(tag==='canvas')el.getContext=()=>({...context2d(),createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData:data=>images.push(data)});return el;};
  target(f.view,'$:picker').run();const strip=images.find(i=>i.width===19);assert(strip);
  assert(strip.data.some((v,i)=>i%4!==3&&v===255));assert(strip.data.some((v,i)=>i%4===1&&v===255));f.view.dispose();
});

test('backend field errors stay by their property and safe object additions do not alter prototypes',()=>{
  const {view}=fixture(object({n:{type:'integer'}}),{n:1});view.setErrors([{path:'/n',rule:'minimum',message:'至少为 2'}]);view.render();assert(view.rows.some(r=>r.kind==='error'&&r.path==='$/n'));
  view.setData({type:'object',additionalProperties:{type:'string'}},{});view.render();target(view,'$:add-key').run();const input=inputOf(view);input.value='__proto__';input.fire('keydown',{key:'Enter'});assert.equal(Object.getPrototypeOf(view.value).constructor.name,'Object');assert.equal(Object.getOwnPropertyDescriptor(view.value,'__proto__').value,'');
});

test('controller confirmation, duplicate recovery, notifications and old-node migration survive the renderer rewrite',async()=>{
  const h=harness(),n=node();h.context.findNodes=()=>[{path:'10:20',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();const view=h.forms[0];
  assert(n.widgets[0].hidden);assert.equal(n.widgets.length,2);
  const schema=object({n:{type:'integer'}}),entry={request_id:'one',workflow_id:'root',node_id:'10:20',schema,has_value:false,value:null};h.setLive([entry]);h.handlers.get('liuxinyu.template_form')({detail:entry});await flush();
  assert.deepEqual(h.revealed,['10:20']);view.commit('$/n',row(view,'$/n').set,7);assert.equal(JSON.parse(n.widgets[0].value).value.n,7);
  h.handlers.get('liuxinyu.template_form')({detail:entry});assert.equal(view.value.n,7);await target(view,'footer:确认').run();await flush();assert.equal(JSON.parse(n.widgets[0].value).confirmed,true);
  view.commit('$/n',row(view,'$/n').set,8);assert.equal(JSON.parse(n.widgets[0].value).confirmed,false);h.document.visibilityState='hidden';h.setLive([{...entry,request_id:'two'}]);await h.handlers.get('reconnected')();assert.equal(h.notices.length,0);assert(h.requests.some(r=>r.url.endsWith('/presence')&&r.body.request_id==='two'&&r.body.foreground===false));assert(!view.chrome.actions.some(a=>a.label==='系统通知'));assert.equal(view.value.n,8);await target(view,'footer:取消执行').run();assert.equal(h.requests.at(-1).body.cancel,true);
  const before=n.widgets[0].value,ghost={name:'schema',element:{remove(){this.removed=true;}},onRemove(){this.unregistered=true;}};n.widgets.push(ghost);n.inputs[0].widget={name:'schema'};n.widgets[0].value=JSON.stringify(schema);n.onConfigure({inputs:[{name:'schema',widget:{name:'schema'}}],widgets_values:[JSON.stringify(schema),before]});await flush();assert.equal(n.widgets[0].value,before);assert.equal(n.inputs[0].link,42);assert(ghost.hidden&&ghost.unregistered);n.onRemoved();assert.equal(n.widgets.length,1);
});

test('finishing conditional forms preserves resolved labels, types and closed-object controls',async()=>{
  for(const mode of ['确认','取消执行','backend-finish']){
    const h=harness(),n=node();h.context.findNodes=()=>[{path:'7',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();
    const group={...object({mode:{type:'string',title:'本次是否制作',enum:['制作','不制作']},config:{...object({name:{type:'string',title:'配置名称'}}),title:'制作配置'}}),title:'主图'};
    const resolved=object({group}),schema=object({group:{...group,if:{properties:{mode:{const:'制作'}}},then:{required:['config']}}});
    const value={group:{mode:'制作',config:{name:'test'}}};
    h.setInspect(()=>({presentation:resolved,errors:[]}));
    const entry={request_id:'conditional',workflow_id:'root',node_id:'7',schema,value,has_value:true};h.setLive([entry]);h.handlers.get('liuxinyu.template_form')({detail:entry});await flush();const v=h.forms[0];
    await target(v,'footer:校验').run();v.expanded.set('$/group',true);v.expanded.set('$/group/config',true);v.render(v.chrome);
    const snapshot=()=>{paint(v);return plain(v.rows.filter(r=>r.set).map(r=>({path:r.path,label:r.label,kind:r.kind,optional:r.optional,types:r.types,add:!!r.add})));};
    const before=snapshot();assert.equal(row(v,'$/group/mode').label,'本次是否制作');
    assert(!v.targets.some(t=>t.id.endsWith(':type')||t.id.endsWith(':add-key')||t.id.endsWith(':presence')));
    if(mode==='backend-finish')h.handlers.get('liuxinyu.template_form_done')({detail:{request_id:'conditional',confirmed:false}});
    else await target(v,`footer:${mode}`).run();
    assert.deepEqual(snapshot(),before,mode);
    assert(!v.targets.some(t=>t.id.endsWith(':type')||t.id.endsWith(':add-key')||t.id.endsWith(':presence')),mode);
    assert.deepEqual(plain(v.value),value);n.onRemoved();
  }
});

test('pending rule parsing can finish after the request ends without falling back to arbitrary fields',async()=>{
  const h=harness(),n=node();h.context.findNodes=()=>[{path:'7',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();
  const resolved=object({name:{type:'string',title:'配置名称'}}),schema={allOf:[resolved]},value={name:'saved'};
  let resolveInspection;h.setInspect(()=>new Promise(resolve=>{resolveInspection=resolve;}));
  const entry={request_id:'late',workflow_id:'root',node_id:'7',schema,value,has_value:true};h.setLive([entry]);
  h.handlers.get('liuxinyu.template_form')({detail:entry});await new Promise(resolve=>setTimeout(resolve,180));
  const v=h.forms[0];paint(v);assert(v.rows.some(r=>r.kind==='pending'));assert(!v.targets.some(t=>/:type$|:add-key$/.test(t.id)));
  h.handlers.get('liuxinyu.template_form_done')({detail:{request_id:'late',confirmed:false}});
  resolveInspection({presentation:resolved,errors:[]});await flush();paint(v);
  assert.equal(row(v,'$/name').label,'配置名称');assert(!v.rows.some(r=>r.kind==='pending'));assert.deepEqual(plain(v.value),value);n.onRemoved();
});

test('native notification activation locates the existing workflow and acknowledges without loading another graph',async()=>{
  const h=harness(),n=node();let loads=0,focuses=0;
  h.context.findNodes=()=>[{path:'10:20',node:n}];h.app.loadGraphData=()=>loads++;
  h.context.window.focus=()=>focuses++;h.context.setTimeout=()=>0;
  h.extension.setup();h.handlers.get('liuxinyu.template_form_activate')({detail:{entry:{workflow_id:'root',node_id:'10:20'},activation_id:'activation'}});
  await flush();assert.deepEqual(h.revealed,['10:20']);assert.equal(loads,0);assert.equal(focuses,1);
  const ack=h.requests.find(r=>r.url.endsWith('/activated')).body;assert(ack.existing&&ack.focused);assert.equal(ack.client_id,'test-page');
  h.handlers.get('liuxinyu.template_form_activate')({detail:{entry:{workflow_id:'other',node_id:'10:20'},activation_id:'other'}});
  await flush();assert.equal(h.requests.at(-1).body.existing,false);assert.equal(loads,0);
});

test('fallback notification tab restores the request workflow before revealing a nested node',async()=>{
  const h=harness(),workflow={id:'target',nodes:[]};let loaded,cleaned=false;
  h.setActivation({workflow,entry:{request_id:'a'.repeat(32),workflow_id:'target',node_id:'10:20'}});
  h.context.window.location={hash:'#lxy-form='+'a'.repeat(32),pathname:'/',search:''};
  h.context.window.history={replaceState(){cleaned=true;}};
  h.app.loadGraphData=async data=>{loaded=data;h.app.rootGraph=data;};
  h.context.findNodes=graph=>graph.id==='target'?[{path:'10:20',node:{}}]:[];
  h.extension.afterConfigureGraph();await flush();await flush();
  assert.deepEqual(loaded,workflow);assert.deepEqual(h.revealed,['10:20']);assert(cleaned);
});

test('indent guides join direct children, collapse with groups, and inherit list clipping without hit targets',()=>{
  const group=object({enabled:{type:'boolean'},settings:object({name:{type:'string'}})});
  const {view,n}=fixture(object({scope:object({main:group,detail:group,sku:group}),items:{type:'array',items:group}}),
    {scope:{main:{enabled:true,settings:{name:'a'}},detail:{enabled:false,settings:{name:'b'}},sku:{enabled:true,settings:{name:'c'}}},items:[{enabled:true,settings:{name:'d'}}]});
  const open=item=>{view.expanded.set(item.path,true);for(const child of item.children||[])open(child);};open(view.tree);view.render(view.chrome);
  for(const width of [360,720]){
    n.size[0]=width;view.render(view.chrome);paint(view);
    const guide=view.rows.find(r=>r.kind==='indentGuide'&&r.path==='$/scope');assert(guide);
    assert.equal(guide.branches.length,3);assert.equal(guide.rect.x,view.labelStart(row(view,'$/scope'))-9);
    const last=row(view,'$/scope/sku');assert.equal(guide.rect.y+guide.rect.h,last.rect.y+12);
    for(const branch of guide.branches)assert(branch.x>guide.rect.x);
    const nested=view.rows.find(r=>r.kind==='indentGuide'&&r.path==='$/items/0');assert(nested.clip);assert(nested.clip.h>0);
    assert(!view.targets.some(t=>t.row.kind==='indentGuide'));
  }
  target(view,'$/scope/main:fold').run();
  assert(!view.rows.some(r=>r.kind==='indentGuide'&&r.path==='$/scope/main'));
  assert(view.rows.some(r=>r.kind==='indentGuide'&&r.path==='$/scope'));
  target(view,'$/scope:fold').run();assert(!view.rows.some(r=>r.kind==='indentGuide'&&r.path.startsWith('$/scope')));
});

test('list add/remove requires a selection and keeps the operation on its own list',()=>{
  const f=fixture({type:'array',items:{type:'string'}},['a','b']),v=f.view;
  assert.equal(target(v,'$:remove-item').kind,'disabled');v.removeItem(v.lists[0]);assert.deepEqual(plain(v.value),['a','b']);
  target(v,'$:add-item').run();assert.equal(v.activeList,'$');assert.equal(v.selected.get('$'),2);assert.equal(v.value[2],'');
  target(v,'$:remove-item').run();assert.equal(v.selected.get('$'),1);assert.equal(v.activeList,'$');
  target(v,'$:remove-item').run();target(v,'$:remove-item').run();assert.equal(v.value.length,0);assert(!v.selected.has('$'));assert.equal(target(v,'$:remove-item').kind,'disabled');
});

test('drag paints the complete item in its vertical track and shifts peers without committing',()=>{
  const f=fixture({type:'array',items:object({name:{type:'string'},inner:{type:'array',items:{type:'integer'}}})},[{name:'A',inner:[1]},{name:'B',inner:[2]},{name:'C',inner:[3]}]),v=f.view;
  const open=item=>{v.expanded.set(item.path,true);for(const child of item.children||[])open(child);};open(v.tree);v.render();
  const t=target(v,'$:drag2'),cursor={eDown:{clientX:t.rect.x+6,clientY:t.rect.y+8}};v.pointerDown(cursor,f.app.canvas);
  const area=v.lists[0],start=area.entries[0].y+5;cursor.onDrag({clientX:area.viewport.x-150,clientY:start});
  assert.equal(v.drag.to,0);assert(v.dragOffset(0)>0);assert(v.dragOffset(2)<0);assert.deepEqual(plain(v.value.map(x=>x.name)),['A','B','C']);
  const moves=[],texts=[],ctx=context2d();ctx.translate=(x,y)=>moves.push({x,y});ctx.fillText=text=>texts.push(text);v.draw(ctx);
  assert(moves.every(p=>p.x===0));assert(texts.includes('C'));assert.equal(v.targets.length,0);
  assert(v.rows.filter(r=>r.path==='$/2/inner'&&r.kind==='listBackground').every(r=>r.entryOwners.some(o=>o.path==='$'&&o.index===2)));
  const layout=v.layout.bind(v);let layouts=0;v.layout=(...args)=>{layouts++;return layout(...args);};
  v.widget.computedHeight=v.availableHeight;
  v.widget.draw(context2d(),v.node,v.node.size[0],v.widget.y??0);
  assert.equal(layouts,0);
  cursor.onDragEnd();cursor.finally();assert.deepEqual(plain(v.value.map(x=>x.name)),['C','A','B']);assert.equal(f.changes.length,1);
});

test('error octagon matches the two-line text block and remains vertically centered',()=>{
  const {view}=fixture({type:'string'},'');view.render({errors:[{path:'配置.名称',message:'不能为空。'}]});
  const row=view.rows.find(r=>r.kind==='diagnostic'),points=[],ctx=context2d();
  ctx.moveTo=(x,y)=>points.push({x,y});ctx.lineTo=(x,y)=>points.push({x,y});view.drawRow(ctx,row);
  const top=Math.min(...points.map(p=>p.y)),bottom=Math.max(...points.map(p=>p.y));
  assert.equal(bottom-top,38);assert.equal((top+bottom)/2,row.rect.y+row.rect.h/2);
  assert.equal(row.pathLines.length+row.messageLines.length,2);assert.equal(row.rect.h-16,44);
});

test('refresh action is leftmost, preserves compatible drafts and updates reset baseline',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string',default:'old'}});
  n.widgets[0].value=JSON.stringify({schema,value:{name:'edited'},confirmed:true});
  let queued=0,finish;h.context.queueTemplateRefresh=async()=>{queued++;return {prompt_id:'refresh',target:'4'};};
  h.context.waitTemplateRefresh=()=>new Promise(resolve=>{finish=resolve;});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  assert.equal(v.chrome.actions[0].label,'保存当前配置值(只用于当前模版)');
  const run=v.chrome.actions.find(a=>a.label==='计算链以更新模版缓存').run,work=run();await flush();await run();assert.equal(queued,1);
  assert.equal(JSON.parse(n.widgets[0].value).refresh_job.prompt_id,'refresh');
  const updated=object({name:{type:'string',default:'new'},extra:{type:'integer',default:5}});
  finish(updated);await work;
  let state=JSON.parse(n.widgets[0].value);assert.deepEqual(state.value,{name:'edited',extra:5});
  assert.deepEqual(state.template.schema,updated);assert.equal(state.confirmed,false);assert.equal(state.refresh_job,undefined);
  await target(v,'footer:复位到模板').run();assert.deepEqual(JSON.parse(n.widgets[0].value).value,{name:'new',extra:5});
  assert(!h.requests.some(r=>r.url.endsWith('/submit')));n.onRemoved();
});

test('empty form can refresh; failure retains old data; saved refresh resumes without queueing again',async()=>{
  const h=harness(),n=node();let queued=0;
  h.context.queueTemplateRefresh=async()=>{queued++;return {prompt_id:'refresh',target:'4'};};
  h.context.waitTemplateRefresh=async()=>({type:'string',default:'new'});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  await target(v,'footer:计算链以更新模版缓存').run();assert.equal(v.value,'new');
  const before=JSON.parse(n.widgets[0].value);
  h.context.waitTemplateRefresh=async()=>{throw Error('upstream failed');};
  await target(v,'footer:计算链以更新模版缓存').run();assert.deepEqual(JSON.parse(n.widgets[0].value),before);assert.match(v.chrome.status,/upstream failed/);
  n.onRemoved();const next=node();next.widgets[0].value=JSON.stringify({...before,refresh_job:{prompt_id:'saved',target:'4'}});
  h.context.waitTemplateRefresh=async job=>{assert.equal(job.prompt_id,'saved');return {type:'string',default:'latest'};};
  h.extension.nodeCreated(next);await flush();assert.equal(queued,2);assert.equal(h.forms.at(-1).schema.default,'latest');next.onRemoved();
});

test('imported values override old drafts and save action exports current template metadata at the left',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string'}});n.id=4;h.app.rootGraph.nodes=[n];h.context.findNodes=()=>[{node:n,path:'4'}];
  n.widgets[0].value=JSON.stringify({schema,value:{name:'old'},confirmed:true});
  h.extension.setup();h.extension.nodeCreated(n);await flush();
  h.handlers.get('liuxinyu.template_form')({detail:{request_id:'import',workflow_id:'root',node_id:'4',schema,value:{name:'new'},has_value:true,imported:true,input_types:{'$/name':'string'},field_required:{'$/name':true}}});
  await flush();const v=h.forms[0];assert.equal(v.value.name,'new');
  const save=v.chrome.actions.find(a=>a.align==='left');assert(save);
  paint(v);const footer=v.rows.find(r=>r.kind==='footer');assert.equal(footer.items.find(i=>i.action===save).x,0);
  await save.run();const request=h.requests.find(r=>r.url.endsWith('/save-values'));
  assert.equal(request.body.value.name,'new');assert.deepEqual(request.body.field_required,{'$/name':true});
  assert(!h.requests.some(r=>r.url.endsWith('/submit')));n.onRemoved();
});

test('refresh refuses to enqueue behind the same form waiting for confirmation',async()=>{
  const h=harness(),n=node();n.id=4;h.app.rootGraph.nodes=[n];h.context.findNodes=()=>[{node:n,path:'4'}];h.extension.setup();h.extension.nodeCreated(n);await flush();
  h.context.queueTemplateRefresh=()=>{throw Error('must not enqueue');};
  const entry={request_id:'waiting',workflow_id:'root',node_id:'4',schema:{type:'string'},value:'',has_value:true};
  h.handlers.get('liuxinyu.template_form')({detail:entry});await flush();
  await target(h.forms[0],'footer:计算链以更新模版缓存').run();assert.match(h.forms[0].chrome.status,/请先确认或取消/);n.onRemoved();
});

test('temporary status failure resumes the same job instead of repeating upstream work',async()=>{
  const h=harness(),n=node();let queued=0,attempt=0;
  h.context.queueTemplateRefresh=async()=>{queued++;return {prompt_id:'keep',target:'4'};};
  h.context.waitTemplateRefresh=async job=>{assert.equal(job.prompt_id,'keep');if(!attempt++)throw Object.assign(new Error('offline'),{refreshRecoverable:true});return {type:'integer',default:8};};
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  await target(v,'footer:计算链以更新模版缓存').run();assert.equal(JSON.parse(n.widgets[0].value).refresh_job.prompt_id,'keep');
  await target(v,'footer:计算链以更新模版缓存').run();assert.equal(queued,1);assert.equal(v.value,8);n.onRemoved();
});

test('reset keeps an immutable template and the previous draft across reload, without confirming or submitting',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string',default:'template'},items:{type:'array',items:{type:'integer'},default:[1,2]}});
  n.widgets[0].value=JSON.stringify({schema,value:{name:'edited',items:[7,8,9]},confirmed:true});h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  v.errors.set('$/name','invalid draft');await target(v,'footer:复位到模板').run();
  let state=JSON.parse(n.widgets[0].value);assert.deepEqual(state.value,{name:'template',items:[1,2]});assert.equal(state.confirmed,false);
  assert.deepEqual(state.reset_backup.value,{name:'edited',items:[7,8,9]});assert.deepEqual(state.template.schema,schema);assert.equal(state.template.resolved,true);assert.equal(v.errors.size,0);
  assert(!h.requests.some(r=>r.url.endsWith('/submit')));const saved=n.widgets[0].value;n.onRemoved();
  const next=node();next.widgets[0].value=saved;h.extension.nodeCreated(next);await flush();const restored=h.forms.at(-1);
  restored.commit('$/name',row(restored,'$/name').set,'second edit');
  const requests=h.requests.length;await target(restored,'footer:复位到模板').run();assert.equal(h.requests.length,requests,'resolved baseline is reused');
  state=JSON.parse(next.widgets[0].value);assert.equal(state.value.name,'template');assert.equal(state.reset_backup.value.name,'second edit');assert.equal(state.template.value.name,'template');
  state.schema.properties.name.default='new template';next.widgets[0].value=JSON.stringify(state);next.onConfigure({});await flush();
  await target(restored,'footer:复位到模板').run();assert.equal(restored.value.name,'new template','changed input defaults invalidate the old template snapshot');next.onRemoved();
});

test('reset resolves input rules, preserves a pending request and leaves the draft untouched on resolution failure',async()=>{
  const h=harness(),n=node();h.context.findNodes=()=>[{path:'2',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();
  const schema={type:'object',properties:{n:{$ref:'#/$defs/N'}},required:['n'],$defs:{N:{type:'integer',default:4}}};
  const entry={request_id:'reset-pending',workflow_id:'root',node_id:'2',schema,has_value:true,value:{n:12}};
  h.setLive([entry]);h.handlers.get('liuxinyu.template_form')({detail:entry});await flush();const v=h.forms[0];
  v.commit('$/n',row(v,'$/n').set,15);const before=n.widgets[0].value;
  h.setInspect(()=>{throw Error('reference unavailable');});await target(v,'footer:复位到模板').run();assert.equal(n.widgets[0].value,before);assert.equal(v.value.n,15);
  h.setInspect(()=>({presentation:object({n:{type:'integer',default:4}}),errors:[]}));await target(v,'footer:复位到模板').run();
  const state=JSON.parse(n.widgets[0].value);assert.equal(state.value.n,4);assert.equal(state.request_id,'reset-pending');target(v,'footer:确认');assert(!h.requests.some(r=>r.url.endsWith('/submit')));
  n.widgets[0].value=before;n.onConfigure({});await flush();assert.equal(v.value.n,15);target(v,'footer:确认');
  n.onRemoved();
});

test('successful reuse refreshes the input template defaults but never overwrites a newer draft',async()=>{
  const h=harness(),n=node(),schema={type:'integer',default:1};n.widgets[0].value=JSON.stringify({schema,value:7,confirmed:true});
  h.context.findNodes=()=>[{path:'2',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  h.handlers.get('liuxinyu.template_form_reused')({detail:{request_id:'reuse-new',workflow_id:'root',node_id:'2',schema:{type:'integer',default:3},value:7}});
  assert.equal(v.value,7);assert.equal(v.schema.default,3);await target(v,'footer:复位到模板').run();assert.equal(v.value,3);
  v.commit('$',row(v,'$').set,9);
  h.handlers.get('liuxinyu.template_form_reused')({detail:{request_id:'reuse-old',workflow_id:'root',node_id:'2',schema,value:7}});
  assert.equal(v.value,9);assert.equal(v.schema.default,3);n.onRemoved();
});

test('footer follows allocated height and wraps without overlap while manual spare height survives edits',()=>{
  const f=fixture({type:'string'},'value'),v=f.view;
  const actions=['计算链以更新模版缓存','复位到模板','校验','取消执行','确认'].map(label=>({label,run(){}}));
  for(const width of [360,480,720]){
    f.n.size[0]=width;v.render({actions});f.n.size[1]+=180;f.n.arrange();paint(v);
    const targets=v.targets.filter(t=>t.row.kind==='footer');assert.equal(targets.length,5);
    const right=targets.find(t=>t.id==='footer:确认').rect;
    assert.equal(right.x+right.w,width-12);assert.equal(right.y+right.h,v.widget.computedHeight-12);
    for(const t of targets){assert(t.rect.x>=12);assert(t.rect.x+t.rect.w<=width-12);}
    for(let i=0;i<targets.length;i++)for(let j=0;j<i;j++){
      const a=targets[i].rect,b=targets[j].rect;assert(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y);
    }
    const height=f.n.size[1];v.commit('$',row(v,'$').set,'edited');assert.equal(f.n.size[1],height);
  }
});

test('validation shows Chinese field guidance and a count summary, with a structured diagnostic row',async()=>{
  const h=harness(),n=node();n.widgets[0].value=JSON.stringify({schema:object({名称:{type:'string'}}),value:{名称:''},confirmed:false});
  h.setInspect(()=>({errors:[{path:'/名称',field:'名称',location:'配置 → 第 1 项 → 名称',rule:'minLength',message:'不能为空，请填写内容。'}]}));
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];await target(v,'footer:校验').run();
  assert.equal(v.chrome.status,'发现 1 个问题，请按下方提示修改。');assert.deepEqual(plain(v.chrome.errors[0]),{path:'名称',targetPath:'$/名称',message:'不能为空，请填写内容。'});
  assert.equal(v.serverErrors.get('$/名称'),'不能为空，请填写内容。');paint(v);
  assert(v.targets.some(t=>t.kind==='click'&&t.hint==='点击定位到此字段'));assert(!JSON.stringify(v.chrome.errors[0]).includes('minLength'));n.onRemoved();
});

test('validation auto-fits form content and gives diagnostics one-and-a-half minimum heights',async()=>{
  const h=harness(),n=node(),schema=object({items:{type:'array',items:{type:'string'}}});
  n.widgets[0].value=JSON.stringify({schema,value:{items:Array.from({length:12},(_,i)=>`item ${i}`)},confirmed:false});
  let invalid=true;h.setInspect(()=>({errors:invalid?Array.from({length:9},(_,i)=>({path:'/items/'+i,message:'错误 '+i})):[]}));
  h.extension.nodeCreated(n);await flush();const v=h.forms[0],width=n.size[0];n.size[1]=220;n.arrange();
  await target(v,'footer:校验').run();paint(v);
  const content=v.lists.find(a=>a.path==='$/items'),diagnostics=v.lists.find(a=>a.path==='@diagnostics');
  assert.equal(content.viewport.h,content.total);assert.equal(diagnostics.viewport.h,108);assert(diagnostics.total>108);
  assert.equal(n.size[0],width);const errorHeight=n.size[1];
  invalid=false;await target(v,'footer:校验').run();paint(v);
  assert(!v.lists.some(a=>a.path==='@diagnostics'));assert(n.size[1]<errorHeight,`${n.size[1]} < ${errorHeight}`);assert.equal(n.size[0],width);n.onRemoved();
});

test('failed Check and Confirm keep diagnostics and revalidate committed edits until valid, without submitting',async()=>{
  for(const action of ['\u6821\u9a8c','\u786e\u8ba4']){
    const h=harness(),n=node(),schema=object({first:{type:'string',minLength:1},second:{type:'string',minLength:1}});
    n.widgets[0].value=JSON.stringify({schema,value:{first:'',second:''},confirmed:false});
    h.setInspect(body=>({presentation:body.schema,errors:Object.keys(body.value).filter(k=>!body.value[k]).map(k=>({path:'/'+k,message:'required'}))}));
    const controllers=new Set();h.context.mount(n,controllers);await flush();const c=[...controllers][0],v=h.forms[0];
    if(action==='\u786e\u8ba4')c.receive({request_id:'live-validation',schema,has_value:true,value:{first:'',second:''}});
    await target(v,'footer:'+action).run();assert.equal(v.chrome.errors.length,2);
    v.commit('$/first',row(v,'$/first').set,'ok');
    assert.equal(v.chrome.errors.length,2,'previous diagnostics remain while the new check is pending');
    assert.equal(v.serverErrors.size,2);assert.equal(v.busy,false,'background validation does not lock editing');
    await new Promise(r=>setTimeout(r,190));
    assert.equal(v.chrome.errors.length,1);assert(v.serverErrors.has('$/second'));assert(!v.serverErrors.has('$/first'));
    v.commit('$/second',row(v,'$/second').set,'ok');await new Promise(r=>setTimeout(r,190));
    assert.equal(v.chrome.errors.length,0);assert.equal(v.serverErrors.size,0);assert.equal(v.chrome.status,'\u6821\u9a8c\u901a\u8fc7');
    assert.equal(JSON.parse(n.widgets[0].value).confirmed,false);
    assert(!h.requests.some(r=>r.url.endsWith('/submit')),'passing an automatic check never submits');
    if(action==='\u786e\u8ba4')assert.equal(c.pending.size,1);
    n.onRemoved();
  }
});

test('live validation rejects stale responses and retains errors when an inspection fails',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string',minLength:3}});
  n.widgets[0].value=JSON.stringify({schema,value:{name:''},confirmed:false});
  const error={path:'/name',message:'too short'};
  h.setInspect(body=>({presentation:body.schema,errors:[error]}));h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  await target(v,'footer:\u6821\u9a8c').run();
  let oldResolve;h.setInspect(()=>new Promise(resolve=>{oldResolve=resolve;}));
  v.commit('$/name',row(v,'$/name').set,'a');await new Promise(r=>setTimeout(r,175));assert(oldResolve);
  h.setInspect(()=>{throw Error('offline');});
  v.commit('$/name',row(v,'$/name').set,'ab');await new Promise(r=>setTimeout(r,175));
  assert.equal(v.chrome.errors.length,1);assert(v.chrome.status.includes('offline'));
  oldResolve({presentation:schema,errors:[]});await flush();
  assert.equal(v.chrome.errors.length,1,'old successful response cannot erase newer errors');
  h.setInspect(body=>({presentation:body.schema,errors:[]}));
  v.commit('$/name',row(v,'$/name').set,'abc');await new Promise(r=>setTimeout(r,175));
  assert.equal(v.chrome.errors.length,0);assert.equal(v.serverErrors.size,0);n.onRemoved();
});

test('reset and undo during a waiting request retain diagnostics until checked again',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string',minLength:3}});
  n.widgets[0].value=JSON.stringify({schema,value:{name:'a'},confirmed:false});
  h.setInspect(body=>({presentation:body.schema,errors:body.value.name.length<3?[{path:'/name',message:'too short'}]:[]}));
  const controllers=new Set();h.context.mount(n,controllers);await flush();const c=[...controllers][0],v=h.forms[0];
  c.receive({request_id:'reset-live',schema,has_value:true,value:{name:'a'}});
  await target(v,'footer:\u6821\u9a8c').run();
  await target(v,'footer:\u590d\u4f4d\u5230\u6a21\u677f').run();
  assert.equal(v.chrome.errors.length,1);await new Promise(r=>setTimeout(r,190));
  assert.equal(v.chrome.errors.length,1);assert.equal(v.value.name,'');
  const state=JSON.parse(n.widgets[0].value);state.value.name='valid';n.widgets[0].value=JSON.stringify(state);
  c.restore();assert.equal(v.chrome.errors.length,1,'undo keeps errors pending the fresh check');
  await new Promise(r=>setTimeout(r,190));assert.equal(v.chrome.errors.length,0);assert.equal(c.pending.size,1);
  assert(!h.requests.some(r=>r.url.endsWith('/submit')));n.onRemoved();
});

test('live validation checks conditional fields after required-value completion',async()=>{
  const h=harness(),n=node(),schema=object({flag:{type:'boolean'},name:{type:'string',minLength:1}});
  n.widgets[0].value=JSON.stringify({schema,value:{flag:false,name:''},confirmed:false});
  h.setInspect(body=>({presentation:body.value.flag?object({...schema.properties,tax:{type:'string',minLength:1}}):schema,
    errors:body.value.flag?[{path:Object.hasOwn(body.value,'tax')?'/tax':'$',message:'required'}]:[{path:'/name',message:'required'}]}));
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];await target(v,'footer:\u6821\u9a8c').run();
  v.commit('$/flag',row(v,'$/flag').set,true);await new Promise(r=>setTimeout(r,190));
  assert(Object.hasOwn(v.value,'tax'));assert.equal(v.chrome.errors[0].targetPath,'$/tax');assert(v.serverErrors.has('$/tax'));n.onRemoved();
});

test('inline errors wrap within field frames while diagnostic cards keep their original message',()=>{
  const schema=object({scope:{...object({items:{type:'array',items:object({name:{type:'string'}})}}),title:'Visible scope'}});
  const f=fixture(schema,{scope:{items:[{name:''}]}}),v=f.view;
  const message='scope.items.name: '+('a long rule explanation '.repeat(25)),display='Visible scope.Items.Name: '+('readable guidance '.repeat(25));
  v.setErrors([{path:'/scope',message,display_message:display},{path:'/scope/items/0/name',message,display_message:display}]);
  for(const width of [360,480,720]){
    f.n.size[0]=width;v.render({errors:[{path:'scope',targetPath:'$/scope',message}]});paint(v);
    for(const path of ['$/scope','$/scope/items/0/name']){
      const error=v.rows.find(r=>r.kind==='error'&&r.path===path),frame=v.rows.find(r=>r.kind==='errorFrame'&&r.path===path);
      assert(error.lines.length>1);assert.equal(error.lines.join(''),display);
      assert.equal(error.rect.h,error.lines.length*20);
      assert(error.rect.x>=frame.rect.x+6);assert(error.rect.x+error.rect.w<=frame.rect.x+frame.rect.w-6);
      assert(frame.rect.y<=row(v,path).rect.y);assert(frame.rect.y+frame.rect.h>=error.rect.y+error.rect.h+4);
      assert(frame.rect.x>=12&&frame.rect.x+frame.rect.w<=width-12);
      assert(error.lines.every(line=>line.length*7<=error.rect.w));
      if(path.endsWith('/name'))assert(frame.clip&&frame.clipStack.length,'nested frame obeys list clipping');
    }
    const diagnostic=v.rows.find(r=>r.kind==='diagnostic');
    assert.equal(diagnostic.pathLines.join(''),'scope');assert.equal(diagnostic.messageLines.join(''),message);
    const ctx=context2d(),painted=[];ctx.fillText=text=>painted.push(text);
    const error=v.rows.find(r=>r.kind==='error'&&r.path==='$/scope');v.drawRow(ctx,error);
    assert.equal(painted.join(''),display,'render every inline character, without ellipsis');
  }
  v.setErrors([]);v.render();assert(!v.rows.some(r=>r.kind==='error'||r.kind==='errorFrame'));
});

test('root and folded group errors retain a bounded multiline explanation',()=>{
  const f=fixture(object({group:object({name:{type:'string'}})}),{group:{name:''}}),v=f.view;
  const message='long message '.repeat(30);v.setErrors([{path:'$',message},{path:'/group',message}]);
  v.expanded.set('$/group',false);v.render();paint(v);
  for(const path of ['$','$/group']){
    assert.equal(v.rows.filter(r=>r.kind==='error'&&r.path===path).length,1);
    const error=v.rows.find(r=>r.kind==='error'&&r.path===path),frame=v.rows.find(r=>r.kind==='errorFrame'&&r.path===path);
    assert.equal(error.lines.join(''),message);assert(frame.rect.h>error.rect.h);
  }
});

test('expanded and collapsed sections survive workflow reload without changing confirmation or values',async()=>{
  const schema=object({group:object({items:{type:'array',items:object({name:{type:'string'}})}})}),value={group:{items:[{name:'item'}]}};
  const h=harness(),n=node();n.properties={unrelated:'keep'};n.widgets[0].value=JSON.stringify({schema,value,confirmed:true});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  target(v,'$/group/items:fold').run();target(v,'$/group:fold').run();
  const properties=plain(n.properties),state=n.widgets[0].value;
  assert.equal(new Map(properties.lxy_template_form_view.expanded).get('$/group/items'),true);
  assert.equal(new Map(properties.lxy_template_form_view.expanded).get('$/group'),false);
  assert.equal(properties.unrelated,'keep');assert.equal(JSON.parse(state).confirmed,true);
  assert.deepEqual(JSON.parse(state).value,value);n.onRemoved();
  const next=harness(),restored=node();restored.properties=properties;restored.widgets[0].value=state;
  next.extension.nodeCreated(restored);await flush();const shown=next.forms[0];
  assert.equal(shown.expanded.get('$/group'),false);assert.equal(shown.expanded.get('$/group/items'),true);
  target(shown,'$/group:fold').run();assert(shown.lists.some(area=>area.path==='$/group/items'));
  assert.equal(JSON.parse(restored.widgets[0].value).confirmed,true);
  assert(!next.requests.some(r=>r.url.endsWith('/submit')));restored.onRemoved();
});

test('expansion persistence follows reordered members and ignores malformed saved entries',()=>{
  const f=fixture({type:'array',items:object({name:{type:'string'},nested:object({count:{type:'integer'}})})},
    [{name:'first',nested:{count:1}},{name:'second',nested:{count:2}}]),v=f.view;
  v.expanded.set('$/0/nested',true);v.expanded.set('$/1/nested',false);v.render();
  v.reorder(v.lists[0],0,2);
  const saved=new Map(f.n.properties.lxy_template_form_view.expanded);
  assert.equal(saved.get('$/1/nested'),true);assert.equal(saved.get('$/0/nested'),false);
  f.n.properties.lxy_template_form_view.expanded=[['$/0/nested',true],['$/bad','false'],null,['invalid',true]];
  v.restoreExpansion();assert.deepEqual([...v.expanded].map(e=>plain(e)),[['$/0/nested',true]]);
});

test('selected members use background-colored guides, and list content has real margins',()=>{
  const member={type:'object',properties:{name:{type:'string'},inner:object({value:{type:'string'}})},required:['name','inner']};
  const {view:v,n}=fixture({type:'array',items:member},[{name:'a',inner:{value:'b'}},{name:'c',inner:{value:'d'}}]);
  const open=item=>{v.expanded.set(item.path,true);for(const child of item.children||[])open(child);};open(v.tree);v.render();
  v.selected.set('$',0);
  for(const width of [360,560]){
    n.size[0]=width;v.render();paint(v);const area=v.lists[0];
    for(const item of area.entries){
      const name=target(v,`$/${item.index}/name:value`),add=target(v,`$/${item.index}:add-key`);
      assert.equal(name.rect.h,20);assert(name.rect.y>=item.y+6);assert(add.rect.y+add.rect.h<=item.y+item.h-6);
      assert(name.rect.x>=area.viewport.x+4);assert(name.rect.x+name.rect.w<=area.viewport.x+area.viewport.w-4);
    }
    const selected=row(v,'$/0/name'),unselected=row(v,'$/1/name'),guide=v.rows.find(r=>r.kind==='indentGuide'&&r.path==='$/0/inner');
    assert.equal(v.guideColor(selected,'normal'),'#353535');assert.equal(v.guideColor(guide,'normal'),'#353535');assert.equal(v.guideColor(unselected,'normal'),'normal');
    v.activeList=null;assert.equal(v.guideColor(selected,'normal'),'#353535');
  }
});

test('error navigation centers the field in visible canvas space at current zoom and DPR',()=>{
  const f=fixture(object({name:{type:'string'}}),{name:''}),v=f.view,c=f.app.canvas;
  const box=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  let surface=box(50,40,800,600),panels=[];
  c.canvas.getBoundingClientRect=()=>surface;
  f.context.window.devicePixelRatio=1.25;
  f.document.querySelector=()=>null;
  f.document.querySelectorAll=()=>panels.map(b=>({getBoundingClientRect:()=>b}));
  for(const [width,blocks,expected] of [[800,[box(550,40,300,600)],[300,340]],
    [800,[box(50,40,150,600),box(550,40,300,600),box(200,500,350,140)],[375,270]],
    [500,[box(550,40,300,600)],[300,340]]]){
    surface=box(50,40,width,600);panels=blocks;
    for(const scale of [0.4,1.7]){
      c.ds={scale,offset:[0,0]};v.matrix={a:scale*1.25,d:scale*1.25,b:0,c:0,e:100,f:70};
      v.revealError('$/name');
      const screen=v.screenRect({...row(v,'$/name').rect,h:24});
      const actual=[screen.left+screen.width/2+c.ds.offset[0]*v.matrix.a*surface.width/c.canvas.width,
        screen.top+screen.height/2+c.ds.offset[1]*v.matrix.d*surface.height/c.canvas.height];
      actual.forEach((n,i)=>assert(Math.abs(n-expected[i])<1e-8,`${actual} != ${expected}`));
      assert.equal(c.ds.scale,scale);assert.deepEqual(plain(v.value),{name:''});
    }
  }
});

test('all validation ancestors expand and a diagnostic reveals a deeply clipped field',()=>{
  const member=object({'a/b':object({'~name':{type:'string'}})}),schema=object({outer:{type:'array',items:object({inner:{type:'array',items:member}})}});
  const value={outer:Array.from({length:8},()=>({inner:Array.from({length:20},()=>({'a/b':{'~name':''}}))}))};
  const f=fixture(schema,value),v=f.view,path='$/outer/7/inner/19/a~1b/~0name',other='$/outer/0/inner/0/a~1b/~0name';
  const close=item=>{v.expanded.set(item.path,false);for(const child of item.children||[])close(child);};close(v.tree);v.manualHeight=1000;
  v.setErrors([{path:path.slice(1),message:'必填'},{path:other.slice(1),message:'必填'}]);
  for(const p of ['$/outer','$/outer/7','$/outer/7/inner','$/outer/7/inner/19','$/outer/7/inner/19/a~1b','$/outer/0/inner/0/a~1b'])assert.equal(v.expanded.get(p),true,p);
  v.render({errors:[{path:v.errorPath(path),targetPath:path,message:'必填'}]});paint(v);f.app.canvas.ds={offset:[0,0],scale:1};
  target(v,'diagnostic:explanation-0').run();paint(v);
  const field=row(v,path);assert(field);
  for(const part of field.clipStack){assert(field.rect.y>=part.rect.y);assert(field.rect.y+24<=part.rect.y+part.rect.h);}
  assert(v.scroll.get('$/outer')>0);assert.equal(v.focus,path+':value');assert.notEqual(f.app.canvas.ds.offset[1],0);
  assert.deepEqual(plain(v.value),value,'navigation must not change data');
  v.revealError(path+'/not-present');assert.equal(v.focus,path+':value','unrendered paths locate the nearest field');
});

test('deep nesting stops consuming the value column and keeps controls inside their parent',()=>{
  let schema={type:'string'},value='leaf';for(let i=0;i<18;i++){schema={type:'array',items:schema};value=[value];}
  const {view:v,n}=fixture(schema,value);n.size[0]=360;
  const open=item=>{v.expanded.set(item.path,true);for(const child of item.children||[])open(child);};open(v.tree);v.render();paint(v);
  const field=v.targets.find(t=>t.id.endsWith(':value'));assert(field.rect.w>=80);
  for(const part of field.row.clipStack){assert(field.rect.x>=part.rect.x);assert(field.rect.x+field.rect.w<=part.rect.x+part.rect.w-4);}
});

test('diagnostic paths and wrapped log rows preserve full text within resized nodes',()=>{
  const {view,n}=fixture({type:'object'},{配置:[{名称:''}],'0':{'a/b':'x'}});
  assert.equal(view.errorPath('/配置/0/名称'),'配置.第1项.名称');
  assert.equal(view.errorPath('/0/a~1b'),'0.a/b');assert.equal(view.errorPath('$'),'整个表单');
  const path='出图要求.主图.配置.第1项.图片组成.第2项.配置名称',message='不能为空或只包含空白字符，请至少填写一个非空白字符。'.repeat(3);
  let narrowHeight;
  for(const width of [360,720]){
    n.size[0]=width;view.render({errors:[{path,message},{path:'其他.字段',message:'请填写内容。'}],actions:[{label:'校验',run(){}}]});
    const rows=view.rows.filter(r=>r.kind==='diagnostic');assert.equal(rows.length,2);
    const first=rows[0];assert.equal(first.pathLines.join(''),path);assert.equal(first.messageLines.join(''),message);
    if(width===360){narrowHeight=first.rect.h;assert(first.messageLines.length>1);}else assert(first.rect.h<narrowHeight);
    assert(rows[1].rect.y>=first.rect.y+first.rect.h);
    const diagnostics=view.lists.find(a=>a.path==='@diagnostics');
    assert(view.rows.find(r=>r.kind==='footer').rect.y>=diagnostics.viewport.y+diagnostics.viewport.h+10);
    const ctx=context2d(),drawn=[];ctx.fillText=(text,x,y)=>drawn.push({text,x,y});view.draw(ctx);
    for(const line of drawn.filter(t=>t.x===first.rect.x+56&&t.y<first.rect.y+first.rect.h)){
      assert(!line.text.includes('…'));assert(line.x+ctx.measureText(line.text).width<=first.rect.x+first.rect.w-12);
    }
  }
});

test('standard schemas without type retain all legal types, complex values remain field-editable and missing required fields can be added',()=>{
  const f=fixture({properties:{n:{type:'number'}}},'allowed');assert.equal(row(f.view,'$').kind,'string');target(f.view,'$:type');
  f.view.setData({type:'object',required:['missing']},{});f.view.render();target(f.view,'$/missing:presence').run();assert(Object.hasOwn(f.view.value,'missing'));
  f.view.setData({allOf:[object({n:{type:'integer'}})]},{n:2});f.view.render();paint(f.view);assert(f.view.rows.some(r=>r.kind==='pending'));
  assert(!f.view.targets.some(t=>/:type$|:add-key$|:presence$/.test(t.id)));
  f.view.setPresentation(object({n:{type:'integer'}}));f.view.render();target(f.view,'$/n:value');f.view.setPresentation(undefined);
  f.view.setData({type:'integer'},'wrong');f.view.render();target(f.view,'$:repair-type').run();f.view.popup.root.querySelector('button').fire('click');assert.equal(f.view.value,0);
  f.view.setData({type:'array',items:true},['x']);f.view.render();const type=target(f.view,'$/0:type').rect,value=target(f.view,'$/0:value').rect;assert(value.x+value.w<=type.x||type.y+type.h<=value.y);
});

test('author error annotations never become form fields or initialized output keys',()=>{
  const schema=object({name:{type:'string',default:'',minLength:1,'x-error-message':'请填写名称'}});
  schema['x-error-message']={additionalProperties:'不能添加其他字段',default:'请检查表单'};
  const f=fixture(schema,{name:''}),initial=f.context.initialValue(schema,schema);
  assert.deepEqual(plain(initial),{name:''});
  assert(!f.view.rows.some(r=>r.path?.includes('x-error-message')));
  assert.deepEqual(plain(f.view.value),{name:''});
  assert.equal(f.view.tree.children.length,1);f.view.dispose();
});

test('nullable types use a full labelled dropdown, preserve selection, and initialize numeric bounds',()=>{
  const f=fixture(object({quantity:{type:['integer','null'],minimum:1,default:null}}),{quantity:null}),v=f.view;
  let type=target(v,'$/quantity:type');assert.equal(type.kind,'menu');assert(type.rect.w>=90);
  assert(!v.targets.some(t=>t.id==='$/quantity:value'),'null has just the type dropdown');
  const texts=[],ctx=context2d();ctx.fillText=text=>texts.push(text);v.widget.draw(ctx,f.n,f.n.size[0],0);
  assert(texts.includes('无值'));assert(!texts.includes('null'));assert(!texts.includes('⋮'));
  type=target(v,'$/quantity:type');type.run();
  const options=v.popup.root.querySelectorAll('button');assert.deepEqual(options.map(b=>b.textContent),['整数','无值']);
  assert.equal(options[1].attrs['aria-selected'],'true');options[0].fire('click');assert.equal(v.value.quantity,1);
  v.commit('$/quantity',row(v,'$/quantity').set,5);target(v,'$/quantity:type').run();v.popup.root.querySelectorAll('button')[0].fire('click');assert.equal(v.value.quantity,5);
  target(v,'$/quantity:type').run();v.popup.root.querySelectorAll('button')[1].fire('click');assert.equal(v.value.quantity,null);
  v.dispose();
});

test('type dropdowns name all types and share enum menu sizing on nested collections',()=>{
  const f=fixture(true,[]),v=f.view;
  target(v,'$:type').run();let options=v.popup.root.querySelectorAll('button');
  assert(options.some(b=>b.textContent==='整数'));assert(options.some(b=>b.textContent==='浮点数'));assert(options.some(b=>b.textContent==='布尔值'));assert(options.some(b=>b.textContent==='无值'));
  assert.equal(options.find(b=>b.textContent==='数组').attrs['aria-selected'],'true');
  assert.equal(f.context.typesOf(true).includes('integer'),true);
  const defaults={type:'object',properties:{数量:{type:'integer',default:2432},颜色:{type:'string',default:'默认色'}},required:['数量','颜色']};
  assert.deepEqual(plain(f.context.initialValue(defaults,defaults)),{数量:2432,颜色:'默认色'});
  v.dispose();
});

test('projected array items show a projection badge with an explanatory hover hint',()=>{
  const schema=object({SKU列表:{type:'array',items:{type:'object',title:'SKU项',properties:{as:{type:'integer'}},required:['as'],additionalProperties:false,'x-requiredPropertiesFrom':{pointer:'/区分键',propertySchemaByType:{integer:{type:'integer'}}}}}});
  const f=fixture(schema,{SKU列表:[{as:2432}]}),v=f.view,path='$/SKU列表/0';
  assert.equal(row(v,path).projected,true);
  const labels=[],ctx=context2d();ctx.fillText=text=>labels.push(text);v.widget.draw(ctx,f.n,f.n.size[0],0);
  assert(labels.includes('投影'));
  const marker=target(v,`${path}:projection`);
  assert.equal(marker.kind,'hint');assert.match(marker.hint,/“本次制作范围与规格\.SKU图\.制作配置\.区分键”/);
  v.dispose();
});

test('explicit floating-point choice stays selected when its initial numeric value is integral',()=>{
  const f=fixture({type:['integer','number','null'],minimum:1,default:null},null),v=f.view;
  target(v,'$:type').run();v.popup.root.querySelectorAll('button')[1].fire('click');
  assert.equal(v.value,1);assert.equal(row(v,'$').kind,'number');
  target(v,'$:type').run();assert.equal(v.popup.root.querySelectorAll('button')[1].attrs['aria-selected'],'true');
  v.popup.root.querySelectorAll('button')[0].fire('click');assert.equal(row(v,'$').kind,'integer');v.dispose();
});

test('draft reconciliation fills required keys, preserves compatible values and records type conflicts',()=>{
  const h=harness(),schema=object({name:{type:'string',minLength:1},count:{type:'number',maximum:5},changed:{type:'boolean'},nested:object({id:{type:'string'}}),items:{type:'array',items:object({label:{type:'string'}})}});
  schema.properties.optional={type:'string'};
  const old={count:99,changed:'old',nested:{},items:[{}]},next=plain(h.context.completeRequired(schema,old));
  assert.deepEqual(next.value,{count:99,changed:false,nested:{id:''},items:[{label:''}],name:''});
  assert.deepEqual(next.backups,[{path:'$',key:'changed',value:'old'}]);assert.deepEqual(next.replaced,['$/changed']);assert.deepEqual(old,{count:99,changed:'old',nested:{},items:[{}]});
  assert.equal(h.context.completeRequired(schema,next.value).added.length,0);assert.equal(h.context.completeRequired(schema,next.value).replaced.length,0);
  const unlisted=h.context.initialValue({type:'object',required:['missing']},{type:'object',required:['missing']});assert(Object.hasOwn(unlisted,'missing'));
  const invalidDefault={type:'object',properties:{x:{type:'integer',default:'bad'}}};
  const fixed=h.context.completeRequired(invalidDefault,{x:'old'});assert.equal(fixed.value.x,0);assert.equal(h.context.completeRequired(invalidDefault,fixed.value).replaced.length,0);
  invalidDefault.required=['x'];assert.equal(h.context.completeRequired(invalidDefault,{}).backups.length,0,'invalid new defaults are not old user values');
  const array=h.context.completeRequired(object({items:{type:'array',items:{type:'integer'}}}),{items:['old',2]});
  assert.deepEqual(plain(array.value),{items:[0,2]});assert.deepEqual(plain(array.backups),[{path:'$',key:'items',value:['old',2]}]);
});

test('new required fields immediately become inputs and validation reports the filled key, not absence',async()=>{
  const h=harness(),n=node(),oldSchema={type:'object',properties:{name:{type:'string'}}};
  n.widgets[0].value=JSON.stringify({schema:oldSchema,value:{},confirmed:true});
  h.setInspect(body=>({presentation:body.schema,errors:body.value.name===''?[{path:'/name',rule:'minLength',message:'不能为空'}]:[]}));
  h.context.findNodes=()=>[{path:'2',node:n}];h.extension.setup();h.extension.nodeCreated(n);await flush();
  const schema=object({name:{type:'string',minLength:1}}),entry={request_id:'changed-required',workflow_id:'root',node_id:'2',schema,value:{},has_value:true};
  h.handlers.get('liuxinyu.template_form')({detail:entry});const v=h.forms[0];
  target(v,'$/name:value');assert(!v.targets.some(t=>t.id==='$/name:presence'));assert.equal(v.value.name,'');
  assert.equal(JSON.parse(n.widgets[0].value).confirmed,false);await target(v,'footer:校验').run();
  assert.equal(v.chrome.errors[0].targetPath,'$/name');assert(h.requests.filter(r=>r.url.endsWith('/inspect')).every(r=>Object.hasOwn(r.body.value,'name')));
  assert(!h.requests.some(r=>r.url.endsWith('/submit')));n.onRemoved();
});

test('conditional required initialization revalidates completed values before presenting errors',async()=>{
  const h=harness(),n=node(),schema={type:'object',if:{properties:{flag:{const:true}}},then:{required:['tax']}};
  n.widgets[0].value=JSON.stringify({schema,value:{flag:true},confirmed:true});
  h.setInspect(body=>({presentation:object({flag:{type:'boolean'},tax:{type:'string',minLength:1}}),errors:[{path:Object.hasOwn(body.value,'tax')?'/tax':'$',message:Object.hasOwn(body.value,'tax')?'不能为空':'缺少必填键'}]}));
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];await target(v,'footer:校验').run();
  assert.equal(v.value.tax,'');assert.equal(v.chrome.errors[0].targetPath,'$/tax');assert.equal(v.chrome.errors[0].message,'不能为空');n.onRemoved();
});

test('type replacement uses backend-approved backups and persists pending decisions across reload',async()=>{
  const h=harness(),n=node(),schema=object({name:{type:'string'}});schema.additionalProperties=true;
  n.widgets[0].value=JSON.stringify({schema,value:{name:12},confirmed:true});
  h.setInspect(body=>({presentation:{...schema,properties:{...schema.properties,name_备份1:{}}},errors:[],...(body.backup_candidates?{value:{...body.value,name_备份1:body.backup_candidates[0].value},backups:[{kept:true}]}:{})}));
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  assert.equal(v.value.name,'');assert.equal(JSON.parse(n.widgets[0].value).pending_backups[0].value,12);
  await target(v,'footer:校验').run();assert.deepEqual(plain(v.value),{name:'',name_备份1:12});
  assert(!JSON.parse(n.widgets[0].value).pending_backups);assert.equal(JSON.parse(n.widgets[0].value).confirmed,false);n.onRemoved();
});

test('backend presentation updates conditions without rewriting the schema, saved values or already edited fields',async()=>{
  const h=harness(),n=node(),schema={type:'object',properties:{flag:{type:'boolean'}},if:{properties:{flag:{const:true}}},then:{properties:{extra:{type:'string'}}}};
  n.widgets[0].value=JSON.stringify({schema,value:{flag:false,extra:'keep'},confirmed:false});
  h.setInspect(body=>({schema:body.schema,presentation:object(body.value.flag?{flag:{type:'boolean'},extra:{type:'string',minLength:2}}:{flag:{type:'boolean'}}),errors:[]}));
  h.extension.nodeCreated(n);await flush();await new Promise(resolve=>setTimeout(resolve,180));const view=h.forms[0];
  assert.deepEqual(plain(view.schema),schema);assert.equal(view.value.extra,'keep');
  target(view,'$/flag:boolean').run();await new Promise(resolve=>setTimeout(resolve,180));assert.equal(row(view,'$/extra').schema.minLength,2);assert.equal(view.value.extra,'keep');
  assert.deepEqual(JSON.parse(n.widgets[0].value).schema,schema);n.onRemoved();
});

test('activity preview measurement and rendering cannot overwrite the live form hit regions, matrix or scrolling',()=>{
  const f=fixture(object({flag:{type:'boolean'},rows:{type:'array',items:{type:'integer'}}}),{flag:false,rows:Array.from({length:16},(_,i)=>i)});
  const {view,n}=f,liveContext=context2d();liveContext.canvas=f.app.canvas.canvas;
  liveContext.getTransform=()=>({a:1.45,b:0,c:0,d:1.45,e:332,f:280});view.widget.draw(liveContext,n,480,26);
  const before={matrix:view.matrix,canvas:view.canvas,targets:view.targets,rows:view.rows,lists:view.lists,width:view.width,height:view.height,scroll:[...view.scroll]};
  const facade=Object.create(n);facade.size=[300,n.size[1]];const copy=Object.create(view.widget);copy.node=facade;
  const ctx=context2d();ctx.canvas={width:332,height:500,getBoundingClientRect:()=>({left:1100,top:120,width:332,height:500})};ctx.getTransform=()=>({a:1,b:0,c:0,d:1,e:16,f:83});
  let scheduled=0;f.context.queueMicrotask=()=>scheduled++;view.nextFocus='$/flag:boolean';
  copy.computeLayoutSize(facade);copy.draw(ctx,facade,300,26);
  for(const key of ['matrix','canvas','targets','rows','lists','width','height'])assert.equal(view[key],before[key],key);
  assert.deepEqual([...view.scroll],before.scroll);assert.equal(scheduled,0);assert.equal(view.nextFocus,'$/flag:boolean');view.nextFocus=null;
  const hit=view.targets.find(t=>t.id==='$/flag:boolean'),screen=view.screenRect(hit.rect),point={clientX:screen.left+screen.width/2,clientY:screen.top+screen.height/2},cursor={eDown:point};
  view.pointerDown(cursor,f.app.canvas);cursor.onClick(point);assert.equal(view.value.flag,true);
});

test('installed pointer and widget dispatch retain clicks across sizing and slow sub-threshold pointer movement',t=>{
  const assets=path.resolve(__dirname,'../../../../python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');if(!fs.existsSync(assets))return t.skip('Installed frontend unavailable');
  const bundle=fs.readdirSync(assets).filter(name=>/^settingStore-.*\.js$/.test(name)).map(name=>fs.readFileSync(path.join(assets,name),'utf8')).find(text=>text.includes('processWidgetClick(e,t,n,r='));
  const section=(start,end)=>{const a=bundle.indexOf(start),b=bundle.indexOf(end,a);assert(a>=0&&b>a);return bundle.slice(a,b);};
  const f=fixture(object({flag:{type:'boolean'},group:object({name:{type:'string'}})}),{flag:false,group:{name:'x'}});
  f.context.dist2=(x,y,a,b)=>(x-a)**2+(y-b)**2;f.context.isInRectangle=(x,y,a,b,w,h)=>x>=a&&x<=a+w&&y>=b&&y<=b+h;f.context.Z={NODE_WIDGET_HEIGHT:20};
  vm.runInContext('this.Pointer='+section('class CanvasPointer{',';function createCursorCache')+';this.Dispatch=class {'+section('getWidgetOnPos(e,t,n=!1){','findInputSlot(')+section('processWidgetClick(e,t,n,r=this.pointer){','processMouseMove(')+'};',f.context);
  f.n.widgets[0].hidden=true;f.n.isWidgetVisible=w=>!w.hidden;f.n.getWidgetOnPos=f.context.Dispatch.prototype.getWidgetOnPos;
  const element={setPointerCapture(){},hasPointerCapture(){return false;},releasePointerCapture(){}};
  function click(id,jitter=false){
    const hit=target(f.view,id),down={clientX:hit.rect.x+8,clientY:hit.rect.y+10,button:0,buttons:1,pointerId:1,timeStamp:100};
    const pointer=new f.context.Pointer(element);pointer.down(down);
    f.view.widget.last_y=0;
    const widget=f.n.getWidgetOnPos(down.clientX,down.clientY);assert.equal(widget,f.view.widget);
    f.context.Dispatch.prototype.processWidgetClick.call({pointer,graph_mouse:[down.clientX,down.clientY]},down,f.n,widget);
    f.view.widget.computeLayoutSize(f.n);
    const up={...down,clientX:down.clientX+(jitter?1:0),timeStamp:200};
    if(jitter)pointer.move(up);pointer.up({...up,buttons:0});
  }
  click('$/flag:boolean');assert.equal(f.view.value.flag,true);
  click('$/flag:boolean',true);assert.equal(f.view.value.flag,false);
  const open=f.view.isOpen(row(f.view,'$/group'));click('$/group:fold',true);assert.equal(f.view.isOpen(row(f.view,'$/group')),!open);
  let confirmed=0;f.view.render({actions:[{label:'确认',run(){confirmed++;}}]});click('footer:确认',true);assert.equal(confirmed,1);
  f.n.size[1]+=250;f.n.arrange();click('footer:确认',true);assert.equal(confirmed,2);assert(target(f.view,'footer:确认').rect.y>f.view.height);
});

test('restored inspector synchronizes native hit width before image and menu clicks',t=>{
  const assets=path.resolve(__dirname,'../../../../python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');if(!fs.existsSync(assets))return t.skip('Installed frontend unavailable');
  const bundle=fs.readdirSync(assets).filter(name=>/^settingStore-.*\.js$/.test(name)).map(name=>fs.readFileSync(path.join(assets,name),'utf8')).find(text=>text.includes('getWidgetOnPos(e,t,n=!1){'));
  const start=bundle.indexOf('getWidgetOnPos(e,t,n=!1){'),end=bundle.indexOf('findInputSlot(',start);
  const f=fixture(object({photo:{type:'string','x-image':{}}}),{photo:'image.png'}),v=f.view;
  f.context.isInRectangle=(x,y,a,b,w,h)=>x>=a&&x<=a+w&&y>=b&&y<=b+h;f.context.Z={NODE_WIDGET_HEIGHT:20};
  vm.runInContext('this.Hit=class {'+bundle.slice(start,end)+'}',f.context);
  f.n.widgets[0].hidden=true;f.n.isWidgetVisible=w=>!w.hidden;f.n.getWidgetOnPos=f.context.Hit.prototype.getWidgetOnPos;
  f.n.size[0]=1200;v.widget.width=300;v.widget.last_y=999;
  paint(v);
  assert.equal(v.widget.width,1200);assert.equal(v.widget.last_y,0);
  let picked=0;v.chooseImage=()=>picked++;
  paint(v);
  for(const id of ['$/photo:image-mode','$/photo:image']){
    const hit=v.targets.find(t=>t.id===id),p={x:hit.rect.x+hit.rect.w/2,y:hit.rect.y+hit.rect.h/2};
    assert.equal(f.n.getWidgetOnPos(p.x,p.y),v.widget);
    assert.equal(v.hit(p).id,id);hit.run();
    if(v.popup)v.popup.close();
  }
  assert.equal(picked,1);assert.equal(v.value.photo,'image.png');v.dispose();
});

test('Ctrl click expands all descendants including folded list objects and preserves other branches',()=>{
  const schema=object({group:object({items:{type:'array',items:object({nested:object({text:{type:'string'}})})}}),other:object({text:{type:'string'}})});
  const f=fixture(schema,{group:{items:[{nested:{text:'a'}},{nested:{text:'b'}}]},other:{text:'c'}}),v=f.view;
  for(const key of ['$/group','$/group/items','$/group/items/0','$/group/items/0/nested','$/group/items/1','$/group/items/1/nested','$/other'])v.expanded.set(key,false);
  v.render();const hit=target(v,'$/group:fold');
  v.point=e=>({x:e.clientX,y:e.clientY});v.active=()=>true;
  const down={clientX:hit.rect.x+8,clientY:hit.rect.y+10,ctrlKey:true},cursor={eDown:down};
  v.pointerDown(cursor,{});cursor.onClick({...down,ctrlKey:false});
  for(const key of ['$/group','$/group/items','$/group/items/0','$/group/items/0/nested','$/group/items/1','$/group/items/1/nested'])assert.equal(v.expanded.get(key),true,key);
  assert.equal(v.expanded.get('$/other'),false);
  const order=[],set=v.expanded.set.bind(v.expanded);v.expanded.set=(key,value)=>{if(!value)order.push(key);return set(key,value);};
  target(v,'$/group:fold').run({ctrlKey:true});
  for(const key of ['$/group','$/group/items','$/group/items/0','$/group/items/0/nested','$/group/items/1','$/group/items/1/nested'])assert.equal(v.expanded.get(key),false,key);
  for(const key of order){const parent=key.slice(0,key.lastIndexOf('/'));if(order.includes(parent))assert(order.indexOf(key)<order.indexOf(parent));}
  assert.equal(order.at(-1),'$/group');assert(!order.includes('$/other'));
  target(v,'$/group:fold').run({ctrlKey:true});assert.equal(v.expanded.get('$/group'),true);
  target(v,'$/group:fold').run();assert.equal(v.expanded.get('$/group'),false);
  assert.equal(v.expanded.get('$/group/items/1/nested'),true);
  assert.equal(v.value.group.items[1].nested.text,'b');v.dispose();
});

test('double click resize corner fits all expanded nested lists without changing width or values',()=>{
  const f=fixture(object({items:{type:'array',items:object({rows:{type:'array',items:{type:'string'}}})}}),{items:[{rows:Array(12).fill('text')},{rows:Array(8).fill('more')}]});
  const v=f.view;for(const p of ['$/items','$/items/0','$/items/0/rows','$/items/1','$/items/1/rows'])v.expanded.set(p,true);
  v.render();f.n.size[1]=220;f.n.arrange();paint(v);assert(v.lists.some(a=>a.viewport.h<a.total));
  const width=f.n.size[0],value=plain(v.value);v.scroll.set('$/items',50);
  v.point=e=>({x:e.clientX,y:e.clientY});v.active=()=>true;
  let prevented=false;
  v.doubleClickListener({target:v.canvas,clientX:width-3,clientY:f.n.size[1]-(v.widget.last_y??0)-3,preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert(prevented);assert.equal(f.n.size[0],width);assert([...v.scroll.values()].every(offset=>offset===0));
  paint(v);for(const a of v.lists)assert(a.viewport.h>=a.total,`${a.path}: ${a.viewport.h} < ${a.total}`);
  const fitted=f.n.size[1];assert(fitted>220);assert.deepEqual(plain(v.value),value);
  f.n.size[1]+=500;f.n.arrange();paint(v);v.fitContentHeight();assert.equal(f.n.size[1],fitted);
  v.dispose();
});

test('every fold change fits visible content without list scrolling and preserves width and values',()=>{
  const schema=object({group:object({items:{type:'array',items:object({rows:{type:'array',items:{type:'string'}}})}})});
  const value={group:{items:[{rows:Array(8).fill('a')},{rows:Array(6).fill('b')}]}};
  const f=fixture(schema,value),v=f.view,width=f.n.size[0],original=plain(v.value);
  for(const path of ['$/group','$/group/items','$/group/items/0','$/group/items/0/rows','$/group/items/1','$/group/items/1/rows'])v.expanded.set(path,false);
  v.render();v.fitContentHeight();paint(v);
  const collapsed=f.n.size[1];
  target(v,'$/group:fold').run();paint(v);
  assert(f.n.size[1]>collapsed);assert.equal(f.n.size[0],width);
  target(v,'$/group/items:fold').run({ctrlKey:true});paint(v);
  const expanded=f.n.size[1];assert(expanded>collapsed);
  for(const area of v.lists)assert(area.viewport.h>=area.total,`${area.path}: ${area.viewport.h} < ${area.total}`);
  assert([...v.scroll.values()].every(offset=>offset===0));assert.deepEqual(plain(v.value),original);
  target(v,'$/group:fold').run();paint(v);
  assert(f.n.size[1]<expanded);assert.equal(f.n.size[0],width);assert.deepEqual(plain(v.value),original);
  v.dispose();
});

test('Ctrl arrow capture bypasses native selection before widget dispatch and toggles both ways',()=>{
  const f=fixture(object({group:object({nested:object({text:{type:'string'}})})}),{group:{nested:{text:'x'}}}),v=f.view;
  v.expanded.set('$/group',false);v.expanded.set('$/group/nested',false);v.render();v.point=e=>({x:e.clientX,y:e.clientY});v.active=()=>true;
  function click({ctrlKey=true,drag=false,cancel=false,outside=false}={}){
    const hit=target(v,'$/group:fold'),r=hit.arrowRect;
    let stopped=0;const e={target:v.canvas,button:0,ctrlKey,pointerId:9,clientX:outside?r.x+40:r.x+8,clientY:r.y+12,stopImmediatePropagation(){stopped++;}};
    f.document.fire('pointerdown',e);
    if(stopped){
      f.document.fire(cancel?'pointercancel':'pointerup',{...e,type:cancel?'pointercancel':'pointerup',clientX:e.clientX+(drag?20:0),ctrlKey:false});
      assert.equal(stopped,2);
    }
    return stopped;
  }
  assert.equal(click({ctrlKey:false}),0);assert.equal(click({outside:true}),0);
  assert.equal(click(),2);assert.equal(v.expanded.get('$/group/nested'),true);
  assert.equal(click(),2);assert.equal(v.expanded.get('$/group'),false);assert.equal(v.expanded.get('$/group/nested'),false);
  click({drag:true});assert.equal(v.expanded.get('$/group'),false);
  click({cancel:true});assert.equal(v.expanded.get('$/group'),false);
  v.dispose();assert(!f.document.events.pointerdown.includes(v.foldDownListener));
});

test('connected JSON is readonly, validates immediately, and source ports are mutually exclusive',async()=>{
  const h=harness(),n=node(),schema=object({group:object({text:{type:'string'}})});
  n.id=4;h.app.rootGraph.nodes=[n];h.context.findNodes=()=>[{node:n,path:'4'}];
  n.addInput=(name,type,options)=>n.inputs.push({name,type,...options,link:null});
  n.inputs.push({name:'values_json',link:17,type:'STRING'});
  n.widgets[0].value=JSON.stringify({schema,value:{group:{text:'old'}},confirmed:true});
  h.extension.setup();h.extension.nodeCreated(n);await flush();
  assert(!n.inputs.some(i=>i.name==='sync_file'));const v=h.forms[0];assert.equal(v.readOnly,true);
  h.handlers.get('liuxinyu.template_form_source')({detail:{node_id:'4',workflow_id:'root',schema,value:{group:{text:'input'}},imported:true}});await flush();
  assert.equal(v.value.group.text,'input');assert.equal(target(v,'$/group/text:value').kind,'disabled');
  v.commit('$/group/text',()=>{throw Error('must not mutate');},'changed');
  assert(target(v,'$/group:fold').run);assert(!v.chrome.actions.some(a=>a.label==='确认'||a.label==='复位到模板'));
  n.inputs.find(i=>i.name==='values_json').link=null;n.onConnectionsChange();await flush();
  assert(n.inputs.some(i=>i.name==='sync_file'));assert.equal(v.readOnly,false);
  n.inputs.find(i=>i.name==='sync_file').link=18;n.onConnectionsChange();await flush();
  assert(!n.inputs.some(i=>i.name==='values_json'));assert.equal(v.readOnly,true);
  h.handlers.get('liuxinyu.template_form_source')({detail:{node_id:'4',workflow_id:'root',schema,value:{group:{text:'file'}},sync_token:'token',imported:true}});await flush();
  v.toggleSync();assert.equal(v.readOnly,false);
  v.commit('$/group/text',row(v,'$/group/text').set,'edited');await flush();
  assert.equal(h.requests.find(r=>r.url.endsWith('/sync-values')).body.value.group.text,'edited');
  v.toggleSync();assert.equal(v.readOnly,true);n.onRemoved();
});

test('enabling file sync without a token reads the input chain and unlocks editing',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});
  n.widgets[0].value=JSON.stringify({schema,value:{text:'cached'}});
  let reads=0;
  h.context.queueTemplateRefresh=async()=>{reads++;return {prompt_id:'read'};};
  h.context.waitTemplateRefresh=async()=>({imported:true,schema,value:{text:'file'},sync_token:'fresh'});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  assert.equal(v.readOnly,true);await v.toggleSync();
  assert.equal(reads,1);assert.equal(v.readOnly,false);assert.equal(v.value.text,'file');
  v.commit('$/text',row(v,'$/text').set,'edited');await flush();
  assert.equal(h.requests.find(r=>r.url.endsWith('/sync-values')).body.sync_token,'fresh');n.onRemoved();
});

test('restoring a checked sync flag without a token initializes without another click',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});n.properties={lxy_sync_input:true};
  n.widgets[0].value=JSON.stringify({schema,value:{text:'cached'}});
  let reads=0,finish;
  h.context.queueTemplateRefresh=async()=>{reads++;return {prompt_id:'restore'};};
  h.context.waitTemplateRefresh=()=>new Promise(resolve=>{finish=resolve;});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  assert.equal(reads,1);assert.equal(v.readOnly,true);
  finish({imported:true,schema,value:{text:'restored file'},sync_token:'restored'});await flush();
  assert.equal(v.readOnly,false);assert.equal(v.value.text,'restored file');
  v.commit('$/text',row(v,'$/text').set,'written');await flush();
  assert.equal(h.requests.find(r=>r.url.endsWith('/sync-values')).body.value.text,'written');n.onRemoved();
});

test('failed file initialization unchecks sync and preserves the cached value',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});n.widgets[0].value=JSON.stringify({schema,value:{text:'cached'}});
  h.context.queueTemplateRefresh=async()=>{throw Error('file unavailable');};
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];await v.toggleSync();
  assert.equal(n.properties.lxy_sync_input,false);assert.equal(v.readOnly,true);assert.equal(v.value.text,'cached');
  assert.match(v.chrome.status,/file unavailable/);n.onRemoved();
});

test('changing source discards an in-flight file read',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});n.widgets[0].value=JSON.stringify({schema,value:{text:'cached'}});
  let finish;h.context.queueTemplateRefresh=async()=>({prompt_id:'read'});
  h.context.waitTemplateRefresh=()=>new Promise(resolve=>{finish=resolve;});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0],job=v.toggleSync();await flush();
  n.inputs.find(i=>i.name==='sync_file').link=19;n.onConnectionsChange();await flush();
  finish({imported:true,schema,value:{text:'old file'},sync_token:'old'});await job;
  assert.equal(v.value.text,'cached');assert.equal(v.readOnly,true);assert.equal(n.properties.lxy_sync_input,false);n.onRemoved();
});

test('accepted edits still write when sync is unchecked before the queued write starts',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});n.properties={lxy_sync_input:true};
  n.widgets[0].value=JSON.stringify({schema,value:{text:'file'},sync_token:'token'});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  v.commit('$/text',row(v,'$/text').set,'edited');v.toggleSync();await flush();
  assert.equal(v.readOnly,true);assert.equal(h.requests.find(r=>r.url.endsWith('/sync-values')).body.value.text,'edited');n.onRemoved();
});

test('changing source before a queued write starts cancels the old-file write',async()=>{
  const h=harness(),n=node(),schema=object({text:{type:'string'}});
  n.inputs.push({name:'sync_file',link:18});n.properties={lxy_sync_input:true};
  n.widgets[0].value=JSON.stringify({schema,value:{text:'file'},sync_token:'token'});
  h.extension.nodeCreated(n);await flush();const v=h.forms[0];
  v.commit('$/text',row(v,'$/text').set,'edited');
  n.inputs.find(i=>i.name==='sync_file').link=19;n.onConnectionsChange();await flush();
  assert.equal(h.requests.filter(r=>r.url.endsWith('/sync-values')).length,0);assert.equal(v.readOnly,true);n.onRemoved();
});

test('sync checkbox hover uses pointer and clears it on leave, disconnect and dispose',()=>{
  const f=fixture(object({text:{type:'string'}}),{text:'x'}),v=f.view;
  f.n.inputs.push({name:'sync_file',link:18});v.syncToggleRect={x:200,y:-30,w:14,h:14};
  const event={target:v.canvas,clientX:205,clientY:-25};
  v.readOnly=true;v.pointerMove(event);assert.equal(v.canvas.style.cursor,'pointer');
  v.busy=true;v.pointerMove(event);assert.equal(v.canvas.style.cursor,'pointer');
  v.pointerMove({...event,clientX:900});assert.equal(v.canvas.style.cursor,'');
  v.pointerMove(event);f.n.inputs.find(i=>i.name==='sync_file').link=null;
  v.pointerMove(event);assert.equal(v.canvas.style.cursor,'');
  f.n.inputs.find(i=>i.name==='sync_file').link=18;v.pointerMove(event);
  v.dispose();assert.equal(v.canvas.style.cursor,'');
});

test('readonly paints no row overlay and removes disabled hover while folds remain hoverable',()=>{
  const f=fixture(object({text:{type:'string'},group:object({value:{type:'string'}})}),{text:'x',group:{value:'y'}}),v=f.view;
  v.readOnly=true;paint(v);const ctx=context2d(),fills=[],texts=[];
  ctx.fillRect=(...rect)=>fills.push({rect,color:ctx.fillStyle});ctx.fillText=()=>texts.push(ctx.fillStyle);
  v.draw(ctx);assert(!fills.some(x=>x.color==='rgba(45,45,45,0.35)'));assert(texts.includes('#777'));
  v.point=e=>({x:e.clientX,y:e.clientY});
  let t=v.targets.find(t=>t.id==='$/text:value');v.pointerMove({target:v.canvas,clientX:t.rect.x+2,clientY:t.rect.y+2});assert.equal(v.hover,undefined);
  t=v.targets.find(t=>t.id==='$/group:fold');v.pointerMove({target:v.canvas,clientX:t.arrowRect.x+2,clientY:t.arrowRect.y+2});assert.equal(v.hover,t.id);
  v.dispose();
});

test('installed native layout excludes internal state and reserves ports above the entire inspector',t=>{
  const assets=path.resolve(__dirname,'../../../../python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets');if(!fs.existsSync(assets))return t.skip('Installed frontend unavailable');
  const bundle=fs.readdirSync(assets).filter(name=>/^settingStore-.*\.js$/.test(name)).map(name=>fs.readFileSync(path.join(assets,name),'utf8')).find(text=>text.includes('getLayoutWidgets(){'));
  const section=(start,end)=>{const a=bundle.indexOf(start),b=bundle.indexOf(end,a);assert(a>=0&&b>a);return bundle.slice(a,b);};
  const h=harness(),n=node();h.context.fixture=n;h.context.Z={NODE_WIDGET_HEIGHT:20,vueNodesMode:false};h.context.distributeSpace=(space,items)=>items.map(item=>Math.max(item.minSize,Math.min(item.maxSize,space/items.length)));
  vm.runInContext('this.Native=class {'+section('isWidgetVisible(e){','hasAdvancedWidgets(){')+section('_arrangeWidgets(e){','_arrangeWidgetInputSlots(){')+'};hideInternalState(fixture);normalizeSchemaSocket(fixture);',h.context);
  const view=new h.context.NativeForm(n,()=>{});view.setData(object({rows:{type:'array',items:{type:'string'}}}),{rows:['a','b']});view.render();n.getLayoutWidgets=h.context.Native.prototype.getLayoutWidgets;n.bodyHeight=n.size[1];h.context.Native.prototype._arrangeWidgets.call(n,24);
  assert.equal(n.getLayoutWidgets().length,1);assert(view.widget.y>=26);assert(view.widget.computedHeight>=view.height);assert.equal(n.inputs.length,1);assert.equal(n.inputs[0].type,'STRING');
});

if(process.env.LXY_FORM_EXPORT){
  // Command-line renderer probe: capture actual draw operations for inspection.
  const demo=JSON.parse(fs.readFileSync(process.env.LXY_FORM_EXPORT,'utf8'));
  const stored=JSON.parse(demo.nodes.find(n=>n.type==='LiuxinyuTemplateForm').widgets_values[0]);
  const f=fixture(stored.schema,stored.value);f.n.size[0]=560;f.view.render();
  const operations=[],ctx=context2d();
  for(const method of ['fillRect','strokeRect','fillText','roundRect','rect','moveTo','lineTo','arc','beginPath','fill','stroke','save','restore','clip'])ctx[method]=function(...args){operations.push({method,args,fill:this.fillStyle,stroke:this.strokeStyle,font:this.font});};
  f.view.draw(ctx);fs.writeFileSync(process.env.LXY_FORM_DRAW||process.env.LXY_FORM_EXPORT+'.draw.json',JSON.stringify({width:f.view.width,height:f.view.height,operations}));
}
