import { visibleCanvasRect } from "./canvas_viewport.js";
import { imagePreviewURL, imageThumbnailURL, imageFileValue, imageValueSource, imageInputMode, clipboardImageReference, imageReferenceFile, systemFormImage } from "./template_form_images.js";
import { storeFormFile, readFormFile, fileReferenceURL, systemFormFile } from "./template_form_files.js";
import { app } from "../../scripts/app.js";
import { cloneJSON, own, resolveSchema, rawReason, typesOf, valueType, initialValue, itemSchema, numericBounds, vectorComponents } from "./template_form_model.js";
import { closeFormPopup, editFormValue, formMenu, pickFormDate, pickFormColor, colorDigits, acceptsSchemaInput, formMenuUnit, formMenuFont, formMenuFontReady, formFont, formTextLayout, formStringLines } from "./template_form_popups.js";

const typeNames={enum:"枚举",object:"对象",array:"数组",string:"字符串",integer:"整数",number:"浮点数",boolean:"布尔值",null:"无值",
  "string:image":"图片", "string:file":"文件", "string:date":"日期", "string:time":"时间", "string:date-time":"日期时间", "string:color":"HEX 颜色"};
const stringModes=["image","file","date","time","date-time","color"];
const diagnosticLineHeight=20,diagnosticGap=4,diagnosticIconSize=diagnosticLineHeight*2+diagnosticGap-6;
const diagnosticMinHeight=72,diagnosticAutoHeight=diagnosticMinHeight*1.5;
const diagnosticTextInset=8+diagnosticIconSize+10;
const listItemPadding=6,listEdgePadding=4;
const pathKey=(path,key)=>`${path}/${String(key).replace(/~/g,"~0").replace(/\//g,"~1")}`;
function validFieldName(schema,name,root){
  schema=resolveSchema(schema??true,root);
  if(schema===true)return true;if(schema===false)return false;
  const length=[...name].length;
  return (!schema.type||[].concat(schema.type).includes('string'))&&
    (!own(schema,'const')||schema.const===name)&&(!schema.enum||schema.enum.includes(name))&&
    length>=(schema.minLength??0)&&length<=(schema.maxLength??Infinity)&&
    (!schema.pattern||new RegExp(schema.pattern,'u').test(name))&&
    (!schema.allOf||schema.allOf.every(s=>validFieldName(s,name,root)))&&
    (!schema.anyOf||schema.anyOf.some(s=>validFieldName(s,name,root)))&&
    (!schema.oneOf||schema.oneOf.filter(s=>validFieldName(s,name,root)).length===1)&&
    (!schema.not||!validFieldName(schema.not,name,root));
}
const inside=(r,x,y)=>r&&x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h;
const intersection=(a,b)=>!a?b:!b?a:{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y),w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))};

