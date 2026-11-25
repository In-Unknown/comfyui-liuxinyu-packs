const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),vm=require('vm'),path=require('path');
function fixture(){
 const listeners={},canvas={width:1000,height:800,getBoundingClientRect:()=>({left:0,top:0,width:1000,height:800})};
 const document={addEventListener(n,f){(listeners[n]??=[]).push(f);},removeEventListener(n,f){listeners[n]=listeners[n].filter(x=>x!==f);}};
 const app={canvas:{canvas},registerExtension(){}};let copied;
 const context=vm.createContext({app,document,formFont:'14px sans-serif',formTextLayout:()=>({baseline:4}),navigator:{clipboard:{writeText:async v=>{copied=v;}}}});
 const source=fs.readFileSync(path.join(__dirname,'../object_preview.js'),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');
 assert(!source.includes('addDOMWidget'));vm.runInContext(source+'\nthis.Preview=ObjectPreview;',context);
 const node={size:[480,340],graph:{},addCustomWidget(w){return this.widget=w;},setSize(s){this.size=s;},setDirtyCanvas(){}};
 const view=new context.Preview(node);
 const ctx={canvas,save(){},restore(){},translate(){},beginPath(){},rect(){},clip(){},roundRect(){},fill(){},stroke(){},fillRect(){},fillText(){},moveTo(){},lineTo(){},measureText:t=>({width:String(t).length*7}),getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0})};
 const paint=()=>node.widget.draw(ctx,node,999,0);return {view,node,paint,ctx,canvas,listeners,get copied(){return copied;}};
}
test('canvas owns layout, tree expansion, selection details and full JSON copy',async()=>{
 const f=fixture();f.view.receive([{a:[1,{b:'long text'}],empty:{}}]);f.paint();assert.equal(f.view.rows.length,3);
 f.view.toggle(f.view.rows[1]);f.paint();assert.equal(f.view.rows.length,5);
 f.view.select(f.view.rows[3]);f.paint();assert(f.view.detail);assert(f.view.detailText.includes('long text'));
 for(const t of f.view.targets)assert(t.rect.x+t.rect.w<=480);
 await f.view.copy(f.view.detailText);assert.equal(f.copied,f.view.detailText);
 f.view.dispose();assert(Object.values(f.listeners).every(list=>list.length===0));
});
test('wheel consumes only node content and leaves canvas zoom alone; large lists paint visible rows',()=>{
 const f=fixture();f.view.receive([Array.from({length:10000},(_,i)=>i)]);f.paint();assert(f.view.targets.length<30);
 let consumed=0;const e={target:f.canvas,clientX:100,clientY:100,deltaY:100,preventDefault(){consumed++;},stopImmediatePropagation(){}};
 f.view.wheel(e);assert.equal(consumed,1);assert.equal(f.view.scroll,100);
 f.view.wheel({...e,ctrlKey:true});f.view.wheel({...e,clientX:800});assert.equal(consumed,1);
 f.paint();assert(f.view.targets.length<30);
});
test('pointer toggle and facade paint preserve live hit geometry',()=>{
 const f=fixture();f.view.receive([{a:[1]}]);f.paint();const targets=f.view.targets;
 const facade=Object.create(f.node);facade.size=[300,200];f.node.widget.draw(f.ctx,facade,800,0);assert.equal(f.view.targets,targets);
 const t=f.view.targets.find(t=>t.id==='fold:0/a');const e={target:f.canvas,clientX:t.rect.x+3,clientY:t.rect.y+3};const cursor={eDown:e};f.view.pointer(cursor);cursor.onClick(e);f.paint();assert.equal(f.view.rows.length,3);
});

