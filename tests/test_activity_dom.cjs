const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) {
    this.nodeType = 1; this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = []; this.style = { setProperty(k,v) { this[k] = v; } };
    this.listeners = {}; this.dataset = {}; this.className = ''; this.textContent = ''; this.hidden = false;
    this.classList = { toggle: (name, enabled) => { this.classes ??= new Set(); enabled ? this.classes.add(name) : this.classes.delete(name); } };
    if (['INPUT','TEXTAREA','SELECT'].includes(this.tagName)) { this.value = ''; this.checked = false; }
  }
  setAttribute(name, value) { this.attributes = this.attributes.filter(a => a.name !== name); this.attributes.push({name,value}); }
  getAttribute(name) { return this.attributes.find(a=>a.name===name)?.value ?? (name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())] : null); }
  removeAttribute(name) { this.attributes = this.attributes.filter(a => a.name !== name); }
  append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentElement = this; } }
  prepend(child) { child.remove(); this.children.unshift(child); child.parentElement = this; }
  remove() { if (this.parentElement) { const list = this.parentElement.children; list.splice(list.indexOf(this),1); this.parentElement = null; } }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  replaceWith(child) { const parent = this.parentElement; if (parent) { const i = parent.children.indexOf(this); this.remove(); parent.children.splice(i,0,child); child.parentElement = parent; } }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name, event={}) { for (const fn of this.listeners[name] || []) fn({target:this,currentTarget:this,...event}); }
  attachShadow() { return this.shadowRoot = new Element('shadow'); }
  matches(selector) {
    if(selector==='*') return true;
    const match=selector.match(/^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/);
    return !!match && (!match[1] || this.localName===match[1]) && (!match[2] || (match[3]===undefined ? this.getAttribute(match[2])!=null : this.getAttribute(match[2])===match[3]));
  }
  querySelectorAll(selector='*') { return this.children.flatMap(child => [child,...child.querySelectorAll('*')]).filter(child=>child.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
  get childNodes() { return this.children; }
  cloneNode(deep) { const node = new Element(this.tagName); Object.assign(node.style,this.style); node.textContent=this.textContent;
    node.className=this.className; node.dataset={...this.dataset}; node.hidden=this.hidden;
    node.attributes=this.attributes.map(a=>({...a})); if (deep) node.append(...this.children.map(c=>c.cloneNode(true))); return node; }
  get scrollHeight() { return 24 + Math.ceil((this.value?.length || this.textContent.length)/30)*20 + this.children.reduce((n,c)=>n+c.scrollHeight,0); }
  getBoundingClientRect() { return {height:this.scrollHeight,top:0,bottom:this.scrollHeight}; }
  get isConnected() { return true; }
  get clientWidth() { return 700; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector)||null; }
  focus() { this.focused=true; }
  get outerHTML() { return JSON.stringify([this.tagName,this.className,this.textContent,this.attributes,this.dataset,this.children.map(child=>child.outerHTML)]); }
}
const observers = [];
class Observer { constructor(fn) { this.fn=fn; observers.push(this); } observe() {} disconnect() { this.closed=true; } }
const document = {createElement:tag=>new Element(tag), querySelectorAll:()=>[]};
const context = vm.createContext({document, MutationObserver:Observer, getComputedStyle:node=>({display:node.style.display||'block',getPropertyValue:k=>node.style[k]||''})});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../activity_view.js'),'utf8').replace(/^export /gm,''),context);
const DomMirror = vm.runInContext('DomMirror',context);
const source = new Element('div'); source.style.display='none'; source.textContent='Streaming reply';
const input = new Element('textarea'); input.value='A'.repeat(500); input.setAttribute('onchange','submitRequest()');
const status = new Element('div'); status.textContent='Waiting for review';
source.append(status,input);
let dirty=0;
const mirror = new DomMirror(source,new Element('div'),()=>dirty++);
const initial = mirror.sync(450);
assert(initial>300,'Content expands beyond the old fixed-height widget');
assert.equal(mirror.clone.style.display,'block','Canvas-culling does not hide the activity mirror');
assert.equal(mirror.clone.inert,true);
const copiedInput = mirror.pairs.find(pair=>pair[0]===input)[1];
assert.equal(copiedInput.value,input.value);
assert.equal(copiedInput.attributes.some(a=>a.name==='onchange'),false);
assert.equal(copiedInput.readOnly,true);
input.value+='B'.repeat(300);
mirror.sync(450);
assert.equal(copiedInput.value,input.value,'Property-only changes do not require a DOM mutation');
status.textContent='Generating'; observers[0].fn([]); assert.equal(dirty,1);
mirror.sync(450); assert.equal(mirror.clone.children[0].textContent,'Generating');
assert.equal(source.style.display,'none'); assert.equal(input.value.length,800);
mirror.destroy(); assert.equal(observers[0].closed,true);
const custom = new Element('test-stream');
custom.attachShadow(); const shadowText = new Element('span'); shadowText.textContent = 'Live shadow content';
custom.shadowRoot.append(shadowText);
const shadowMirror = new DomMirror(custom,new Element('div'),()=>{});
shadowMirror.sync(400);
assert.equal(shadowMirror.clone.tagName,'DIV','Do not instantiate a second custom element');
assert.equal(shadowMirror.clone.children[0].textContent,'Live shadow content');
shadowMirror.destroy();
const embed = new Element('iframe');
embed.cloneNode=()=>{throw Error('Embedded documents must not be cloned');};
const embedMirror = new DomMirror(embed,new Element('div'),()=>{}); embedMirror.sync(400);
assert.match(embedMirror.clone.textContent,/原节点/); embedMirror.destroy();

