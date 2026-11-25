// Photoshop-style geometry; sRGB / D50 Lab, with unprofiled CMYK explicitly labelled.
export function pickerLab(rgb){
  const c=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
  const xyz=[.4360747*c[0]+.3850649*c[1]+.1430804*c[2],.2225045*c[0]+.7168786*c[1]+.0606169*c[2],.0139322*c[0]+.0971045*c[1]+.7141733*c[2]];
  const f=xyz.map((v,i)=>{v/=[.96422,1,.82521][i];return v>216/24389?Math.cbrt(v):(24389/27*v+16)/116;});
  return [116*f[1]-16,500*(f[0]-f[1]),200*(f[1]-f[2])];
}
export function pickerFromLab([l,a,b]){
  const fy=(l+16)/116,f=[fy+a/500,fy,fy-b/200];
  const [x,y,z]=f.map((v,i)=>(v**3>216/24389?v**3:(116*v-16)/(24389/27))*[.96422,1,.82521][i]);
  return [3.1338561*x-1.6168667*y-.4906146*z,-.9787684*x+1.9161415*y+.033454*z,.0719453*x-.2289914*y+1.4052427*z].map(v=>Math.round(255*Math.max(0,Math.min(1,v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055))));
}
export function pickerCMYK(rgb){const c=rgb.map(v=>1-v/255),k=Math.min(...c);return [...c.map(v=>k===1?0:(v-k)/(1-k)*100),k*100];}
export function pickerFromCMYK(c){return c.slice(0,3).map(v=>Math.round(255*(1-v/100)*(1-c[3]/100)));}

const psPickerCSS=`
.lxy-form-popup.lxy-ps-picker{padding:0;border:0;border-radius:0;background:#535353;color:#ddd;box-shadow:0 5px 14px #0006;overflow-x:hidden;overflow-y:auto;max-height:calc(100vh - 16px);font:12px 'Microsoft YaHei',sans-serif}
.lxy-ps-picker .ps-title{height:29px;background:#fff;color:#000;display:flex;align-items:center;justify-content:space-between;padding-left:8px}
.lxy-ps-picker button.ps-close{width:30px;height:29px;padding:0;border:0;border-radius:0;background:#fff;color:#000;font-size:19px}
.lxy-ps-picker .ps-body{position:relative;width:535px;height:369px}
.lxy-ps-picker button.ps-action{position:absolute;width:105px;height:26px;padding:0;border:1px solid #aaa;border-radius:15px;background:transparent;color:#eee;font-size:12px}
.lxy-ps-picker button.ps-action:hover{background:#666}.lxy-ps-picker button.ps-action:focus-visible{outline:2px solid #eee;outline-offset:2px}
.lxy-ps-picker input.ps-value{position:absolute;width:35px;height:22px!important;background:#4b4b4b;border:1px solid #666;border-radius:0;padding:1px 4px;font-size:12px;color:#eee;appearance:textfield}
.lxy-ps-picker input::-webkit-inner-spin-button{appearance:none}.lxy-ps-picker input.ps-value:focus{border-color:#3285d7}
.lxy-ps-picker input.ps-radio,.lxy-ps-picker input.ps-check{position:absolute;width:13px;height:13px!important;padding:0;margin:0;accent-color:#ddd}
.lxy-ps-picker .ps-label{position:absolute;line-height:22px;white-space:nowrap}
.lxy-ps-picker canvas{position:absolute;touch-action:none;cursor:crosshair}
.lxy-ps-picker .ps-preview{position:absolute;width:60px;height:35px;border-left:1px solid #333;border-right:1px solid #333}
.lxy-ps-picker .ps-error{position:absolute;left:10px;bottom:2px;color:#ffd2c8;font-size:11px;max-width:400px}
.lxy-ps-picker .ps-book-list{position:absolute;left:12px;top:45px;width:286px;height:250px;overflow-x:hidden;overflow-y:auto;padding-right:8px}
.lxy-ps-picker button.ps-swatch{display:block;width:100%;height:42px;border:2px solid transparent;border-radius:0;padding:0;margin:0 0 1px;color:#eee;background:transparent}
.lxy-ps-picker button.ps-swatch.selected{border-color:#00c9ff}.lxy-ps-picker .ps-swatch-color{display:block;height:26px}.lxy-ps-picker .ps-swatch-name{display:block;height:12px;font-size:10px;line-height:12px}
.lxy-form-popup.lxy-ps-picker select{position:absolute;left:75px;top:10px;width:185px;min-width:0;max-width:185px;height:23px;background:#484848;color:#ddd;border:1px solid #666;padding:0 4px}
`;

