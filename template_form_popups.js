import { photoshopPicker } from "./template_color_picker.js";
import { api } from "../../scripts/api.js";
// Temporary editors only. The persistent form is drawn inside the node canvas.
export const formFont='14px "Microsoft YaHei", sans-serif';
export function formStringLines(value,width,measure){
  const result=[],parts=String(value??'').split(/\r\n|\r|\n/);
  parts.forEach((part,index)=>{
    let text='';
    for(const char of part){
      if(text&&measure(text+char)>Math.max(1,width)){result.push({text,hardEnd:false});text='';}
      text+=char;
    }
    result.push({text,hardEnd:index<parts.length-1});
  });return result;
}
export function formTextLayout(ctx,text='国Ag09'){
  const m=ctx.measureText(String(text||'国Ag09'));
  const ink=(m.actualBoundingBoxAscent??11)-(m.actualBoundingBoxDescent??3);
  return {baseline:ink/2};
}
export const formMenuUnit=14/12;
export const formMenuFont='14px LxyInspectorInter, sans-serif';
export const formMenuFontReady=typeof FontFace==='undefined'?Promise.resolve():new FontFace('LxyInspectorInter','url("/extensions/comfyui-liuxinyu-packs/fonts/Inter-Regular.ttf")').load().then(font=>document.fonts.add(font)).catch(error=>console.warn('[liuxinyu.TemplateForm] Inter 字体加载失败',error));
const fullMatch=(expression,value)=>{try{return new RegExp(`^(?:${expression})$`).test(value);}catch{return false;}};
const patternMatch=(expression,value)=>{try{return new RegExp(expression).test(value);}catch{return false;}};
function matchesPatternPrefix(pattern,value){
  const source=pattern.replace(/^\^/,'').replace(/\$$/,'');let inClass=false,escaped=false;
  const cuts=[0];
  for(let i=0;i<source.length;i++){
    const char=source[i];if(escaped){escaped=false;cuts.push(i+1);continue;}if(char==='\\'){escaped=true;continue;}
    if(char==='[')inClass=true;else if(char===']')inClass=false;
    if(!inClass&&char!==']')cuts.push(i+1);
  }
  for(const cut of cuts){
    const fragment=source.slice(0,cut);let prefix='',classMode=false,slash=false;
    for(let i=0;i<fragment.length;i++){
      const char=fragment[i];
      if(slash){prefix+=char;slash=false;continue;}
      if(char==='\\'){prefix+=char;slash=true;continue;}
      if(char==='[')classMode=true;else if(char===']')classMode=false;
      if(!classMode&&char==='+'){prefix+='*';continue;}
      if(!classMode&&char==='{'){
        const quantifier=fragment.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
        if(quantifier){prefix+=`{0,${quantifier[2]||quantifier[1]}}`;i+=quantifier[0].length-1;continue;}
      }
      prefix+=char;
    }
    try{if(new RegExp(`^(?:${prefix})$`).test(value))return true;}catch{}
  }
  return false;
}
export function acceptsSchemaInput(schema,value,previous='',complete=false){
  if(value==='')return true;
  const pattern=schema?.pattern,patternValid=!pattern||patternMatch(pattern,value);
  const format=schema?.format;
  if(format){
    const valid={email:/^[^\s@]+@[^\s@]+\.[^\s@]+$/,uri:/^[A-Za-z][A-Za-z\d+.-]*:[^\s]*$/,"uri-reference":/^(?:[A-Za-z][A-Za-z\d+.-]*:)?[^\s]*$/,"iri":/^[A-Za-z][A-Za-z\d+.-]*:[^\s]*$/,"iri-reference":/^(?:[A-Za-z][A-Za-z\d+.-]*:)?[^\s]*$/,hostname:/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?))*$/i,ipv4:/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,ipv6:/^[\da-f:]+$/i,"date":/^\d{4}-\d{2}-\d{2}$/,"time":/^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/i,"date-time":/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/i,duration:/^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/i,"json-pointer":/^(?:\/(?:[^~/]|~[01])*)*$/,"relative-json-pointer":/^\d+(?:#|(?:\/(?:[^~/]|~[01])*)*)$/,"regex":/^[\s\S]*$/,"uri-template":/^[^\s{}]*(?:\{[^{}]+\}[^\s{}]*)*$/,"uuid":/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i,color:/^#[\da-f]{6}(?:[\da-f]{2})?$/i};
    const exact=valid[format];
    if(exact){
      if(exact.test(value)){
        if(format==='date'||format==='date-time'){
          const day=value.slice(0,10),[year,month,date]=day.split('-').map(Number),check=new Date(0);check.setUTCFullYear(year,month-1,date);
          if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==date)return false;
        }
        if(format==='time'||format==='date-time'){
          const time=value.slice(format==='time'?0:11),match=time.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))?$/i);
          if(!match||Number(match[1])>23||Number(match[2])>59||Number(match[3]||0)>59||Number(match[5]||0)>23||Number(match[6]||0)>59)return false;
        }
        if(format==='ipv6'){try{new URL(`http://[${value}]`);return patternValid;}catch{}}
        else if(format==='regex'){try{new RegExp(value);}catch{return false;}return patternValid;}
        else return patternValid;
      }
      if(complete)return false;
      const partial={email:/^[^\s@]*@?[^\s@]*(?:\.[^\s@]*)?$/,uri:/^[A-Za-z][A-Za-z\d+.-]*:?[^\s]*$/,"uri-reference":/^[A-Za-z\d+.-]*:?[^\s]*$/,iri:/^[A-Za-z][A-Za-z\d+.-]*:?[^\s]*$/,"iri-reference":/^[A-Za-z\d+.-]*:?[^\s]*$/,hostname:/^[a-z\d.-]*$/i,ipv4:/^[\d.]*$/,ipv6:/^[\da-f:]*$/i,date:/^[\d-]{0,10}$/,time:/^[\d:.+Z-]*$/i,"date-time":/^[\dT:.+Z-]*$/i,duration:/^-?P[\dYMWDT.HS-]*$/i,"json-pointer":/^(?:\/[^~]*(?:~[01][^~]*)*)*$/,"relative-json-pointer":/^\d*(?:#|(?:\/[^~]*(?:~[01][^~]*)*)*)?$/,regex:/^[\s\S]*$/,"uri-template":/^[^\s{}]*(?:\{[^{}]*\}[^\s{}]*)*$/,uuid:/^[\da-f-]*$/i,color:/^#?[\da-f]*$/i};
      if(partial[format])return partial[format].test(value)&&(!pattern||patternValid||matchesPatternPrefix(pattern,value));
      if(format==='ipv6'){try{new URL(`http://[${value}]`);return true;}catch{return /^(?:[\da-f]{0,4}:?)*$/i.test(value);}}
      if(format==='uri-template')return value.split('{').length-value.split('}').length<=1;
      return false;
    }
    return false;
  }
  if(value===previous&&!complete)return true;
  if(!pattern)return true;
  if(patternValid)return true;
  if(complete)return false;
  if(!pattern.startsWith('^'))return true;
  return matchesPatternPrefix(pattern,value);
}
const popupCSS = `
.lxy-form-popup{position:fixed;z-index:10000;box-sizing:border-box;background:#383838;color:#ccc;color-scheme:dark;border:1px solid #666;border-radius:3px;padding:10px;font:13px sans-serif;box-shadow:0 4px 16px #0006;overflow:auto;max-height:90vh;outline:none!important}
.lxy-form-popup *{box-sizing:border-box;font:inherit;letter-spacing:normal}
.lxy-form-popup button{display:inline-flex;align-items:center;justify-content:center;text-align:center;line-height:18px;margin:0;border:1px solid #292929;border-radius:3px;color:#ccc;background:#505050;padding:5px 9px;cursor:pointer;min-width:0;box-shadow:none!important}
.lxy-form-popup button:hover{background:#5b5b5b}.lxy-form-popup button:active{background:#303030}.lxy-form-popup button:disabled{opacity:.4;cursor:default}
.lxy-form-popup input,.lxy-form-popup select,.lxy-form-popup textarea{display:block;line-height:18px;margin:0;text-align:left;background:#2b2b2b;color:#ddd;border:1px solid #252525;border-radius:3px;padding:4px;min-width:0;outline:none;width:100%}
.lxy-form-popup:not(.lxy-form-inline) input:not([type=range]),.lxy-form-popup select{height:30px}
.lxy-form-popup :focus-visible{outline:1px solid #718b9a;outline-offset:0}
.lxy-form-popup .row{display:flex;gap:6px;align-items:center;margin-bottom:7px}.lxy-form-popup .row>*{flex:1}
.lxy-form-popup .footer{display:flex;justify-content:flex-end;gap:7px;margin-top:9px}
.lxy-form-popup .error{color:#cd9b91;white-space:pre-wrap;margin-top:6px}
.lxy-form-popup .error:empty{display:none}
.lxy-form-popup .calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.lxy-form-popup .calendar button{height:29px;padding:0;background:transparent;border-color:transparent}
.lxy-form-popup .calendar button:hover{background:#484848}.lxy-form-popup .calendar .selected{background:#526873}.lxy-form-popup .calendar .today{border-color:#898989}
.lxy-form-popup .calendar .other{color:#777}.lxy-form-popup .weekday{text-align:center;color:#999;padding:4px 0}
.lxy-form-popup .time-column{height:150px;overflow:auto;scrollbar-width:thin;scrollbar-color:#777 #303030;background:#303030}
.lxy-form-popup .time-column button{width:100%;border:0;border-radius:0;background:transparent;height:28px;padding:0}.lxy-form-popup .time-column .selected{background:#526873}
.lxy-form-popup.lxy-form-menu{padding:0;border:1px solid #636363;border-radius:0;background:#3c3c3c;box-shadow:none;scrollbar-width:thin;transform-origin:top left;font:12px LxyInspectorInter,sans-serif;overflow-x:hidden}
.lxy-form-popup .menu-item{position:relative;display:block;text-align:left;width:100%;height:20px;min-height:20px;line-height:20px;padding:0 4px 0 21px;border:0;border-radius:0;background:#3c3c3c;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none!important;cursor:default}
.lxy-form-popup .menu-item:nth-child(even){background:#3f3f3f}
.lxy-form-popup .menu-item:hover,.lxy-form-popup .menu-item:active{background:#3c3c3c}
.lxy-form-popup .menu-item:nth-child(even):hover,.lxy-form-popup .menu-item:nth-child(even):active{background:#3f3f3f}
.lxy-form-popup .menu-item.is-highlighted,.lxy-form-popup .menu-item.is-highlighted:hover,.lxy-form-popup .menu-item.is-highlighted:active{background:#3e5f96;color:#ddd}
.lxy-form-popup .menu-item[aria-selected=true]::before{content:'';position:absolute;left:7px;top:5px;width:3px;height:7px;border:solid #b6b6b6;border-width:0 1.5px 1.5px 0;transform:rotate(35deg)}
.lxy-form-popup .menu-option-row{position:relative;height:20px;background:#3c3c3c}
.lxy-form-popup .menu-option-row:nth-child(even){background:#3f3f3f}
.lxy-form-popup .menu-option-row>.menu-item{background:transparent;padding-right:44px}
.lxy-form-popup .menu-option-row>.menu-item.is-highlighted{background:#3e5f96}
.lxy-form-popup .menu-option-actions{position:absolute;right:2px;top:0;display:flex;height:20px}
.lxy-form-popup .menu-option-action{display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:0;background:transparent;color:#aaa}
.lxy-form-popup .menu-option-action:hover,.lxy-form-popup .menu-option-action:active,.lxy-form-popup .menu-option-action:focus-visible{background:transparent;color:#eee;outline:none}
.lxy-form-popup .menu-option-action svg{width:13px;height:13px;display:block;pointer-events:none}
.lxy-form-popup .menu-item.menu-add{text-align:center;padding:0 4px}
.lxy-form-popup.lxy-form-menu .menu-option-editor{position:absolute;left:21px;right:24px;top:2px;width:calc(100% - 45px);height:16px!important;font:inherit;line-height:14px;padding:0 2px;border-radius:3px}
.lxy-form-popup .menu-option-error{margin:0;padding:1px 24px 4px 21px;color:#e5a49c;white-space:normal;overflow-wrap:anywhere;line-height:16px}
.lxy-form-popup .menu-option-error:empty{display:none}
.lxy-form-popup .menu-option-row:has(.menu-option-error:not(:empty)){height:auto;min-height:20px}
.lxy-form-popup .menu-option-editor[aria-invalid=true]{border-color:#ab7771}
.lxy-form-popup.lxy-form-menu .menu-add-editor{left:4px;right:4px;width:calc(100% - 8px)}
.lxy-form-popup .menu-add-error{padding-left:4px;padding-right:4px}
.lxy-form-popup canvas{display:block;touch-action:none;max-width:100%}
.lxy-form-popup .swatch{min-height:25px;border:1px solid #292929}
.lxy-form-inline{padding:0;border:0;border-radius:3px;overflow:hidden;box-shadow:inset 0 0 0 var(--input-border,1px) #718b9a;background:#2b2b2b}
.lxy-form-inline input{position:absolute;left:5px;width:calc(100% - 10px);appearance:none;border:0;border-radius:0;height:20px;min-height:0;max-height:none;padding:0;font:${formFont};line-height:20px;color:#ccc;outline:none!important;box-shadow:none!important;text-indent:0;letter-spacing:normal;background:transparent}
.lxy-form-inline textarea{position:absolute;inset:4px;width:calc(100% - 8px);height:calc(100% - 8px);resize:none;border:0;border-radius:0;padding:3px 5px;font:${formFont};line-height:20px;color:#ccc;background:transparent;outline:none!important;box-shadow:none!important;white-space:pre-wrap;overflow:auto}
.lxy-form-inline .error{display:none}.lxy-form-inline:has(input[aria-invalid=true]),.lxy-form-inline:has(textarea[aria-invalid=true]){box-shadow:inset 0 0 0 var(--input-border,1px) #ab7771}
`;