// Integration with the native sidebar: a run opens global activity once, independently of navigation.
const panel = new Element('div'), header = new Element('section'), nav = new Element('nav');
const outerTabs = new Element('div'), tablist = new Element('div');
outerTabs.setAttribute('role','tablist'); outerTabs.append(tablist); nav.append(outerTabs); header.append(nav); panel.append(header);
const selectedClass='native-selected hover:bg-native-selected active:scale-95 transition-all';
const inactiveClass='native-inactive hover:bg-native-hover focus:bg-native-hover active:scale-95 transition-all';
for (const name of ['parameters','nodes','settings']) {
  const button=new Element('button');button.dataset.testid=`panel-tab-${name}`;button.setAttribute('role','tab');
  button.setAttribute('aria-selected',String(name==='parameters'));button.className=name==='parameters'?selectedClass:inactiveClass;
  tablist.append(button);
}
const close=new Element('button');close.setAttribute('aria-pressed','true');close.className='native-icon-button';header.append(close);
const registry = new Map(); const selection={selectedItems:[{}]};
const panelActions=[];
const sidebar={isOpen:true,activeTab:'parameters',openCount:0,closeCount:0,
  $onAction(fn){panelActions.push(fn);},
  openPanel(name){panelActions.forEach(fn=>fn({name:'openPanel',args:[name]}));this.openCount++;this.isOpen=true;if(name)this.activeTab=name;},
  closePanel(){this.closeCount++;this.isOpen=false;}};
registry.set('canvas',selection);registry.set('rightSidePanel',sidebar);
const rootElement={__vue_app__:{config:{globalProperties:{$pinia:{_s:registry}}}}};
document.querySelector=selector=>selector==='[data-v-app]'?rootElement:panel;
document.body=new Element('body'); document.head=new Element('head'); document.hidden=false; document.addEventListener=()=>{};
const root={id:'root'}, node={id:3,title:'Stream node'};
const events=new Map(),frames=[],windowEvents=new Map();
let now=0;
let extension, navigation, resolveNavigation;
const timers=new Map();let timerId=0;function advanceActivity(){const list=[...timers].filter(([,t])=>t.ms===5000);for(const [id,t] of list){timers.delete(id);t.fn();}}
const liveCards=[];
class Card { constructor(node,canvas,click){this.node=node;this.click=click;this.element=new Element('article');this.dirty=true;liveCards.push(this);} render(){this.dirty=false;} destroy(){this.element.remove();} }
const app={rootGraph:root,canvas:{deselectAll(){selection.selectedItems=[];}},registerExtension(e){extension=e;},extensionManager:{toast:{add(){}}}};
const ctx=vm.createContext({app,api:{addEventListener:(name,fn)=>events.set(name,fn)},document,window:{addEventListener:(name,fn)=>windowEvents.set(name,fn)},
  URL, MutationObserver:Observer,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){frames.length=0;},setInterval:()=>1,clearInterval(){},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},performance:{now:()=>now+=150},console,
  ActivityNodeView:Card,findNodes:()=>[{root,node,path:'3'}],revealNode:match=>{navigation=match;return new Promise(resolve=>resolveNavigation=resolve);}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../activity_state.js'),'utf8').replace(/^export /gm,''),ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../activity_follow.js'),'utf8').replace(/^export /gm,''),ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../execution_resume.js'),'utf8').replace(/^export /gm,''),ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../activity.js'),'utf8').replace(/^import .*;\r?$/gm,'').replaceAll('import.meta.url','"http://local/extensions/activity.js"'),ctx);
