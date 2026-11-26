import { api } from "../../scripts/api.js";

export function imageSource(schema) {
  const source=schema?.['x-image']?.source||'path';
  if(!['path','url','base64','data-url','copy'].includes(source))throw Error('x-image.source 必须为 path、url、base64、data-url 或 copy');
  return source;
}
export function imageValueSource(schema,value) {
  if(/^data:image\//i.test(value))return 'data-url';
  if(/^https?:\/\//i.test(value))return 'url';
  if(value&&value.length>128&&/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)&&!value.includes('.'))return 'base64';
  return imageSource(schema)==='base64'&&value&&!/[.\\]/.test(value)?'base64':'path';
}
export function imageInputMode(mode,origin,hasPath=false) {
  return mode==='base64'?'data-url':mode==='copy'?'copy':mode==='link'?'path':origin==='paste'?'data-url':'path';
}
export async function systemFormImage(action,mode,path){
  const response=await api.fetchApi('/liuxinyu/template_form/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,mode,path})});
  const result=await response.json();if(!response.ok)throw Error(result.error||`图片操作失败：HTTP ${response.status}`);
  return result.value;
}
export function clipboardImageReference(data) {
  const value=(data?.getData?.('text/uri-list')||data?.getData?.('text/plain')||'').trim().split(/\r?\n/).find(line=>line&&!line.startsWith('#'))||'';
  return /^(https?:\/\/|file:\/\/|[A-Za-z]:[\\/])/.test(value)||/^[^\r\n]+\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(value)?value:'';
}
export function imagePreviewURL(schema,value) {
  if(!value)return '';
  const source=imageValueSource(schema,value);
  if(source==='base64')return `data:${schema.contentMediaType||'image/png'};base64,${value}`;
  if(source==='data-url'){
    if(!/^data:image\/[\w.+-]+;base64,/i.test(value))throw Error('需要带 image 媒体类型的 Base64 Data URL');
    return value;
  }
  if(source==='url'){
    const url=new URL(value,window.location.href);
    if(!['http:','https:'].includes(url.protocol))throw Error('图片 URL 只支持 HTTP(S)');
    return url.href;
  }
  const path=String(value).replace(/\\/g,'/');
  if(path.startsWith('file:'))throw Error('请通过文件选择器选择本机图片');
  if(/^[A-Za-z]:\//.test(path))return api.apiURL(`/liuxinyu/template_form/image?path=${encodeURIComponent(value)}`);
  if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)&&! /^[A-Za-z]:\//.test(path))throw Error('图片链接只支持 HTTP(S) 或图片 Data URL');
  if(path.startsWith('/')||/^[A-Za-z]:/.test(path)||path.split('/').includes('..'))throw Error('图片路径应为本机绝对路径或 ComfyUI/input 内相对路径');
  const index=path.lastIndexOf('/');
  return api.apiURL(`/view?${new URLSearchParams({filename:path.slice(index+1),subfolder:index<0?'':path.slice(0,index),type:'input'})}`);
}
export function imageThumbnailURL(schema, value) {
  return imagePreviewURL(schema, value);
}
export async function imageReferenceFile(schema,value) {
  const response=await fetch(imagePreviewURL(schema,value));
  if(!response.ok)throw Error(`读取图片失败：HTTP ${response.status}`);
  return response.blob();
}
export async function imageFileValue(schema,file) {
  const source=imageSource(schema);
  if(!file?.type?.startsWith('image/'))throw Error('请选择或粘贴图片文件');
  // Decode before saving, so a renamed non-image file cannot become the value.
  const bitmap=await createImageBitmap(file);bitmap.close();
  if(source==='path')throw Error('保存原始路径请使用系统文件选择器');
  if(source==='base64'||source==='data-url'){
    if(source==='base64'&&(!schema.contentMediaType||schema.contentMediaType!==file.type))throw Error('纯 Base64 字段须用 contentMediaType 声明与所选图片一致的类型；多种格式请使用 data-url');
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(file);});
    return source==='base64'?data.slice(data.indexOf(',')+1):data;
  }
  const body=new FormData();body.append('image',file,file.name||'pasted-image.png');body.append('type','input');body.append('subfolder','template_form');
  const response=await api.fetchApi('/upload/image',{method:'POST',body});
  if(!response.ok)throw Error(`图片上传失败：HTTP ${response.status}`);
  const result=await response.json();
  if(typeof result.name!=='string'||!result.name)throw Error('图片上传响应缺少文件名');
  const path=[result.subfolder,result.name].filter(Boolean).join('/');
  return source==='copy'?path:new URL(imagePreviewURL({'x-image':{source:'path'}},path),window.location.href).href;
}
