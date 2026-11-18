import { api } from "../../scripts/api.js";
import { initialValue, cloneJSON, completeRequired } from "./template_form_model.js";
import { NativeTemplateForm } from "./template_form_native.js";
import { queueTemplateRefresh, waitTemplateRefresh } from "./template_form_refresh.js";

export function hideInternalState(node) {
  const stored=node.widgets?.find(widget=>widget.name==="form_state");
  if(!stored)return;
  stored.hidden=true;stored.options??={};Object.assign(stored.options,{hidden:true,socketless:true});
  stored.computeSize=()=>[0,-4];stored.computeLayoutSize=()=>({minHeight:0,maxHeight:0,minWidth:0});stored.computedHeight=0;
  if(stored.element)stored.element.hidden=true;
  for(let index=(node.inputs?.length||0)-1;index>=0;index--)if(node.inputs[index].name==="form_state")node.removeInput(index);
  return stored;
}

export function normalizeSchemaSocket(node) {
  const input=node.inputs?.find(input=>input.name==="schema");
  if(input){delete input.widget;delete input._widget;input.type="STRING";input.label="JSON Schema";}
  for(let index=(node.widgets?.length||0)-1;index>=0;index--){
    const widget=node.widgets[index];
    if(!["schema","template_form"].includes(widget.name))continue;
    // Retired native DOM widgets can have an earlier onAdded registration hook.
    // Hiding the retired object also prevents that late registration painting it.
    widget.hidden=true;widget.type="hidden";widget.options??={};widget.options.hidden=true;
    if(widget.element)widget.element.hidden=true;
    widget.onRemove?.();widget.element?.remove();node.widgets.splice(index,1);
  }
}