function element(tag, parent, props = {}) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") el.textContent = value;
    else if (key === "className") el.className = value;
    else el[key] = value;
  }
  parent?.append(el); return el;
}

export function closeFormPopup(owner) { owner.popup?.close(); }

function popup(owner, anchor, width, inline = false) {
  closeFormPopup(owner);
  if (!document.getElementById("lxy-form-popup-style")) {
    element("style", document.head, { id: "lxy-form-popup-style", text: popupCSS });
  }
  const root = element("div", document.body, { className: `lxy-form-popup${inline ? " lxy-form-inline" : ""}` });
  root.setAttribute("role", inline ? "group" : "dialog");
  root.setAttribute("aria-modal", "false");
  let frame, closed = false;
  const state = { root, inline, close() {
    if (closed) return;
    closed = true; cancelAnimationFrame(frame);
    document.removeEventListener("pointerdown", outside, true);
    root.remove(); if (owner.popup === state) owner.popup = null;
    state.onClose?.(); owner.dirty?.();
  }};
  const outside = event => { if (!root.contains(event.target)&&!state.ignoreOutside?.(event)) (state.outside || state.close)(); };
  document.addEventListener("pointerdown", outside, true);
  for (const name of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) root.addEventListener(name, event => event.stopPropagation());
  root.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); state.close(); }
  });
  function place() {
    if (closed) return;
    const rect = anchor();
    if (!rect) { state.close(); return; }
    const scale=state.inline?(rect.scale??rect.height/24):state.menu?(rect.scale||1)*formMenuUnit:1;
    const w = state.inline||state.menu?rect.width:Math.min(typeof width==="function"?width(rect):width,Math.max(80,window.innerWidth-16));
    // Inline text is typeset at the exact screen font size. Scaling a completed
    // native input raster gives different hinting/rounding from canvas text.
    root.style.width = `${state.inline?w:w/scale}px`;
    root.style.height = state.inline ? `${rect.height}px` : "auto";
    if(state.inline)state.placeInline?.(rect.height,scale);
    root.style.transform=state.menu?`scale(${scale})`:"none";
    if(state.menu)root.style.maxHeight=`${(window.innerHeight-16)/scale}px`;
    if(state.inline&&rect.clip){
      const c=rect.clip;
      root.style.clipPath=`inset(${Math.max(0,c.top-rect.top)}px ${Math.max(0,rect.left+rect.width-c.right)}px ${Math.max(0,rect.top+rect.height-c.bottom)}px ${Math.max(0,c.left-rect.left)}px)`;
    }else root.style.clipPath="none";
    const height = state.inline?rect.height:root.getBoundingClientRect().height;
    root.style.left = `${state.inline?rect.left:Math.max(8,Math.min(rect.left,window.innerWidth-w-8))}px`;
    const gap=state.menu?0:4,below = state.inline ? rect.top : rect.top + rect.height + gap;
    root.style.top = `${state.inline?rect.top:Math.max(8,Math.min(below+height>window.innerHeight-8?rect.top-height-gap:below,window.innerHeight-height-8))}px`;
    if(state.manualPosition){root.style.left=Math.max(0,Math.min(window.innerWidth-w,state.manualPosition.x))+'px';root.style.top=Math.max(0,Math.min(window.innerHeight-29,state.manualPosition.y))+'px';}
    if(state.menu&&root.style.visibility==='hidden'){root.style.visibility='visible';state.onPlaced?.();}
    frame = requestAnimationFrame(place);
  }
  owner.popup = state; frame = requestAnimationFrame(place);
  return state;
}