export function photoshopPicker(owner,anchor,value,digits,commit,{popup,element,colorRGBA,colorHex,rgbHSV,hsvRGB,fetchBooks}){
  if(!document.getElementById('lxy-ps-picker-css'))element('style',document.head,{id:'lxy-ps-picker-css',text:psPickerCSS});
  let rgba;try{rgba=colorRGBA(value);}catch{rgba=[0,0,0,255];}
  const original=[...rgba];let hsv=rgbHSV(rgba),lab=pickerLab(rgba.slice(0,3)),cmyk=pickerCMYK(rgba.slice(0,3)),mode='H',webOnly=false;
  let swatches=[];try{const saved=JSON.parse(localStorage.getItem('liuxinyu.colorSwatches')||'[]');if(Array.isArray(saved))swatches=saved.filter(s=>typeof s.name==='string'&&/^#[\da-f]{6}$/i.test(s.hex));}catch{}
  const p=popup(owner,anchor,()=>panel==='books'?609:panel==='name'?543:535);p.root.classList.add('lxy-ps-picker');p.outside=()=>{};
  let panel='picker',sync=()=>{},error,closed=false;
  const oldClose=p.close;p.close=()=>{closed=true;oldClose();};
  const pos=(el,x,y,w)=>{el.style.left=x+'px';el.style.top=y+'px';if(w)el.style.width=w+'px';return el;};
  const label=(parent,text,x,y,w)=>pos(element('span',parent,{text,className:'ps-label'}),x,y,w);
  const action=(parent,text,x,y,fn)=>pos(element('button',parent,{text,className:'ps-action',onclick:fn}),x,y);
  function shell(title,height=369){
    p.root.replaceChildren();p.root.setAttribute('aria-label',title);
    const head=element('div',p.root,{className:'ps-title'});element('span',head,{text:title});
    head.onpointerdown=e=>{if(e.target?.tagName?.toLowerCase()==='button')return;const rect=p.root.getBoundingClientRect(),dx=e.clientX-rect.left,dy=e.clientY-rect.top;head.setPointerCapture(e.pointerId);head.onpointermove=event=>{if(head.hasPointerCapture(event.pointerId)){p.manualPosition={x:event.clientX-dx,y:event.clientY-dy};p.root.style.left=p.manualPosition.x+'px';p.root.style.top=p.manualPosition.y+'px';}};};head.onpointerup=e=>{if(head.hasPointerCapture(e.pointerId))head.releasePointerCapture(e.pointerId);};
    element('button',head,{text:'×',className:'ps-close',ariaLabel:'关闭',onclick:()=>panel==='picker'?p.close():showPicker()});
    const body=element('div',p.root,{className:'ps-body'});body.style.height=height+'px';body.style.width=(panel==='books'?609:panel==='name'?543:535)+'px';return body;
  }
  p.root.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel!=='picker'){e.preventDefault();e.stopImmediatePropagation();showPicker();}},true);
  function setRGB(rgb){rgba=[...rgb.map(v=>Math.max(0,Math.min(255,Math.round(v)))),rgba[3]];hsv=rgbHSV(rgba);lab=pickerLab(rgba.slice(0,3));cmyk=pickerCMYK(rgba.slice(0,3));}
  function quantize(){if(webOnly)setRGB(rgba.slice(0,3).map(v=>Math.round(v/51)*51));}
  function sample(x,y,t){
    if('HSB'.includes(mode)){const v=[...hsv];if(mode==='H'){v[0]=t;v[1]=x;v[2]=1-y;}if(mode==='S'){v[0]=x;v[1]=t;v[2]=1-y;}if(mode==='B'){v[0]=x;v[1]=1-y;v[2]=t;}return hsvRGB(...v);}
    if('RGB'.includes(mode)){const v=[...rgba];const i='RGB'.indexOf(mode),others=[0,1,2].filter(j=>j!==i);v[i]=t*255;v[others[0]]=x*255;v[others[1]]=(1-y)*255;return v.slice(0,3);}
    const v=[...lab],i=['L','a','b'].indexOf(mode),others=[0,1,2].filter(j=>j!==i),scale=(j,v)=>j===0?v*100:v*255-128;v[i]=scale(i,t);v[others[0]]=scale(others[0],x);v[others[1]]=scale(others[1],1-y);return pickerFromLab(v);
  }
  function coords(){
    if(mode==='H')return [hsv[1],1-hsv[2],hsv[0]];if(mode==='S')return [hsv[0],1-hsv[2],hsv[1]];if(mode==='B')return [hsv[0],1-hsv[1],hsv[2]];
    const isRGB='RGB'.includes(mode),i=(isRGB?['R','G','B']:['L','a','b']).indexOf(mode),values=isRGB?rgba.slice(0,3).map(v=>v/255):[lab[0]/100,(lab[1]+128)/255,(lab[2]+128)/255],others=[0,1,2].filter(j=>j!==i);return [values[others[0]],1-values[others[1]],values[i]];
  }
  function showPicker(){
    panel='picker';const body=shell('拾色器',digits===8?398:369),fields={};
    const square=pos(element('canvas',body,{width:256,height:256,ariaLabel:'颜色区域',tabIndex:0}),10,30);
    const strip=pos(element('canvas',body,{width:19,height:256,ariaLabel:'颜色通道条',tabIndex:0}),278,30);
    const cursor=pos(element('div',body),10,30);cursor.style.cssText='position:absolute;width:10px;height:10px;border:1px solid white;border-radius:50%;box-shadow:0 0 1px 1px black;pointer-events:none;transform:translate(-50%,-50%)';
    const arrow=pos(element('div',body,{text:'▸    ◂'}),268,30);arrow.style.cssText='position:absolute;left:268px;width:39px;color:white;pointer-events:none;white-space:pre;line-height:10px;transform:translateY(-50%)';
    label(body,'新的',326,24);const fresh=pos(element('div',body,{className:'ps-preview'}),309,46);
    const old=pos(element('div',body,{className:'ps-preview',title:'恢复当前颜色',onclick:()=>{setRGB(original.slice(0,3));rgba[3]=original[3];sync();}}),309,81);old.style.background=colorHex(original,6);label(body,'当前',326,112);
    action(body,'确定',419,10,()=>{if(error.textContent)return;commit(colorHex(rgba,digits));p.close();});action(body,'取消',419,44,p.close);
    action(body,'添加到色板',419,85,showName);action(body,'颜色库',419,127,showBooks);
    const groups=[['H',0,360,316,168,'度'],['S',0,100,316,195,'%'],['B',0,100,316,222,'%'],['R',0,255,316,253,''],['G',0,255,316,280,''],['Blue',0,255,316,307,''],['L',0,100,429,168,''],['a',-128,127,429,195,''],['b',-128,127,429,222,''],['C',0,100,445,253,'%'],['M',0,100,445,280,'%'],['Y',0,100,445,307,'%'],['K',0,100,445,334,'%']];
    for(const [key,min,max,x,y,unit] of groups){
      const channel=key==='Blue'?'B':key,isCMYK='CMYK'.includes(key);
      if(!isCMYK){const radio=pos(element('input',body,{type:'radio',name:'lxy-color-channel',className:'ps-radio',ariaLabel:`选择${key}通道`,checked:(key==='B'?mode==='B':key==='Blue'?false:mode===key)}),x-6,y+6);radio.onchange=()=>{mode=key==='Blue'?'RGB-B':key; if(mode==='RGB-B')mode='Blue';sync();};fields[key+'Radio']=radio;}
      label(body,channel+':',x+12,y);const input=pos(element('input',body,{type:'text',inputMode:'decimal',className:'ps-value',ariaLabel:key==='Blue'?'蓝':key}),x+(isCMYK?24:40),y);label(body,unit,x+(isCMYK?64:80),y);
      fields[key]=input;if(isCMYK)input.title='无 ICC 的 CMYK 数学换算；色标簿保留原始通道值';
      input.oninput=()=>{if(!/^-?\d{0,3}(\.\d*)?$/.test(input.value)){input.value=input.acceptedValue??'';return;}if(input.value===''||input.value==='-'){error.textContent=`请填写 ${channel} 通道`;return;}const n=Number(input.value);if(n<min||n>max){input.value=input.acceptedValue??'';error.textContent=`${channel}：${min}–${max}`;return;}
        if(['H','S','B'].includes(key)){hsv[['H','S','B'].indexOf(key)]=n/(key==='H'?360:100);const keep=[...hsv];setRGB(hsvRGB(...hsv));hsv=keep;}
        else if(['R','G','Blue'].includes(key)){const rgb=rgba.slice(0,3);rgb[['R','G','Blue'].indexOf(key)]=n;setRGB(rgb);}
        else if(['L','a','b'].includes(key)){lab[['L','a','b'].indexOf(key)]=n;setRGB(pickerFromLab(lab));}
        else {cmyk['CMYK'.indexOf(key)]=n;const keep=[...cmyk];setRGB(pickerFromCMYK(cmyk));cmyk=keep;}quantize();sync(input);};
    }
    label(body,'#',312,338);const hex=pos(element('input',body,{className:'ps-value',ariaLabel:'HEX'}),327,338,80);
    hex.oninput=()=>{const text=hex.value.replace(/^#/,'');if(!/^[\da-f]*$/i.test(text)||text.length>digits){hex.value=colorHex(rgba,digits).slice(1);return;}if(text.length!==digits){error.textContent=`请输入 ${digits} 位十六进制颜色`;return;}rgba=colorRGBA('#'+text);setRGB(rgba.slice(0,3));quantize();sync(hex);};
    const web=pos(element('input',body,{type:'checkbox',className:'ps-check',checked:webOnly,ariaLabel:'只有 Web 颜色'}),10,300);label(body,'只有 Web 颜色',29,295);web.onchange=()=>{webOnly=web.checked;quantize();sync();};
    if(digits===8){label(body,'透明度',310,369);const alpha=pos(element('input',body,{className:'ps-value',ariaLabel:'透明度',type:'number',min:0,max:255,value:rgba[3]}),368,369,40);alpha.oninput=()=>{const n=Number(alpha.value);if(Number.isInteger(n)&&n>=0&&n<=255){rgba[3]=n;sync();}else error.textContent='透明度：0–255';};}
    error=element('div',body,{className:'ps-error'});error.style.maxWidth='285px';
    function paintCanvas(canvas,fn){const ctx=canvas.getContext('2d');if(!ctx.createImageData)return;const data=ctx.createImageData(canvas.width,canvas.height);for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){let rgb=fn(x/(canvas.width-1),y/(canvas.height-1));if(webOnly)rgb=rgb.map(v=>Math.round(v/51)*51);const i=(y*canvas.width+x)*4;data.data.set([...rgb,255],i);}ctx.putImageData(data,0,0);}
    let lastPaint='';
    sync=(editing)=>{error.textContent='';fresh.style.background=colorHex(rgba,6);hex.value=editing===hex?hex.value:colorHex(rgba,digits).slice(1).toLowerCase();
      const vals={H:hsv[0]*360,S:hsv[1]*100,B:hsv[2]*100,R:rgba[0],G:rgba[1],Blue:rgba[2],L:lab[0],a:lab[1],b:lab[2],C:cmyk[0],M:cmyk[1],Y:cmyk[2],K:cmyk[3]};
      for(const key of Object.keys(vals)){if(fields[key]!==editing)fields[key].value=String(Math.round(vals[key]));fields[key].acceptedValue=fields[key].value;if(fields[key+'Radio'])fields[key+'Radio'].checked=mode===key;}
      const actualMode=mode; if(mode==='Blue')mode='B_rgb';
      // RGB blue is disambiguated from HSB brightness for the shared renderer.
      const getCoords=()=>actualMode==='Blue'?[rgba[0]/255,1-rgba[1]/255,rgba[2]/255]:coords();
      const getSample=(x,y,t)=>actualMode==='Blue'?[x*255,(1-y)*255,t*255]:sample(x,y,t);
      const [x,y,t]=getCoords(),paintKey=JSON.stringify([actualMode,t,webOnly]);
      if(lastPaint!==paintKey){paintCanvas(square,(x,y)=>getSample(x,y,t));lastPaint=paintKey;}
      paintCanvas(strip,(_,v)=>actualMode==='H'?hsvRGB(1-v,1,1):getSample(x,y,1-v));mode=actualMode;
      cursor.style.left=(10+x*256)+'px';cursor.style.top=(30+y*256)+'px';arrow.style.top=(30+(1-t)*256)+'px';
    };
    const move=(canvas,event)=>{const rect=canvas.getBoundingClientRect(),x=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y=Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));let xy=mode==='Blue'?[rgba[0]/255,1-rgba[1]/255,rgba[2]/255]:coords();if(canvas===square){xy[0]=x;xy[1]=y;}else xy[2]=1-y;const rgb=mode==='Blue'?[xy[0]*255,(1-xy[1])*255,xy[2]*255]:sample(...xy);const keep=mode==='H'?xy[2]:hsv[0];setRGB(rgb);if(mode==='H')hsv[0]=keep;quantize();sync();};
    for(const canvas of [square,strip]){canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);move(canvas,e);};canvas.onpointermove=e=>{if(canvas.hasPointerCapture(e.pointerId))move(canvas,e);};canvas.onpointerup=e=>{if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);};canvas.onkeydown=e=>{if(!e.key.startsWith('Arrow'))return;e.preventDefault();const r=canvas.getBoundingClientRect(),v=mode==='Blue'?[rgba[0]/255,1-rgba[1]/255,rgba[2]/255]:coords();if(canvas===square){v[0]+=e.key==='ArrowRight'?1/255:e.key==='ArrowLeft'?-1/255:0;v[1]+=e.key==='ArrowDown'?1/255:e.key==='ArrowUp'?-1/255:0;}else v[2]+=e.key==='ArrowUp'?1/255:-1/255;move(canvas,{clientX:r.left+v[0]*r.width,clientY:r.top+(canvas===square?v[1]:1-v[2])*r.height});};}
    sync();
  }
  function showName(){
    panel='name';const body=shell('色板名称',88);const preview=pos(element('div',body),15,14);preview.style.width='50px';preview.style.height='50px';preview.style.background=colorHex(rgba,6);label(body,'名称:',75,12);
    const name=pos(element('input',body,{className:'ps-value',value:`色板 ${swatches.length+1}`,ariaLabel:'色板名称'}),114,14,319);
    const save=pos(element('input',body,{type:'checkbox',className:'ps-check',checked:true}),74,49);label(body,'添加到我的当前库',93,43);
    const message=element('div',body,{className:'ps-error'});
    action(body,'确定',444,14,()=>{if(!name.value.trim()){message.textContent='请填写色板名称';return;}const entry={name:name.value.trim(),hex:colorHex(rgba,6)};swatches.push(entry);if(save.checked){try{localStorage.setItem('liuxinyu.colorSwatches',JSON.stringify(swatches));}catch{swatches.pop();message.textContent='色板保存失败，请检查浏览器存储权限';return;}}showPicker();}).style.width='84px';action(body,'取消',444,49,showPicker).style.width='84px';name.focus();name.select();
  }
  async function showBooks(){
    panel='books';const body=shell('颜色库',301);label(body,'色库:',38,9);const select=element('select',body,{ariaLabel:'色库'});element('option',select,{text:'我的色板',value:'local'});element('option',select,{text:'Web 安全颜色',value:'web'});
    const list=element('div',body,{className:'ps-book-list'}),details=label(body,'',350,135),newPreview=pos(element('div',body,{className:'ps-preview'}),350,46),oldPreview=pos(element('div',body,{className:'ps-preview'}),350,81);oldPreview.style.background=colorHex(rgba,6);details.style.whiteSpace='pre-line';
    const spectrum=pos(element('canvas',body,{width:19,height:250,ariaLabel:'色库颜色导航'}),309,45);
    let selected=null,version=0;const message=element('div',body,{className:'ps-error'});
    const bookRGB=c=>c.hex?colorRGBA(c.hex).slice(0,3):c.space==='lab'?pickerFromLab(c.values):c.space==='cmyk'?pickerFromCMYK(c.values):c.values;
    const choose=c=>{selected=c;newPreview.style.background=colorHex(bookRGB(c),6);details.textContent=c.space==='cmyk'?c.values.map((v,i)=>'CMYK'[i]+':     '+Math.round(v)).join('\n'):c.name;for(const b of list.querySelectorAll('button')){b.classList.remove('selected');if(b.title===c.name)b.classList.add('selected');}};
    async function load(){const current=++version;selected=null;list.replaceChildren();message.textContent='';let colors=[];
      if(select.value==='local')colors=swatches;
      else if(select.value==='web'){for(let r=0;r<=255;r+=51)for(let g=0;g<=255;g+=51)for(let b=0;b<=255;b+=51){const hex=colorHex([r,g,b],6);colors.push({name:hex,hex});}}
      else try{const result=await fetchBooks(select.value);if(closed||panel!=='books'||current!==version)return;colors=result.colors||[];}catch(e){message.textContent=e.message;return;}
      for(const c of colors){const button=element('button',list,{className:'ps-swatch',title:c.name,onclick:()=>choose(c)});const sample=element('span',button,{className:'ps-swatch-color'});sample.style.background=colorHex(bookRGB(c),6);element('span',button,{className:'ps-swatch-name',text:c.name});}
      const ctx=spectrum.getContext('2d');colors.forEach((c,i)=>{ctx.fillStyle=colorHex(bookRGB(c),6);ctx.fillRect(0,i*250/colors.length,19,Math.ceil(250/colors.length));});
      spectrum.onpointerdown=e=>{if(!colors.length)return;const r=spectrum.getBoundingClientRect(),index=Math.max(0,Math.min(colors.length-1,Math.floor((e.clientY-r.top)/r.height*colors.length)));choose(colors[index]);list.querySelectorAll('button')[index]?.scrollIntoView?.({block:'center'});};
      if(colors.length){const nearest=colors.reduce((best,c)=>{const distance=bookRGB(c).reduce((sum,v,i)=>sum+(v-rgba[i])**2,0);return distance<best.distance?{c,distance}:best;},{c:colors[0],distance:Infinity}).c;choose(nearest);list.querySelector('.selected')?.scrollIntoView?.({block:'center'});}else message.textContent='当前色库为空，可在拾色器中添加色板。';
    }
    select.onchange=load;select.value='local';
    action(body,'确定',509,10,()=>{if(selected){setRGB(bookRGB(selected));quantize();showPicker();}}).style.width='90px';action(body,'取消',509,44,showPicker).style.width='90px';action(body,'拾色器(P)',509,145,showPicker).style.width='90px';
    const search=pos(element('input',body,{className:'ps-value',ariaLabel:'查找颜色名称',placeholder:'键入颜色名称'}),350,235,168);search.oninput=()=>{const match=[...list.querySelectorAll('button')].find(b=>b.title.toLowerCase().includes(search.value.toLowerCase()));match?.scrollIntoView?.({block:'nearest'});};
    await load();try{const result=await fetchBooks();if(closed||panel!=='books')return;for(const book of result.books||[])element('option',select,{text:book.name.replace(' Process',' 印刷色'),value:book.id});const hks=(result.books||[]).find(b=>b.name==='HKS Z Process');if(hks&&select.value==='local'&&!swatches.length){select.value=hks.id;await load();}}catch(e){message.textContent='本机色库读取失败：'+e.message;}
  }
  showPicker();return p;
}
