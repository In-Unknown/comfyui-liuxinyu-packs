import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodes } from "./node_find.js";

export async function queueTemplateRefresh(node){
  const root=app.rootGraph||app.graph;
  const matches=findNodes(root,String(node.id)).filter(match=>match.node===node);
  if(matches.length!==1)throw new Error('无法唯一确定表单的执行位置，请检查子图实例。');
  const target=matches[0].path,prompt=await app.graphToPrompt(root);
  const source=prompt.output[target];
  if(source?.class_type!=='LiuxinyuTemplateForm')throw new Error('表单已静音或被绕过，请先启用节点。');
  if(!Array.isArray(source.inputs.schema)||source.inputs.schema.length!==2)throw new Error('请先连接 JSON Schema 输入。');
  // Change only the execution snapshot. The user's graph and saved workflow
  // keep the real form node, its state and every existing connection.
  prompt.output[target]={class_type:'LiuxinyuTemplateSchemaCache',inputs:{schema:source.inputs.schema},_meta:source._meta};
  const response=await api.queuePrompt(0,prompt,{partialExecutionTargets:[target]});
  if(!response.prompt_id)throw new Error('模板更新任务未成功入队，请检查上游节点连接。');
  return {prompt_id:response.prompt_id,target,workflow_id:String(root.id||'')};
}

export function waitTemplateRefresh(job,{isCurrent=()=>true,onStatus=()=>{}}={}){
  let timer,checking=false,again=false,ended=false;
  const events=['execution_success','execution_error','execution_interrupted','execution_start','reconnected'];
  let check;
  const promise=new Promise((resolve,reject)=>{
    const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);for(const name of events)api.removeEventListener(name,changed);error?reject(error):resolve(value);};
    const changed=event=>{if(!event.detail?.prompt_id||event.detail.prompt_id===job.prompt_id)void check();};
    const get=async url=>{
      try{const response=await api.fetchApi(url,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);return await response.json();}
      catch(cause){const error=new Error(`暂时无法读取模板更新任务：${cause.message}；再次点击按钮将查询同一任务，不重复计算。`);error.refreshRecoverable=true;throw error;}
    };
    const history=async()=> (await get(`/history/${encodeURIComponent(job.prompt_id)}`))[job.prompt_id];
    check=async()=>{
      if(ended)return;
      if(!isCurrent()){finish(new Error('当前表单已关闭；更新任务信息已保留，重新打开时可恢复结果。'));return;}
      if(checking){again=true;return;}
      checking=true;clearTimeout(timer);
      try{
        let result=await history();
        if(!result){
          const queue=await get('/queue');
          const running=queue.queue_running.some(entry=>entry[1]===job.prompt_id),queued=queue.queue_pending.some(entry=>entry[1]===job.prompt_id);
          if(!running&&!queued){result=await history();if(!result)throw new Error('模板更新任务已取消、移出队列或因后端重启而丢失；原模板未替换。');}
          else onStatus(running?'正在计算 Schema 输入链…':'模板更新任务已排队…');
        }
        if(result){
          if(!isCurrent())throw new Error('当前表单已关闭；重新打开时可恢复模板更新结果。');
          const failure=result.status?.messages?.find(([name])=>name==='execution_error');
          if(result.status?.status_str!=='success')throw new Error(failure?`上游节点 ${failure[1].node_id}：${failure[1].exception_message}`:'模板更新任务被中断，原模板未替换。');
          const schemas=result.outputs?.[job.target]?.lxy_template_schema;
          if(!Array.isArray(schemas)||schemas.length!==1)throw new Error('Schema 输入链未返回唯一模板；请将多个结果整理为一个 Schema 后重试。');
          finish(null,schemas[0]);return;
        }
      }catch(error){finish(error);return;}
      finally{checking=false;}
      if(again){again=false;void check();}else if(!ended)timer=setTimeout(check,10000);
    };
    for(const name of events)api.addEventListener(name,changed);
    void check();
  });
  return promise;
}
