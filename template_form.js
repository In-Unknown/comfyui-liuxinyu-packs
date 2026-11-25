import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodes, revealNode } from "./node_find.js";
import { mount } from "./template_form_controller.js";


const controllers = new Set();
const announced = new Set();
let activating = false;
const rootGraph = () => app.rootGraph || app.graph;
const workflowId = () => String(rootGraph()?.id || "");

function toast(detail, severity = "info") {
  app.extensionManager?.toast?.add({ severity, summary: "JSON Schema填写模版", detail, life: 7000 });
}

async function postNotice(path, data) {
  const response=await api.fetchApi(`/liuxinyu/template_form/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function presence(entry) {
  if(!api.clientId)return;
  void postNotice('presence',{client_id:api.clientId,workflow_id:workflowId(),request_id:entry?.request_id,
    foreground:document.visibilityState==='visible'&&document.hasFocus()}).catch(error=>console.warn('[liuxinyu.TemplateForm] 页面状态报告失败',error));
}

async function locateEntry(entry) {
  if(String(entry.workflow_id)!==workflowId())return false;
  const match=findNodes(rootGraph(),String(entry.node_id)).find(item=>item.path===String(entry.node_id));
  if(!match)return false;
  await revealNode(match);return true;
}

async function activateExisting({entry,activation_id}) {
  let existing=false,focused=false;
  try {
    existing=await locateEntry(entry);
    if(existing){
      const previous=document.title,marker=`ComfyUI 表单 ${activation_id}`;
      document.title=marker;window.focus();
      setTimeout(()=>{if(document.title===marker)document.title=previous;},5000);
      focused=document.visibilityState==='visible'&&document.hasFocus();
    }
  } catch(error){toast(`通知定位失败：${error.message}`,'warn');}
  await postNotice('activated',{activation_id,client_id:api.clientId,existing,focused});
}

async function openNotificationTarget() {
  const token=/^#lxy-form=([a-f0-9]{32})$/.exec(window.location?.hash||'')?.[1];
  if(!token||activating)return;
  activating=true;
  try {
    const response=await api.fetchApi(`/liuxinyu/template_form/notification/${token}`,{cache:'no-store'}),data=await response.json();
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    if(String(data.entry.workflow_id)!==workflowId())await app.loadGraphData(data.workflow);
    if(!await locateEntry(data.entry))throw new Error('工作流中没有找到对应节点');
    await recover();
  } catch(error){toast(`通知无法定位：${error.message}`,'warn');}
  finally {
    window.history?.replaceState(null,'',window.location.pathname+window.location.search);
    activating=false;
  }
}

function notify(entry, reused = false) {
  presence(entry);
  if (announced.has(entry.request_id)) return;
  announced.add(entry.request_id);
  if (announced.size > 512) announced.delete(announced.values().next().value);
  const foreground = document.visibilityState === "visible" && document.hasFocus();
  const message = reused ? `节点 ${entry.node_id} 已复用确认值，当前校验通过，继续执行。`
    : `节点 ${entry.node_id} 正在等待你填写表单并确认。`;
  toast(message);
  const locate = () => {
    if (String(entry.workflow_id) !== workflowId()) return;
    const match = findNodes(rootGraph(), String(entry.node_id)).find(item => item.path === String(entry.node_id));
    if (match) void revealNode(match).catch(error => toast(`自动定位失败：${error.message}。可用 Ctrl+F 查找 ${entry.node_id}。`, "warn"));
  };
  if (foreground) { if (!reused) locate(); return; }
}

function receive(entry) {
  notify(entry);
  if (String(entry.workflow_id) !== workflowId()) return;
  const match = findNodes(rootGraph(), String(entry.node_id)).find(item => item.path === String(entry.node_id));
  if (!match) return;
  for (const controller of controllers) if (controller.node === match.node) controller.receive(entry);
}

async function recover() {
  presence();
  const id = workflowId();
  if (!id) return;
  try {
    const response = await api.fetchApi(`/liuxinyu/template_form/pending?workflow_id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (id !== workflowId()) return;
    const live = new Set(data.requests.map(entry => entry.request_id));
    for (const controller of controllers) for (const key of controller.pending.keys()) if (!live.has(key)) controller.finish(key);
    for (const entry of data.requests) receive(entry);
  } catch (error) { console.warn("[liuxinyu.TemplateForm] 无法恢复待填写表单：", error); }
}

app.registerExtension({
  name: "liuxinyu.TemplateForm",
  setup() {
    api.addEventListener('liuxinyu.template_form_activate',({detail})=>{void activateExisting(detail).catch(error=>console.warn('[liuxinyu.TemplateForm]',error));});
    api.addEventListener('liuxinyu.template_form_notification_error',({detail})=>toast(detail.message,'warn'));
    document.addEventListener('visibilitychange',()=>presence());
    window.addEventListener?.('focus',()=>presence());
    window.addEventListener?.('hashchange',()=>void openNotificationTarget());
    api.addEventListener('reconnected',()=>void openNotificationTarget());
    api.addEventListener("liuxinyu.template_form", ({ detail }) => receive(detail));
    api.addEventListener('liuxinyu.template_form_source',({detail})=>{
      if(String(detail.workflow_id)!==workflowId())return;
      const match=findNodes(rootGraph(),String(detail.node_id)).find(item=>item.path===String(detail.node_id));
      for(const controller of controllers)if(controller.node===match?.node)controller.source(detail);
    });
    api.addEventListener("liuxinyu.template_form_reused", ({ detail }) => {
      notify(detail,true);
      if(String(detail.workflow_id)!==workflowId()||detail.schema===undefined)return;
      const match=findNodes(rootGraph(),String(detail.node_id)).find(item=>item.path===String(detail.node_id));
      for(const controller of controllers)if(controller.node===match?.node)controller.reuse(detail);
    });
    api.addEventListener("liuxinyu.template_form_done", ({ detail }) => {
      for (const controller of controllers) {
        if (detail.confirmed && controller.pending.has(detail.request_id)) controller.accept(detail);
        controller.finish(detail.request_id);
      }
    });
    api.addEventListener("reconnected", recover);
    // Also covers websocket loss during a short wait/submit, without polling.
    for (const event of ["execution_success", "execution_error", "execution_interrupted"]) api.addEventListener(event, recover);
  },
  nodeCreated(node) { if (node.comfyClass === "LiuxinyuTemplateForm") mount(node, controllers); },
  afterConfigureGraph() { queueMicrotask(()=>{void recover();void openNotificationTarget();}); },
});
