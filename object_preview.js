import { app } from "../../scripts/app.js";
import { formFont, formTextLayout } from "./template_form_popups.js";

const ROW=28;
const container=value=>value!==null&&typeof value==='object';
const kind=value=>value===null?'null':Array.isArray(value)?'数组':({object:'对象',string:'字符串',number:'数字',boolean:'布尔值'})[typeof value];
const contains=(r,p)=>r&&p&&p.x>=r.x&&p.y>=r.y&&p.x<r.x+r.w&&p.y<r.y+r.h;

export function jsonColorTokens(text){
  const tokens=[];let depth=0;
  const brackets=['#ffd700','#da70d6','#179fff'];
  for(const match of text.matchAll(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\s+|./g)){
    const value=match[0];let color='#d4d4d4';
    if(value[0]==='"')color=/^\s*:/.test(text.slice(match.index+value.length))?'#9cdcfe':'#ce9178';
    else if(/^-?\d/.test(value))color='#b5cea8';
    else if(/^(true|false|null)$/.test(value))color='#569cd6';
    else if(value==='{'||value==='[')color=brackets[depth++%brackets.length];
    else if(value==='}'||value===']')color=brackets[Math.max(0,--depth)%brackets.length];
    tokens.push({text:value,color});
  }
  return tokens;
}