extension.setup();
function flush(){const list=frames.splice(0);list.forEach(fn=>fn());}
flush();
const activityTab=panel.querySelector('[data-testid="panel-tab-activity"]');
assert.equal(activityTab.parentElement,tablist,'Activity belongs inside the actual native button group, not its outer wrapper');
assert.equal(activityTab.className,inactiveClass,'Native hover/focus/pressed classes are reused unchanged');
const chrome=panel.querySelector('[data-activity-chrome="true"]');
assert.equal(chrome.querySelector('[data-testid="activity-tab-activity"]').className,selectedClass);
assert.equal(chrome.querySelector('[data-testid="activity-tab-nodes"]').className,inactiveClass);
chrome.querySelector('button[aria-pressed]').fire('click');assert.equal(sidebar.closeCount,1);
activityTab.fire('keydown',{key:'ArrowRight',preventDefault(){}});
assert.equal(tablist.children[1].focused,true,'Arrow navigation shares the native tab group');
const initialOpen=sidebar.openCount;
events.get('execution_start')({detail:{prompt_id:'fast-run'}});flush();
assert.equal(sidebar.openCount,initialOpen,'No panel before five seconds');
events.get('execution_success')({detail:{prompt_id:'fast-run'}});advanceActivity();flush();
assert.equal(sidebar.openCount,initialOpen,'Finished short run never opens panel');
events.get('execution_start')({detail:{prompt_id:'cancel-fast'}});
events.get('execution_interrupted')({detail:{prompt_id:'cancel-fast'}});advanceActivity();flush();
assert.equal(sidebar.openCount,initialOpen,'Interrupted short run never opens panel');
events.get('execution_start')({detail:{prompt_id:'run'}});advanceActivity();flush();
assert.equal(sidebar.openCount,1);assert.equal(selection.selectedItems.length,0);
assert(panel.classes.has('liuxinyu-activity-selected'));
events.get('execution_start')({detail:{prompt_id:'run'}});advanceActivity();flush();assert.equal(sidebar.openCount,1);
events.get('progress_state')({detail:{prompt_id:'run',nodes:{3:{state:'running'}}}});flush();
assert.equal(liveCards.length,1);liveCards[0].click();assert.equal(navigation.node,node);
// Conditional switch stays between native chrome and the scroll container.
const followButton = panel.querySelector('[role="switch"]');
const controls = followButton.parentElement, scrolling = controls.parentElement.children.at(-1);
assert.equal(controls.parentElement.children[0].dataset.activityChrome, 'true');
assert.equal(controls.parentElement.children[1], controls);
assert.equal(controls.hidden, true);
let height = 100;
liveCards[0].element.getBoundingClientRect = () => ({ height, top: -scrolling.scrollTop, bottom: height - scrolling.scrollTop });
scrolling.scrollTop = 0; scrolling.clientHeight = 100; scrolling.clientTop = 0;
Object.defineProperty(scrolling, 'scrollHeight', { get: () => height + 24 });
scrolling.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
const tick = () => vm.runInContext('refresh()', ctx);
for (let i = 0; i < 16; i++) tick();
height = 300; tick(); assert.equal(controls.hidden, true);
height = 400; tick(); assert.equal(controls.hidden, false);
assert.equal(scrolling.scrollTop, 312);
followButton.fire('click');
assert.equal(followButton.getAttribute('aria-checked'), 'false');
height = 600; tick(); assert.equal(scrolling.scrollTop, 312, 'Disabled follow allows reading earlier content');
assert.equal(controls.hidden, false, 'Turning off does not hide the control');
followButton.fire('click'); tick(); assert.equal(scrolling.scrollTop, 512);
assert.equal(navigation.node, node, 'Following never invokes canvas navigation');
for (let i = 0; i < 16; i++) tick();
assert.equal(controls.hidden, true, 'Idle content hides the switch');
followButton.fire('click');
extension.afterConfigureGraph(); flush();
assert.equal(followButton.getAttribute('aria-checked'), 'false', 'Graph reset preserves preference');
events.get('execution_success')({detail:{prompt_id:'run'}});flush();
assert.equal(liveCards[0].element.parentElement,null,'Card disappears while navigation is still pending');
assert(!panel.classes.has('liuxinyu-activity-selected'),'Completion restores the original native tab independently of navigation');
assert.equal(sidebar.isOpen,false,'A sidebar collapsed before execution is collapsed again');
assert.equal(sidebar.activeTab,'parameters');
resolveNavigation(true);
windowEvents.get('pagehide')({persisted:true});
windowEvents.get('pageshow')({persisted:true});flush();
events.get('execution_start')({detail:{prompt_id:'next-run'}});advanceActivity();flush();
assert.equal(sidebar.openCount,2,'Activity resumes after browser back/forward cache restoration');
events.get('execution_success')({detail:{prompt_id:'next-run'}});flush();