export function editFormValue(owner, anchor, value, commit, { multiline = false, allowMultiline = false, onTab, onMultiline, label = "值", accepts = null, onInput = null } = {}) {
  const inline = allowMultiline || !multiline;
  multiline = multiline || (allowMultiline && /[\r\n]/.test(String(value ?? "")));
  const p = popup(owner, anchor, 380, inline);
  p.root.setAttribute("aria-label", label);
  let input = element(multiline || allowMultiline ? "textarea" : "input", p.root, { value: String(value ?? ""), ariaLabel: label });
  // A native scrollbar can be taller than the entire one-line editor at
  // canvas zoom. Keep caret-driven horizontal scrolling without painting a bar.
  if(inline){input.style.overflowX="hidden";input.style.overflowY="hidden";}
  const marks=inline&&allowMultiline?element('div',p.root):null;
  if(marks){marks.setAttribute('aria-hidden','true');marks.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden';input.wrap='soft';}
  let acceptedValue=input.value,inlineMultiline=inline&&multiline;
  const expand=()=>{
    if(!allowMultiline||inlineMultiline)return;
    multiline=true;inlineMultiline=true;onMultiline?.();
    const rect=anchor();if(rect)p.placeInline?.(rect.height,rect.scale??1);
  };
  const filterInput=()=>{
    if(accepts&&!accepts(input.value,acceptedValue)){
      const position=input.selectionStart??input.value.length;
      input.value=acceptedValue;input.setSelectionRange?.(Math.min(position,acceptedValue.length),Math.min(position,acceptedValue.length));
      return;
    }
    acceptedValue=input.value;
    if(/[\r\n]/.test(input.value))expand();
    onInput?.(input.value);
  };
  input.addEventListener("input",filterInput);
  if(inline){
    const ctx=document.createElement('canvas').getContext?.('2d');
    if(ctx){
      ctx.font=formFont;ctx.textBaseline='alphabetic';
      // Measure the native input's real baseline instead of guessing its internal
      // line-box rounding. An inline zero-height marker shares that baseline.
      let height=24,lastScale,baseline=0;
      p.placeInline=(h,scale)=>{
        height=h;
        if(marks){
          input.style.whiteSpace='pre-wrap';input.style.wordBreak='break-all';input.style.overflowWrap='anywhere';
          input.style.boxSizing='border-box';input.style.padding=`0 ${14*scale}px 0 0`;
          const rect=anchor(),width=Math.max(1,(rect?.width??380)/scale-26);
          const lines=formStringLines(input.value,width,text=>ctx.measureText(text).width);
          marks.replaceChildren();
          lines.forEach((line,index)=>{if(line.hardEnd){
            const mark=element('span',marks,{text:'↵'});
            mark.style.cssText=`position:absolute;left:${(6+ctx.measureText(line.text).width)*scale}px;top:${2*scale+index*20*scale-(input.scrollTop||0)}px;font:${formFont.replace('14px',`${14*scale}px`)};line-height:${20*scale}px;color:#888`;
          }});
        }
        if(lastScale!==scale){
          const font=formFont.replace('14px',`${14*scale}px`),lineHeight=20*scale;
          const probe=element('div',document.body),copy=element('input',probe),marker=element('span',probe);
          probe.style.cssText='position:fixed;visibility:hidden;white-space:nowrap;left:0;top:0;line-height:0';
          copy.style.cssText=`display:inline-block;vertical-align:baseline;box-sizing:border-box;appearance:none;width:100px;height:${lineHeight}px;margin:0;border:0;padding:0;font:${font};line-height:${lineHeight}px`;
          marker.style.cssText='display:inline-block;vertical-align:baseline;width:0;height:0;margin:0;padding:0;border:0';
          baseline=marker.getBoundingClientRect().top-copy.getBoundingClientRect().top;probe.remove();lastScale=scale;
          input.style.font=font;input.style.lineHeight=input.style.height=`${lineHeight}px`;
          input.style.left=`${6*scale}px`;input.style.width=`calc(100% - ${12*scale}px)`;
          p.root.style.setProperty('--input-border',`${scale}px`);p.root.style.borderRadius=`${3*scale}px`;
        }
        if((inlineMultiline||allowMultiline)&&h>24*scale){
          input.style.overflowY="auto";
          input.style.font=formFont.replace('14px',`${14*scale}px`);
          input.style.padding=marks?`0 ${14*scale}px 0 0`:"0";input.style.resize="none";input.style.whiteSpace=marks?"pre-wrap":"pre";
          input.style.top=`${2*scale}px`;input.style.left=`${6*scale}px`;input.style.width=`calc(100% - ${12*scale}px)`;
          input.style.height=`calc(100% - ${4*scale}px)`;input.style.lineHeight=`${20*scale}px`;return;
        }
        input.style.height=`${20*scale}px`;
        input.style.overflowY="hidden";
        if(allowMultiline){input.style.padding=marks?`0 ${14*scale}px 0 0`:"0";input.style.resize="none";input.style.whiteSpace=marks?"pre-wrap":"pre";}
        input.style.top=`${h/2+formTextLayout(ctx,input.value).baseline*scale-baseline}px`;
      };
      input.addEventListener('input',()=>p.placeInline(height,lastScale??1));
    }
  }
  if(allowMultiline&&!multiline)input.title="Shift+Enter 展开多行编辑";
  if (multiline&&!inline) { input.rows = 7; input.style.resize = "vertical"; }
  const error = element("div", p.root, { className: "error" });
  function save() {
    if(accepts&&!accepts(input.value,acceptedValue,true)){
      error.textContent="输入尚未达到字段格式要求";input.setAttribute("aria-invalid","true");input.title=error.textContent;return false;
    }
    try { if (commit(input.value) === false) throw new Error("请检查输入值"); p.close(); return true; }
    catch (e) { error.textContent = e.message; input.setAttribute("aria-invalid", "true"); return false; }
  }
  p.outside = save;
  const addApply=()=>{const footer=element("div",p.root,{className:"footer"});element("button",footer,{text:"应用",onclick:save});};
  function onKey(event) {
    if(event.isComposing)return;
    if(event.key==="Enter"&&event.shiftKey&&allowMultiline){
      event.preventDefault();
      const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
      const candidate=input.value.slice(0,start)+'\n'+input.value.slice(end);
      if(accepts&&!accepts(candidate,acceptedValue))return;
      input.value=candidate;input.setSelectionRange?.(start+1,start+1);filterInput();return;
    }
    if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    if (event.key === "Tab") { event.preventDefault(); if (save()) onTab?.(event.shiftKey ? -1 : 1); }
  }
  input.addEventListener("keydown",onKey);
  if (multiline&&!inline) addApply();
  input.focus({ preventScroll: true }); input.select();
  return p;
}

export function formMenu(owner, anchor, choices, choose) {
  const p = popup(owner, anchor, rect=>rect.width);
  p.menu=true;
  p.root.style.visibility='hidden';
  p.root.classList.add("lxy-form-menu");
  p.root.setAttribute("role", "listbox");
  p.outside=()=>{if(!p.finishEdit||p.finishEdit(true))p.close();};
  p.root.addEventListener('pointerdown',event=>{
    if(p.finishEdit&&event.target!==p.editInput&&!p.finishEdit(true)){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  const highlight=button=>buttons.forEach(item=>{item.classList.remove('is-highlighted');if(item===button&&!item.disabled)item.classList.add('is-highlighted');});
  let buttons=[];
  function render(){
  p.root.replaceChildren();
  buttons=choices.map((choice, i) => {
    const parent=choice.actions?.length||choice.create?element('div',p.root,{className:'menu-option-row'}):p.root;
    const button=element("button", parent, {
      className: choice.centered?"menu-item menu-add":"menu-item", text: choice.label, title:choice.label, disabled: choice.disabled === true,
      onclick: () => { if(p.finishEdit&&!p.finishEdit(true))return;if(choice.create){startEdit(button,'',text=>{const added=choice.create(text);choices.splice(choices.indexOf(choice),0,added);},true);return;}p.close(); if(choice.action)choice.action();else choose(choice.value, i); },
    });
    button.addEventListener('pointermove',()=>highlight(button));
    button.setAttribute("role",choice.action||choice.create?"menuitem":"option");
    if(!choice.action&&!choice.create)button.setAttribute("aria-selected",String(choice.selected===true));
    function startEdit(control,value,saveValue,rebuild=false){
      const input=element('input',parent,{className:choice.create?'menu-option-editor menu-add-editor':'menu-option-editor',value});
      const error=element('div',parent,{className:choice.create?'menu-option-error menu-add-error':'menu-option-error'});error.setAttribute('role','alert');
      control.style.visibility='hidden';button.style.visibility='hidden';
      input.setAttribute('aria-label',choice.create?'新增选项':`修改：${choice.label}`);
      let finished=false;
      const finish=save=>{
        if(finished)return true;
        if(save){try{saveValue(input.value);}catch(e){error.textContent=e.message;input.title=e.message;input.setAttribute('aria-invalid','true');return false;}}
        finished=true;p.finishEdit=null;p.editInput=null;input.remove();error.remove();control.style.visibility='';button.style.visibility='';
        if(save&&rebuild)render();return true;
      };
      p.finishEdit=finish;p.editInput=input;
      input.addEventListener('input',()=>{error.textContent='';input.title='';input.setAttribute('aria-invalid','false');});
      input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();if(finish(event.key==='Enter'))(rebuild?buttons.at(-1):control)?.focus();}});
      input.addEventListener('blur',()=>finish(true));input.focus();input.select();
    }
    if(choice.actions?.length){
      const actions=element('div',parent,{className:'menu-option-actions'});
      for(const action of choice.actions){
        const control=element('button',actions,{className:'menu-option-action',title:action.label,onclick:event=>{
          event.stopPropagation();highlight(null);
          if(p.finishEdit&&!p.finishEdit(true))return;
          if(!action.edit){p.close();action.run(choice.value);return;}
          if(parent.querySelector('input')){parent.querySelector('input').focus();return;}
          startEdit(control,choice.value,text=>{
              const next=action.edit(text,choice.value);choice.value=choice.label=next;button.textContent=button.title=next;
              actions.querySelectorAll('button').forEach(b=>b.setAttribute('aria-label',`${b.title}：${next}`));
          });
        }});
        control.addEventListener('pointermove',()=>highlight(null));
        control.addEventListener('pointerenter',()=>highlight(null));
        control.setAttribute('aria-label',`${action.label}：${choice.label}`);
        const path=action.icon==='edit'?'M9 3l4 4M3 9l7-7 4 4-7 7-5 1z':'M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 7v4M9 7v4';
        control.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
      }
    }
    return button;
  });
  }
  render();
  p.root.addEventListener('pointerleave',()=>highlight(null));
  p.highlightAt=event=>{
    const button=document.elementFromPoint?.(event.clientX,event.clientY)?.closest?.('.menu-item');
    const item=buttons.includes(button)?button:null;highlight(item);return item;
  };
  p.root.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...p.root.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement);
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus({preventScroll:true});highlight(buttons[next]);buttons[next]?.scrollIntoView?.({block:"nearest"});
  });
  p.onPlaced=()=>{(buttons.find((button,i)=>choices[i].selected&&!button.disabled)||buttons.find(button=>!button.disabled))?.focus({preventScroll:true});};
  return p;
}