test('Ctrl arrow recursively toggles all descendants and preserves siblings; cancel does not toggle',()=>{
 const f=fixture();f.view.receive([{a:{'b/c':[{}, {deep:[]} ]},sibling:{keep:[]}}]);f.paint();
 const t=f.view.targets.find(t=>t.id==='fold:0/a');
 const e={button:0,ctrlKey:true,pointerId:1,target:f.canvas,clientX:t.rect.x+3,clientY:t.rect.y+3,preventDefault(){},stopImmediatePropagation(){}};
 f.view.foldDown(e);f.view.foldUp({...e,type:'pointerup'});f.paint();
 assert(f.view.expanded.has('0/a/b%2Fc/1/deep'));assert(!f.view.expanded.has('0/sibling'));
 f.view.foldDown(e);f.view.foldUp({...e,type:'pointercancel'});assert(f.view.expanded.has('0/a'));
 f.view.foldDown(e);f.view.foldUp({...e,type:'pointerup'});assert(![...f.view.expanded].some(p=>p.startsWith('0/a')));
 f.view.toggle(f.view.rows.find(r=>r.path==='0/a'));assert(!f.view.expanded.has('0/a/b%2Fc'));
});
test('double click corner fits expanded tree and wrapped detail without scrolling or width changes',()=>{
 const f=fixture();f.canvas.getContext=()=>f.ctx;
 f.view.receive([{a:Array.from({length:30},(_,i)=>({name:'value'+i}))}]);f.view.toggleRecursive(f.view.rows[1]);f.paint();
 f.view.select(f.view.rows[1]);f.paint();const before=JSON.stringify(f.view.items),width=f.node.size[0];
 let prevented=false;f.view.doubleClick({target:f.canvas,clientX:width-2,clientY:f.node.size[1]-2,preventDefault(){prevented=true;},stopImmediatePropagation(){}});f.paint();
 assert(prevented);assert.equal(f.node.size[0],width);assert(f.view.body.h>=f.view.rows.length*28);assert(f.view.detail.h>=f.view.detailLines.length*22);
 assert.equal(JSON.stringify(f.view.items),before);const height=f.node.size[1];f.node.size[1]+=400;f.view.fitContentHeight();assert.equal(f.node.size[1],height);
});

test('tree connectors carry ancestor trunks through descendants and terminate at the last child',()=>{
 const f=fixture();f.view.receive([{a:{one:1,two:2},b:3}]);f.view.toggle(f.view.rows[1]);
 const one=f.view.rows.find(r=>r.path==='0/a/one'),two=f.view.rows.find(r=>r.path==='0/a/two'),b=f.view.rows.find(r=>r.path==='0/b');
 const lines=r=>JSON.parse(JSON.stringify(f.view.treeLines(r,12,100,10)));
 assert.deepEqual(lines(one),[[20.5,100,20.5,128],[40.5,100,40.5,128],[40.5,114,50,114]]);
 assert.deepEqual(lines(two),[[20.5,100,20.5,128],[40.5,100,40.5,114],[40.5,114,50,114]]);
 assert.deepEqual(lines(b),[[20.5,100,20.5,114],[20.5,114,30,114]]);
 f.view.toggle(f.view.rows[1]);assert(!f.view.rows.some(r=>r.path==='0/a/one'));
});
test('clickable areas show hand cursor, ownership prevents resetting another widget cursor',()=>{
 const f=fixture();f.canvas.style={cursor:''};f.view.receive([{a:1}]);f.paint();
 const t=f.view.targets.find(t=>t.id==='copy'),event={target:f.canvas,clientX:t.rect.x+2,clientY:t.rect.y+2};
 f.view.move(event);assert.equal(f.canvas.style.cursor,'pointer');
 f.view.move({...event,clientX:900});assert.equal(f.canvas.style.cursor,'');
 f.view.move(event);f.canvas.__lxyFormPointerOwner={};f.canvas.style.cursor='text';f.view.move({...event,clientX:900});assert.equal(f.canvas.style.cursor,'text');
 f.view.move(event);f.view.dispose();assert.equal(f.canvas.style.cursor,'');
});

test('wheel matches template form boundaries, units and independent detail scrolling',()=>{
 const f=fixture();f.view.receive([{short:1}]);f.paint();let consumed=0;
 const event={target:f.canvas,clientX:100,clientY:80,deltaY:1,deltaMode:1,preventDefault(){consumed++;},stopImmediatePropagation(){}};
 f.view.wheel(event);assert.equal(consumed,0,'fitting content returns wheel to canvas');
 f.view.receive([Array.from({length:100},(_,i)=>i)]);f.paint();
 f.view.wheel({...event,deltaY:-1});assert.equal(consumed,0,'top boundary');
 f.view.wheel(event);assert.equal(f.view.scroll,16);assert.equal(consumed,1);
 f.view.wheel({...event,deltaY:1,deltaMode:2});assert.equal(f.view.scroll,16+f.view.body.h);
 f.view.wheel({...event,deltaY:1e6,deltaMode:0});assert.equal(f.view.scroll,f.view.rows.length*28-f.view.body.h);
 const count=consumed;f.view.wheel(event);assert.equal(consumed,count,'bottom boundary');
 f.view.wheel({...event,deltaY:0,deltaX:30});assert.equal(consumed,count,'horizontal wheel is not vertical scroll');
 f.view.select(f.view.rows[0]);f.paint();const tree=f.view.scroll;
 const detailEvent={...event,clientY:f.view.detail.y+5};f.view.wheel(detailEvent);assert.equal(f.view.detailScroll,16);assert.equal(f.view.scroll,tree);
 const after=consumed;f.view.wheel({...detailEvent,ctrlKey:true});f.view.wheel({...detailEvent,metaKey:true});assert.equal(consumed,after);
 f.view.detailScroll=f.view.detailLines.length*22-f.view.detail.h;f.view.wheel(detailEvent);assert.equal(consumed,after);
});

