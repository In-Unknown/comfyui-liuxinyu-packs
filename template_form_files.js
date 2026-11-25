import { api } from "../../scripts/api.js";

export const fileBase64Threshold=512*1024;
export async function systemFormFile(action,mode,path){
  const response=await api.fetchApi('/liuxinyu/template_form/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,mode:mode??null,path})});
  const result=await response.json();if(!response.ok)throw Error(result.error||`文件操作失败：HTTP ${response.status}`);
  return result.file;
}
export function fileStorageMode(mode,size){return mode==='base64'?'base64':mode==='link'?'link':size<fileBase64Threshold?'base64':'link';}
export function fileReferenceURL(value){
  if(/^https?:\/\//i.test(value))return value;
  if(/^[A-Za-z]:|^[/\\]|^\w+:/.test(value)||value.replace(/\\/g,'/').split('/').includes('..'))throw Error('请通过选择文件上传本机文件，路径须相对于 ComfyUI/input');
  return api.apiURL(`/liuxinyu/template_form/file?path=${encodeURIComponent(value)}`);
}
export async function readFormFile(value,info){
  if(info?.value===value&&info.encoding==='base64'){
    const bytes=Uint8Array.from(atob(value),char=>char.charCodeAt(0));
    return new File([bytes],info.name||'file.bin',{type:info.type||'application/octet-stream'});
  }
  const response=await fetch(fileReferenceURL(value));
  if(!response.ok)throw Error(`读取文件失败：HTTP ${response.status}`);
  return new File([await response.blob()],info?.name||value.split(/[\\/]/).pop()?.split('?')[0]||'file.bin');
}
export async function storeFormFile(file,mode){
  const encoding=fileStorageMode(mode,file.size);
  let value;
  if(encoding==='base64'){
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取文件失败'));reader.readAsDataURL(file);});
    value=data.slice(data.indexOf(',')+1);
  }else{
    const body=new FormData();body.append('image',file,file.name||'file.bin');body.append('type','input');body.append('subfolder','template_form_files');
    const response=await api.fetchApi('/upload/image',{method:'POST',body});
    if(!response.ok)throw Error(`文件上传失败：HTTP ${response.status}`);
    const result=await response.json();if(!result.name)throw Error('文件上传响应缺少文件名');
    value=[result.subfolder,result.name].filter(Boolean).join('/');
  }
  return {value,encoding,name:file.name||'file.bin',display:encoding==='link'?value:file.webkitRelativePath||file.path||file.name||'file.bin',size:file.size,type:file.type};
}