async function post(path,body){
  const response=await api.fetchApi(`/liuxinyu/template_form/${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok&&!result.errors)throw new Error(result.error||`HTTP ${response.status}`);
  return result;
}

export function mount(node,controllers){
  const stored=hideInternalState(node);if(!stored)return;
  normalizeSchemaSocket(node);
  let current,busy=false,disposed=false,status="连接 JSON Schema，运行后填写",errors=[],presentationTimer,revision=0;
  const pending=new Map();let refreshJob;
  const saved=()=>{try{return JSON.parse(stored.value||"{}");}catch{return {};}};
  const sameSchema=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function templateFor(schema,previous){
    if(previous?.template&&sameSchema(previous.template.schema,schema)&&Object.hasOwn(previous.template,'value'))return cloneJSON(previous.template);
    let value;try{value=initialValue(schema,schema)??null;}catch{value=null;}
    return {schema:cloneJSON(schema),value,resolved:false};
  }
  const view=new NativeTemplateForm(node,value=>{
    if(!current)return;current.value=cloneJSON(value);current.autoInitial=false;if(!current.validationActive)errors=[];persist(current,false);schedulePresentation();
    status=current.validationActive?"正在重新校验…":pending.size?"待确认":"草稿 · 下次运行需要确认";view.updateStatus(status);
  });
  function schedulePresentation(){
    const version=++revision;clearTimeout(presentationTimer);
    presentationTimer=setTimeout(()=>refreshPresentation(version),150);
  }
  function completeEntry(entry){
    const schema=entry.presentation??entry.schema,next=completeRequired(schema,entry.value,schema,view.branches);
    if(!next.added.length&&!next.replaced.length)return false;
    entry.value=next.value;entry.autoInitial=false;
    entry.pendingBackups=[...(entry.pendingBackups||[]),...next.backups];
    for(const path of [...next.added,...next.replaced])view.expandPath(path);
    if(!entry.validationActive){errors=[];view.setErrors([]);}view.errors.clear();persist(entry,false);
    status=next.replaced.length?'已按新类型重建字段，请检查并确认':'已补齐必填字段，请检查并确认';return true;
  }
  function inspectEntry(entry){
    return post('inspect',{schema:entry.schema,value:entry.value,...(entry.pendingBackups?.length?{backup_candidates:entry.pendingBackups}:{})});
  }
  function applyInspection(entry,result){
    if(result.backups){
      entry.value=cloneJSON(result.value);entry.pendingBackups=[];persist(entry,false);
    }else if(entry.pendingBackups?.length)throw new Error('后端尚未支持类型冲突备份，请更新并重启后端后重试。');
    if(result.presentation!==undefined)entry.presentation=result.presentation;
  }
  async function refreshPresentation(version){
    if(disposed||version!==revision||!current)return;
    if(view.popup||view.gesture||view.drag){presentationTimer=setTimeout(()=>refreshPresentation(version),150);return;}
    const entry=current;
    try{
      let result;
      for(let pass=0;pass<16;pass++){
        result=await inspectEntry(entry);
        if(disposed||version!==revision||current!==entry)return;
        if(view.popup||view.gesture||view.drag){presentationTimer=setTimeout(()=>refreshPresentation(version),150);return;}
        if(result.error)throw new Error(result.error);
        applyInspection(entry,result);
        if(entry.autoInitial&&result.presentation!==undefined){
          entry.value=initialValue(result.presentation,result.presentation)??null;entry.autoInitial=false;
          persist(entry,false);schedulePresentation();render();return;
        }
        // Conditional rules may add/retype fields. Validate the completed value,
        // not the result returned for the preceding value.
        if(!entry.validationActive||!completeEntry(entry))break;
        if(pass===15)throw new Error('必填字段规则连续变化，无法完成初始化，请检查条件或递归规则。');
      }
      if(entry.validationActive){
        entry.validationActive=!!result.errors?.length||!!view.errors.size;
        status=entry.validationActive?"请继续修正填写内容":"校验通过";
        showErrors(result.errors||[]);
      }else render();
    }catch(error){if(!disposed&&version===revision&&current===entry){status=`表单规则解析失败：${error.message}`;view.updateStatus(status);}}
  }
  function persist(entry,confirmed){
    const source=sameSchema(current?.schema,entry.schema)?current:saved();
    const template=entry.template||templateFor(entry.schema,source);
    const reset_backup=entry.reset_backup??(sameSchema(source?.schema,entry.schema)?source?.reset_backup:undefined);
    const next=JSON.stringify({schema:entry.schema,value:entry.value,request_id:entry.request_id,confirmed,template,reset_backup,refresh_job:refreshJob,pending_backups:entry.pendingBackups?.length?entry.pendingBackups:undefined});
    if(stored.value===next)return;
    stored.value=next;node.graph?.change?.();node.setDirtyCanvas?.(true,true);
  }
  function showErrors(list){
    if(list.length&&current)current.validationActive=true;
    view.setErrors(list);
    errors=list.map(item=>typeof item==="string"?item:{path:view.errorPath(item.path),targetPath:view.errorPointer(item.path),message:item.message});
    if(errors.length)status=`发现 ${errors.length} 个问题，请按下方提示修改。`;render();
  }
  function render(){
    if(disposed)return;
    if(current){
      // Load the new schema before expanding added paths; setData resets old schema UI state.
      view.setData(current.schema,current.value);view.setPresentation(current.presentation);
      if(completeEntry(current)){view.setData(current.schema,current.value);schedulePresentation();}
    }
    const waiting=!!current?.request_id&&pending.has(current.request_id);
    const actions=[{label:"计算链以更新模版缓存",run:()=>refreshTemplate()}];
    if(current)actions.push({label:"复位到模板",run:resetTemplate},{label:"校验",run:()=>action("check")});
    if(waiting)actions.push({label:"取消执行",run:()=>action("cancel")},{label:"确认",run:()=>action("submit")});
    view.render({status,errors,actions,busy,requests:[...pending.values()],selected:current?.request_id,select});
  }
  function select(entry){
    entry.template??=templateFor(entry.schema,saved());
    const keepErrors=current===entry&&entry.validationActive;
    current=entry;if(!keepErrors){errors=[];view.errors.clear();view.setErrors([]);}
    status=entry.request_id?"等待填写并确认":saved().confirmed?"已确认 · 校验通过时自动复用":"草稿 · 首次运行需要确认";
    if(keepErrors)status="正在重新校验…";
    render();schedulePresentation();
  }
  function saveRefreshJob(){
    stored.value=JSON.stringify({...saved(),refresh_job:refreshJob});
    node.graph?.change?.();node.setDirtyCanvas?.(true,true);
  }
  async function refreshTemplate(recoverJob){
    if(busy||disposed)return;
    if(pending.size){status='请先确认或取消当前等待填写的执行，再计算模板输入链。';view.updateStatus(status);return;}
    busy=true;++revision;clearTimeout(presentationTimer);
    status='正在提交模板更新任务…';errors=[];render();
    const entry=current;
    try{
      refreshJob=recoverJob||refreshJob||await queueTemplateRefresh(node);saveRefreshJob();
      const schema=await waitTemplateRefresh(refreshJob,{
        isCurrent:()=>!disposed,
        onStatus:text=>{if(!disposed){status=text;view.updateStatus(status);}},
      });
      if(disposed)return;
      if(current!==entry||pending.size)throw new Error('计算期间表单收到另一执行的输入，未覆盖它；请结束该执行后再更新模板。');
      node.graph?.beforeChange?.();
      try{
        refreshJob=undefined;
        const hasValue=!!entry;
        current={schema:cloneJSON(schema),value:hasValue?cloneJSON(entry.value):initialValue(schema,schema)??null,
          template:templateFor(schema),autoInitial:!hasValue};
        view.branches.clear();view.selected.clear();view.scroll.clear();view.activeList=null;
        errors=[];view.errors.clear();view.setErrors([]);persist(current,false);
        status='模版缓存已更新 · 已保留可复用的填写值';render();schedulePresentation();
      }finally{node.graph?.afterChange?.();}
    }catch(error){
      if(!disposed){if(!error.refreshRecoverable)refreshJob=undefined;saveRefreshJob();status=`模版缓存更新失败：${error.message}`;errors=[status];}
    }finally{busy=false;if(!disposed)render();}
  }
  async function resetTemplate(){
    if(busy||!current)return;
    const entry=current,version=++revision;
    clearTimeout(presentationTimer);busy=true;view.setBusy(true);
    try{
      const template=cloneJSON(entry.template||templateFor(entry.schema,saved()));
      if(!template.resolved){
        const result=await post('inspect',{schema:template.schema,value:template.value});
        if(result.error)throw new Error(result.error);
        const presentation=result.presentation??template.schema;
        template.value=initialValue(presentation,presentation)??null;template.resolved=true;
      }
      if(disposed||current!==entry||version!==revision)return;
      const backup={schema:cloneJSON(entry.schema),value:cloneJSON(entry.value),confirmed:saved().confirmed===true};
      node.graph?.beforeChange?.();
      try{
        entry.reset_backup=backup;entry.template=template;entry.value=cloneJSON(template.value);entry.pendingBackups=[];entry.autoInitial=false;entry.presentation=undefined;
        if(!entry.validationActive){errors=[];view.setErrors([]);}view.errors.clear();view.branches.clear();view.selected.clear();view.scroll.clear();view.activeList=null;
        persist(entry,false);
      }finally{node.graph?.afterChange?.();}
      status='已复位到模板 · 需要重新确认';schedulePresentation();
    }catch(error){if(!disposed&&current===entry){status=`复位失败，原填写内容已保留：${error.message}`;errors=[status];}}
    finally{busy=false;render();}
  }
  function accept(entry){
    if(current?.request_id&&current.request_id!==entry.request_id)return;
    const draft=saved();
    if(draft.request_id&&draft.request_id!==entry.request_id&&pending.has(draft.request_id))return;
    persist(entry,true);
    if(current?.request_id===entry.request_id)current.value=cloneJSON(entry.value);
  }
  function finish(id){
    if(!pending.delete(id))return;
    if(current?.request_id===id){
      if(pending.size){select(pending.values().next().value);return;}
      // Ending the request does not change the field rules. Keep the resolved
      // presentation and draft metadata instead of reverting to the raw schema.
      current.request_id=undefined;
      status=saved().confirmed?"已确认 · 下次校验通过可复用":"本次执行已结束";
    }
    render();
  }
  async function action(mode){
    if(busy||!current)return;
    if(mode!=="cancel")current.validationActive=true;
    if(mode!=="cancel"&&view.errors.size){view.updateStatus([...view.errors.values()][0]);return;}
    const selected=current;
    busy=true;view.setBusy(true);
    try{
      let result;
      if(mode!=='cancel'){
        ++revision;clearTimeout(presentationTimer);
        // Revalidate the completed value, never show stale "missing key" errors
        // for the value that preceded conditional/ref resolution.
        for(let pass=0;pass<16;pass++){
          result=await inspectEntry(selected);
          if(disposed||current!==selected)return;
          if(result.error)throw new Error(result.error);
          applyInspection(selected,result);
          if(!completeEntry(selected))break;
          if(pass===15)throw new Error('必填字段规则连续变化，无法完成初始化，请检查条件或递归规则。');
        }
        if(result.errors?.length){showErrors(result.errors);return;}
      }
      const submitted={...selected,value:cloneJSON(selected.value)};
      if(mode!=='check')result=await post('submit',{request_id:selected.request_id,value:selected.value,cancel:mode==='cancel'});
      if(disposed)return;
      if(result.errors?.length){if(current===selected)showErrors(result.errors);return;}
      selected.validationActive=false;errors=[];view.setErrors([]);
      if(mode==="check")status="校验通过";
      else{
        if(mode==="submit")accept(submitted);
        finish(selected.request_id);
        if(!pending.size)status=mode==="cancel"?"已取消本次执行":"已确认并固着";
      }
    }catch(error){if(!disposed)showErrors([error.message]);}
    finally{busy=false;render();}
  }
  function receive(entry){
    if(pending.has(entry.request_id))return;
    const draft=saved(),same=JSON.stringify(draft.schema)===JSON.stringify(entry.schema);
    const value=same&&Object.hasOwn(draft,"value")?draft.value:entry.has_value?entry.value:initialValue(entry.schema,entry.schema);
    const record={...entry,value:cloneJSON(value)??null,pendingBackups:same?cloneJSON(draft.pending_backups||[]):[],template:templateFor(entry.schema,draft),reset_backup:same?draft.reset_backup:undefined,autoInitial:!(same&&Object.hasOwn(draft,"value"))&&!entry.has_value};pending.set(entry.request_id,record);
    if(!current?.request_id||!pending.has(current.request_id))select(record);
    else render();
  }
  const controller={node,receive,finish,accept,pending,
    reuse(entry){
      const draft=saved();
      // A queued execution must not overwrite a newer unconfirmed edit.
      if(busy||pending.size||!current||draft.confirmed!==true||JSON.stringify(current.value)!==JSON.stringify(entry.value))return;
      current.schema=cloneJSON(entry.schema);current.template=templateFor(entry.schema,current);current.presentation=undefined;
      persist(current,true);status='已确认 · 本次校验通过并复用';render();schedulePresentation();
    },
    restore(){
      normalizeSchemaSocket(node);hideInternalState(node);
      view.restoreExpansion();
      const draft=saved();
      if(pending.size){
        // Native undo restores the widget snapshot while execution is waiting.
        // Keep its request alive, but restore the draft used by Confirm as well.
        const entry=draft.request_id?pending.get(draft.request_id):current;
        if(entry&&pending.has(entry.request_id)&&sameSchema(draft.schema,entry.schema)&&Object.hasOwn(draft,'value')){
          Object.assign(entry,{value:cloneJSON(draft.value),pendingBackups:cloneJSON(draft.pending_backups||[]),template:templateFor(entry.schema,draft),reset_backup:draft.reset_backup,autoInitial:false});select(entry);
        }
        return;
      }
      if(draft.schema!==undefined&&Object.hasOwn(draft,"value"))select({schema:draft.schema,value:draft.value,pendingBackups:cloneJSON(draft.pending_backups||[]),template:templateFor(draft.schema,draft),reset_backup:draft.reset_backup});
      else render();
      if(draft.refresh_job&&!busy)void refreshTemplate(draft.refresh_job);
    },
    dispose(){disposed=true;clearTimeout(presentationTimer);revision++;view.dispose();controllers.delete(controller);},
  };
  controllers.add(controller);
  const configured=node.onConfigure;
  node.onConfigure=function(...args){
    const info=args[0],legacy=info?.inputs?.some(input=>input.name==="schema"&&input.widget);
    const result=configured?.apply(this,args);
    if(legacy&&Array.isArray(info.widgets_values))stored.value=typeof info.widgets_values[1]==="string"?info.widgets_values[1]:"{}";
    queueMicrotask(()=>controller.restore());return result;
  };
  const removed=node.onRemoved;
  node.onRemoved=function(...args){controller.dispose();return removed?.apply(this,args);};
  queueMicrotask(()=>controller.restore());
}