// Open native tabs are restored, while an already-selected Activity stays selected.
sidebar.openPanel('settings');
events.get('execution_start')({detail:{prompt_id:'settings-run'}});advanceActivity();flush();
assert(panel.classes.has('liuxinyu-activity-selected'));
events.get('execution_success')({detail:{prompt_id:'settings-run'}});flush();
assert.equal(sidebar.isOpen,true);assert.equal(sidebar.activeTab,'settings');
assert(!panel.classes.has('liuxinyu-activity-selected'));
activityTab.fire('click');flush();
events.get('execution_start')({detail:{prompt_id:'activity-run'}});advanceActivity();flush();
events.get('execution_success')({detail:{prompt_id:'activity-run'}});flush();
assert.equal(sidebar.isOpen,true);assert(panel.classes.has('liuxinyu-activity-selected'));

// Overlapping starts must not snapshot the automatically opened Activity page.
vm.runInContext('switchTab("nodes")',ctx);sidebar.closePanel();
events.get('execution_start')({detail:{prompt_id:'overlap-a'}});advanceActivity();flush();
events.get('execution_start')({detail:{prompt_id:'overlap-b'}});advanceActivity();flush();
events.get('execution_success')({detail:{prompt_id:'overlap-a'}});flush();
assert.equal(sidebar.isOpen,true);
events.get('execution_interrupted')({detail:{prompt_id:'overlap-b'}});flush();
assert.equal(sidebar.isOpen,false);assert.equal(sidebar.activeTab,'nodes');

// Error delivery yields without closing or overriding the native error UI.
for (const nativeFirst of [true,false]) {
  sidebar.activeTab='settings';sidebar.closePanel();
  const id='error-'+nativeFirst;
  events.get('execution_start')({detail:{prompt_id:id}});advanceActivity();flush();
  if (nativeFirst) sidebar.openPanel('errors');
  const before={opens:sidebar.openCount,closes:sidebar.closeCount};
  events.get('execution_error')({detail:{prompt_id:id}});
  assert(!panel.classes.has('liuxinyu-activity-selected'),'Error immediately unmasks native panel');
  assert.equal(sidebar.openCount,before.opens);assert.equal(sidebar.closeCount,before.closes);
  if (!nativeFirst) sidebar.openPanel('errors');
  flush();events.get('execution_success')({detail:{prompt_id:id}});flush();
  assert.equal(sidebar.isOpen,true);assert.equal(sidebar.activeTab,'errors');
  assert(!panel.classes.has('liuxinyu-activity-selected'));
}

// Reopening the already-selected native errors tab must also remove the overlay.
activityTab.fire('click');flush();
assert(panel.classes.has('liuxinyu-activity-selected'));
events.get('execution_start')({detail:{prompt_id:'activity-error'}});advanceActivity();flush();
events.get('execution_error')({detail:{prompt_id:'activity-error'}});flush();
events.get('execution_success')({detail:{prompt_id:'activity-error'}});flush();
assert(!panel.classes.has('liuxinyu-activity-selected'),'Errors override even an original Activity selection');
activityTab.fire('click');flush();
sidebar.openPanel('errors');
assert(!panel.classes.has('liuxinyu-activity-selected'));

// Native error navigation before a success notification cancels restoration.
vm.runInContext('switchTab("settings")',ctx);
events.get('execution_start')({detail:{prompt_id:'view-errors'}});advanceActivity();flush();
sidebar.openPanel('errors');
events.get('execution_success')({detail:{prompt_id:'view-errors'}});flush();
assert.equal(sidebar.activeTab,'errors');assert.equal(sidebar.isOpen,true);

// A direct store selection is respected too, without requiring a native click.
vm.runInContext('switchTab("settings")',ctx);
events.get('execution_start')({detail:{prompt_id:'direct-errors'}});advanceActivity();flush();
sidebar.activeTab='errors';flush();tick();
events.get('execution_success')({detail:{prompt_id:'direct-errors'}});flush();
assert.equal(sidebar.activeTab,'errors');assert(!panel.classes.has('liuxinyu-activity-selected'));

// Finishing another workflow must not restore the previous workflow's sidebar.
vm.runInContext('switchTab("settings")',ctx);sidebar.closePanel();
events.get('execution_start')({detail:{prompt_id:'old-workflow'}});advanceActivity();flush();
app.rootGraph={id:'other-root'};extension.afterConfigureGraph();flush();
sidebar.openPanel('nodes');
events.get('execution_success')({detail:{prompt_id:'old-workflow'}});flush();
assert.equal(sidebar.isOpen,true);assert.equal(sidebar.activeTab,'nodes');
console.log('PASS: HTML content/property sync, hidden subgraphs, expanded text, no inline handlers, cleanup, automatic global activity, duplicate-start suppression and independent navigation');