export class ObjectPreview {
  constructor(node){
    this.node=node;this.items=null;this.rows=[];this.expanded=new Set();this.scroll=0;this.detailScroll=0;this.targets=[];this.selected=null;this.hover=null;
    const view=this;
    this.widget=node.addCustomWidget({name:'object_preview',type:'object_preview_canvas',serialize:false,options:{serialize:false},serializeValue:()=>undefined,
      computeLayoutSize:()=>({minWidth:420,minHeight:180,maxHeight:Infinity}),
      draw(ctx,n,width,y){
        // Activity cards use facade nodes. Their paint must not change live hit regions.
        const renderer=n===node?view:Object.assign(Object.create(Object.getPrototypeOf(view)),view,{node:n,targets:[],hover:null});
        ctx.save();try{ctx.translate(0,y);renderer.matrix=ctx.getTransform();renderer.canvas=ctx.canvas;
          renderer.draw(ctx,n.size[0],Math.max(0,Math.min(this.computedHeight??Infinity,n.size[1]-y)));
        }finally{ctx.restore();}
      },
      onPointerDown(cursor){view.pointer(cursor);return true;},
    });
    this.wheelListener=e=>this.wheel(e);this.moveListener=e=>this.move(e);this.keyListener=e=>this.key(e);
    document.addEventListener('wheel',this.wheelListener,{capture:true,passive:false});
    document.addEventListener('pointermove',this.moveListener,true);document.addEventListener('keydown',this.keyListener,true);
    this.outsideListener=e=>{if(!this.point(e)||!contains(this.bounds,this.point(e)))this.focused=false;};
    document.addEventListener('pointerdown',this.outsideListener,true);
    this.foldDown=e=>{
      if(e.button!==0||!e.ctrlKey||e.altKey||e.shiftKey)return;
      const hit=this.hit(this.point(e));if(!hit?.id.startsWith('fold:'))return;
      e.preventDefault();e.stopImmediatePropagation();this.foldPress={id:hit.id,pointerId:e.pointerId,x:e.clientX,y:e.clientY};
    };
    this.foldUp=e=>{
      const press=this.foldPress;if(!press||press.pointerId!==e.pointerId)return;
      this.foldPress=null;e.preventDefault();e.stopImmediatePropagation();
      const hit=this.hit(this.point(e));
      if(e.type!=='pointercancel'&&hit?.id===press.id&&Math.hypot(e.clientX-press.x,e.clientY-press.y)<=6)this.toggleRecursive(hit.row);
    };
    this.doubleClick=e=>{
      const p=this.point(e),bottom=this.node.size[1]-(this.widget.last_y??this.widget.y??0);
      if(contains({x:this.node.size[0]-16,y:bottom-16,w:20,h:20},p)){e.preventDefault();e.stopImmediatePropagation();this.fitContentHeight();}
    };
    document.addEventListener('pointerdown',this.foldDown,true);document.addEventListener('pointerup',this.foldUp,true);document.addEventListener('pointercancel',this.foldUp,true);document.addEventListener('dblclick',this.doubleClick,true);
    const executed=node.onExecuted;
    node.onExecuted=function(message){const result=executed?.apply(this,arguments);if(Array.isArray(message?.liuxinyu_object_preview))view.receive(message.liuxinyu_object_preview.flatMap(p=>p.items));return result;};
    const removed=node.onRemoved;
    node.onRemoved=function(...args){view.dispose();return removed?.apply(this,args);};
    node.setSize([Math.max(420,node.size[0]),Math.max(340,node.size[1])]);
  }
  active(){return !this.disposed&&!this.node.flags?.collapsed&&this.node.graph&&(!app.canvas?.graph||app.canvas.graph===this.node.graph);}
  dirty(){this.node.setDirtyCanvas?.(true,true);}
  dispose(){this.clearCursor();this.disposed=true;document.removeEventListener('wheel',this.wheelListener,true);document.removeEventListener('pointermove',this.moveListener,true);document.removeEventListener('keydown',this.keyListener,true);document.removeEventListener('pointerdown',this.outsideListener,true);
    document.removeEventListener('pointerdown',this.foldDown,true);document.removeEventListener('pointerup',this.foldUp,true);document.removeEventListener('pointercancel',this.foldUp,true);document.removeEventListener('dblclick',this.doubleClick,true);
  }
  receive(items){this.items=items;this.expanded=new Set(items.map((_,i)=>String(i)));this.selected=null;this.scroll=0;this.rebuild();}
  rebuild(){
    this.rows=[];const stack=(this.items||[]).map((value,i)=>({value,key:this.items.length===1?'$':`结果 ${i+1}`,path:String(i),depth:0,guides:[]})).reverse();
    while(stack.length){const row=stack.pop();this.rows.push(row);if(!container(row.value)||!this.expanded.has(row.path))continue;
      const keys=Object.keys(row.value);for(let i=keys.length-1;i>=0;i--){const k=keys[i];stack.push({value:row.value[k],key:Array.isArray(row.value)?`[${k}]`:k,path:`${row.path}/${encodeURIComponent(k)}`,depth:row.depth+1,guides:[...row.guides,i<keys.length-1]});}}
    this.resizeContent();this.dirty();
  }
  toggle(row){if(this.expanded.has(row.path))this.expanded.delete(row.path);else this.expanded.add(row.path);this.rebuild();}
  treeLines(row,left,y,maxDepth){
    const lines=[];
    row.guides.forEach((continues,level)=>{
      if(level>=maxDepth)return;
      const x=left+level*20+8.5,own=level===row.depth-1;
      if(own){lines.push([x,y,x,y+(continues?ROW:ROW/2)]);lines.push([x,y+ROW/2,left+row.depth*20-2,y+ROW/2]);}
      else if(continues)lines.push([x,y,x,y+ROW]);
    });
    if(row.depth<maxDepth&&container(row.value)&&Object.keys(row.value).length&&this.expanded.has(row.path)){
      const x=left+row.depth*20+8.5;lines.push([x,y+22,x,y+ROW]);
    }
    return lines;
  }
  toggleRecursive(row){
    const open=!this.expanded.has(row.path);
    if(!open){for(const path of [...this.expanded])if(path===row.path||path.startsWith(row.path+'/'))this.expanded.delete(path);}
    else{const stack=[{value:row.value,path:row.path}];while(stack.length){const item=stack.pop();if(!container(item.value))continue;this.expanded.add(item.path);
      for(const key of Object.keys(item.value))if(container(item.value[key]))stack.push({value:item.value[key],path:`${item.path}/${encodeURIComponent(key)}`});}}
    this.rebuild();
  }
  fitContentHeight(){
    this.manualHeight=null;this.lastHeight=this.node.size[1];this.scroll=0;this.detailScroll=0;this.resizeContent();
    this.dirty();
  }
  naturalSize(ctx,width){
    let detail=0;
    if(this.selected){
      const key=`${width}:${this.detailText}`;
      if(key!==this.detailKey){this.layoutJSON(ctx,Math.max(1,width-38));this.detailKey=key;}
      detail=this.detailLines.length*22+36;
    }
    return {tree:Math.max(28,this.rows.length*ROW),detail};
  }
  resizeContent(){
    const ctx=(this.canvas||app.canvas?.canvas)?.getContext?.('2d');if(!ctx)return;
    ctx.save();ctx.font=formFont;const size=this.naturalSize(ctx,this.node.size[0]);ctx.restore();
    if(this.lastHeight!==undefined&&this.node.size[1]!==this.lastHeight)this.manualHeight=this.node.size[1];
    const height=this.manualHeight??Math.ceil((this.widget.last_y??this.widget.y??24)+Math.max(180,size.tree+size.detail+66));
    this.node.graph?.beforeChange?.();try{this.node.setSize([this.node.size[0],height]);this.node.arrange?.();this.lastHeight=this.node.size[1];}finally{this.node.graph?.afterChange?.();}
  }
  select(row){this.selected=row;this.detailText=JSON.stringify(row.value,null,2);this.detailScroll=0;this.resizeContent();this.dirty();}
  toggleSelection(row){
    if(this.selected?.path!==row.path){this.select(row);return;}
    this.selected=null;this.detailText='';this.detailScroll=0;this.resizeContent();this.dirty();
  }
  async copy(value){try{await navigator.clipboard.writeText(value);this.notice='已复制';}catch{this.notice='复制失败：浏览器未允许访问剪贴板';}this.dirty();}
  text(ctx,value,r,color='#ccc'){
    ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,Math.max(0,r.w),r.h);ctx.clip();ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.textAlign='left';
    let text=String(value);while(text.length>1&&ctx.measureText(text).width>r.w)text=text.slice(0,-2)+'…';
    ctx.fillText(text,r.x,r.y+r.h/2+formTextLayout(ctx,text).baseline);ctx.restore();
  }
  target(id,r,run,row){this.targets.push({id,rect:r,run,row});}
  button(ctx,id,label,r,run,enabled=true){
    ctx.fillStyle=this.pressed===id?'#353535':this.hover===id?'#575757':'#494949';ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,3);ctx.fill();
    const tw=ctx.measureText(label).width;this.text(ctx,label,{...r,x:r.x+Math.max(4,(r.w-tw)/2),w:r.w-4},enabled?'#ddd':'#777');if(enabled)this.target(id,r,run);
  }
  wrap(ctx,text,width){const lines=[];for(const part of text.split('\n')){let line='';for(const c of part){if(line&&ctx.measureText(line+c).width>width){lines.push(line);line='';}line+=c;}lines.push(line);}return lines;}
  layoutJSON(ctx,width){
    this.detailLines=[''];this.detailColors=[[]];let index=0;
    const newline=()=>{index++;this.detailLines.push('');this.detailColors.push([]);};
    for(const token of jsonColorTokens(this.detailText))for(const char of token.text){
      if(char==='\n'){newline();continue;}
      if(this.detailLines[index]&&ctx.measureText(this.detailLines[index]+char).width>width)newline();
      const spans=this.detailColors[index],last=spans[spans.length-1];
      if(last?.color===token.color)last.text+=char;else spans.push({text:char,color:token.color,x:ctx.measureText(this.detailLines[index]).width});
      this.detailLines[index]+=char;
    }
  }
  scrollbar(ctx,r,total,offset){if(total<=r.h)return;const h=Math.max(18,r.h*r.h/total),y=r.y+(r.h-h)*offset/(total-r.h);ctx.fillStyle='#747474';ctx.beginPath();ctx.roundRect(r.x+r.w-5,y,4,h,2);ctx.fill();this.target(r===this.body?'scroll-body':'scroll-detail',{x:r.x+r.w-9,y:r.y,w:9,h:r.h},()=>{},null);}
  draw(ctx,width,height){
    this.bounds={x:0,y:0,w:width,h:height};this.targets=[];ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.font=formFont;
    const copyRect={x:width-36,y:4,w:24,h:24},canCopy=!!this.items?.length;
    this.button(ctx,'copy','',copyRect,()=>this.copy(JSON.stringify(this.items.length===1?this.items[0]:this.items,null,2)),canCopy);
    // Copy SVG geometry drawn directly in node coordinates; no DOM or bitmap.
    ctx.save();ctx.translate(copyRect.x+4,copyRect.y+4);ctx.strokeStyle=canCopy?'#ddd':'#777';ctx.lineWidth=1.4;ctx.lineJoin='round';ctx.lineCap='round';
    ctx.beginPath();ctx.roundRect(5,5,9,10,1.5);ctx.stroke();
    ctx.beginPath();ctx.moveTo(3,11);ctx.lineTo(2,11);ctx.lineTo(2,2);ctx.lineTo(11,2);ctx.lineTo(11,3);ctx.stroke();ctx.restore();
    const natural=this.naturalSize(ctx,width),available=Math.max(28,height-66);
    const detailHeight=this.selected?Math.min(natural.detail,Math.max(56,available-Math.min(natural.tree,Math.max(28,available-natural.detail)))):0;
    const body=this.body={x:12,y:36,w:width-24,h:Math.max(28,height-66-detailHeight)};
    this.scroll=Math.max(0,Math.min(this.scroll,this.rows.length*ROW-body.h));
    ctx.save();ctx.beginPath();ctx.rect(body.x,body.y,body.w,body.h);ctx.clip();
    const start=Math.floor(this.scroll/ROW),end=Math.min(this.rows.length,Math.ceil((this.scroll+body.h)/ROW));
    if(!this.rows.length)this.text(ctx,this.items===null?'连接对象或数组，运行后查看。':'没有输入条目。',{...body,h:28},'#999');
    for(let i=start;i<end;i++){
      const row=this.rows[i],y=body.y+i*ROW-this.scroll,r={x:body.x,y,w:body.w-8,h:ROW};
      if(this.selected?.path===row.path||this.hover===row.path){ctx.fillStyle=this.selected?.path===row.path?'#454545':'#3b3b3b';ctx.fillRect(r.x,r.y,r.w,r.h);}
      const maxDepth=Math.max(1,Math.min(10,Math.floor((width*.46-body.x-70)/20)));
      const x=body.x+Math.min(row.depth,maxDepth)*20,keyX=x+18,valueX=Math.max(keyX+45,width*.46),count=container(row.value)?Object.keys(row.value).length:0;
      ctx.strokeStyle=this.selected?.path===row.path?'#353535':'#575757';ctx.lineWidth=1;ctx.beginPath();
      for(const [x1,y1,x2,y2] of this.treeLines(row,body.x,y,maxDepth)){ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);}ctx.stroke();
      this.target(row.path,{...r,y:Math.max(y,body.y),h:Math.max(0,Math.min(y+ROW,body.y+body.h)-Math.max(y,body.y))},()=>this.toggleSelection(row),row);
      if(count){
        const id=`fold:${row.path}`,ay=y+2;ctx.fillStyle=this.pressed===id?'#fff':this.hover===id?'#ccc':'#999';ctx.beginPath();
        if(this.expanded.has(row.path)){ctx.moveTo(x+3,ay+9);ctx.lineTo(x+13,ay+9);ctx.lineTo(x+8,ay+15);}else{ctx.moveTo(x+5,ay+7);ctx.lineTo(x+5,ay+17);ctx.lineTo(x+11,ay+12);}ctx.fill();
        this.target(id,{x,y:Math.max(y,body.y),w:16,h:Math.max(0,Math.min(y+ROW,body.y+body.h)-Math.max(y,body.y))},()=>this.toggle(row),row);}
      this.text(ctx,row.key,{x:keyX,y,w:Math.max(0,valueX-keyX-8),h:ROW},'#b9d4f1');
      const label=container(row.value)?`${Array.isArray(row.value)?'[ ]':'{ }'} ${count} ${Array.isArray(row.value)?'项':'个属性'}`:JSON.stringify(row.value);
      this.text(ctx,label,{x:valueX,y,w:Math.max(0,width-78-valueX),h:ROW},typeof row.value==='string'?'#b3d6a1':'#ddd');
      this.text(ctx,kind(row.value),{x:width-72,y,w:48,h:ROW},'#999');
    }
    this.scrollbar(ctx,body,this.rows.length*ROW,this.scroll);ctx.restore();
    this.detail=null;
    if(this.selected){
      const top=body.y+body.h+4;
      this.text(ctx,this.selected.key,{x:12,y:top,w:width-180,h:24});
      this.button(ctx,'copy-value','复制此值',{x:width-170,y:top,w:90,h:24},()=>this.copy(this.detailText));
      this.button(ctx,'close','关闭',{x:width-74,y:top,w:62,h:24},()=>{this.selected=null;this.resizeContent();this.dirty();});
      const r=this.detail={x:12,y:top+28,w:width-24,h:Math.max(20,detailHeight-36)};
      this.detailScroll=Math.max(0,Math.min(this.detailScroll,this.detailLines.length*22-r.h));
      ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.w,r.h);ctx.clip();
      ctx.textBaseline='alphabetic';ctx.textAlign='left';
      for(let i=Math.floor(this.detailScroll/22);i<Math.min(this.detailLines.length,Math.ceil((this.detailScroll+r.h)/22));i++){
        const baseline=r.y+i*22-this.detailScroll+11+formTextLayout(ctx,this.detailLines[i]).baseline;
        for(const span of this.detailColors[i]){ctx.fillStyle=span.color;ctx.fillText(span.text,r.x+4+span.x,baseline);}
      }
      this.scrollbar(ctx,r,this.detailLines.length*22,this.detailScroll);ctx.restore();
    }
    this.text(ctx,this.notice||'',{x:12,y:height-24,w:width-24,h:20},'#999');
  }
  point(event){
    if(!this.active()||!this.matrix||!this.canvas||event.target&&event.target!==this.canvas)return null;
    const b=this.canvas.getBoundingClientRect();if(!b.width||!b.height)return null;
    const x=(event.clientX-b.left)*this.canvas.width/b.width,y=(event.clientY-b.top)*this.canvas.height/b.height,m=this.matrix,d=m.a*m.d-m.b*m.c;
    return d?{x:(m.d*(x-m.e)-m.c*(y-m.f))/d,y:(m.a*(y-m.f)-m.b*(x-m.e))/d}:null;
  }
  hit(p){return [...this.targets].reverse().find(t=>contains(t.rect,p));}
  clearCursor(){if(this.canvas?.__lxyFormPointerOwner===this){this.canvas.style.cursor='';delete this.canvas.__lxyFormPointerOwner;}}
  move(event){const hit=this.hit(this.point(event)),id=hit?.id??null;
    if(hit&&this.canvas?.style){this.canvas.__lxyFormPointerOwner=this;this.canvas.style.cursor=hit.id.startsWith('scroll-')?'ns-resize':'pointer';}else this.clearCursor();
    if(id!==this.hover){this.hover=id;this.dirty();}}
  pointer(cursor){const down=cursor.eDown,hit=this.hit(this.point(down));if(!hit)return;this.focused=true;this.pressed=hit.id;this.dirty();
    if(hit.id.startsWith('scroll-')){const detail=hit.id==='scroll-detail',r=detail?this.detail:this.body,total=detail?this.detailLines.length*22:this.rows.length*ROW;const drag=e=>{const p=this.point(e);if(!p)return;const h=Math.max(18,r.h*r.h/total),offset=Math.max(0,Math.min(1,(p.y-r.y-h/2)/(r.h-h)))*(total-r.h);if(detail)this.detailScroll=offset;else this.scroll=offset;this.dirty();};drag(down);cursor.onDrag=drag;cursor.onClick=drag;cursor.onDragEnd=drag;cursor.finally=()=>{this.pressed=null;this.dirty();};return;}
    const click=e=>{e=e||down;if(Math.hypot(e.clientX-down.clientX,e.clientY-down.clientY)<6&&this.hit(this.point(e))?.id===hit.id)hit.run();this.pressed=null;this.dirty();};
    cursor.onClick=click;cursor.onDragEnd=click;cursor.finally=()=>{this.pressed=null;this.dirty();};
  }
  wheel(event){
    if(event.ctrlKey||event.metaKey)return;
    const p=this.point(event),detail=contains(this.detail,p),body=contains(this.body,p);if(!detail&&!body)return;
    const area=detail?this.detail:this.body,total=detail?(this.detailLines?.length??0)*22:this.rows.length*ROW;
    if(total<=area.h)return;
    const offset=detail?this.detailScroll:this.scroll;
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?area.h:1);
    const next=Math.max(0,Math.min(total-area.h,offset+delta));
    // Match the form: only consume wheel input that actually scrolls content.
    if(next===offset)return;
    if(detail)this.detailScroll=next;else this.scroll=next;
    event.preventDefault();event.stopImmediatePropagation();this.dirty();
  }
  key(event){if(!this.focused||!this.active()||event.ctrlKey||event.metaKey||event.target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    let index=this.rows.findIndex(r=>r.path===this.selected?.path);if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Enter',' '].includes(event.key)||!this.rows.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){index=Math.max(0,Math.min(this.rows.length-1,index+(event.key==='ArrowDown'?1:-1)));this.select(this.rows[index]);this.scroll=Math.max(0,index*ROW-(this.body?.h??ROW)/2);}
    else if(index>=0&&container(this.rows[index].value)){if(event.key==='ArrowLeft')this.expanded.delete(this.rows[index].path);else if(event.key==='ArrowRight')this.expanded.add(this.rows[index].path);else this.toggle(this.rows[index]);this.rebuild();}
  }
}
app.registerExtension({name:'liuxinyu.ObjectPreview',nodeCreated(node){if(node.comfyClass==='LiuxinyuPreviewJSObject')new ObjectPreview(node);}});
