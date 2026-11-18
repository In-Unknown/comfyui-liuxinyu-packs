import { visibleCanvasRect } from "./canvas_viewport.js";
import { app } from "../../scripts/app.js";
import { cloneJSON, own, resolveSchema, rawReason, typesOf, valueType, initialValue, itemSchema, numericBounds, vectorComponents } from "./template_form_model.js";
import { closeFormPopup, editFormValue, formMenu, pickFormDate, pickFormColor, colorDigits, formMenuUnit, formMenuFont, formMenuFontReady, formFont, formTextLayout } from "./template_form_popups.js";

const typeNames={object:"对象",array:"数组",string:"字符串",integer:"整数",number:"浮点数",boolean:"布尔值",null:"无值"};
const diagnosticLineHeight=20,diagnosticGap=4,diagnosticIconSize=diagnosticLineHeight*2+diagnosticGap-6;
const diagnosticTextInset=8+diagnosticIconSize+10;
const listItemPadding=6,listEdgePadding=4;
const pathKey=(path,key)=>`${path}/${String(key).replace(/~/g,"~0").replace(/\//g,"~1")}`;
const inside=(r,x,y)=>r&&x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h;
const intersection=(a,b)=>!a?b:!b?a:{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y),w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))};

// One real canvas widget owns the property tree, its layout and hit regions.
// Only the currently edited value / an explicitly opened picker uses temporary DOM.
export class NativeTemplateForm {
  constructor(node,onChange){
    this.node=node;this.onChange=onChange;this.errors=new Map();this.expanded=new Map();this.selected=new Map();this.scroll=new Map();this.branches=new Map();this.typeChoices=new Map();
    this.rows=[];this.targets=[];this.lists=[];this.height=40;this.width=440;this.chrome={};this.busy=false;this.disposed=false;this.serverErrors=new Map();
    void formMenuFontReady.then(()=>{if(!this.disposed)this.dirty();});
    const view=this;
    this.widget=node.addCustomWidget({name:"__lxy_form_inspector",type:"template_form_inspector",serialize:false,options:{serialize:false},
      serializeValue:()=>undefined,computeLayoutSize(node){
        const n=node||this.node||view.node,renderer=n===view.node?view:view.preview(n);
        renderer.layout(n.size[0],0);return {minWidth:360,minHeight:renderer.height,maxHeight:1e6};
      },
      draw(ctx,n,width,y){
        const renderer=n===view.node?view:view.preview(n);
        ctx.save();try{ctx.translate(0,y);renderer.matrix=ctx.getTransform();renderer.canvas=ctx.canvas||app.canvas?.canvas;renderer.layout(width,this.computedHeight??n.size[1]-y);renderer.draw(ctx);}finally{ctx.restore();}
      },
      onPointerDown(cursor,n,canvas){return view.pointerDown(cursor,canvas);},
    });
    this.moveListener=event=>this.pointerMove(event);this.wheelListener=event=>this.wheel(event);this.keyListener=event=>this.key(event);
    document.addEventListener("pointermove",this.moveListener,true);
    document.addEventListener("wheel",this.wheelListener,{capture:true,passive:false});
    document.addEventListener("keydown",this.keyListener,true);
    this.outsideListener=event=>{
      if(this.popup?.root.contains(event.target))return;
      if(event.target===this.canvas&&this.hit(this.point(event)))return;
      if(this.focus||this.activeList){this.focus=null;this.activeList=null;this.dirty();}
    };
    document.addEventListener("pointerdown",this.outsideListener,true);
  }
  preview(node){
    // Activity renders facade nodes with copied widgets, but their methods retain
    // this closure. Give that read-only paint its own layout and pointer state.
    const renderer=Object.assign(Object.create(Object.getPrototypeOf(this)),this,{
      node,rows:[],targets:[],lists:[],scroll:new Map(this.scroll),
      hover:null,pressed:null,focus:null,activeList:null,nextFocus:null,drag:null,listMotion:null,motionFrame:null,gesture:null,popup:null,
    });
    renderer.tree=this.schema===undefined?null:renderer.field(this.presentation??this.schema,this.value,()=>{},"$","填写结果",0,true);
    return renderer;
  }
  dirty(){this.node.setDirtyCanvas?.(true,true);}
  active(){return !this.disposed&&this.node.graph&&(!app.canvas?.graph||app.canvas.graph===this.node.graph)&&!this.node.flags?.collapsed;}
  dispose(){
    this.disposed=true;closeFormPopup(this);this.cancelGesture();this.clearHover();
    document.removeEventListener("pointermove",this.moveListener,true);document.removeEventListener("wheel",this.wheelListener,true);document.removeEventListener("keydown",this.keyListener,true);
    document.removeEventListener("pointerdown",this.outsideListener,true);
    if(this.node.widgets.includes(this.widget))this.node.removeWidget(this.widget);
  }
  setData(schema,value){
    if(JSON.stringify(this.schema)!==JSON.stringify(schema)){closeFormPopup(this);this.expanded.clear();this.branches.clear();this.typeChoices.clear();this.scroll.clear();this.errors.clear();}
    if(this.schema===undefined)this.restoreExpansion();
    this.schema=schema;this.value=cloneJSON(value);
  }
  restoreExpansion(){
    const entries=this.node.properties?.lxy_template_form_view?.expanded;
    this.expanded=new Map(Array.isArray(entries)?entries.filter(entry=>Array.isArray(entry)&&
      entry.length===2&&typeof entry[0]==='string'&&(entry[0]==='$'||entry[0].startsWith('$/'))&&typeof entry[1]==='boolean'):[]);
  }
  saveExpansion(){
    if(this.schema===undefined)return;
    const expanded=[...this.expanded];
    if(JSON.stringify(this.node.properties?.lxy_template_form_view?.expanded)===JSON.stringify(expanded))return;
    this.node.properties??={};
    this.node.properties.lxy_template_form_view={expanded};
    this.node.graph?.change?.();
  }
  setPresentation(schema){this.presentation=schema;}
  updateStatus(text){this.chrome.status=text;this.dirty();}
  setBusy(value){if(value){closeFormPopup(this);this.clearHover();this.focus=null;this.activeList=null;}this.busy=value;this.dirty();}
  fail(path,message){this.errors.set(path,message);this.chrome.status=`${path}：${message}`;this.render(this.chrome);}
  setErrors(list){this.serverErrors.clear();for(const item of list)if(typeof item!=="string"){
    const path=this.errorPointer(item.path),previous=this.serverErrors.get(path);
    this.serverErrors.set(path,previous?`${previous}；${item.display_message??item.message}`:item.display_message??item.message);
    this.expandPath(path);
  }}
  errorPointer(path){return !path||path==='$'?'$':path.startsWith('$')?path:`$${path}`;}
  expandPath(path){
    const parts=this.errorPointer(path).split('/');
    for(let i=1;i<=parts.length;i++)this.expanded.set(parts.slice(0,i).join('/'),true);
  }
  errorRow(path){
    let current=this.errorPointer(path);
    while(current){
      const row=this.rows.find(r=>r.path===current&&(r.set||r.kind==='absent')&&!['handle','listSelection','listBackground','listFooter','scrollbar','error','errorFrame'].includes(r.kind));
      if(row)return row;current=current.includes('/')?current.slice(0,current.lastIndexOf('/')):null;
    }
    return this.rows.find(r=>r.set||r.kind==='absent');
  }
  revealError(path){
    closeFormPopup(this);this.cancelGesture();this.expandPath(path);this.render(this.chrome);
    let row=this.errorRow(path);if(!row)return;
    // Reveal the target in the innermost viewport first, then its parents.
    for(const part of [...(row.clipStack||[])].reverse()){
      const area=this.lists.find(a=>a.path===part.path);row=this.errorRow(path);if(!area||!row)continue;
      const top=row.rect.y,bottom=top+24,min=area.viewport.y+listEdgePadding,max=area.viewport.y+area.viewport.h-listEdgePadding;
      const delta=top<min?top-min:bottom>max?bottom-max:0;
      if(delta){this.scroll.set(area.path,Math.max(0,Math.min(area.total-area.viewport.h,area.offset+delta)));this.layout(this.width);}
    }
    row=this.errorRow(path);this.focus=`${row.path}:value`;
    const screen=this.screenRect({...row.rect,h:24}),canvas=app.canvas;
    if(screen&&canvas?.ds?.offset){
      const area=visibleCanvasRect(canvas);
      if(!area?.width||!area?.height)return;
      const b=this.canvas.getBoundingClientRect(),sx=this.matrix.a*b.width/this.canvas.width,sy=this.matrix.d*b.height/this.canvas.height;
      canvas.ds.offset[0]+=(area.left+area.width/2-screen.left-screen.width/2)/sx;
      canvas.ds.offset[1]+=(area.top+area.height/2-screen.top-screen.height/2)/sy;
    }
    this.dirty();
  }
  fieldError(path){return this.errors.get(path)||this.serverErrors.get(path);}
  errorPath(path){
    if(!path||path==='$')return '整个表单';
    let value=this.value;
    return path.replace(/^\$?\//,'').split('/').map(part=>{
      const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
      const label=Array.isArray(value)&&/^\d+$/.test(key)?`第${Number(key)+1}项`:key;
      value=value?.[key];return label;
    }).join('.');
  }
  wrapText(text,width){
    const ctx=(this.canvas||app.canvas?.canvas)?.getContext?.('2d'),lines=[];
    if(ctx){ctx.save();ctx.font=formFont;}
    const measure=text=>ctx?ctx.measureText(text).width:[...text].reduce((n,c)=>n+(c.codePointAt(0)>127?14:7),0);
    try{for(const paragraph of String(text??'').split(/\r?\n/)){
      let line='';for(const char of paragraph){
        if(line&&measure(line+char)>width){lines.push(line);line='';}line+=char;
      }lines.push(line);
    }}finally{ctx?.restore();}
    return lines;
  }
  commit(path,set,value){
    this.errors.delete(path);this.node.graph?.beforeChange?.();
    try{set(value);this.onChange(cloneJSON(this.value));}finally{this.node.graph?.afterChange?.();}
    this.render(this.chrome);
  }
  changeStructure(path,fn){
    if(this.errors.size){this.updateStatus("先修正当前输入错误，再修改结构");return;}
    closeFormPopup(this);this.commit(path,()=>fn(),null);
  }
  field(schema,value,set,path,label,depth=0,root=false){
    let s;try{s=resolveSchema(schema,this.presentation??this.schema);}catch(e){s={_rawReason:e.message};}
    const base={schema:s,value,set,path,label:s?.title||label,depth,description:s?.description||""};
    if(rawReason(s))return {...base,kind:'pending',reason:'正在解析字段规则…',description:rawReason(s)};
    if(s===false)return {...base,kind:"invalid",reason:"Schema 不允许任何值"};
    if(own(s,"const"))return {...base,kind:"const",constant:s.const};
    if(s.enum)return {...base,kind:"enum",choices:s.enum};
    const choices=s.oneOf||s.anyOf;
    if(choices){
      let selected=this.branches.get(path);
      if(selected===undefined){
        const matches=choices.map((child,index)=>{
          let resolved;try{resolved=resolveSchema(child,this.schema);}catch{return -1;}
          const types=typesOf(resolved,value),type=valueType(value);
          if(rawReason(resolved)||!types.includes(type)&&!(type==="integer"&&types.includes("number")))return -1;
          if(resolved.enum&&!resolved.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))return -1;
          if(own(resolved,"const")&&JSON.stringify(resolved.const)!==JSON.stringify(value))return -1;
          if(resolved.required&&(!value||typeof value!=="object"||!resolved.required.every(k=>own(value,k))))return -1;
          return index;
        }).filter(i=>i>=0);
        // Presentation inference only; the original full schema is still validated.
        if(matches.length===1)selected=matches[0];
      }
      return {...base,kind:"branch",choices,selected,children:[this.field(selected==null||selected<0?true:choices[selected],value,set,path,label,depth+1,true)]};
    }
    const types=typesOf(s,value);let type=valueType(value);if(type==="integer"&&!types.includes(type)&&types.includes("number"))type="number";
    if(this.typeChoices.get(path)==='number'&&types.includes('number')&&typeof value==='number')type='number';
    let axes;try{axes=vectorComponents(s,value,this.schema);}catch{axes=null;}
    if(axes)return {...base,kind:"vector",axes};
    if(!types.includes(type))return {...base,kind:"mismatch",types,reason:`需要 ${types.join(" / ")}，点击选择类型`};
    if(type==="object"){
      const props=s.properties||{},required=s.required||[];
      const children=[...new Set([...Object.keys(props),...required,...Object.keys(value)])].map(key=>{
        const child=own(props,key)?props[key]:s.additionalProperties??true,childPath=pathKey(path,key);
        const put=next=>{Object.defineProperty(value,key,{value:next,writable:true,enumerable:true,configurable:true});set(value);};
        const item=own(value,key)?this.field(child,value[key],put,childPath,key,depth+1):{kind:"absent",schema:child,path:childPath,label:child?.title||key,depth:depth+1};
        item.optional=!required.includes(key);item.present=own(value,key);
        item.toggle=()=>this.changeStructure(childPath,()=>{if(own(value,key))delete value[key];else put(initialValue(child,this.schema)??null);set(value);});
        return item;
      });
      return {...base,kind:root&&types.length===1?"root":"group",types,children,add:s.additionalProperties!==false?()=>this.addKey(base):null};
    }
    if(type==="array")return {...base,kind:"list",types,children:value.map((item,i)=>{
      const child=this.field(itemSchema(s,i),item,next=>{value[i]=next;set(value);},`${path}/${i}`,`元素 ${i}`,depth+1);
      child.arrayMember=true;
      const name=child.kind==='group'?child.children.find(field=>field.kind==='string'&&field.value.trim()):null;
      child.label=name?name.value:`元素 ${i}${child.schema?.title?` · ${child.schema.title}`:""}`;
      child.description=[`元素 ${i}`,child.description].filter(Boolean).join(' · ');return child;
    })};
    return {...base,kind:type,types,bounds:["integer","number"].includes(type)?numericBounds(s,type):null,color:colorDigits(s)};
  }
  render(chrome={}){
    if(this.disposed)return;
    this.saveExpansion();
    this.chrome=chrome;this.busy=!!chrome.busy;
    this.tree=this.schema===undefined?null:this.field(this.presentation??this.schema,this.value,next=>this.value=next,"$","填写结果",0,true);
    this.layout(this.node.size[0],Infinity,true);
    const preferredHeight=this.height;
    if(this.node.graph){
      const size=this.node.computeSize(),height=this.node.size[1];
      const preferredSize=preferredHeight+size[1]-this.height;
      if(this.lastRenderedHeight!==undefined?height!==this.lastRenderedHeight:height>preferredSize)this.manualHeight=height;
      this.node.setSize([Math.max(360,this.node.size[0],size[0]),Math.max(size[1],this.manualHeight??preferredSize)]);this.node.arrange?.();
      this.lastRenderedHeight=this.node.size[1];
    }
    this.layout(this.node.size[0]);
    this.dirty();
  }
  isOpen(item){return this.expanded.get(item.path)??item.depth<2;}
  gap(left,right,depth=0){
    if(!left||!right)return 0;
    const section=item=>['group','list','branch'].includes(item.kind);
    // A section's own open state must not move its header. Only preceding
    // content determines the gap above it.
    if(section(left)&&section(right)&&!this.isOpen(left))return 4;
    return section(left)||section(right)?(depth===0?10:6):4;
  }
  stackHeight(children,depth,right,left,indent){return children.reduce((sum,child,i)=>sum+this.measure(child,right,left,indent)+this.gap(children[i-1],child,depth),0);}
  measure(item,right=this.width-12,left=12,indent=0,suppressError=false){
    let h=24;
    if(item.kind==="root"||item.kind==="group"){
      const content=item.kind==="group"&&!this.isOpen(item)?0:this.stackHeight(item.children,item.depth,right,left,indent+(item.kind==="group"?12:0))+(item.add?8+24+6:0);
      h=item.kind==="root"?content:24+(this.isOpen(item)&&content?4+content:0);
    }
    else if(item.kind==="list"){
      const listLeft=Math.min(left+indent,this.valueColumn-72),rightInset=Math.min(12,Math.max(0,right-this.valueColumn-120));
      item.contentHeight=this.isOpen(item)?item.children.reduce((sum,child)=>sum+this.measure(child,right-rightInset,listLeft+22,0)+2*listItemPadding,2*listEdgePadding):0;
      item.viewportHeight=Math.max(28,Math.min(this.listBudget,item.contentHeight));
      h=24+(this.isOpen(item)?item.viewportHeight+24:0);
    }
    else if(item.kind==="branch")h=28+this.measure(item.children[0],right,left,indent+12,true);
    else if(item.kind==="vector"){
      item.columns=Math.min(this.fieldRight,right-26)-this.valueColumn<item.axes.length*46?2:item.axes.length;
      h=28*Math.ceil(item.axes.length/item.columns)-4;
    }
    item.stackedType=item.types?.length>1&&!['root','group','list','null','mismatch'].includes(item.kind)&&Math.min(this.fieldRight,right-26)-this.valueColumn<180;
    if(item.stackedType)h+=28;
    const error=suppressError?null:this.fieldError(item.path);
    item.errorLeft=Math.min(left+indent,this.valueColumn-72);
    item.errorLines=error?this.wrapText(error,Math.max(1,right-item.errorLeft-12)):[];
    item.errorHeight=item.errorLines.length?8+item.errorLines.length*diagnosticLineHeight:0;
    h+=item.errorHeight;
    item.height=h;return h;
  }
  footerLayout(actions,width){
    const ctx=(this.canvas||app.canvas?.canvas)?.getContext?.('2d');
    if(ctx){ctx.save();ctx.font=formFont;}
    let x=width,y=0;const items=[];
    try{for(const action of [...actions].reverse()){
      const textWidth=ctx?ctx.measureText(action.label).width:[...action.label].reduce((n,c)=>n+(c.charCodeAt(0)>127?14:7),0);
      const w=Math.min(width,textWidth+20);
      if(x<w&&x!==width){y-=30;x=width;}
      x-=w;items.push({action,x,y,w});x-=6;
    }}finally{ctx?.restore();}
    for(const item of items)item.y-=y;
    return {items,height:24-y};
  }
  layout(width,availableHeight=this.node.size[1]-(this.widget?.y??24),measureOnly=false){
    // Measure the complete form first. Only a real container constraint introduces
    // scrolling; the shared budget distributes scarce space across nested lists.
    if(availableHeight===0){this.listBudget=28;this.measuringLists=true;this.layoutContent(width);this.measuringLists=false;return;}
    this.measuringLists=true;
    this.listBudget=Infinity;this.layoutContent(width);
    if(Number.isFinite(availableHeight)&&this.height>availableHeight){
      let low=28,high=this.height;
      for(let pass=0;pass<16&&high-low>.25;pass++){
        const middle=(low+high)/2;this.listBudget=middle;this.layoutContent(width);
        if(this.height>availableHeight)high=middle;else low=middle;
      }
      this.listBudget=low;this.layoutContent(width);
    }
    this.measuringLists=measureOnly;this.layoutContent(width);this.measuringLists=false;
    const footer=this.rows.find(row=>row.kind==='footer');
    if(footer&&Number.isFinite(availableHeight)&&availableHeight>this.height)footer.rect.y+=availableHeight-this.height;
  }
  layoutContent(width){
    // Native hit testing may call computeSize between paint and pointer-up.
    // Keep the hit regions of the visible frame until draw replaces them.
    this.width=Math.max(280,width);this.rows=[];this.lists=[];
    // Shared value start; right edges respect the enclosing list's content box.
    this.valueColumn=Math.round(Math.min(this.width-148,Math.max(124,this.width*.48)));
    this.fieldRight=this.width-38;
    let y=4;
    if(this.chrome.requests?.length>1){this.rows.push({kind:"requests",rect:{x:12,y,w:this.width-24,h:26}});y+=30;}
    if(this.tree){this.measure(this.tree);this.place(this.tree,12,y,this.width-24,0,null);y+=this.tree.height;}
    else y+=8;
    const status=this.errors.size?[...this.errors.entries()].map(([p,m])=>`${p}: ${m}`)[0]:this.chrome.status||"连接 JSON Schema，运行后填写";
    this.rows.push({kind:"status",text:status,rect:{x:12,y:y+4,w:this.width-24,h:24}});y+=30;
    for(const [index,error] of (this.chrome.errors||[]).entries()){
      const path=typeof error==='string'?'':error.path,message=typeof error==='string'?error:error.message;
      const textWidth=this.width-24-diagnosticTextInset-12,pathLines=path?this.wrapText(path,textWidth):[],messageLines=this.wrapText(message,textWidth);
      const h=16+Math.max(diagnosticIconSize,(pathLines.length+messageLines.length)*diagnosticLineHeight+(pathLines.length?diagnosticGap:0));
      this.rows.push({kind:'diagnostic',index,targetPath:typeof error==='string'?'$':error.targetPath??'$',pathLines,messageLines,text:[path,message].filter(Boolean).join('\n'),rect:{x:12,y,w:this.width-24,h}});y+=h;
    }
    if(this.chrome.errors?.length)y+=10;
    let footer;
    if(this.chrome.actions?.length){
      const layout=this.footerLayout(this.chrome.actions,this.width-24);
      footer={kind:"footer",items:layout.items,rect:{x:12,y,w:this.width-24,h:layout.height}};
      this.rows.push(footer);y+=layout.height+8;
    }
    this.height=Math.max(52,y+4);
  }
  place(item,x,y,w,indent,clip,clipStack=[]){
    const row={...item,rect:{x,y,w,h:item.kind==="vector"?28*Math.ceil(item.axes.length/item.columns)-4:24},clip,clipStack,indent};
    if(item.kind==="list"){
      const left=Math.min(x+indent,this.valueColumn-72);
      row.rect={x:left,y,w:x+w-left,h:24};row.indent=0;
    }
    if(item.kind==="root"){
      item.children.forEach((child,i)=>{y+=this.gap(item.children[i-1],child,item.depth);this.place(child,x,y,w,indent,clip,clipStack);y+=child.height;});
      if(item.add)this.rows.push({...row,kind:"add",rect:{x,y:y+8,w,h:24}});
      this.placeFieldError(item,row);return;
    }
    this.rows.push(row);
    if(item.kind==="branch"){
      const guide=this.indentGuide(row),start=this.rows.length;
      this.place(item.children[0],x,y+28,w,indent+12,clip,clipStack);this.extendGuide(guide,this.rows[start]);this.placeFieldError(item,row);return;
    }
    if(item.kind==="group"&&this.isOpen(item)){
      const guide=this.indentGuide(row);
      let next=y+28;item.children.forEach((child,i)=>{
        next+=this.gap(item.children[i-1],child,item.depth);const start=this.rows.length;
        this.place(child,x,next,w,indent+12,clip,clipStack);this.extendGuide(guide,this.rows[start]);next+=child.height;
      });
      if(item.add)this.rows.push({...row,kind:"add",rect:{x,y:next+8,w,h:24}});
    }
    if(item.kind==="list"&&this.isOpen(item)){
      const total=item.contentHeight,viewport={x:row.rect.x,y:y+24,w:row.rect.w,h:item.viewportHeight};
      const offset=Math.max(0,Math.min(this.scroll.get(item.path)||0,Math.max(0,total-viewport.h)));if(!this.measuringLists)this.scroll.set(item.path,offset);
      const area={...row,viewport,total,offset,entries:[]};this.lists.push(area);
      this.rows.push({...row,kind:"listBackground",area,rect:viewport});
      let next=viewport.y+listEdgePadding-offset;
      item.children.forEach((child,index)=>{
        const entry={index,y:next,h:child.height+2*listItemPadding};area.entries.push(entry);
        const childClip=intersection(clip,viewport);
        const start=this.rows.length,childStack=[...clipStack,{path:item.path,rect:viewport}];
        this.rows.push({...row,kind:"listSelection",index,area,rect:{x:viewport.x+1,y:next,w:viewport.w-2,h:entry.h},clip:childClip,clipStack:childStack});
        this.rows.push({...row,kind:"handle",index,area,rect:{x:viewport.x+3,y:next+listItemPadding,w:18,h:24},clip:childClip,clipStack:childStack});
        // Keep the scrollbar gutter even when it is hidden, so folding does not
        // change descendant widths or move the nested footer horizontally.
        const rightInset=Math.min(12,Math.max(0,viewport.x+viewport.w-this.valueColumn-120));
        this.place(child,viewport.x+22,next+listItemPadding,viewport.w-22-rightInset,0,childClip,childStack);
        for(let i=start;i<this.rows.length;i++){
          (this.rows[i].entryOwners??=[]).push({path:item.path,index});
          // A nested collection's backgrounds/handles already own an area and
          // index. Never overwrite those with this enclosing entry's index.
          if(!this.rows[i].list&&!this.rows[i].area){this.rows[i].list=area;this.rows[i].index=index;}
        }
        next+=entry.h;
      });
      if(!item.children.length)this.rows.push({...row,kind:"empty",rect:viewport,clip});
      this.rows.push({...row,kind:"listFooter",area,rect:{x:viewport.x,y:viewport.y+viewport.h,w:viewport.w,h:24}});
      if(total>viewport.h)this.rows.push({...row,kind:"scrollbar",area,rect:{x:viewport.x+viewport.w-6,y:viewport.y,w:6,h:viewport.h},clip});
    }
    this.placeFieldError(item,row);
  }
  placeFieldError(item,row){
    if(!item.errorHeight)return;
    const r=row.rect,left=item.errorLeft,width=r.x+r.w-left;
    const errorY=r.y+item.height-item.errorHeight;
    this.rows.push({...row,kind:"errorFrame",divider:errorY,rect:{x:left,y:r.y,w:width,h:item.height}});
    this.rows.push({...row,kind:"error",text:this.fieldError(item.path),lines:item.errorLines,
      rect:{x:left+6,y:errorY+4,w:width-12,h:item.errorHeight-8}});
  }
  labelStart(row){return Math.min(row.rect.x+(row.indent||0)+16,this.valueColumn-52);}
  indentGuide(row){
    const guide={kind:'indentGuide',path:row.path,clip:row.clip,clipStack:row.clipStack,branches:[],rect:{x:this.labelStart(row)-9,y:row.rect.y+22,w:0,h:0}};
    this.rows.push(guide);return guide;
  }
  extendGuide(guide,child){
    if(!child)return;
    const end=this.labelStart(child)-(['group','list'].includes(child.kind)?17:5);
    // At the narrow layout's indentation limit there is no free gutter left.
    if(end<=guide.rect.x)return;
    const y=child.rect.y+12;guide.branches.push({x:end,y});
    guide.rect.w=Math.max(guide.rect.w,end-guide.rect.x);guide.rect.h=y-guide.rect.y;
  }
  target(row,part,rect,run,kind="click",extra={}){
    const id=`${row.path||row.kind}:${part}`,target={id,rect,clip:row.clip,run,kind,row,...extra};
    if(!this.drag?.started)this.targets.push(target);return target;
  }
  box(ctx,r,{hover=false,pressed=false,disabled=false,focused=false,error=false,variant="input"}={}){
    ctx.globalAlpha=disabled ? .45 : 1;
    ctx.fillStyle=variant==="input"?(pressed?"#222":"#2b2b2b"):(pressed?"#353535":hover?"#575757":"#494949");
    ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,3);ctx.fill();
    ctx.strokeStyle=error?"#ab7771":focused?"#718b9a":hover?"#555":"#252525";ctx.stroke();ctx.globalAlpha=1;
  }
  text(ctx,text,x,y,width,color="#ccc",height=24,align="left"){
    ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline="alphabetic";text=String(text??"");
    const baseline=formTextLayout(ctx,text).baseline;
    while(text.length>1&&ctx.measureText(text).width>width)text=text.slice(0,-2)+"…";
    ctx.fillText(text,align==="center"?x+width/2:x,y+height/2+baseline);
    return ctx.measureText(text).width;
  }
  arrow(ctx,x,y,open,color="#999"){ctx.fillStyle=color;ctx.beginPath();if(open){ctx.moveTo(x,y+9);ctx.lineTo(x+10,y+9);ctx.lineTo(x+5,y+15);}else{ctx.moveTo(x+2,y+7);ctx.lineTo(x+2,y+17);ctx.lineTo(x+8,y+12);}ctx.fill();}
  button(ctx,row,part,rect,label,run,disabled=false,flat=false){
    const id=`${row.path||row.kind}:${part}`;
    if(flat){
      if(!disabled&&!this.busy&&(this.hover===id||this.pressed===id)){ctx.fillStyle=this.pressed===id?"#2b2b2b":"#505050";ctx.fillRect(rect.x,rect.y+1,rect.w,rect.h-2);}
    }else this.box(ctx,rect,{hover:!disabled&&this.hover===id,pressed:!disabled&&this.pressed===id,disabled:disabled||this.busy,variant:part==="count"?"input":"button"});
    if(["+","＋","−","⋮"].includes(label)){
      const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;
      ctx.save();ctx.strokeStyle=ctx.fillStyle=disabled?"#777":"#ccc";ctx.lineWidth=1.5;ctx.beginPath();
      if(label==="⋮"){for(const dy of [-4,0,4]){ctx.moveTo(cx+1,cy+dy);ctx.arc(cx,cy+dy,1,0,Math.PI*2);}ctx.fill();}
      else{ctx.moveTo(cx-4,cy);ctx.lineTo(cx+4,cy);if(label!=="−"){ctx.moveTo(cx,cy-4);ctx.lineTo(cx,cy+4);}ctx.stroke();}
      ctx.restore();
    }else if(part==="count")this.text(ctx,label,rect.x+6,rect.y,rect.w-12,disabled?"#777":"#ccc",rect.h);
    else this.text(ctx,label,rect.x+4,rect.y,rect.w-8,disabled?"#777":"#ccc",rect.h,"center");
    const hint=part==="presence"?`${row.present?"移除":"添加"}字段：${row.label}`:part==="count"?"编辑列表条数":part==="add-item"?"在列表末尾添加并选中新项":part==="remove-item"?"移除当前选中项；请先选择一项":part==="type"?"选择值的类型":"";
    this.target(row,part,rect,disabled?null:run,disabled?"disabled":['type','requests'].includes(part)?'menu':"click",{hint:disabled?`当前不可用：${hint||label}`:hint});
  }
  draw(ctx){
    this.targets=[];ctx.font=formFont;ctx.lineWidth=1;ctx.textBaseline="alphabetic";
    const moving=[],drag=this.drag?.started?this.drag:null;
    const motionPath=drag?.area.path??this.listMotion?.path,now=Date.now();
    const paint=(row,dy=0)=>{
      let clip=row.clip;
      if(motionPath&&row.clipStack?.length){
        const member=row.entryOwners?.find(owner=>owner.path===motionPath);
        const prefix=member?`${motionPath}/${member.index}`:null;
        clip=row.clipStack.reduce((result,part)=>intersection(result,{...part.rect,y:part.rect.y+(prefix&&(part.path===prefix||part.path.startsWith(prefix+'/'))?dy:0)}),null);
      }
      if(clip&&(row.rect.y+dy+row.rect.h<clip.y||row.rect.y+dy>clip.y+clip.h))return;
      // A cut-off nested footer must not leave fragments of clickable +/- over
      // the enclosing list's fixed footer. Reveal both actions after scrolling.
      if(row.kind==='listFooter'&&clip&&(row.rect.y+dy<clip.y||row.rect.y+dy+row.rect.h>clip.y+clip.h))return;
      ctx.save();if(clip){ctx.beginPath();ctx.rect(clip.x,clip.y,clip.w,clip.h);ctx.clip();}
      const targetStart=this.targets.length;
      ctx.translate(0,dy);this.drawRow(ctx,row);ctx.restore();
      if(dy)for(const target of this.targets.slice(targetStart)){target.rect={...target.rect,y:target.rect.y+dy};target.clip=clip;}
    };
    for(const row of this.rows){
      const member=motionPath&&row.entryOwners?.find(owner=>owner.path===motionPath);
      if(drag&&member&&member.index===drag.index){moving.push(row);continue;}
      paint(row,member?this.motionOffset(member.index,now):0);
    }
    for(const row of moving)paint(row,this.dragOffset(drag.index));
    if(this.nextFocus){const target=this.targets.find(t=>t.id===this.nextFocus);this.nextFocus=null;if(target)queueMicrotask(()=>target.run?.());}
  }
  dragOffset(index){
    const drag=this.drag,source=drag.area.entries[drag.index],viewport=drag.area.viewport;
    if(index===drag.index)return Math.max(viewport.y,Math.min(viewport.y+viewport.h-Math.min(source.h,viewport.h),drag.point.y-drag.grabOffset))-source.y;
    if(drag.to<drag.index&&index>=drag.to&&index<drag.index)return source.h;
    if(drag.to>drag.index+1&&index>drag.index&&index<drag.to)return -source.h;
    return 0;
  }
  motionOffset(index,now=Date.now()){
    const entry=this.listMotion?.entries.get(index);if(!entry)return 0;
    const t=Math.max(0,Math.min(1,(now-entry.start)/160)),ease=1-(1-t)**3;
    return entry.from+(entry.to-entry.from)*ease;
  }
  animateList(path,targets){
    const now=Date.now(),previous=this.listMotion?.path===path?this.listMotion:null,entries=new Map();
    for(const [index,to] of targets){
      const old=previous?.entries.get(index);
      entries.set(index,old?.to===to?old:{from:previous?this.motionOffset(index,now):0,to,start:now});
    }
    this.listMotion={path,entries};this.scheduleListAnimation();
  }
  scheduleListAnimation(){
    if(this.motionFrame||this.disposed)return;
    this.motionFrame=requestAnimationFrame(()=>{
      this.motionFrame=null;if(!this.listMotion)return;
      this.dirty();
      if([...this.listMotion.entries.values()].some(e=>Date.now()-e.start<160&&e.from!==e.to))this.scheduleListAnimation();
      else if(!this.drag)this.listMotion=null;
    });
  }
  finishReorder(drag){
    const now=Date.now(),old=drag.area.entries.map((entry,i)=>({index:i,y:entry.y+(i===drag.index?this.dragOffset(i):this.motionOffset(i,now))}));
    const to=drag.to??drag.index,dest=to>drag.index?to-1:to;
    this.drag=null;this.reorder(drag.area,drag.index,to);this.layout(this.width);
    const area=this.lists.find(a=>a.path===drag.area.path);
    if(!area){this.listMotion=null;return;}
    const entries=new Map();
    for(const item of old){
      const i=item.index===drag.index?dest:dest<drag.index&&item.index>=dest&&item.index<drag.index?item.index+1:dest>drag.index&&item.index>drag.index&&item.index<=dest?item.index-1:item.index;
      entries.set(i,{from:item.y-area.entries[i].y,to:0,start:now});
    }
    this.listMotion={path:area.path,entries};this.scheduleListAnimation();
  }
  updateDragTarget(){
    const drag=this.drag,source=drag.area.entries[drag.index],top=source.y+this.dragOffset(drag.index);
    drag.to=drag.index;
    if(top>source.y){
      drag.to=drag.index+1;
      for(let i=drag.index+1;i<drag.area.entries.length;i++){
        const entry=drag.area.entries[i];if(top+source.h<=entry.y+entry.h/2)break;drag.to=i+1;
      }
    }else for(let i=drag.index-1;i>=0;i--){
      const entry=drag.area.entries[i];if(top>=entry.y+entry.h/2)break;drag.to=i;
    }
    this.animateList(drag.area.path,new Map(drag.area.entries.map((_,i)=>[i,i===drag.index?0:this.dragOffset(i)])));
  }
  drawRow(ctx,row){
    const r=row.rect,indent=row.indent||0,path=row.path;
    const fieldRight=Math.min(this.fieldRight,r.x+r.w-26);
    if(row.kind==='indentGuide'){
      if(!row.branches.length)return;
      const x=Math.round(r.x)+.5;
      ctx.strokeStyle=this.guideColor(row,'#5a5a5a');ctx.lineWidth=1;ctx.beginPath();
      ctx.moveTo(x,Math.round(r.y)+.5);ctx.lineTo(x,Math.round(r.y+r.h)+.5);
      for(const branch of row.branches){const y=Math.round(branch.y)+.5;ctx.moveTo(x,y);ctx.lineTo(Math.round(branch.x)+.5,y);}
      ctx.stroke();return;
    }
    if(row.kind==="listBackground"){
      const right=r.x+r.w,top=r.y,bottom=r.y+r.h,tabRight=right-8,tabLeft=tabRight-64;
      // The title is outside the outline. Only body and footer form one shape.
      const left=r.x+.5,radius=3,xRight=right-.5,yTop=top+.5,yBottom=bottom-.5;
      ctx.beginPath();ctx.moveTo(left+radius,yTop);ctx.lineTo(xRight-radius,yTop);ctx.quadraticCurveTo(xRight,yTop,xRight,yTop+radius);
      ctx.lineTo(xRight,yBottom-radius);ctx.quadraticCurveTo(xRight,yBottom,xRight-radius,yBottom);ctx.lineTo(tabRight-.5,yBottom);
      ctx.lineTo(tabRight-.5,bottom+23.5-radius);ctx.quadraticCurveTo(tabRight-.5,bottom+23.5,tabRight-.5-radius,bottom+23.5);
      ctx.lineTo(tabLeft+.5+radius,bottom+23.5);ctx.quadraticCurveTo(tabLeft+.5,bottom+23.5,tabLeft+.5,bottom+23.5-radius);
      ctx.lineTo(tabLeft+.5,yBottom);ctx.lineTo(left+radius,yBottom);ctx.quadraticCurveTo(left,yBottom,left,yBottom-radius);
      ctx.lineTo(left,yTop+radius);ctx.quadraticCurveTo(left,yTop,left+radius,yTop);ctx.closePath();
      ctx.fillStyle="#454545";ctx.fill();ctx.strokeStyle="#292929";ctx.stroke();
      this.target(row,"body",r,null,"hint");return;
    }
    if(row.kind==="listSelection"){
      if(this.selected.get(path)===row.index){ctx.fillStyle=this.activeList===path?"#2c5d87":"#505050";ctx.fillRect(r.x,r.y,r.w,r.h);}
      this.target(row,`select${row.index}`,r,()=>{this.activeList=path;this.selected.set(path,row.index);this.dirty();});return;
    }
    if(row.kind==="handle"){
      ctx.strokeStyle=this.pressed===`${path}:drag${row.index}`?"#eee":this.hover===`${path}:drag${row.index}`?"#bbb":"#888";ctx.beginPath();for(const dy of [-2,2]){ctx.moveTo(r.x+r.w/2-5,r.y+r.h/2+dy);ctx.lineTo(r.x+r.w/2+5,r.y+r.h/2+dy);}ctx.stroke();
      this.target(row,`drag${row.index}`,r,()=>this.selected.set(path,row.index),"reorder",{area:row.area,index:row.index});return;
    }
    if(row.kind==="scrollbar"){
      const a=row.area,h=Math.max(18,r.h*r.h/a.total),y=r.y+(r.h-h)*a.offset/(a.total-r.h);
      ctx.fillStyle="#707070";ctx.fillRect(r.x+1,y,4,h);this.target(row,"scroll",r,null,"scroll",{area:a});return;
    }
    if(row.kind==="listFooter"){
      this.target(row,"footer-space",r,null,"hint");
      const a=row.area,value=row.value,canAdd=value.length<(row.schema.maxItems??Infinity)&&itemSchema(row.schema,value.length)!==false;
      this.button(ctx,row,"add-item",{x:r.x+r.w-68,y:r.y+1,w:28,h:22},"＋",()=>this.resizeList(row,value.length+1),!canAdd,true);
      const selected=this.selected.get(path);
      this.button(ctx,row,"remove-item",{x:r.x+r.w-40,y:r.y+1,w:28,h:22},"−",()=>this.removeItem(row),!Number.isInteger(selected)||selected<0||selected>=value.length||value.length<=(row.schema.minItems||0),true);return;
    }
    if(row.kind==="empty"){this.text(ctx,"空列表",r.x+8,r.y,r.w-16,"#888",r.h);return;}
    if(row.kind==='diagnostic'){
      ctx.beginPath();ctx.rect(r.x,r.y,r.w,r.h);ctx.clip();
      const clickable=row.targetPath!=null;
      ctx.fillStyle=clickable&&this.hover===`diagnostic:explanation-${row.index}`?'#454545':row.index%2?'#353535':'#3b3b3b';ctx.fillRect(r.x,r.y,r.w,r.h);
      ctx.strokeStyle='#292929';ctx.strokeRect(r.x+.5,r.y+.5,r.w-1,r.h-1);
      const cx=r.x+8+diagnosticIconSize/2,cy=r.y+r.h/2,radius=diagnosticIconSize/(2*Math.cos(Math.PI/8));
      ctx.fillStyle='#e06459';ctx.beginPath();
      for(let i=0;i<8;i++){const angle=Math.PI/8+i*Math.PI/4,x=cx+radius*Math.cos(angle),y=cy+radius*Math.sin(angle);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);}ctx.closePath();ctx.fill();
      const unit=diagnosticIconSize/20;
      ctx.fillStyle='#242424';ctx.fillRect(cx-1.25*unit,cy-6*unit,2.5*unit,8*unit);ctx.fillRect(cx-1.25*unit,cy+4*unit,2.5*unit,2.5*unit);
      let y=r.y+8;
      for(const line of row.pathLines){this.text(ctx,line,r.x+diagnosticTextInset,y,r.w-diagnosticTextInset-12,'#ddd',diagnosticLineHeight);y+=diagnosticLineHeight;}
      if(row.pathLines.length)y+=diagnosticGap;
      for(const line of row.messageLines){this.text(ctx,line,r.x+diagnosticTextInset,y,r.w-diagnosticTextInset-12,'#c9c9c9',diagnosticLineHeight);y+=diagnosticLineHeight;}
      this.target(row,`explanation-${row.index}`,r,clickable?()=>this.revealError(row.targetPath):null,clickable?'click':'hint',{hint:clickable?'点击定位到此字段':row.text});return;
    }
    if(row.kind==="errorFrame"){
      ctx.strokeStyle="#ab7771";ctx.lineWidth=1;ctx.beginPath();
      ctx.roundRect(r.x+.5,r.y+.5,r.w-1,r.h-1,4);ctx.stroke();
      ctx.beginPath();ctx.moveTo(r.x+1,row.divider+.5);ctx.lineTo(r.x+r.w-1,row.divider+.5);ctx.stroke();return;
    }
    if(row.kind==="error"){
      row.lines.forEach((line,index)=>this.text(ctx,line,r.x,r.y+index*diagnosticLineHeight,r.w,"#cd9b91",diagnosticLineHeight));
      this.target(row,"explanation-"+r.y,r,null,'hint',{hint:row.text});return;
    }
    if(row.kind==="status"){this.text(ctx,row.text,r.x,r.y,r.w,"#aaa",r.h);return;}
    if(row.kind==="footer"){
      for(const {action,x,y,w} of row.items)this.button(ctx,row,action.label,{x:r.x+x,y:r.y+y,w,h:24},action.label,action.run);return;
    }
    if(row.kind==="requests"){
      this.button(ctx,row,"requests",r,`待填写项（${this.chrome.requests.length}）`,()=>this.menu(row,r,this.chrome.requests.map(e=>({label:e.node_id,value:e})),entry=>this.chrome.select(entry)));return;
    }
    if(row.kind==="add"){this.button(ctx,row,"add-key",{x:Math.min(r.x+indent+16,this.valueColumn-52),y:r.y+2,w:Math.min(110,r.w-16),h:20},"＋ 新增字段",()=>this.addKey(row));return;}
    const optional=row.optional||row.present===false;
    const labelX=this.labelStart(row);
    // Optional membership is distinct from boolean values and array operations.
    // Missing fields offer an explicit add action in the value column; removal
    // lives in the trailing gutter instead of displacing every field label.
    const foldable=['group','list'].includes(row.kind);
    if(optional&&row.present&&!foldable){
      const pr={x:Math.min(this.width-36,r.x+r.w-20),y:r.y+3,w:18,h:18};
      this.button(ctx,row,"presence",pr,"−",row.toggle);
    }
    if(foldable){
      const open=this.isOpen(row),typeWidth=row.types?.length>1?96:0,presenceWidth=optional&&row.present?24:0;
      const controlsRight=r.x+r.w-4-presenceWidth,countWidth=(row.kind==="list"?48:0)+typeWidth;
      const title={x:labelX-16,y:r.y,w:controlsRight-labelX+16-countWidth,h:24};
      this.arrow(ctx,labelX-14,r.y,open,this.pressed===`${path}:fold`?"#fff":this.hover===`${path}:fold`?"#ccc":"#999");this.text(ctx,row.label,labelX,r.y,title.w-20);
      this.target(row,"fold",{x:r.x,y:r.y,w:r.w,h:24},()=>{closeFormPopup(this);this.expanded.set(path,!open);this.render(this.chrome);},"click",{hint:[row.label,row.description].filter(Boolean).join(' · ')});
      if(presenceWidth)this.button(ctx,row,"presence",{x:r.x+r.w-22,y:r.y+3,w:18,h:18},"−",row.toggle);
      if(row.kind==="list"){
        const count={x:controlsRight-44-typeWidth,y:r.y+2,w:44,h:20};
        this.button(ctx,row,"count",count,String(row.value.length),()=>this.edit(row,count,row.value.length,text=>this.resizeList(row,Number(text))));
      }
      if(typeWidth)this.typeDropdown(ctx,row,{x:controlsRight-90,y:r.y+2,w:90,h:20});
      return;
    }
    const hasTypes=row.types?.length>1;
    const valueX=this.valueColumn,labelWidth=Math.max(8,valueX-labelX-8);
    const labelEnd=labelX+this.text(ctx,row.label,labelX,r.y,labelWidth,row.kind==="absent"?"#999":"#ccc");
    if(valueX-labelEnd>18){
      ctx.save();ctx.strokeStyle=this.guideColor(row,'rgba(180,180,180,0.18)');ctx.lineWidth=1;ctx.setLineDash([3,3]);
      ctx.beginPath();ctx.moveTo(labelEnd+6,r.y+12);ctx.lineTo(valueX-5,r.y+12);ctx.stroke();ctx.restore();
    }
    this.target(row,"label",{x:labelX,y:r.y,w:labelWidth,h:24},null,"hint",{hint:ctx.measureText(row.label).width>labelWidth?row.label:row.description});
    const vr={x:valueX,y:r.y+2,w:fieldRight-valueX,h:20};
    if(hasTypes&&row.kind!=="mismatch"){
      if(row.kind==='null'){this.typeDropdown(ctx,row,vr);return;}
      const mr=row.stackedType?{...vr}:{x:fieldRight-90,y:vr.y,w:90,h:20};
      this.typeDropdown(ctx,row,mr);
      if(row.stackedType)vr.y+=28;else vr.w-=96;
    }
    row.valueRect=vr;
    if(row.kind==="mismatch"){
      this.typeDropdown(ctx,row,vr,"repair-type");return;
    }
    if(row.kind==="absent"){this.button(ctx,row,"presence",{...vr,w:Math.min(84,vr.w)},"＋ 添加",row.toggle);return;}
    if(row.kind==="pending"){this.text(ctx,row.reason,vr.x+6,vr.y,vr.w-12,"#999",vr.h);return;}
    if(row.kind==="invalid"){this.text(ctx,row.reason,vr.x,vr.y,vr.w,"#cd9b91",vr.h);return;}
    if(row.kind==="boolean"){
      const br={x:vr.x,y:vr.y+1,w:18,h:18};this.box(ctx,br,{hover:this.hover===`${path}:boolean`,pressed:this.pressed===`${path}:boolean`,focused:this.focus===`${path}:boolean`});
      if(row.value){ctx.strokeStyle="#ccc";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(br.x+4,br.y+9);ctx.lineTo(br.x+8,br.y+13);ctx.lineTo(br.x+15,br.y+4);ctx.stroke();ctx.lineWidth=1;}
      this.target(row,"boolean",br,()=>this.commit(path,row.set,!row.value));
    }else if(row.kind==="vector"){
      const gap=4,columns=row.columns||row.axes.length,cell=(vr.w-gap*(columns-1))/columns;row.axes.forEach((key,i)=>{
        const start=vr.x+(i%columns)*(cell+gap),cy=vr.y+Math.floor(i/columns)*28,cr={x:start+17,y:cy,w:cell-17,h:20};this.text(ctx,key.toUpperCase(),start,cy,13,"#aaa",20,"center");
        this.valueBox(ctx,row,cr,String(row.value[key]),()=>this.edit(row,cr,row.value[key],text=>{
          const child=resolveSchema(row.schema.properties[key],this.schema);const n=this.number(text,child);const next={...row.value,[key]:n};this.commit(path,row.set,next);
        }),`axis${key}`);
      });
    }else if(row.kind==="number"||row.kind==="integer"){
      let nr=vr;
      if(row.bounds.slider){
        nr={x:vr.x+vr.w-66,y:vr.y,w:66,h:20};const sr={x:vr.x,y:vr.y,w:vr.w-76,h:20};
        ctx.strokeStyle="#242424";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(sr.x+4,sr.y+10);ctx.lineTo(sr.x+sr.w-4,sr.y+10);ctx.stroke();ctx.lineWidth=1;
        const f=Math.max(0,Math.min(1,(row.value-row.bounds.min)/(row.bounds.max-row.bounds.min)));ctx.fillStyle=this.pressed===`${path}:slider`?"#8aa8bb":this.hover===`${path}:slider`?"#ddd":"#aaa";ctx.fillRect(sr.x+4+(sr.w-8)*f-3.5,sr.y+3,7,14);
        this.target(row,"slider",sr,null,"slider");
      }
      this.valueBox(ctx,row,nr,String(row.value),()=>this.edit(row,nr,row.value,text=>this.commit(path,row.set,this.number(text,{...row.schema,type:row.kind}))),"value","number");
    }else if(row.kind==="enum"||row.kind==="branch"){
      const height=Math.min(vr.h,18*formMenuUnit);vr.y+=(vr.h-height)/2;vr.h=height;
      const display=value=>value===null?'无值':typeof value==="string"?value:JSON.stringify(value);
      const choices=row.kind==="enum"?row.choices.map(value=>({label:display(value)+(row.choices.filter(v=>display(v)===display(value)).length>1?`（${typeNames[valueType(value)]}）`:""),value,selected:JSON.stringify(value)===JSON.stringify(row.value)})): [{label:"保留当前值",value:-1,selected:row.selected==null||row.selected<0},...row.choices.map((s,i)=>({label:s.title||`结构 ${i+1}`,value:i,selected:i===row.selected}))];
      const label=row.kind==="enum"?display(row.value):choices[row.selected==null?0:row.selected+1]?.label;
      this.valueBox(ctx,row,vr,label,()=>this.menu(row,vr,choices,choice=>{
        if(row.kind==="enum")this.commit(path,row.set,cloneJSON(choice));
        else this.changeStructure(path,()=>{this.branches.set(path,choice);if(choice>=0){const next=initialValue(row.choices[choice],this.schema)??null;row.set(next&&row.value&&typeof next==="object"&&typeof row.value==="object"&&!Array.isArray(next)&&!Array.isArray(row.value)?Object.assign(Object.create(null),next,row.value):next);}});
      }),row.kind==="branch"?"branch":"value","menu",16*formMenuUnit);
    }else if(row.kind==="const"||row.kind==="null"){
      this.text(ctx,(row.kind==="const"?row.constant:null)===null?'无值':JSON.stringify(row.constant),vr.x+6,vr.y,vr.w-12,"#999",vr.h);
      if(row.kind==="const"&&JSON.stringify(row.value)!==JSON.stringify(row.constant))this.button(ctx,row,"const",vr,"使用固定值",()=>this.commit(path,row.set,cloneJSON(row.constant)));
    }else{
      const text=row.kind==="json"?JSON.stringify(row.value):String(row.value??"");
      const date=["date","time","date-time"].includes(row.schema?.format),color=row.color;
      const tr=color?{...vr,x:vr.x+38,w:vr.w-38}:{...vr,w:vr.w-(date?28:0)};
      this.valueBox(ctx,row,tr,text,()=>this.edit(row,tr,text,input=>{
        const next=row.kind==="json"?JSON.parse(input):input;this.commit(path,row.set,next);
      },row.kind==="json"||text.includes("\n")));
      if(date||color){const pr={x:color?vr.x:vr.x+vr.w-25,y:vr.y,w:color?34:25,h:20};
        this.button(ctx,row,"picker",pr,"",()=>{
          const anchor=this.anchor(row,pr);
          if(color)pickFormColor(this,anchor,row.value,color,value=>this.commit(path,row.set,value));
          else pickFormDate(this,anchor,row.schema.format,row.value,value=>this.commit(path,row.set,value));
        });
        if(color&&/^#[\da-f]{6}([\da-f]{2})?$/i.test(row.value)){
          for(let y=0;y<16;y+=4)for(let x=0;x<26;x+=4){ctx.fillStyle=(x/4+y/4)%2?"#666":"#999";ctx.fillRect(pr.x+4+x,pr.y+2+y,Math.min(4,26-x),4);}
          ctx.fillStyle=row.value;ctx.fillRect(pr.x+4,pr.y+2,26,16);
        }else if(date){
          ctx.strokeStyle="#aaa";ctx.beginPath();
          const cx=pr.x+pr.w/2,cy=pr.y+pr.h/2;
          if(row.schema.format==="time"){ctx.arc(cx,cy,7,0,Math.PI*2);ctx.moveTo(cx,cy-5);ctx.lineTo(cx,cy);ctx.lineTo(cx+4,cy);}
          else{ctx.rect(cx-6.5,cy-6.5,13,13);ctx.moveTo(cx-6.5,cy-2.5);ctx.lineTo(cx+6.5,cy-2.5);}
          ctx.stroke();
        }
      }
    }
  }
  typeDropdown(ctx,row,rect,part='type'){
    let current=['integer','number'].includes(row.kind)?row.kind:valueType(row.value);
    if(current==='integer'&&!row.types.includes(current)&&row.types.includes('number'))current='number';
    const choices=row.types.map(type=>({label:typeNames[type],value:type,selected:type===current}));
    const height=Math.min(rect.h,18*formMenuUnit);rect.y+=(rect.h-height)/2;rect.h=height;
    this.valueBox(ctx,row,rect,typeNames[current],()=>this.menu(row,rect,choices,type=>{
      if(type===current)return;
      this.changeStructure(row.path,()=>{
        this.typeChoices.set(row.path,type);
        const schema={...row.schema,type};
        // A nullable field often defaults to null. Switching to a number must
        // initialize the chosen type using its bounds instead of that null default.
        for(const key of ['default','const'])if(own(schema,key)&&valueType(schema[key])!==type&&!(type==='number'&&valueType(schema[key])==='integer'))delete schema[key];
        row.set(initialValue(schema,this.presentation??this.schema)??null);
      });
    }),part,'menu',16*formMenuUnit);
  }
  guideColor(row,normal){return row.entryOwners?.some(owner=>this.selected.get(owner.path)===owner.index)?'#353535':normal;}
  valueBox(ctx,row,rect,text,run,part="value",kind="edit",rightInset=6){
    if(kind==='menu'){
      const id=`${row.path}:${part}`,u=formMenuUnit,open=this.popup?.triggerId===id;
      ctx.save();ctx.globalAlpha=this.busy?.45:1;
      ctx.fillStyle=this.hover===id||this.pressed===id||open?'#585858':'#515151';
      ctx.strokeStyle=this.fieldError(row.path)?'#ab7771':'#242424';ctx.lineWidth=u;
      ctx.beginPath();ctx.roundRect(rect.x+.5*u,rect.y+.5*u,rect.w-u,rect.h-u,1.5*u);ctx.fill();ctx.stroke();
      ctx.font=formMenuFont;this.text(ctx,text,rect.x+3*u,rect.y,rect.w-3*u-rightInset,'#bdbdbd',rect.h);
      const x=rect.x+rect.w-9*u,y=rect.y+rect.h/2;
      ctx.fillStyle='#bdbdbd';ctx.beginPath();ctx.moveTo(x-3.5*u,y-1.5*u);ctx.lineTo(x+3.5*u,y-1.5*u);ctx.lineTo(x,y+2.5*u);ctx.closePath();ctx.fill();ctx.restore();
      this.target(row,part,rect,run,kind);return;
    }
    const id=`${row.path}:${part}`;this.box(ctx,rect,{hover:this.hover===id,pressed:this.pressed===id,focused:this.focus===id,disabled:this.busy,error:!!this.fieldError(row.path),variant:kind==="click"?"menu":"input"});
    this.text(ctx,text,rect.x+6,rect.y,rect.w-6-rightInset,"#ccc",rect.h);this.target(row,part,rect,run,kind);
  }
  number(text,schema){
    const n=Number(text);if(!String(text).trim()||!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER||schema.type==="integer"&&!Number.isInteger(n))throw new Error("请输入有效数值，整数不能带小数");
    return n;
  }
  targetAt(row,rect){return this.targets.find(t=>t.row.path===row.path&&['x','y','w','h'].every(k=>Math.abs(t.rect[k]-rect[k])<.01));}
  anchor(row,rect){
    const target=this.targetAt(row,rect);
    return ()=>{
      const current=target?this.targets.find(t=>t.id===target.id):null;
      const screen=target?(current?this.screenRect(current.rect):null):this.screenRect(rect);
      if(!screen)return null;
      const b=this.canvas.getBoundingClientRect(),local=current?.clip?this.screenRect(current.clip):null;
      const left=Math.max(b.left,local?.left??b.left),top=Math.max(b.top,local?.top??b.top);
      const right=Math.min(b.left+b.width,local?local.left+local.width:b.left+b.width),bottom=Math.min(b.top+b.height,local?local.top+local.height:b.top+b.height);
      return {...screen,scale:screen.height/(current?.rect.h||rect.h),clip:{left,top,right,bottom}};
    };
  }
  menu(row,rect,choices,choose){
    const target=this.targetAt(row,rect);
    if(target&&this.popup?.triggerId===target.id){closeFormPopup(this);return;}
    const popup=formMenu(this,this.anchor(row,rect),choices,choose);
    popup.triggerId=target?.id;
    // Let the canvas's pointer-up toggle the opener. Closing on document
    // pointer-down would otherwise make that same click open a new menu.
    popup.ignoreOutside=event=>event.target===this.canvas&&!!target&&this.hit(this.point(event))?.id===target.id;
    this.focus=target?.id;this.dirty();popup.onClose=()=>{this.focus=null;this.hover=null;this.dirty();};
  }
  edit(row,rect,value,commit,multiline=false){
    const target=this.targetAt(row,rect);
    const editIds=this.targets.filter(t=>t.run&&(t.id.endsWith(":value")||t.id.includes(":axis"))).map(t=>t.id);
    const oldStatus=this.chrome.status;let applied=false;
    this.focus=target?.id;
    const popup=editFormValue(this,this.anchor(row,rect),value,text=>{try{commit(text);applied=true;this.errors.delete(row.path);return true;}catch(e){this.fail(row.path,e.message);throw e;}},{multiline,allowMultiline:row.kind==="string"||row.kind==="json",label:row.label,onTab:direction=>{
      const index=editIds.indexOf(target?.id);this.nextFocus=editIds[(index+direction+editIds.length)%editIds.length];this.dirty();
    }});
    popup.onClose=()=>{if(this.errors.delete(row.path)&&!applied)this.chrome.status=oldStatus;this.focus=null;this.render(this.chrome);};
    this.dirty();
  }
  addKey(row){
    const rect=this.targets.find(t=>t.id===`${row.path}:add-key`)?.rect||row.rect||{x:12,y:4,w:200,h:24};this.edit({...row,path:row.path+":new"},rect,"",key=>{
      if(own(row.value,key))throw new Error("该键已存在");
      this.changeStructure(row.path,()=>{Object.defineProperty(row.value,key,{value:initialValue(row.schema.additionalProperties??true,this.schema)??null,writable:true,enumerable:true,configurable:true});row.set(row.value);});
    });
  }
  resizeList(row,count){
    if(!Number.isSafeInteger(count)||count<0)throw new Error("条数必须为非负整数");
    if(count<(row.schema.minItems||0)||count>(row.schema.maxItems??Infinity))throw new Error("条数超出 minItems / maxItems");
    if(count-row.value.length>1000)throw new Error("一次最多新增 1000 项");
    for(let i=row.value.length;i<count;i++)if(itemSchema(row.schema,i)===false)throw new Error("Schema 不允许此位置新增条目");
    this.changeStructure(row.path,()=>{while(row.value.length<count)row.value.push(initialValue(itemSchema(row.schema,row.value.length),this.schema)??null);row.value.length=count;row.set(row.value);this.reindexListState(row.path,i=>i<count?i:null);this.activeList=row.path;if(count)this.selected.set(row.path,count-1);else this.selected.delete(row.path);this.scroll.set(row.path,Number.MAX_SAFE_INTEGER);});
  }
  reindexListState(path,mapIndex){
    const prefix=path+'/';
    const remap=key=>{
      if(!key?.startsWith(prefix))return key;
      const tail=key.slice(prefix.length),match=tail.match(/^(\d+)(\/.*)?$/);if(!match)return key;
      const index=mapIndex(Number(match[1]));return index==null?null:`${prefix}${index}${match[2]||''}`;
    };
    for(const map of [this.expanded,this.selected,this.scroll,this.branches,this.typeChoices]){
      const moved=[];for(const [key,value] of map){if(!key.startsWith(prefix))continue;map.delete(key);const next=remap(key);if(next!=null)moved.push([next,value]);}
      for(const [key,value] of moved)map.set(key,value);
    }
    if(this.activeList)this.activeList=remap(this.activeList);
  }
  removeItem(row){
    const index=this.selected.get(row.path);
    if(!Number.isInteger(index)||index<0||index>=row.value.length||row.value.length<=(row.schema.minItems||0))return;
    this.changeStructure(row.path,()=>{row.value.splice(index,1);row.set(row.value);this.reindexListState(row.path,i=>i===index?null:i>index?i-1:i);this.activeList=row.path;if(row.value.length)this.selected.set(row.path,Math.max(0,index-1));else this.selected.delete(row.path);});
  }
  reorder(area,index,to){
    const dest=Math.max(0,Math.min(area.value.length,to));if(dest===index||dest===index+1)return;
    this.changeStructure(area.path,()=>{const [value]=area.value.splice(index,1);const target=dest>index?dest-1:dest;area.value.splice(target,0,value);area.set(area.value);
      this.reindexListState(area.path,i=>i===index?target:target<index&&i>=target&&i<index?i+1:target>index&&i>index&&i<=target?i-1:i);
      this.selected.set(area.path,target);
    });
  }
  screenRect(r){
    if(!this.active()||!this.matrix||!this.canvas)return null;
    const b=this.canvas.getBoundingClientRect(),m=this.matrix,sx=b.width/this.canvas.width,sy=b.height/this.canvas.height;
    return {left:b.left+(m.a*r.x+m.c*r.y+m.e)*sx,top:b.top+(m.b*r.x+m.d*r.y+m.f)*sy,width:r.w*m.a*sx,height:r.h*m.d*sy};
  }
  point(event){
    if(!this.active()||!this.matrix||!this.canvas)return null;
    const b=this.canvas.getBoundingClientRect(),m=this.matrix,x=(event.clientX-b.left)*this.canvas.width/b.width-m.e,y=(event.clientY-b.top)*this.canvas.height/b.height-m.f,det=m.a*m.d-m.b*m.c;
    return det?{x:(m.d*x-m.c*y)/det,y:(m.a*y-m.b*x)/det}:null;
  }
  hit(point){return point?[...this.targets].reverse().find(t=>inside(t.rect,point.x,point.y)&&(!t.clip||inside(t.clip,point.x,point.y))):null;}
  pointerMove(event){
    if(this.busy){this.clearHover();return;}
    if(this.popup||this.drag||this.gesture)return;
    if(event.target&&event.target!==this.canvas){this.clearHover();return;}
    const p=this.point(event),hit=this.hit(p),id=hit?.id;
    if(id!==this.hover){this.hover=id;this.dirty();}
    if(this.canvas){
      if(hit){this.canvas.__lxyFormPointerOwner=this;this.canvas.style.cursor=hit.kind==="reorder"?"grab":hit.kind==="number"?"ew-resize":hit.kind==="edit"?"text":hit.kind==="click"?"pointer":"default";}
      else if(this.canvas.__lxyFormPointerOwner===this){this.canvas.style.cursor="";delete this.canvas.__lxyFormPointerOwner;}
      if(hit||this.lastHint&&this.canvas.title===this.lastHint)this.canvas.title=hit?.hint||"";
      this.lastHint=hit?.hint||"";
    }
  }
  clearHover(){
    if(this.hover){this.hover=null;this.dirty();}
    if(this.canvas?.__lxyFormPointerOwner===this){this.canvas.style.cursor="";this.canvas.title="";delete this.canvas.__lxyFormPointerOwner;}
    this.lastHint="";
  }
  pointerDown(cursor,canvas){
    if(this.busy)return true;
    const down=cursor.eDown,p=this.point(down),hit=this.hit(p);if(!hit||hit.kind==="disabled")return true;
    if(hit.kind==='menu'){
      this.pressed=hit.id;hit.run?.();const menu=this.popup;
      cursor.onClick=()=>{this.pressed=null;this.dirty();};
      cursor.onDrag=event=>menu?.highlightAt?.(event);
      cursor.onDragEnd=event=>{
        const button=menu?.highlightAt?.(event);
        if(button&&!button.disabled)button.click();
        else if(this.hit(this.point(event))?.id!==hit.id)menu?.close();
        this.pressed=null;this.dirty();
      };
      cursor.finally=()=>{this.pressed=null;this.dirty();};this.dirty();return true;
    }
    this.pressed=hit.id;this.focus=['edit','number','slider'].includes(hit.kind)||hit.id.endsWith(':boolean')?hit.id:null;
    const owner=hit.area||hit.row.area||hit.row.list;
    const listHeader=hit.row.kind==='list'&&hit.id.endsWith(':fold');
    const fieldFocus=['edit','number','slider'].includes(hit.kind)||/:(boolean|value|picker|axis[^:]*|label|count|type|presence)$/.test(hit.id)||hit.id.endsWith(':fold')&&!hit.row.arrayMember;
    this.activeList=listHeader?hit.row.path:fieldFocus?null:owner?.path||null;
    if(!listHeader&&!fieldFocus&&owner&&Number.isInteger(hit.index??hit.row.index))this.selected.set(owner.path,hit.index??hit.row.index);
    this.dirty();
    const click=event=>{const up=event||down,point=this.point(up);this.pressed=null;if(Math.hypot(up.clientX-down.clientX,up.clientY-down.clientY)<=6&&this.hit(point)?.id===hit.id)hit.run?.();this.dirty();};
    cursor.onClick=click;
    // CanvasPointer also ends a slow, slightly moving click through onDragEnd.
    cursor.onDragEnd=click;
    if(hit.kind==="reorder"){
      this.drag={area:hit.area,index:hit.index,point:p,start:p,grabOffset:p.y-hit.area.entries[hit.index].y,started:false,to:null};
      cursor.onDrag=event=>{
        if(!this.drag)return;const pt=this.point(event);if(!pt)return;
        const drag=this.drag;drag.point=pt;if(Math.hypot(pt.x-p.x,pt.y-p.y)>5)drag.started=true;
        if(drag.started){const a=drag.area;
          {
            const direction=pt.y<a.viewport.y+18?-1:pt.y>a.viewport.y+a.viewport.h-18?1:0;
            if(direction){this.scroll.set(a.path,Math.max(0,Math.min(a.total-a.viewport.h,a.offset+direction*10)));this.layout(this.width);drag.area=this.lists.find(l=>l.path===a.path)||a;}
            this.updateDragTarget();
          }
        }this.autoScrollDrag();this.dirty();
      };
      cursor.onDragEnd=event=>{const drag=this.drag;this.pressed=null;if(drag?.started&&drag.to!=null)this.finishReorder(drag);else{this.drag=null;if(drag&&!drag.started)click(event);}this.dirty();};
    }else if(hit.kind==="slider"||hit.kind==="number"){
      const old=hit.row.value;this.gesture={row:hit.row,old,changed:false};
      const move=event=>{
        if(!this.gesture)return;const point=this.point(event);if(!point)return;
        if(hit.kind==="number"&&!this.gesture.changed&&Math.hypot(event.clientX-down.clientX,event.clientY-down.clientY)<=6)return;
        const b=hit.row.bounds,step=b.step==="any" ? .1 : b.step;
        let next=hit.kind==="slider"?b.min+Math.max(0,Math.min(1,(point.x-hit.rect.x-4)/(hit.rect.w-8)))*(b.max-b.min):old+(point.x-p.x)*step/5;
        if(b.step!=="any")next=Math.round(next/b.step)*b.step;
        next=Number(Math.max(b.min??-Number.MAX_SAFE_INTEGER,Math.min(b.max??Number.MAX_SAFE_INTEGER,next)).toPrecision(15));
        hit.row.set(next);this.gesture.changed=true;this.tree=this.field(this.presentation??this.schema,this.value,v=>this.value=v,"$","填写结果",0,true);this.layout(this.width);this.dirty();
      };
      cursor.onDrag=move;
      cursor.onDragEnd=event=>{if(hit.kind==="slider"&&this.gesture&&!this.gesture.changed)move(event||down);const g=this.gesture;this.gesture=null;this.pressed=null;if(g?.changed){const next=cloneJSON(this.value);g.row.set(g.old);this.commit(g.row.path,v=>this.value=v,next);}else if(g&&hit.kind==="number")click(event);this.dirty();};
      if(hit.kind==="slider")cursor.onClick=event=>{move(event||down);cursor.onDragEnd();};
    }else if(hit.kind==="scroll"){
      const a=hit.area,old=a.offset;cursor.onDrag=event=>{const point=this.point(event);if(!point)return;this.scroll.set(a.path,Math.max(0,Math.min(a.total-a.viewport.h,old+(point.y-p.y)*a.total/a.viewport.h)));this.layout(this.width);this.dirty();};
    }
    cursor.finally=()=>{this.pressed=null;if(this.gesture||this.drag)this.cancelGesture();this.dirty();};
    return true;
  }
  autoScrollDrag(){
    if(this.dragFrame)return;
    const tick=()=>{
      this.dragFrame=null;const drag=this.drag;if(!drag?.started)return;
      const a=drag.area,p=drag.point;
      const dir=p.y<a.viewport.y+18?-1:p.y>a.viewport.y+a.viewport.h-18?1:0;
      const offset=Math.max(0,Math.min(Math.max(0,a.total-a.viewport.h),a.offset+dir*6));if(!dir||offset===a.offset)return;
      this.scroll.set(a.path,offset);this.layout(this.width);drag.area=this.lists.find(l=>l.path===a.path)||a;
      this.updateDragTarget();
      this.dirty();this.dragFrame=requestAnimationFrame(tick);
    };this.dragFrame=requestAnimationFrame(tick);
  }
  cancelGesture(){if(this.dragFrame){cancelAnimationFrame(this.dragFrame);this.dragFrame=null;}if(this.motionFrame){cancelAnimationFrame(this.motionFrame);this.motionFrame=null;}this.listMotion=null;if(this.gesture){this.gesture.row.set(this.gesture.old);this.gesture=null;this.render(this.chrome);}this.drag=null;this.pressed=null;}
  key(event){
    if(event.key==="Escape"&&(this.drag||this.gesture)){event.preventDefault();event.stopImmediatePropagation();this.cancelGesture();this.dirty();return;}
    if(this.busy||this.popup||this.drag||this.gesture||!this.active()||!this.activeList||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    if(event.target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete'].includes(event.key))return;
    const area=this.lists.find(a=>a.path===this.activeList);if(!area)return;
    event.preventDefault();event.stopImmediatePropagation();
    let index=this.selected.get(area.path);
    if(event.key==='Delete'){
      if(Number.isInteger(index)&&index>=0&&index<area.value.length&&area.value.length>(area.schema.minItems||0))this.removeItem(area);
      return;
    }
    if(!area.value.length)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      index=Number.isInteger(index)?(index+(event.key==='ArrowDown'?1:-1)+area.value.length)%area.value.length:(event.key==='ArrowDown'?0:area.value.length-1);
      this.selected.set(area.path,index);
    }else{
      const item=area.children[index];if(!item||!['group','list'].includes(item.kind))return;
      this.expanded.set(item.path,event.key==='ArrowRight');this.render(this.chrome);
    }
    const current=this.lists.find(a=>a.path===area.path),entry=current?.entries[index];
    if(entry){
      const delta=entry.y<current.viewport.y?entry.y-current.viewport.y:Math.max(0,entry.y+entry.h-current.viewport.y-current.viewport.h);
      this.scroll.set(area.path,Math.max(0,Math.min(current.total-current.viewport.h,current.offset+delta)));this.layout(this.width);
    }
    this.dirty();
  }
  wheel(event){
    if(this.popup||this.busy||event.ctrlKey||event.metaKey||(event.target&&event.target!==this.canvas))return;
    const p=this.point(event);if(!p)return;
    const area=[...this.lists].reverse().find(a=>a.total>a.viewport.h&&inside(a.viewport,p.x,p.y)&&(!a.clip||inside(a.clip,p.x,p.y)));
    if(!area)return;
    event.preventDefault();event.stopImmediatePropagation();
    this.scroll.set(area.path,Math.max(0,Math.min(area.total-area.viewport.h,area.offset+event.deltaY*(event.deltaMode===1?16:1))));this.layout(this.width);this.dirty();
  }
}