test('expansion grows naturally beyond fixed heights; detail uses content size; manual size can be reset',()=>{
 const f=fixture();f.canvas.getContext=()=>f.ctx;
 f.view.receive([{a:Array.from({length:80},(_,i)=>({value:i}))}]);f.paint();
 f.view.toggleRecursive(f.view.rows[1]);f.paint();assert(f.node.size[1]>4000);assert(f.view.body.h>=f.view.rows.length*28);
 f.view.select(f.view.rows.find(r=>r.path==='0/a/0/value'));f.paint();assert.equal(f.view.detail.h,22);assert(f.view.body.h>=f.view.rows.length*28);
 f.node.size[1]=400;f.view.select(f.view.rows[1]);f.paint();assert.equal(f.node.size[1],400);assert(f.view.body.h<f.view.rows.length*28);
 f.view.fitContentHeight();f.paint();assert(f.view.body.h>=f.view.rows.length*28);assert(f.view.detail.h>=f.view.detailLines.length*22);
 f.view.toggleRecursive(f.view.rows[1]);f.paint();assert(f.view.body.h>=f.view.rows.length*28);
});

test('clicking selected row deselects and closes details; other rows switch selection and arrows only fold',()=>{
 const f=fixture();f.canvas.getContext=()=>f.ctx;f.view.receive([{a:{v:1},b:2}]);f.paint();
 const click=id=>{f.view.targets.find(t=>t.id===id).run();f.paint();};
 click('0/a');assert.equal(f.view.selected.path,'0/a');assert(f.view.detail);const height=f.node.size[1];
 click('fold:0/a');assert.equal(f.view.selected.path,'0/a');
 click('0/b');assert.equal(f.view.selected.path,'0/b');
 click('0/b');assert.equal(f.view.selected,null);assert.equal(f.view.detail,null);assert.equal(f.view.detailScroll,0);assert(f.node.size[1]<=height+28);
 click('0/a');assert.equal(f.view.selected.path,'0/a');
});

test('toolbar removes collapse button and draws copy icon without text, preserving JSON copy',async()=>{
 const f=fixture(),texts=[];f.ctx.fillText=t=>texts.push(t);f.view.receive([{a:1}]);f.paint();
 assert(!f.view.targets.some(t=>t.id==='collapse'));assert(!texts.includes('复制JSON'));assert(!texts.includes('收起'));
 const copy=f.view.targets.find(t=>t.id==='copy');assert.equal(copy.rect.w,24);await copy.run();assert.deepEqual(JSON.parse(f.copied),{a:1});
});

test('JSON detail colors keys, escaped strings, numbers, literals and matching brackets across wraps',()=>{
 const f=fixture();const value={key:'quote " slash \\ 中文 long text',number:-1.2e-7,array:[true,false,null,{x:42}]};
 f.view.receive([value]);f.view.select(f.view.rows[0]);f.paint();
 const spans=f.view.detailColors.flat();
 assert(spans.some(s=>s.color==='#9cdcfe'&&s.text.includes('key')));
 assert(spans.some(s=>s.color==='#ce9178'&&s.text.includes('quote')));
 assert(spans.some(s=>s.color==='#b5cea8'&&s.text.includes('-1.2e-7')));
 assert(spans.some(s=>s.color==='#569cd6'&&s.text.includes('true')));
 assert(spans.some(s=>s.color==='#ffd700'&&s.text==='{'));
 f.view.layoutJSON(f.ctx,42);
 assert.equal(f.view.detailLines.join(''),JSON.stringify(value,null,2).replace(/\n/g,''));
 for(let i=0;i<f.view.detailLines.length;i++)assert.equal(f.view.detailColors[i].map(s=>s.text).join(''),f.view.detailLines[i]);
 assert.equal(f.view.detailText,JSON.stringify(value,null,2));
});