export function dateParts(value, format, now = new Date()) {
  const m = String(value || "").match(/^(?:(\d{4}-\d\d-\d\d)(?:T|$))?(?:(\d\d):(\d\d):(\d\d(?:\.\d+)?)(Z|[+-]\d\d:\d\d))?$/i);
  const local = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const offset = -now.getTimezoneOffset(), zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset)/60)).padStart(2,"0")}:${String(Math.abs(offset)%60).padStart(2,"0")}`;
  return { date: m?.[1] || local, hour: m?.[2] || "09", minute: m?.[3] || "00", second: m?.[4] || "00", zone: m?.[5] || zone };
}

export function dateValue(parts, format) {
  if (!/^\d{4}-\d\d-\d\d$/.test(parts.date)) throw new Error("日期应为 YYYY-MM-DD");
  const [year, month, day] = parts.date.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31,30,31,30,31,31,30,31,30,31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month-1]) throw new Error("日期不存在");
  if (format === "date") return parts.date;
  if (!/^\d{1,2}$/.test(parts.hour) || Number(parts.hour)>23 || !/^\d{1,2}$/.test(parts.minute) || Number(parts.minute)>59 || !/^\d{1,2}(\.\d+)?$/.test(parts.second) || Number(parts.second)>=60) throw new Error("时须为 0–23，分和秒须小于 60");
  if (!/^(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(parts.zone)) throw new Error("时区应为 Z 或 ±HH:MM");
  const time = `${parts.hour.padStart(2,"0")}:${parts.minute.padStart(2,"0")}:${parts.second.padStart(2,"0")}${parts.zone.toUpperCase()}`;
  return format === "time" ? time : `${parts.date}T${time}`;
}

export function pickFormDate(owner, anchor, format, value, commit) {
  const p = popup(owner, anchor, format === "time" ? 290 : 300), parts = dateParts(value, format);
  p.root.setAttribute("aria-label", "选择日期时间");
  let year = Number(parts.date.slice(0,4)), month = Number(parts.date.slice(5,7));
  const error = element("div", null, { className: "error" });
  const apply = () => { try { const next=dateValue(parts,format); commit(next); p.close(); } catch(e) { error.textContent=e.message; } };
  if (format !== "time") {
    const header = element("div", p.root, { className: "row" });
    const shift = delta => { month += delta; if(month===0){month=12;year--;}if(month===13){month=1;year++;} year=Math.max(1,Math.min(9999,year)); drawCalendar(); };
    element("button", header, { text:"‹", title:"上个月", onclick:()=>shift(-1) });
    const yearInput = element("input", header, { type:"number", min:"1", max:"9999", value:year, ariaLabel:"年份" }); yearInput.style.flex="2";
    const monthInput = element("select", header, { ariaLabel:"月份" }); monthInput.style.flex="2";
    for(let i=1;i<=12;i++) element("option",monthInput,{text:`${i} 月`,value:String(i)});
    element("button",header,{text:"›",title:"下个月",onclick:()=>shift(1)});
    yearInput.onchange=()=>{year=Math.max(1,Math.min(9999,Number(yearInput.value)||year));drawCalendar();};
    monthInput.onchange=()=>{month=Number(monthInput.value);drawCalendar();};
    const grid = element("div",p.root,{className:"calendar"});
    function drawCalendar(){
      grid.replaceChildren();yearInput.value=year;monthInput.value=String(month);
      for(const label of "一二三四五六日")element("span",grid,{text:label,className:"weekday"});
      const first=new Date(0);first.setFullYear(year,month-1,1);first.setHours(12,0,0,0);
      const start=new Date(first);start.setDate(1-(first.getDay()+6)%7);
      const today=dateParts("","date").date;
      for(let i=0;i<42;i++){
        const day=new Date(start);day.setDate(start.getDate()+i);
        const text=`${String(day.getFullYear()).padStart(4,"0")}-${String(day.getMonth()+1).padStart(2,"0")}-${String(day.getDate()).padStart(2,"0")}`;
        element("button",grid,{text:String(day.getDate()),title:text,disabled:day.getFullYear()<1||day.getFullYear()>9999,
          className:[day.getMonth()+1!==month?"other":"",text===today?"today":"",text===parts.date?"selected":""].join(" "),
          onclick:()=>{parts.date=text;if(format==="date")apply();else drawCalendar();}});
      }
    }
    drawCalendar();
    element("button",p.root,{text:"今天",onclick:()=>{parts.date=dateParts("","date").date;year=Number(parts.date.slice(0,4));month=Number(parts.date.slice(5,7));drawCalendar();}});
  }
  if (format !== "date") {
    const row=element("div",p.root,{className:"row"});row.style.marginTop="10px";
    for(const [key,label,max] of [["hour","时",23],["minute","分",59],["second","秒",59]]){
      const col=element("label",row,{text:label});
      const input=element("input",col,{type:"number",min:"0",max:String(max),step:key==="second"?"any":"1",value:parts[key],ariaLabel:label});
      input.oninput=()=>{parts[key]=input.value;};
      if(format==="time"){
        const scroller=element("div",col,{className:"time-column"});
        for(let n=0;n<=max;n++)element("button",scroller,{text:String(n).padStart(2,"0"),className:n===Number(parts[key])?"selected":"",onclick:event=>{
          parts[key]=input.value=String(n).padStart(2,"0");scroller.querySelector(".selected")?.classList.remove("selected");event.currentTarget.classList.add("selected");
        }});
        scroller.scrollTop=Math.max(0,Math.floor(Number(parts[key]))*28-56);
      }
    }
    const zone=element("label",p.root,{text:"时区（Z 或 ±HH:MM）"});
    element("input",zone,{value:parts.zone,ariaLabel:"时区",oninput:event=>parts.zone=event.target.value});
  }
  p.root.append(error);
  const footer=element("div",p.root,{className:"footer"});
  element("button",footer,{text:"取消",onclick:p.close});element("button",footer,{text:"应用",onclick:apply});
}

// Deliberately recognize a small documented set of standard JSON Schema patterns.
export function colorDigits(schema) {
  if (schema?.type !== "string") return 0;
  const match = schema.pattern?.match(/^\^#\[(?:0-9a-fA-F|0-9A-Fa-f|a-fA-F0-9)\]\{(6|8)\}\$$/);
  return match ? Number(match[1]) : 0;
}
export function colorRGBA(hex) {
  if(!/^#[\da-f]{6}([\da-f]{2})?$/i.test(hex))throw new Error("颜色必须为 #RRGGBB 或 #RRGGBBAA");
  return [1,3,5,7].map((i)=>i===7&&hex.length===7?255:parseInt(hex.slice(i,i+2),16));
}
export function colorHex(rgba,digits=8) {return "#"+rgba.slice(0,digits===8?4:3).map(n=>Math.round(Math.max(0,Math.min(255,n))).toString(16).padStart(2,"0")).join("").toUpperCase();}
export function rgbHSV([r,g,b]) {
  r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let h=0;if(delta)h=(max===r?(g-b)/delta+(g<b?6:0):max===g?(b-r)/delta+2:(r-g)/delta+4)/6;
  return [h,max?delta/max:0,max];
}
export function hsvRGB(h,s,v) {
  const f=n=>{const k=(n+h*6)%6;return Math.round((v-v*s*Math.max(0,Math.min(k,4-k,1)))*255);};return [f(5),f(3),f(1)];
}

export function pickFormColor(owner,anchor,value,digits,commit) {
  return photoshopPicker(owner,anchor,value,digits,commit,{popup,element,colorRGBA,colorHex,rgbHSV,hsvRGB,
    fetchBooks:async book=>{const response=await api.fetchApi('/liuxinyu/template_form/color_books'+(book?'?book='+encodeURIComponent(book):''));const result=await response.json();if(!response.ok)throw new Error(result.error||'读取色库失败');return result;}});
}