// One real canvas widget owns the property tree, its layout and hit regions.
// Only the currently edited value / an explicitly opened picker uses temporary DOM.
export class NativeTemplateForm {
  constructor(node,onChange){
    this.node=node;this.onChange=onChange;this.errors=new Map();this.expanded=new Map();this.selected=new Map();this.scroll=new Map();this.branches=new Map();this.typeChoices=new Map();this.fieldRequired=new Map();this.fieldEnums=new Map();this.multilinePaths=new Set();
    this.rows=[];this.targets=[];this.lists=[];this.height=40;this.width=440;this.chrome={};this.busy=false;this.disposed=false;this.serverErrors=new Map();
    void formMenuFontReady.then(()=>{if(!this.disposed)this.render(this.chrome);});
    const view=this;
    this.widget=node.addCustomWidget({name:"__lxy_form_inspector",type:"template_form_inspector",serialize:false,options:{serialize:false},
      serializeValue:()=>undefined,computeLayoutSize(node){
        const n=node||this.node||view.node,renderer=n===view.node?view:view.preview(n);
        renderer.layout(n.size[0],0);return {minWidth:renderer.minWidth,minHeight:renderer.height,maxHeight:1e6};
      },
      draw(ctx,n,width,y){
        const renderer=n===view.node?view:view.preview(n);
        // Layout and paint share the node's bounds, never a stale widget width.
        const nodeWidth=n.size[0],availableHeight=Math.max(0,Math.min(this.computedHeight??Infinity,n.size[1]-y));
        // Native getWidgetOnPos reads width/last_y/computedHeight, whereas this
        // inspector paints against the node bounds. Keep its outer hit region
        // synchronized on every paint, including the first restored frame.
        this.width=nodeWidth;this.last_y=y;this.computedHeight=availableHeight;
        ctx.save();try{ctx.translate(0,y);renderer.matrix=ctx.getTransform();renderer.canvas=ctx.canvas||app.canvas?.canvas;
          if(!renderer.drag?.started||renderer.width!==nodeWidth||renderer.availableHeight!==availableHeight)renderer.layout(nodeWidth,availableHeight);
          ctx.beginPath();ctx.rect(0,0,nodeWidth,availableHeight);ctx.clip();renderer.draw(ctx);}finally{ctx.restore();}
      },
      onPointerDown(cursor,n,canvas){return view.pointerDown(cursor,canvas);},
    });
    this.moveListener=event=>this.pointerMove(event);this.wheelListener=event=>this.wheel(event);this.keyListener=event=>this.key(event);
    // Native Ctrl+primary-click can start selection before widget dispatch.
    // Claim only our fold arrow in capture, leaving all other Ctrl gestures native.
    this.foldDownListener=event=>{
      if(event.button===0&&event.target===this.canvas&&this.active()&&this.syncToggleRect){
        const point=this.point(event);
        if(point&&inside(this.syncToggleRect,point.x,point.y)){event.preventDefault();event.stopImmediatePropagation();this.toggleSync?.();return;}
      }
      if(event.button!==0||!event.ctrlKey||event.altKey||event.shiftKey||this.busy||this.popup||!this.active()||event.target!==this.canvas)return;
      const point=this.point(event),hit=this.hit(point);
      if(!hit?.arrowRect||!point||!inside(hit.arrowRect,point.x,point.y))return;
      event.preventDefault();event.stopImmediatePropagation();
      this.foldPress={id:hit.id,pointerId:event.pointerId,x:event.clientX,y:event.clientY};
    };
    this.foldUpListener=event=>{
      const press=this.foldPress;if(!press||press.pointerId!==event.pointerId)return;
      this.foldPress=null;event.preventDefault();event.stopImmediatePropagation();
      if(event.type==='pointercancel'||this.busy||!this.active())return;
      const point=this.point(event),hit=this.hit(point);
      if(event.target===this.canvas&&hit?.id===press.id&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=6)hit.run?.({ctrlKey:true});
    };
    document.addEventListener('pointerdown',this.foldDownListener,true);
    document.addEventListener('pointerup',this.foldUpListener,true);
    document.addEventListener('pointercancel',this.foldUpListener,true);
    this.doubleClickListener=event=>{
      if(this.busy||this.popup||!this.active()||event.target!==this.canvas)return;
      const point=this.point(event),bottom=this.node.size[1]-(this.widget.last_y??this.widget.y??0);
      if(point&&inside({x:this.node.size[0]-16,y:bottom-16,w:20,h:20},point.x,point.y)){
        event.preventDefault();event.stopImmediatePropagation();this.fitContentHeight();return;
      }
      const hit=this.hit(point);if(!this.readOnly&&hit?.id.endsWith(':label')&&hit.row?.present&&hit.row?.arrayMember!==true){
        event.preventDefault();event.stopImmediatePropagation();this.renameKey(hit.row);
      }
    };
    document.addEventListener("pointermove",this.moveListener,true);
    document.addEventListener("wheel",this.wheelListener,{capture:true,passive:false});
    document.addEventListener("keydown",this.keyListener,true);
    document.addEventListener("dblclick",this.doubleClickListener,true);
    this.imageCache=new Map();this.imageJobs=new Map();
    this.pasteListener=event=>this.pasteImage(event);
    document.addEventListener('paste',this.pasteListener,true);
    this.resumeListener=()=>{
      if(document.visibilityState==='hidden'||!this.active())return;
      closeFormPopup(this);this.clearHover();this.pressed=null;
      this.node.arrange?.();this.layout(this.node.size[0]);this.dirty();
    };
    window.addEventListener?.('focus',this.resumeListener);
    document.addEventListener('visibilitychange',this.resumeListener);
    this.outsideListener=event=>{
      if(event.target!==this.canvas||!this.hit(this.point(event))?.id.match(/:(image|file)$/))this.imageFocus=null;
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
    document.removeEventListener('pointerdown',this.foldDownListener,true);
    document.removeEventListener('pointerup',this.foldUpListener,true);
    document.removeEventListener('pointercancel',this.foldUpListener,true);this.foldPress=null;
    this.disposed=true;closeFormPopup(this);this.cancelGesture();this.clearHover();
    document.removeEventListener("pointermove",this.moveListener,true);document.removeEventListener("wheel",this.wheelListener,true);document.removeEventListener("keydown",this.keyListener,true);
    document.removeEventListener("dblclick",this.doubleClickListener,true);
    document.removeEventListener("pointerdown",this.outsideListener,true);
    document.removeEventListener('paste',this.pasteListener,true);this.imageCache.clear();this.imageJobs.clear();
    window.removeEventListener?.('focus',this.resumeListener);document.removeEventListener('visibilitychange',this.resumeListener);
    if(this.node.widgets.includes(this.widget))this.node.removeWidget(this.widget);
  }
  setData(schema,value,inputTypes,fieldRequired,fieldEnums){
    if(fieldEnums!==undefined)this.fieldEnums=new Map(Object.entries(fieldEnums));
    if(fieldRequired!==undefined)this.fieldRequired=new Map(Object.entries(fieldRequired));
    if(JSON.stringify(this.schema)!==JSON.stringify(schema)){closeFormPopup(this);this.expanded.clear();this.branches.clear();this.scroll.clear();this.errors.clear();}
    if(this.schema===undefined)this.restoreExpansion();
    if(inputTypes!==undefined)this.typeChoices=new Map(Object.entries(inputTypes));
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
    this.node.properties.lxy_template_form_view={...this.node.properties.lxy_template_form_view,expanded};
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
    if(this.readOnly)return;
    this.errors.delete(path);this.node.graph?.beforeChange?.();
    try{set(value);this.onChange(cloneJSON(this.value));}finally{this.node.graph?.afterChange?.();}
    this.render(this.chrome);
  }
  changeStructure(path,fn){
    closeFormPopup(this);this.commit(path,()=>fn(),null);
  }
  field(schema,value,set,path,label,depth=0,root=false){
    if(depth>64)return {schema,path,label,depth,kind:'invalid',reason:'字段嵌套超过 64 层'};
    let s;try{s=resolveSchema(schema,this.presentation??this.schema);}catch(e){s={_rawReason:e.message};}
    const base={schema:s,value,set,path,label:s?.title||label,depth,description:s?.description||""};
    if(this.typeChoices.get(path)==='enum'){
      let original=this.schema;
      for(const token of path.split('/').slice(1)){const key=token.replace(/~1/g,'/').replace(/~0/g,'~');original=resolveSchema(original,this.schema);original=original?.type==='array'?itemSchema(original,Number(key)):original?.properties?.[key]??original?.additionalProperties??true;}
      return {...base,kind:'enum',choices:this.fieldEnums.get(path)||[],types:typesOf(original,value),dynamicEnum:true};
    }
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
    const types=typesOf(s,value);
    base.kind=types.includes(valueType(value))?valueType(value):types[0];
    const selectedMode=this.typeChoices.get(path);
    if(stringModes.includes(selectedMode)&&types.includes('string')&&typeof value==='string'){
      s={...s,type:'string'};
      if(selectedMode==='image')s['x-image']??={};
      else if(selectedMode==='file')s['x-file']??={};
      else if(selectedMode==='color'){s.format='color';s.pattern??='^#[0-9A-Fa-f]{6}$';}
      else s.format=selectedMode;
      base.schema=s;
    }
    let type=valueType(value);if(type==="integer"&&!types.includes(type)&&types.includes("number"))type="number";
    if(this.typeChoices.get(path)==='number'&&types.includes('number')&&typeof value==='number')type='number';
    let axes;try{axes=vectorComponents(s,value,this.schema);}catch{axes=null;}
    if(axes)return {...base,kind:"vector",axes};
    if(!types.includes(type))return {...base,kind:"mismatch",types,reason:`需要 ${types.join(" / ")}，点击选择类型`};
    if(type==='string'&&s['x-file'])return {...base,kind:'file',types};
    if(type==='string'&&s['x-image'])return {...base,kind:'image',types};
    if(type==="object"){
      const props=s.properties||{},required=s.required||[];
      const children=[...new Set([...Object.keys(props),...required,...Object.keys(value)])].map(key=>{
        const child=own(props,key)?props[key]:s.additionalProperties??true,childPath=pathKey(path,key);
        const put=next=>{Object.defineProperty(value,key,{value:next,writable:true,enumerable:true,configurable:true});set(value);};
        const item=own(value,key)?this.field(child,value[key],put,childPath,key,depth+1):{kind:"absent",schema:child,path:childPath,label:child?.title||key,depth:depth+1};
        item.optional=!required.includes(key);item.present=own(value,key);item.required=!item.optional;
        item.editableRequired=!s['x-requiredPropertiesFrom']&&(s['x-editableKeys']?.includes(key)||!own(props,key));
        item.recursiveProjected=!!s['x-requiredPropertiesFrom']&&!!child?.['x-requiredPropertiesFrom'];
        item.toggle=()=>this.changeStructure(childPath,()=>{if(own(value,key)){delete value[key];this.clearTypeChoices(childPath);if(item.editableRequired)this.fieldRequired.delete(childPath);}else put(initialValue(child,this.schema)??null);set(value);});
        return item;
      });
      return {...base,kind:root&&types.length===1?"root":"group",types,children,add:s.additionalProperties!==false&&!s['x-requiredPropertiesFrom']?()=>this.addKey(base):null};
    }
    if(type==="array")return {...base,kind:"list",types,children:value.map((item,i)=>{
      const child=this.field(itemSchema(s,i),item,next=>{value[i]=next;set(value);},`${path}/${i}`,`元素 ${i}`,depth+1);
      child.arrayMember=true;
      child.projected=!!child.schema?.["x-requiredPropertiesFrom"];
      child.recursiveProjected=!!base.recursiveProjected&&child.projected;
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
    this.layout(this.node.size[0],this.chrome.errors?.length?Math.max(100,this.node.size[1]-(this.widget?.y??24)):Infinity,true);
    const preferredHeight=this.height;
    if(this.node.graph){
      const size=this.node.computeSize(),height=this.node.size[1];
      const preferredSize=preferredHeight+size[1]-this.height;
      if(this.lastRenderedHeight!==undefined?height!==this.lastRenderedHeight:height>preferredSize)this.manualHeight=height;
      const nextWidth=Math.max(this.minWidth,this.node.size[0],size[0]),nextHeight=Math.max(size[1],this.manualHeight??preferredSize);
      if(nextWidth!==this.node.size[0]||nextHeight!==this.node.size[1])this.node.setSize([nextWidth,nextHeight]);
      this.node.arrange?.();
      this.lastRenderedHeight=this.node.size[1];
    }
    this.layout(this.node.size[0]);
    this.dirty();
  }
  isOpen(item){return this.expanded.get(item.path)??item.depth<2;}
  fitContentHeight(diagnosticHeight=this.chrome.errors?.length?diagnosticAutoHeight:null){
    this.cancelGesture();
    const width=this.node.size[0];
    // Measure with unlimited vertical space so every nested list and diagnostic
    // receives its natural height, rather than fitting the current scroll budget.
    this.diagnosticHeightLimit=diagnosticHeight;
    try{
      this.layout(width,Infinity);
      const height=Math.ceil((this.widget.y??this.widget.last_y??0)+this.height);
      this.node.graph?.beforeChange?.();
      try{
      this.scroll.clear();this.manualHeight=height;
      this.node.setSize([width,height]);this.node.arrange?.();
      this.lastRenderedHeight=this.node.size[1];this.manualHeight=this.lastRenderedHeight;
      this.layout(width,this.widget.computedHeight??this.node.size[1]-(this.widget.y??0));
      }finally{this.node.graph?.afterChange?.();}
    }finally{this.diagnosticHeightLimit=null;}
    this.dirty();
  }
  setDescendantsExpanded(item,expanded){
    const stack=[item],containers=[];
    while(stack.length){
      const current=stack.pop();
      if(['root','group','list'].includes(current.kind))containers.push(current);
      if(current.children)stack.push(...current.children);
    }
    // Collapse children before their parents; expand parents before children.
    if(!expanded)containers.reverse();
    for(const current of containers)this.expanded.set(current.path,expanded);
  }
  changeExpansion(change){
    closeFormPopup(this);change();this.saveExpansion();this.fitContentHeight();
  }
  textWidth(text,font=formFont){
    const ctx=(this.canvas||app.canvas?.canvas)?.getContext?.('2d');
    if(!ctx)return [...String(text)].reduce((n,c)=>n+(c.codePointAt(0)>127?14:8),0);
    ctx.save();ctx.font=font;const width=ctx.measureText(String(text)).width;ctx.restore();return width;
  }
  typeMinimum(item){
    const names=(item.types||[]).map(type=>typeNames[type]);
    if(item.editableRequired)names.push('枚举');
    if(item.types?.includes('string'))names.push(...stringModes.map(mode=>typeNames['string:'+mode]));
    return this.menuMinimum(names);
  }
  menuMinimum(labels){
    // Menu CSS: 21px check column + 4px right padding + two 1px borders,
    // typeset at 12px and scaled to the canvas's 14px menu font.
    return Math.ceil(Math.max(0,...labels.map(label=>this.textWidth(label,formMenuFont)))+27*formMenuUnit);
  }
  choiceLabels(item){
    if(item.kind==='branch')return ['保留当前值',...item.choices.map((s,i)=>s.title||`结构 ${i+1}`)];
    const display=value=>value===null?'无值':typeof value==='string'?value:JSON.stringify(value);
    return item.choices.map(value=>display(value)+(item.choices.filter(v=>display(v)===display(value)).length>1?`（${typeNames[valueType(value)]}）`:''));
  }
  valueMinimum(item){
    if(item.dynamicEnum)return Math.max(this.menuMinimum(this.choiceLabels(item))+40*formMenuUnit,this.menuMinimum(['＋ 新增选项']));
    if(item.kind==='enum'||item.kind==='branch')return this.menuMinimum(this.choiceLabels(item));
    if(item.kind==='boolean')return 24;
    if(item.kind==='image'||item.kind==='file')return 180;
    if(item.kind==='vector')return item.axes.length*46;
    return 96;
  }
  widthRequirements(){
    let label=112,controls=122,slots=1;
    const visit=(item,left=16,right=0)=>{
      if(!item)return;
      const container=['root','group','list','branch'].includes(item.kind);
      if(item.kind!=='root')label=Math.max(label,left+this.textWidth(item.label)+(item.projected?48:0)+8);
      const typed=item.types?.length>1||item.dynamicEnum;
      const count=typed&&!['null','mismatch','group','list','root','branch'].includes(item.kind)?2:1;
      const value=container&&item.kind!=='branch'?(item.kind==='list'?48:0):this.valueMinimum(item);
      controls=Math.max(controls,right+26+(item.editableRequired?28:0)+(typed?this.typeMinimum(item)+(count===2?6+value:value):value));
      slots=Math.max(slots,count);
      for(const child of item.children||[])visit(child,left+(item.kind==='list'?22:item.kind==='group'||item.kind==='branch'?12:0),right+(item.kind==='list'?12:0));
    };
    visit(this.tree);
    this.labelMinimum=label;this.controlsMinimum=controls;this.widthSlots=slots;
    this.minWidth=Math.ceil(Math.max(360,24+label+controls));
  }
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
    let h=this.textInputHeight(item,right);
    if(item.kind==='image')h=item.value?156:24;
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
    try{for(const action of [...actions].filter(a=>a.align!=='left').reverse()){
      const textWidth=ctx?ctx.measureText(action.label).width:[...action.label].reduce((n,c)=>n+(c.charCodeAt(0)>127?14:7),0);
      const w=Math.min(width,textWidth+20);
      if(x<w&&x!==width){y-=30;x=width;}
      x-=w;items.push({action,x,y,w});x-=6;
    }
    for(const action of actions.filter(a=>a.align==='left')){
      const w=Math.min(width,this.textWidth(action.label)+20);
      if(x<w+6){y-=30;x=width;}
      items.push({action,x:0,y,w});
    }}finally{ctx?.restore();}
    for(const item of items)item.y-=y;
    return {items,height:24-y};
  }
  layout(width,availableHeight=this.node.size[1]-(this.widget?.y??24),measureOnly=false){
    this.availableHeight=availableHeight;
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
    this.widthRequirements();
    this.width=Math.max(this.minWidth,width);this.rows=[];this.lists=[];
    // Shared value start; right edges respect the enclosing list's content box.
    const surplus=Math.max(0,this.width-24-this.labelMinimum-this.controlsMinimum);
    this.valueColumn=12+this.labelMinimum+surplus/(this.widthSlots+1);
    this.fieldRight=this.width-38;
    let y=4;
    if(this.chrome.requests?.length>1){this.rows.push({kind:"requests",rect:{x:12,y,w:this.width-24,h:26}});y+=30;}
    if(this.tree){this.measure(this.tree);this.place(this.tree,12,y,this.width-24,0,null);y+=this.tree.height;}
    else y+=8;
    const status=this.errors.size?[...this.errors.entries()].map(([p,m])=>`${p}: ${m}`)[0]:this.chrome.status||"连接 JSON Schema，运行后填写";
    this.rows.push({kind:"status",text:status,rect:{x:12,y:y+4,w:this.width-24,h:24}});y+=30;
    const diagnosticStart=y,diagnostics=[];
    for(const [index,error] of (this.chrome.errors||[]).entries()){
      const path=typeof error==='string'?'':error.path,message=typeof error==='string'?error:error.message;
      const textWidth=this.width-24-diagnosticTextInset-12,pathLines=path?this.wrapText(path,textWidth):[],messageLines=this.wrapText(message,textWidth);
      const h=16+Math.max(diagnosticIconSize,(pathLines.length+messageLines.length)*diagnosticLineHeight+(pathLines.length?diagnosticGap:0));
      diagnostics.push({kind:'diagnostic',index,targetPath:typeof error==='string'?'$':error.targetPath??'$',pathLines,messageLines,text:[path,message].filter(Boolean).join('\n'),rect:{x:12,y,w:this.width-32,h}});y+=h;
    }
    if(diagnostics.length){
      const total=y-diagnosticStart,footerHeight=this.chrome.actions?.length?this.footerLayout(this.chrome.actions,this.width-24).height+8:0;
      const available=Math.max(diagnosticMinHeight,this.availableHeight-diagnosticStart-footerHeight-14);
      const height=this.diagnosticHeightLimit??Math.min(total,available);
      const viewport={x:12,y:diagnosticStart,w:this.width-24,h:height},path='@diagnostics';
      const offset=Math.max(0,Math.min(total-height,this.scroll.get(path)||0));
      const area={path,total,viewport,offset,children:[],entries:[]};this.lists.push(area);
      for(const row of diagnostics){row.rect.y-=offset;row.clip=viewport;this.rows.push(row);}
      if(total>height)this.rows.push({kind:'scrollbar',path,area,rect:{x:this.width-18,y:diagnosticStart,w:6,h:height}});
      y=diagnosticStart+height;
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
    const row={...item,rect:{x,y,w,h:item.kind==="vector"?28*Math.ceil(item.axes.length/item.columns)-4:this.textInputHeight(item,x+w)},clip,clipStack,indent};
    if(item.kind==='image')row.rect.h=(item.value?156:24)+(item.stackedType?28:0);
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
    if(this.readOnly&&!['fold','scroll'].includes(part)&&!['footer','requests'].includes(row.kind)&&!part.startsWith('explanation')){run=null;kind='disabled';}
    const id=`${row.path||row.kind}:${part}`,target={id,rect,clip:row.clip,run,kind,row,...extra};
    if(!this.drag?.started)this.targets.push(target);return target;
  }
  box(ctx,r,{hover=false,pressed=false,disabled=false,focused=false,error=false,variant="input"}={}){
    if(this.drawingReadOnly){hover=false;pressed=false;focused=false;}
    ctx.globalAlpha=disabled ? .45 : 1;
    ctx.fillStyle=variant==="input"?(pressed?"#222":"#2b2b2b"):(pressed?"#353535":hover?"#575757":"#494949");
    ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,3);ctx.fill();
    ctx.strokeStyle=error?"#ab7771":focused?"#718b9a":hover?"#555":"#252525";ctx.stroke();ctx.globalAlpha=1;
  }
  text(ctx,text,x,y,width,color="#ccc",height=24,align="left"){
    ctx.fillStyle=this.drawingReadOnly?'#777':color;ctx.textAlign=align;ctx.textBaseline="alphabetic";text=String(text??"");
    const baseline=formTextLayout(ctx,text).baseline;
    while(text.length>1&&ctx.measureText(text).width>width)text=text.slice(0,-2)+"…";
    ctx.fillText(text,align==="center"?x+width/2:x,y+height/2+baseline);
    return ctx.measureText(text).width;
  }
  arrow(ctx,x,y,open,color="#999"){ctx.fillStyle=color;ctx.beginPath();if(open){ctx.moveTo(x,y+9);ctx.lineTo(x+10,y+9);ctx.lineTo(x+5,y+15);}else{ctx.moveTo(x+2,y+7);ctx.lineTo(x+2,y+17);ctx.lineTo(x+8,y+12);}ctx.fill();}
  button(ctx,row,part,rect,label,run,disabled=false,flat=false){
    disabled=disabled||this.imageJobs.size>0;
    const id=`${row.path||row.kind}:${part}`;
    if(flat){
      if(!disabled&&!this.busy&&!this.drawingReadOnly&&(this.hover===id||this.pressed===id)){ctx.fillStyle=this.pressed===id?"#2b2b2b":"#505050";ctx.fillRect(rect.x,rect.y+1,rect.w,rect.h-2);}
    }else this.box(ctx,rect,{hover:!disabled&&this.hover===id,pressed:!disabled&&this.pressed===id,disabled:disabled||this.busy,variant:part==="count"?"input":"button"});
    if(["+","＋","−","⋮"].includes(label)){
      const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;
      ctx.save();ctx.strokeStyle=ctx.fillStyle=disabled||this.drawingReadOnly?"#777":"#ccc";ctx.lineWidth=1.5;ctx.beginPath();
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
      this.drawingReadOnly=this.readOnly&&!['footer','status','requests'].includes(row.kind);
      ctx.translate(0,dy);this.drawRow(ctx,row);
      this.drawingReadOnly=false;
      ctx.restore();
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
    const fieldRight=Math.min(this.fieldRight,r.x+r.w-26)-(row.editableRequired?28:0);
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
    if(row.editableRequired){
      const checked=this.fieldRequired.get(path)!==false,br={x:r.x+r.w-48,y:r.y+4,w:16,h:16};

      this.box(ctx,br,{hover:this.hover===`${path}:required`});
      if(checked){ctx.strokeStyle='#ddd';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(br.x+3,br.y+8);ctx.lineTo(br.x+7,br.y+12);ctx.lineTo(br.x+13,br.y+4);ctx.stroke();ctx.lineWidth=1;}
      this.target(row,'required',{x:br.x-2,y:r.y,w:20,h:24},()=>this.commit(path,()=>this.fieldRequired.set(path,!checked),null),'click',{hint:checked?'必填字段，点击改为可选':'可选字段，点击改为必填'});
    }
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
      const presenceWidth=optional&&row.present?24:0;
      const headerSurplus=Math.max(0,r.x+r.w-4-presenceWidth-labelX-this.textWidth(row.label)-20-(row.projected?48:0)-(row.kind==='list'?48:0)-this.typeMinimum(row)-6);
      const open=this.isOpen(row),typeWidth=row.types?.length>1?this.typeMinimum(row)+headerSurplus/2+6:0;
      const controlsRight=r.x+r.w-4-presenceWidth-(row.editableRequired?28:0),countWidth=(row.kind==="list"?48:0)+typeWidth;
      const title={x:labelX-16,y:r.y,w:controlsRight-labelX+16-countWidth,h:24};
      this.arrow(ctx,labelX-14,r.y,open,this.pressed===`${path}:fold`?"#fff":this.hover===`${path}:fold`?"#ccc":"#999");
      const labelWidth=this.text(ctx,row.label,labelX,r.y,Math.max(0,title.w-20-(row.projected?48:0)));
      this.target(row,"fold",{x:r.x,y:r.y,w:r.w,h:24},event=>this.changeExpansion(()=>{if(event?.ctrlKey)this.setDescendantsExpanded(row,!open);else this.expanded.set(path,!open);}),"click",{arrowRect:{x:labelX-16,y:r.y,w:16,h:24},hint:[row.label,row.description,open?'Ctrl+点击：从最深层开始收起全部下级及当前区域':'Ctrl+点击：展开当前区域及全部下级'].filter(Boolean).join(' · ')});
      if(row.editableRequired)this.target(row,'label',{x:labelX,y:r.y,w:Math.max(0,title.w-20-(row.projected?48:0)),h:24},null,'hint',{hint:'双击修改字段名称'});
      if((row.projected||row.recursiveProjected)&&title.w>=94){
        const badgeText=row.recursiveProjected?'递归投影':'投影',badgeWidth=row.recursiveProjected?58:38;
        const badge={x:labelX+labelWidth+8,y:r.y+4,w:badgeWidth,h:16};
        ctx.fillStyle="#29483f";ctx.strokeStyle="#456e61";ctx.beginPath();ctx.roundRect(badge.x,badge.y,badge.w,badge.h,3);ctx.fill();ctx.stroke();
        ctx.save();ctx.font=formFont.replace('14px','11px');this.text(ctx,badgeText,badge.x,badge.y,badge.w,"#c2e1d6",badge.h,"center");ctx.restore();
        this.target(row,"projection",badge,null,"hint",{hint:row.recursiveProjected?'此字段由父级投影对象递归投影，字段值来自对应投影源。':'此 SKU 项的字段来自“本次制作范围与规格.SKU图.制作配置.区分键”；新增项默认继承该路径中的当前值。'});
      }
      if(presenceWidth)this.button(ctx,row,"presence",{x:r.x+r.w-22,y:r.y+3,w:18,h:18},"−",row.toggle);
      if(row.kind==="list"){
        const count={x:controlsRight-44-typeWidth,y:r.y+2,w:44,h:20};
        this.button(ctx,row,"count",count,String(row.value.length),()=>this.edit(row,count,row.value.length,text=>this.resizeList(row,Number(text))));
      }
      if(typeWidth)this.typeDropdown(ctx,row,{x:controlsRight-typeWidth+6,y:r.y+2,w:typeWidth-6,h:20});
      return;
    }
    const hasTypes=row.types?.length>1||row.dynamicEnum;
    const valueX=this.valueColumn,labelWidth=Math.max(8,valueX-labelX-8);
    const labelEnd=labelX+this.text(ctx,row.label,labelX,r.y,labelWidth,row.kind==="absent"?"#999":"#ccc");
    if(valueX-labelEnd>18){
      ctx.save();ctx.strokeStyle=this.guideColor(row,'rgba(180,180,180,0.18)');ctx.lineWidth=1;ctx.setLineDash([3,3]);
      ctx.beginPath();ctx.moveTo(labelEnd+6,r.y+12);ctx.lineTo(valueX-5,r.y+12);ctx.stroke();ctx.restore();
    }
    this.target(row,"label",{x:labelX,y:r.y,w:labelWidth,h:24},null,"hint",{hint:ctx.measureText(row.label).width>labelWidth?row.label:row.description});
    const vr={x:valueX,y:r.y+2,w:fieldRight-valueX,h:Math.max(20,row.rect.h-4)};
    if(hasTypes&&row.kind!=="mismatch"){
      if(row.kind==='null'){this.typeDropdown(ctx,row,vr);return;}
      const typeMin=this.typeMinimum(row),valueMin=this.valueMinimum(row);
      const extra=Math.max(0,vr.w-6-typeMin-valueMin)/2;
      const mr=row.stackedType?{...vr}:{x:fieldRight-typeMin-extra,y:vr.y,w:typeMin+extra,h:20};
      this.typeDropdown(ctx,row,mr);
      if(row.stackedType)vr.y+=28;else vr.w-=mr.w+6;
    }
    row.valueRect=vr;
    if(row.kind==='file'){this.drawFileField(ctx,row,vr);return;}
    if(row.kind==='image'){this.drawImageField(ctx,row,vr);return;}
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
      const labels=this.choiceLabels(row);
      const choices=row.kind==="enum"?row.choices.map((value,i)=>({label:labels[i],value,selected:JSON.stringify(value)===JSON.stringify(row.value)})): [{label:labels[0],value:-1,selected:row.selected==null||row.selected<0},...row.choices.map((s,i)=>({label:labels[i+1],value:i,selected:i===row.selected}))];
      const label=row.kind==="enum"?display(row.value):choices[row.selected==null?0:row.selected+1]?.label;
      const enumChoice=value=>({label:value,value,selected:value===row.value,actions:[
          {label:'修改',icon:'edit',edit:(text,old)=>this.saveEnumOption(row,text,old)},
          {label:'删除',icon:'delete',run:option=>this.removeEnumOption(row,option)},
        ]});
      const enumChoices=row.dynamicEnum?[
        ...row.choices.map(enumChoice),
        {label:'＋ 新增选项',centered:true,create:text=>enumChoice(this.saveEnumOption(row,text,null))},
      ]:choices;
      this.valueBox(ctx,row,vr,label|| (row.dynamicEnum?'新增选项…':''),()=>row.dynamicEnum?this.menu(row,vr,enumChoices,choice=>this.commit(path,row.set,choice)):this.menu(row,vr,choices,choice=>{
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
      },row.kind==="json"));
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
    const selectedMode=this.typeChoices.get(row.path);if(stringModes.includes(selectedMode))current=`string:${selectedMode}`;
    if(selectedMode==='enum')current='enum';
    const choices=[...row.types.map(type=>({label:typeNames[type],value:type,selected:type===current})),
      ...(row.types.includes('string')?stringModes.map(mode=>({label:typeNames[`string:${mode}`],value:`string:${mode}`,selected:current===`string:${mode}`})):[]),
      ...(row.editableRequired&&row.types.includes('string')?[{label:'枚举',value:'enum',selected:current==='enum'}]:[])];
    const height=Math.min(rect.h,18*formMenuUnit);rect.y+=(rect.h-height)/2;rect.h=height;
    this.valueBox(ctx,row,rect,typeNames[current],()=>this.menu(row,rect,choices,type=>{
      if(type===current)return;
      this.changeStructure(row.path,()=>{
        this.clearTypeChoices(row.path);
        if(type==='enum'){this.typeChoices.set(row.path,'enum');this.fieldEnums.set(row.path,[]);row.set('');return;}
        this.fieldEnums.delete(row.path);
          const emptyForType=type==='string'||typeof type==='string'&&type.startsWith('string:')?'':type==='integer'||type==='number'?initialValue({...row.schema,type},this.presentation??this.schema):type==='boolean'?false:type==='array'?[]:type==='object'?{}:null;
          row.set(emptyForType);
          if(typeof type==='string'&&type.startsWith('string:')){
          this.typeChoices.set(row.path,type.slice(7));
          return;
        }
        this.typeChoices.set(row.path,type);

        const schema={...row.schema,type};
        if(selectedMode==='enum'){delete schema.enum;delete schema.not;delete schema.default;}
        if(stringModes.includes(selectedMode)){
          for(const key of ['format','x-image','x-file','pattern'])delete schema[key];
          if(type==='string')return;
        }
        // A nullable field often defaults to null. Switching to a number must
        // initialize the chosen type using its bounds instead of that null default.
        for(const key of ['default','const'])if(own(schema,key)&&valueType(schema[key])!==type&&!(type==='number'&&valueType(schema[key])==='integer'))delete schema[key];
        row.set(initialValue(schema,this.presentation??this.schema)??null);
      });
    }),part,'menu',16*formMenuUnit);
  }
  guideColor(row,normal){return row.entryOwners?.some(owner=>this.selected.get(owner.path)===owner.index)?'#353535':normal;}
  clearTypeChoices(path){
    for(const key of this.typeChoices.keys())if(key===path||key.startsWith(path+'/'))this.typeChoices.delete(key);
    for(const key of this.fieldEnums.keys())if(key===path||key.startsWith(path+'/'))this.fieldEnums.delete(key);
    for(const key of this.fieldRequired.keys())if(key.startsWith(path+'/'))this.fieldRequired.delete(key);
    this.remapAssetPaths(key=>key===path||key.startsWith(path+'/')?null:key);
  }
  remapAssetPaths(remap){
    for(const name of ['lxy_template_files','lxy_template_image_modes']){
      const previous=this.node.properties?.[name];if(!previous)continue;
      const next=Object.create(null);
      for(const [key,value] of Object.entries(previous)){const moved=remap(key);if(moved!=null)next[moved]=value;}
      this.node.properties[name]=next;
    }
  }
  valueBox(ctx,row,rect,text,run,part="value",kind="edit",rightInset=6){
    if(kind==='menu'){
      const id=`${row.path}:${part}`,u=formMenuUnit,open=this.popup?.triggerId===id;
      ctx.save();ctx.globalAlpha=this.busy?.45:1;
      ctx.fillStyle=!this.drawingReadOnly&&(this.hover===id||this.pressed===id||open)?'#585858':'#515151';
      ctx.strokeStyle=this.fieldError(row.path)?'#ab7771':'#242424';ctx.lineWidth=u;
      ctx.beginPath();ctx.roundRect(rect.x+.5*u,rect.y+.5*u,rect.w-u,rect.h-u,1.5*u);ctx.fill();ctx.stroke();
      ctx.font=formMenuFont;this.text(ctx,text,rect.x+3*u,rect.y,rect.w-3*u-rightInset,'#bdbdbd',rect.h);
      const x=rect.x+rect.w-9*u,y=rect.y+rect.h/2;
      ctx.fillStyle=this.drawingReadOnly?'#777':'#bdbdbd';ctx.beginPath();ctx.moveTo(x-3.5*u,y-1.5*u);ctx.lineTo(x+3.5*u,y-1.5*u);ctx.lineTo(x,y+2.5*u);ctx.closePath();ctx.fill();ctx.restore();
      this.target(row,part,rect,run,kind);return;
    }
    const id=`${row.path}:${part}`;this.box(ctx,rect,{hover:this.hover===id,pressed:this.pressed===id,focused:this.focus===id,disabled:this.busy,error:!!this.fieldError(row.path),variant:kind==="click"?"menu":"input"});
    if(row.kind==='string'&&part==='value'){
      const lines=formStringLines(text,rect.w-26,t=>ctx.measureText(t).width),lineHeight=20,start=rect.y+(lines.length>1?2:0);
      ctx.save();ctx.beginPath();ctx.rect(rect.x,rect.y,rect.w,rect.h);ctx.clip();
      lines.forEach((line,index)=>{
        this.text(ctx,line.text,rect.x+6,start+index*lineHeight,rect.w-12,"#ccc",lineHeight);
        if(line.hardEnd)this.text(ctx,'↵',rect.x+6+ctx.measureText(line.text).width,start+index*lineHeight,18,'#888',lineHeight);
      });
      ctx.restore();
    }else this.text(ctx,text,rect.x+6,rect.y,rect.w-6-rightInset,"#ccc",rect.h);
    this.target(row,part,rect,run,kind);
  }
  drawFileField(ctx,row,rect){
    const state=this.node.properties?.lxy_template_files?.[row.path],mode=state?.mode;
    const label=mode==='base64'?'Base64 编码':mode==='link'?'链接路径':'自动';
    const width=110+Math.max(0,rect.w-52-110-6)/2,menuRect={...rect,x:rect.x+rect.w-width,w:width};
    this.valueBox(ctx,row,menuRect,label,()=>this.menu(row,menuRect,[{label:'自动',value:null},{label:'链接路径',value:'link'},{label:'Base64 编码',value:'base64'}],mode=>void this.changeFileMode(row,mode)),'file-mode','menu',16*formMenuUnit);
    const input={...rect,w:Math.max(12,rect.w-width-6)},info=state?.value===row.value?state:null;
    const job=this.imageJobs.get(row.path);
    const text=job==='choose'?'等待选文件…':job?'读取文件中…':info?.display||row.value||'选择文件';
    this.valueBox(ctx,row,input,text,()=>this.chooseFile(row),'file','click');
    const target=this.targets[this.targets.length-1];
    if(target)target.hint=job==='choose'?'请在置顶的系统文件选择框中选择或取消；等待不限时':text;
  }
  chooseFile(row){
    this.imageFocus=row.path;this.activeList=null;closeFormPopup(this);
    void this.setFile(row,null,undefined,'choose');
  }
  async changeFileMode(row,mode){
    if(this.busy||this.imageJobs.size)return;
    const previous=this.node.properties?.lxy_template_files?.[row.path];
    if(row.value||previous?.value===''&&previous.encoding==='base64'){
      await this.setFile(row,()=>readFormFile(row.value,previous),mode,previous?.value===row.value&&previous.path?'convert':null);return;
    }
    this.node.properties??={};this.node.properties.lxy_template_files??={};
    this.node.properties.lxy_template_files[row.path]={mode};this.node.graph?.change?.();this.dirty();
  }
  async setFile(row,file,override,action=null){
    if(this.readOnly)return;
    if(this.busy||this.imageJobs.size)return;
    const original=this.value,schema=this.schema,oldValue=row.value;
    this.imageJobs.set(row.path,action==='choose'?'choose':'read');this.dirty();
    try{
      const mode=override===undefined?this.node.properties?.lxy_template_files?.[row.path]?.mode:override;
      let result;
      if(action)result=await systemFormFile(action,mode,this.node.properties?.lxy_template_files?.[row.path]?.path);
      if(!result&&action==='clipboard'&&file)result=await storeFormFile(typeof file==='function'?await file():file,mode);
      if(!action)result=await storeFormFile(typeof file==='function'?await file():file,mode);
      if(!result)return;
      const current=this.rows.find(item=>item.path===row.path&&item.kind==='file');
      if(this.disposed||this.schema!==schema||this.value!==original||current?.value!==oldValue||JSON.stringify(current.schema)!==JSON.stringify(row.schema))return;
      this.node.properties??={};this.node.properties.lxy_template_files??={};
      this.node.properties.lxy_template_files[row.path]={...result,mode};
      this.commit(row.path,current.set,result.value);
    }catch(error){if(!this.disposed&&this.schema===schema&&this.value===original)this.fail(row.path,error.message);}
    finally{this.imageJobs.delete(row.path);this.dirty();}
  }
  drawImageField(ctx,row,rect){
    const id=`${row.path}:image`,job=this.imageJobs.has(row.path);
    const mode=this.node.properties?.lxy_template_image_modes?.[row.path];
    const label=mode==='base64'?'Base64':mode==='link'?'链接／路径':mode==='copy'?'复制并保存路径':'自动';
    const menuWidth=Math.max(166,90+Math.max(0,rect.w-52-90-6)/2),menuRect={...rect,x:rect.x+rect.w-menuWidth,w:menuWidth,h:20};
    this.valueBox(ctx,row,menuRect,label,()=>this.menu(row,menuRect,[
      {label:'自动',value:null},{label:'链接／路径',value:'link'},{label:'复制并保存路径',value:'copy'},{label:'Base64',value:'base64'},
    ],mode=>void this.changeImageMode(row,mode)),'image-mode','menu',16*formMenuUnit);
    if(row.value)this.button(ctx,row,'image-clear',{...rect,w:Math.min(52,Math.max(12,rect.w-menuRect.w-6)),h:20},'清空',()=>this.commit(row.path,row.set,''));
    rect=row.value?{...rect,y:rect.y+24,h:128}:{...rect,w:Math.max(12,rect.w-menuRect.w-6)};
    this.box(ctx,rect,{hover:this.hover===id,pressed:this.pressed===id,focused:this.imageFocus===row.path,disabled:this.busy});
    let entry,message=job?'处理中…':'选择图片';
    if(row.value){
      try{
        const url=imageThumbnailURL(row.schema,row.value);
        entry=this.imageCache.get(row.path);
        if(entry?.url!==url){
          const image=new Image();entry={url,image,ready:false};this.imageCache.set(row.path,entry);
          image.referrerPolicy='no-referrer';
          image.onload=()=>{entry.ready=true;this.dirty();};
          image.onerror=()=>{entry.error='图片无法加载，点击重新选择';this.dirty();};image.src=url;
        }
        message=entry.error||'正在加载图片…';
      }catch(error){message=error.message;}
    }
    if(entry?.ready&&!job){
      const image=entry.image,scale=Math.min((rect.w-8)/image.naturalWidth,(rect.h-8)/image.naturalHeight);
      const w=image.naturalWidth*scale,h=image.naturalHeight*scale;
      ctx.save();ctx.beginPath();ctx.roundRect(rect.x+2,rect.y+2,rect.w-4,rect.h-4,3);ctx.clip();
      if(this.readOnly){ctx.filter='grayscale(1)';ctx.globalAlpha=.5;}
      ctx.drawImage(image,rect.x+(rect.w-w)/2,rect.y+(rect.h-h)/2,w,h);ctx.restore();
    }else{
      const lines=row.value?this.wrapText(message,rect.w-16):[message],height=lines.length*20;
      lines.forEach((line,i)=>this.text(ctx,line,rect.x+8,rect.y+(rect.h-height)/2+i*20,rect.w-16,'#bbb',20));
    }
    this.target(row,'image',rect,()=>this.chooseImage(row),'click',{hint:'点击选择或替换图片；鼠标放在此处按 Ctrl+V 粘贴图片'});
  }
  chooseImage(row){
    if(this.readOnly)return;
    this.imageFocus=row.path;this.activeList=null;closeFormPopup(this);
    const mode=this.node.properties?.lxy_template_image_modes?.[row.path];
    if(mode!=='copy'&&mode!=='base64'){void this.setImagePath(row,'choose',mode==='link'?'link':'auto');return;}
    const input=document.createElement('input');input.type='file';input.accept='image/*';
    input.onchange=()=>{if(input.files?.[0])void this.setImageFile(row,input.files[0]);};input.click();
  }
  async setImagePath(row,action,mode,path){
    if(this.readOnly||this.busy||this.imageJobs.has(row.path))return false;
    const token={},original=this.value,schema=this.schema,oldValue=row.value;
    this.imageJobs.set(row.path,token);this.dirty();
    try{
      const value=await systemFormImage(action,mode,path);
      if(value===null)return false;
      const current=this.rows.find(item=>item.path===row.path&&item.kind==='image');
      if(this.disposed||this.schema!==schema||this.value!==original||current?.value!==oldValue||JSON.stringify(current.schema)!==JSON.stringify(row.schema))return false;
      this.commit(row.path,current.set,value);return true;
    }catch(error){if(!this.disposed&&this.schema===schema&&this.value===original)this.fail(row.path,error.message);return false;}
    finally{if(this.imageJobs.get(row.path)===token)this.imageJobs.delete(row.path);this.dirty();}
  }
  async changeImageMode(row,mode){
    if(this.busy||this.imageJobs.size)return;
    if(row.value&&mode){
      const source=imageValueSource(row.schema,row.value),encoded=['base64','data-url'].includes(source);
      const local=source==='path'&&/^[A-Za-z]:[\\/]/.test(row.value);
      const relative=source==='path'&&!local;
      if(mode==='link'&&(encoded||relative)||mode==='base64'&&!encoded||mode==='copy'&&!relative){
        let ok;
        if(mode==='link')ok=await this.setImagePath(row,'choose','link');
        else if(local)ok=await this.setImagePath(row,'convert',mode,row.value);
        else ok=await this.setImageFile(row,()=>imageReferenceFile(row.schema,row.value),'convert',false,mode);
        if(!ok)return;
      }
    }
    this.node.properties??={};this.node.properties.lxy_template_image_modes??={};
    if(mode)this.node.properties.lxy_template_image_modes[row.path]=mode;
    else delete this.node.properties.lxy_template_image_modes[row.path];
    this.node.graph?.change?.();this.dirty();
  }
  async setImageFile(row,file,origin='file',hasPath=false,override){
    if(this.readOnly)return;
    if(this.busy||this.imageJobs.has(row.path))return;
    const token={},original=this.value,schema=this.schema,oldValue=row.value;
    this.imageJobs.set(row.path,token);this.dirty();
    try{
      const mode=override??this.node.properties?.lxy_template_image_modes?.[row.path];
      const source=imageInputMode(mode,origin,hasPath);
      const value=await imageFileValue({...row.schema,'x-image':{source}},typeof file==='function'?await file():file);
      const current=this.rows.find(item=>item.path===row.path&&item.kind==='image');
      if(this.disposed||this.schema!==schema||this.value!==original||current?.value!==oldValue||JSON.stringify(current.schema)!==JSON.stringify(row.schema))return;
      this.commit(row.path,current.set,value);
      return true;
    }catch(error){if(!this.disposed&&this.schema===schema&&this.value===original)this.fail(row.path,error.message);}
    finally{if(this.imageJobs.get(row.path)===token)this.imageJobs.delete(row.path);this.dirty();}
  }
  pasteImage(event){
    if(this.readOnly)return;
    if(!this.active()||this.busy||this.popup||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)||event.target?.isContentEditable)return;
    const hovered=this.targets.find(target=>target.id===this.hover&&/:(image|file)$/.test(target.id));
    const target=hovered||this.targets.find(target=>target.row.path===this.imageFocus&&/:(image|file)$/.test(target.id));
    if(!target)return;
    if(target.row.kind==='file'){
      const file=[...(event.clipboardData?.items||[])].find(item=>item.kind==='file')?.getAsFile();
      const reference=(event.clipboardData?.getData?.('text/uri-list')||event.clipboardData?.getData?.('text/plain')||'').trim();
      if(!file&&reference&&!/^(https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|template_form_files\/)/i.test(reference))return;
      event.preventDefault();event.stopImmediatePropagation();this.imageFocus=target.row.path;
      if(file)void this.setFile(target.row,file,undefined,'clipboard');
      else if(!reference||/^(file:\/\/|[A-Za-z]:[\\/])/i.test(reference))void this.setFile(target.row,null,undefined,'clipboard');
      else{try{fileReferenceURL(reference);void this.setFile(target.row,()=>readFormFile(reference));}catch(error){this.fail(target.row.path,error.message);}}
      return;
    }
    const file=[...(event.clipboardData?.items||[])].find(item=>item.kind==='file'&&item.type.startsWith('image/'))?.getAsFile();
    const reference=clipboardImageReference(event.clipboardData);
    if(!file&&!reference)return;
    event.preventDefault();event.stopImmediatePropagation();this.imageFocus=target.row.path;
    if(file){
      const mode=this.node.properties?.lxy_template_image_modes?.[target.row.path];
      if(mode==='link'){void this.setImagePath(target.row,'choose','link');return;}
      void this.setImageFile(target.row,file,'paste',!!reference||!!file.path);return;
    }
    const row=target.row,mode=this.node.properties?.lxy_template_image_modes?.[row.path];
    if(mode==='base64'){void this.setImageFile(row,()=>imageReferenceFile(row.schema,reference),'paste',true);return;}
    if(mode==='copy'){void this.setImageFile(row,()=>imageReferenceFile(row.schema,reference),'paste',true);return;}
    try{imagePreviewURL(row.schema,reference);this.commit(row.path,row.set,reference);}
    catch(error){this.fail(row.path,error.message);}
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
  saveEnumOption(row,text,oldValue){
    const path=row.path,options=[...(this.fieldEnums.get(path)||[])],isNew=oldValue===null;
      const next=text.trim();
      if(!next)throw new Error("选项不能为空");
      if(options.some(value=>value!==oldValue&&value===next))throw new Error("选项已存在");
      if(isNew)options.push(next);else{
        const index=options.indexOf(oldValue);if(index<0)throw new Error('该选项已发生变化，请重新打开菜单');options[index]=next;
      }
      this.commit(path,()=>{
        this.fieldEnums.set(path,options);
        if(isNew&&!options.includes(row.value)||!isNew&&row.value===oldValue){row.set(next);row.value=next;}
      },null);
    return next;
  }
  removeEnumOption(row,value){
    const path=row.path,options=(this.fieldEnums.get(path)||[]).filter(option=>option!==value);
    this.commit(path,()=>{
      this.fieldEnums.set(path,options);
      if(row.value===value)row.set(options[0]??"");
    },null);
  }
  textInputHeight(item,right=this.width-12){
    const value=this.textDraft?.path===item.path?this.textDraft.value:item.value;
    let width=Math.min(this.fieldRight,right-26)-(item.editableRequired?28:0)-this.valueColumn;
    if((item.types?.length>1||item.dynamicEnum)&&!item.stackedType){const min=this.typeMinimum(item);width-=min+6+Math.max(0,width-6-min-this.valueMinimum(item))/2;}
    const lines=item.kind==='string'?formStringLines(value,width-26,t=>this.textWidth(t)).length:typeof value==='string'?value.split(/\r\n|\r|\n/).length:1;
    return lines>1?lines*20+8:24;
  }
  edit(row,rect,value,commit,multiline=false){
    const target=this.targetAt(row,rect);
    const editIds=this.targets.filter(t=>t.run&&(t.id.endsWith(":value")||t.id.includes(":axis"))).map(t=>t.id);
    const oldStatus=this.chrome.status;let applied=false;
    this.focus=target?.id;
    const popup=editFormValue(this,this.anchor(row,rect),value,text=>{try{this.errors.delete(row.path);commit(text);applied=true;return true;}catch(e){this.fail(row.path,e.message);throw e;}},{multiline,allowMultiline:row.kind==="string"||row.kind==="json",onInput:text=>{const right=row.rect.x+row.rect.w,before=this.textInputHeight(row,right);this.textDraft={path:row.path,value:text};if(this.textInputHeight(row,right)!==before)this.render(this.chrome);},accepts:row.kind==='string'?(candidate,previous,complete)=>acceptsSchemaInput(row.schema,candidate,previous,complete):null,label:row.label,onTab:direction=>{
      const index=editIds.indexOf(target?.id);this.nextFocus=editIds[(index+direction+editIds.length)%editIds.length];this.dirty();
    }});
    popup.onClose=()=>{if(this.errors.delete(row.path)&&!applied)this.chrome.status=oldStatus;this.textDraft=null;this.focus=null;this.render(this.chrome);};
    this.dirty();
  }
  renameKey(row){
    const parentPath=row.path.slice(0,row.path.lastIndexOf('/')),oldKey=row.path.slice(row.path.lastIndexOf('/')+1).replace(/~1/g,'/').replace(/~0/g,'~');
    const parent=this.rows.find(item=>item.path===parentPath&&['root','group'].includes(item.kind))||(parentPath==='$'?this.tree:null);
    if(!parent||parent.schema?.['x-requiredPropertiesFrom']||!(parent.schema?.['x-editableKeys']?.includes(oldKey)||!own(parent.schema?.properties||{},oldKey)))return;
    const rect=this.targets.find(t=>t.id===`${row.path}:label`)?.rect||row.rect;
    this.edit({...row,kind:'string',schema:parent.schema.propertyNames??{},path:row.path+':rename'},rect,oldKey,newKey=>{
      if(!newKey.trim())throw new Error('字段名称不能为空');
      if(!validFieldName(parent.schema.propertyNames,newKey,this.schema))throw new Error('字段名称不符合模板的名称规则');
      if(parent.schema['x-keyPatterns']?.some(patterns=>!patterns.some(p=>new RegExp(p).test(newKey))))throw new Error('字段名称不符合模板的名称模式');
      if(parent.schema.additionalProperties===false&&!Object.keys(parent.schema.patternProperties||{}).some(p=>new RegExp(p).test(newKey)))throw new Error('模板不允许此字段名称');
      if(newKey!==oldKey&&own(parent.value,newKey))throw new Error('该字段名称已存在');
      if(newKey===oldKey)return;
      const affected=[parent];
      const collect=item=>{if(item!==parent&&item.schema?.['x-requiredPropertiesFrom']?.pointer===parentPath.slice(1)&&item.value&&typeof item.value==='object'&&!Array.isArray(item.value))affected.push(item);for(const child of item.children||[])collect(child);};
      collect(this.tree);
      for(const item of affected)if(own(item.value,oldKey)&&own(item.value,newKey))throw new Error(`字段“${newKey}”在投影目标中已存在，请先处理名称冲突`);
      this.changeStructure(parentPath,()=>{
        for(const item of affected){
          if(!own(item.value,oldKey))continue;
          const descriptor=Object.getOwnPropertyDescriptor(item.value,oldKey);delete item.value[oldKey];Object.defineProperty(item.value,newKey,{...descriptor});item.set(item.value);
          const from=pathKey(item.path,oldKey),to=pathKey(item.path,newKey);
          this.remapAssetPaths(key=>key===from||key.startsWith(from+'/')?to+key.slice(from.length):key);
          for(const map of [this.expanded,this.selected,this.scroll,this.branches,this.typeChoices,this.fieldRequired,this.fieldEnums])for(const [key,value] of [...map])if(key===from||key.startsWith(from+'/')){map.delete(key);map.set(to+key.slice(from.length),value);}
        }
        this.structureRenamed=true;this.presentation=undefined;
      });
    });
  }
  addKey(row){
    const rect=this.targets.find(t=>t.id===`${row.path}:add-key`)?.rect||row.rect||{x:12,y:4,w:200,h:24};this.edit({...row,kind:'string',schema:row.schema.propertyNames??{},path:row.path+":new"},rect,"",key=>{
      if(!key.trim()||!validFieldName(row.schema.propertyNames,key,this.schema))throw new Error('字段名称不符合模板的名称规则');
      if(row.schema['x-keyPatterns']?.some(patterns=>!patterns.some(p=>new RegExp(p).test(key))))throw new Error('字段名称不符合模板的名称模式');
      if(own(row.value,key))throw new Error("该键已存在");
      this.changeStructure(row.path,()=>{this.fieldRequired.set(pathKey(row.path,key),true);Object.defineProperty(row.value,key,{value:initialValue(row.schema.additionalProperties??true,this.schema)??null,writable:true,enumerable:true,configurable:true});row.set(row.value);});
    });
  }
  resizeList(row,count){
    if(!Number.isSafeInteger(count)||count<0)throw new Error("条数必须为非负整数");
    if(count<(row.schema.minItems||0)||count>(row.schema.maxItems??Infinity))throw new Error("条数超出 minItems / maxItems");
    if(count-row.value.length>1000)throw new Error("一次最多新增 1000 项");
    for(let i=row.value.length;i<count;i++)if(itemSchema(row.schema,i)===false)throw new Error("Schema 不允许此位置新增条目");
    this.changeStructure(row.path,()=>{const oldCount=row.value.length;while(row.value.length<count)row.value.push(initialValue(itemSchema(row.schema,row.value.length),this.schema)??null);row.value.length=count;row.set(row.value);this.reindexListState(row.path,i=>i<count?i:null);this.activeList=row.path;if(count){this.selected.set(row.path,count-1);for(let i=oldCount;i<count;i++)if(row.value[i]&&typeof row.value[i]==='object')this.expanded.set(`${row.path}/${i}`,true);}else this.selected.delete(row.path);this.scroll.set(row.path,Number.MAX_SAFE_INTEGER);});
    this.fitContentHeight();
  }
  reindexListState(path,mapIndex){
    const prefix=path+'/';
    const remap=key=>{
      if(!key?.startsWith(prefix))return key;
      const tail=key.slice(prefix.length),match=tail.match(/^(\d+)(\/.*)?$/);if(!match)return key;
      const index=mapIndex(Number(match[1]));return index==null?null:`${prefix}${index}${match[2]||''}`;
    };
    for(const map of [this.expanded,this.selected,this.scroll,this.branches,this.typeChoices,this.fieldRequired,this.fieldEnums]){
      const moved=[];for(const [key,value] of map){if(!key.startsWith(prefix))continue;map.delete(key);const next=remap(key);if(next!=null)moved.push([next,value]);}
      for(const [key,value] of moved)map.set(key,value);
    }
    if(this.activeList)this.activeList=remap(this.activeList);
    this.remapAssetPaths(remap);
  }
  removeItem(row){
    const index=this.selected.get(row.path);
    if(!Number.isInteger(index)||index<0||index>=row.value.length||row.value.length<=(row.schema.minItems||0))return;
    this.changeStructure(row.path,()=>{row.value.splice(index,1);row.set(row.value);this.reindexListState(row.path,i=>i===index?null:i>index?i-1:i);this.activeList=row.path;if(row.value.length)this.selected.set(row.path,Math.max(0,index-1));else this.selected.delete(row.path);});
    this.fitContentHeight();
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
    if(this.popup||this.drag||this.gesture)return;
    if(event.target&&event.target!==this.canvas){this.clearHover();return;}
    const p=this.point(event),sync=p&&this.syncToggleRect&&inside(this.syncToggleRect,p.x,p.y)&&this.node.inputs?.some(i=>i.name==='sync_file'&&i.link!=null);
    if(this.busy&&!sync){this.clearHover();return;}
    const candidate=sync?{id:'sync-toggle',kind:'click'}:this.hit(p),hit=candidate?.kind==='disabled'?null:candidate,id=hit?.id;
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
    if(this.busy||this.imageJobs.size)return true;
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
    const click=event=>{const up=event||down,point=this.point(up);this.pressed=null;if(Math.hypot(up.clientX-down.clientX,up.clientY-down.clientY)<=6&&this.hit(point)?.id===hit.id)hit.run?.(hit.id.endsWith(':fold')?{ctrlKey:!!down.ctrlKey}:undefined);this.dirty();};
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
    if(this.readOnly&&event.key==='Delete')return;
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
      this.changeExpansion(()=>this.expanded.set(item.path,event.key==='ArrowRight'));
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
    const areas=[...this.lists].reverse().filter(a=>a.total>a.viewport.h&&inside(a.viewport,p.x,p.y)&&(!a.clip||inside(a.clip,p.x,p.y)));
    let remaining=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?(areas[0]?.viewport.h||1):1),changed=false;
    for(const area of areas){
      const next=Math.max(0,Math.min(area.total-area.viewport.h,area.offset+remaining)),used=next-area.offset;
      if(!used)continue;
      this.scroll.set(area.path,next);remaining-=used;changed=true;
      if(!remaining)break;
    }
    // Leave boundary-only events untouched so the canvas can handle its native zoom.
    if(!changed)return;
    event.preventDefault();event.stopImmediatePropagation();this.layout(this.width);this.dirty();
  }
}
