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
  if(input){delete input.widget;delete input._widget;input.type="STRING";input.label="JSON Schema输入键";}
  if(node.addInput&&!node.inputs?.some(input=>input.name==='values_json'))node.addInput('values_json','STRING',{label:'填入值JSON Schema输入值'});
  if(node.addInput&&!node.inputs?.some(input=>input.name==='sync_file'))node.addInput('sync_file','STRING',{label:'更新同步的文件路径'});
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
  let current,busy=false,disposed=false,status="连接 JSON Schema，运行后填写",errors=[],errorLayoutKey='[]',presentationTimer,revision=0;
  const pending=new Map();let refreshJob;
  let syncChain=Promise.resolve(),sourceSignature,sourceRevision=0;
  const sourceConnected=()=>node.inputs?.some(i=>['values_json','sync_file'].includes(i.name)&&i.link!=null);
  const fileConnected=()=>node.inputs?.some(i=>i.name==='sync_file'&&i.link!=null);
  const connectedSource=()=>JSON.stringify((node.inputs||[]).filter(i=>['values_json','sync_file'].includes(i.name)&&i.link!=null).map(i=>[i.name,i.link]));
  const editableSource=()=>fileConnected()&&node.properties?.lxy_sync_input===true&&!!current?.sync_token;
  const saved=()=>{try{return JSON.parse(stored.value||"{}");}catch{return {};}};
  const sameSchema=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function templateFor(schema,previous){
    if(previous?.template&&sameSchema(previous.template.schema,schema)&&Object.hasOwn(previous.template,'value'))return cloneJSON(previous.template);
    let value;try{value=initialValue(schema,schema)??null;}catch{value=null;}
    return {schema:cloneJSON(schema),value,resolved:false};
  }
  const view=new NativeTemplateForm(node,value=>{
    if(!current)return;
    const inputTypes=Object.fromEntries(view.typeChoices),fieldRequired=Object.fromEntries(view.fieldRequired),fieldEnums=Object.fromEntries(view.fieldEnums);
    if(JSON.stringify(fieldEnums)!==JSON.stringify(current.field_enums||{})||JSON.stringify(fieldRequired)!==JSON.stringify(current.field_required||{})||view.structureRenamed||JSON.stringify(inputTypes)!==JSON.stringify(current.input_types||{})){current.presentation=undefined;view.setPresentation(undefined);view.structureRenamed=false;}
    current.value=cloneJSON(value);current.input_types=inputTypes;current.field_required=fieldRequired;current.field_enums=fieldEnums;current.autoInitial=false;if(!current.validationActive)errors=[];persist(current,false);schedulePresentation();
    status=current.validationActive?"正在重新校验…":pending.size?"待确认":"草稿 · 下次运行需要确认";view.updateStatus(status);
    if(editableSource()){
      const payload=cloneJSON({sync_token:current.sync_token,value:current.value,input_types:inputTypes,field_required:fieldRequired,field_enums:fieldEnums});
      const sourceVersion=sourceRevision,signature=connectedSource();
      syncChain=syncChain.then(async()=>{
        if(disposed||sourceVersion!==sourceRevision||signature!==connectedSource()||payload.sync_token!==current?.sync_token)return;
        const result=await post('sync-values',payload);if(result.error)throw Error(result.error);
        if(!disposed&&sourceVersion===sourceRevision)view.updateStatus('已同步到输入文件');
      }).catch(error=>{
        if(disposed||sourceVersion!==sourceRevision)return;
        sourceRevision++;current.sync_token=undefined;node.properties.lxy_sync_input=false;
        status=`同步失败：${error.message}`;persist(current,false);render();
      });
    }
  });
  function schedulePresentation(){
    const version=++revision;clearTimeout(presentationTimer);
    presentationTimer=setTimeout(()=>refreshPresentation(version),150);
  }
  function completeEntry(entry){
    if(sourceConnected())return false;
    const schema=entry.presentation??entry.schema,next=completeRequired(schema,entry.value,schema,view.branches);
    if(!next.added.length&&!next.replaced.length)return false;
    entry.value=next.value;entry.autoInitial=false;
    entry.pendingBackups=[...(entry.pendingBackups||[]),...next.backups];
    for(const path of [...next.added,...next.replaced])view.expandPath(path);
    if(!entry.validationActive){errors=[];view.setErrors([]);}view.errors.clear();persist(entry,false);
    status=next.replaced.length?'已按新类型重建字段，请检查并确认':'已补齐必填字段，请检查并确认';return true;
  }
  function inspectEntry(entry){
    return post('inspect',{schema:entry.schema,value:entry.value,input_types:entry.input_types||{},field_required:entry.field_required||{},field_enums:entry.field_enums||{},...(entry.pendingBackups?.length?{backup_candidates:entry.pendingBackups}:{})});
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
    const next=JSON.stringify({sync_token:entry.sync_token,schema:entry.schema,value:entry.value,input_types:entry.input_types||{},field_required:entry.field_required||{},field_enums:entry.field_enums||{},request_id:entry.request_id,confirmed,template,reset_backup,refresh_job:refreshJob,pending_backups:entry.pendingBackups?.length?entry.pendingBackups:undefined});
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
      view.setData(current.schema,current.value,current.input_types||{},current.field_required||{},current.field_enums||{});view.setPresentation(current.presentation);
      if(completeEntry(current)){view.setData(current.schema,current.value,current.input_types||{},current.field_required||{},current.field_enums||{});schedulePresentation();}
    }
    const waiting=!!current?.request_id&&pending.has(current.request_id);
    const actions=[{label:"计算链以更新模版缓存",run:()=>refreshTemplate()}];
    if(current)actions.unshift({label:'保存当前配置值(只用于当前模版)',align:'left',run:saveValues});
    if(current){if(!sourceConnected())actions.push({label:"复位到模板",run:resetTemplate});actions.push({label:"校验",run:()=>action("check")});}
    if(waiting)actions.push({label:"取消执行",run:()=>action("cancel")},{label:"确认",run:()=>action("submit")});
    view.readOnly=sourceConnected()&&!editableSource();
    view.render({status,errors,actions,busy,requests:[...pending.values()],selected:current?.request_id,select});
    const nextErrorLayoutKey=JSON.stringify(errors);
    if(nextErrorLayoutKey!==errorLayoutKey){errorLayoutKey=nextErrorLayoutKey;view.fitContentHeight();}
  }
  async function saveValues(){
    if(busy||!current)return;
    if(view.popup?.outside&&view.popup.outside()===false)return;
    const payload={schema:current.schema,value:current.value,input_types:current.input_types||{},field_required:current.field_required||{},field_enums:current.field_enums||{}};
    busy=true;render();
    try{const result=await post('save-values',payload);if(result.error)throw Error(result.error);status=result.cancelled?'已取消保存':`配置值已保存：${result.path}`;}
    catch(error){status=`保存失败：${error.message}`;}
    finally{busy=false;if(!disposed)render();}
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
    const entry=current,sourceVersion=sourceRevision;
    try{
      await syncChain;
      refreshJob=recoverJob||refreshJob||await queueTemplateRefresh(node);saveRefreshJob();
      const refreshed=await waitTemplateRefresh(refreshJob,{
        isCurrent:()=>!disposed,
        onStatus:text=>{if(!disposed){status=text;view.updateStatus(status);}},
      });
      const imported=refreshed?.imported===true,schema=imported?refreshed.schema:refreshed;
      if(disposed)return;
      if(sourceVersion!==sourceRevision)throw new Error('输入来源已改变，已丢弃旧来源的读取结果，请重新读取。');
      if(current!==entry||pending.size)throw new Error('计算期间表单收到另一执行的输入，未覆盖它；请结束该执行后再更新模板。');
      node.graph?.beforeChange?.();
      try{
        refreshJob=undefined;
        const hasValue=!!entry;
        current={schema:cloneJSON(schema),value:hasValue?cloneJSON(entry.value):initialValue(schema,schema)??null,
          input_types:cloneJSON(entry?.input_types||{}),field_required:cloneJSON(entry?.field_required||{}),field_enums:cloneJSON(entry?.field_enums||{}),template:templateFor(schema),autoInitial:!hasValue};
        if(imported)Object.assign(current,{value:cloneJSON(refreshed.value),input_types:cloneJSON(refreshed.input_types||{}),field_required:cloneJSON(refreshed.field_required||{}),field_enums:cloneJSON(refreshed.field_enums||{}),sync_token:refreshed.sync_token,autoInitial:false,validationActive:true});
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
      const backup={schema:cloneJSON(entry.schema),value:cloneJSON(entry.value),input_types:cloneJSON(entry.input_types||{}),field_required:cloneJSON(entry.field_required||{}),field_enums:cloneJSON(entry.field_enums||{}),confirmed:saved().confirmed===true};
      node.graph?.beforeChange?.();
      try{
        entry.input_types={};entry.field_required={};entry.field_enums={};entry.reset_backup=backup;entry.template=template;entry.value=cloneJSON(template.value);entry.pendingBackups=[];entry.autoInitial=false;entry.presentation=undefined;
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
    entry.field_enums??=cloneJSON(current?.field_enums||saved().field_enums||{});entry.field_required??=cloneJSON(current?.field_required||saved().field_required||{});entry.input_types??=cloneJSON(current?.input_types||saved().input_types||{});persist(entry,true);
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
      if(mode!=='check')result=await post('submit',{request_id:selected.request_id,value:selected.value,input_types:selected.input_types||{},field_required:selected.field_required||{},field_enums:selected.field_enums||{},cancel:mode==='cancel'});
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
    const draft=entry.imported?entry:saved(),same=JSON.stringify(draft.schema)===JSON.stringify(entry.schema);
    const value=same&&Object.hasOwn(draft,"value")?draft.value:entry.has_value?entry.value:initialValue(entry.schema,entry.schema);
    const record={...entry,value:cloneJSON(value)??null,input_types:cloneJSON(same?draft.input_types||{}:{}),field_required:cloneJSON(same?draft.field_required||{}:{}),field_enums:cloneJSON(same?draft.field_enums||{}:{}),pendingBackups:same?cloneJSON(draft.pending_backups||[]):[],template:templateFor(entry.schema,draft),reset_backup:same?draft.reset_backup:undefined,autoInitial:!(same&&Object.hasOwn(draft,"value"))&&!entry.has_value};pending.set(entry.request_id,record);
    if(entry.imported)record.validationActive=true;
    if(!current?.request_id||!pending.has(current.request_id))select(record);
    else render();
  }
  const controller={node,receive,finish,accept,pending,
    source(entry){select({...entry,autoInitial:false,validationActive:true});persist(current,false);},
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
          Object.assign(entry,{value:cloneJSON(draft.value),input_types:cloneJSON(draft.input_types||{}),field_required:cloneJSON(draft.field_required||{}),field_enums:cloneJSON(draft.field_enums||{}),pendingBackups:cloneJSON(draft.pending_backups||[]),template:templateFor(entry.schema,draft),reset_backup:draft.reset_backup,autoInitial:false});select(entry);
        }
        return;
      }
      if(draft.schema!==undefined&&Object.hasOwn(draft,"value"))select({sync_token:draft.sync_token,schema:draft.schema,value:draft.value,input_types:cloneJSON(draft.input_types||{}),field_required:cloneJSON(draft.field_required||{}),field_enums:cloneJSON(draft.field_enums||{}),pendingBackups:cloneJSON(draft.pending_backups||[]),template:templateFor(draft.schema,draft),reset_backup:draft.reset_backup});
      else render();
      if(draft.refresh_job&&!busy)void refreshTemplate(draft.refresh_job);
    },
    dispose(){disposed=true;clearTimeout(presentationTimer);revision++;view.dispose();controllers.delete(controller);},
  };
  controllers.add(controller);
  async function prepareSync(){
    if(!fileConnected()||!node.properties?.lxy_sync_input||current?.sync_token||busy||disposed)return;
    await refreshTemplate();
    if(!disposed&&node.properties.lxy_sync_input&&!current?.sync_token){
      node.properties.lxy_sync_input=false;node.graph?.change?.();render();
    }
  }
  function updateSourcePorts(){
    const signature=connectedSource();
    if(sourceSignature!==undefined&&sourceSignature!==signature){
      sourceRevision++;
      if(current)current.sync_token=undefined;
      if(node.properties)node.properties.lxy_sync_input=false;
      status='输入来源已改变，请计算链以更新模版缓存';
    }
    sourceSignature=signature;
    for(const [name,other,label] of [['values_json','sync_file','填入值JSON Schema输入值'],['sync_file','values_json','更新同步的文件路径']]){
      const connected=node.inputs?.some(i=>i.name===other&&i.link!=null),index=node.inputs?.findIndex(i=>i.name===name)??-1;
      if(connected&&index>=0&&node.inputs[index].link==null)node.removeInput(index);
      else if(!connected&&index<0)node.addInput?.(name,'STRING',{label});
    }
    render();
    // Restoring a saved checkbox does not dispatch a click. Resume its input
    // initialization here as well as in toggleSync.
    void prepareSync();
  }
  const connections=node.onConnectionsChange;
  node.onConnectionsChange=function(...args){const result=connections?.apply(this,args);queueMicrotask(updateSourcePorts);return result;};
  const foreground=node.onDrawForeground;
  node.onDrawForeground=function(ctx,...args){
    foreground?.call(this,ctx,...args);view.syncToggleRect=null;
    const index=this.inputs?.findIndex(i=>i.name==='sync_file');if(index<0||this.flags?.collapsed)return;
    const slot=this.inputs[index],pos=this.getInputPos?.(index);if(!pos)return;
    const x=pos[0]-this.pos[0]+20+ctx.measureText(slot.label||slot.name).width,y=pos[1]-this.pos[1]-7;
    const label=this.properties?.lxy_sync_input&&!current?.sync_token&&busy?'正在读取同步文件…':'同步输入修改';
    ctx.save();ctx.font='12px "Microsoft YaHei", sans-serif';ctx.fillStyle='#aaa';ctx.fillText(label,x,y+11);
    const bx=x+ctx.measureText(label).width+6;ctx.strokeStyle='#aaa';ctx.strokeRect(bx,y,14,14);
    if(editableSource()){ctx.beginPath();ctx.moveTo(bx+3,y+7);ctx.lineTo(bx+6,y+10);ctx.lineTo(bx+12,y+3);ctx.stroke();}ctx.restore();
    view.syncToggleRect={x:bx,y:y-(view.widget.last_y??view.widget.y??0),w:14,h:14};
  };
  view.toggleSync=async()=>{
    if(!fileConnected())return;
    node.properties??={};node.properties.lxy_sync_input=!node.properties.lxy_sync_input;
    node.graph?.change?.();render();
    await prepareSync();
  };
  const configured=node.onConfigure;
  node.onConfigure=function(...args){
    const info=args[0],legacy=info?.inputs?.some(input=>input.name==="schema"&&input.widget);
    const result=configured?.apply(this,args);
    if(legacy&&Array.isArray(info.widgets_values))stored.value=typeof info.widgets_values[1]==="string"?info.widgets_values[1]:"{}";
    queueMicrotask(()=>{controller.restore();updateSourcePorts();});return result;
  };
  const removed=node.onRemoved;
  node.onRemoved=function(...args){controller.dispose();return removed?.apply(this,args);};
  queueMicrotask(()=>{controller.restore();updateSourcePorts();});
}
