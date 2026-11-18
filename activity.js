import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findNodes, revealNode } from "./node_find.js";
import { ActivityState } from "./activity_state.js";
import { ActivityNodeView } from "./activity_view.js";
import { ActivityFollow, followCardBottom } from "./activity_follow.js";
import { installExecutionResume } from "./execution_resume.js";

const state = new ActivityState();
const cards = new Map();
const follow = new ActivityFollow();
let active = false;
let panel, page, grid, empty, tab, observer, timer, content, followControls, followSwitch, followThumb;
let frame = null;
let installed = false;
let lastPaint = 0;
let missingPanelReported = false;
let chromeSignature = "";
const boundTabGroups = new WeakSet();
const boundPanelStores = new WeakSet();
let beforeRun = null;
let lastNativeTab;
// Capture websocket replay during module loading, before async extension setup.
const executionResume = installExecutionResume(api, () => app.rootGraph || app.graph,
  (id, root, snapshot) => {
    state.start(id, root);
    const job = state.jobs.get(id);
    if (job) { job.root = root; job.rootId = root.id; }
    if (snapshot) state.progress(snapshot, root);
    app.canvas?.setDirty?.(true, true);
  }, error => console.error("[liuxinyu.Activity]", error));

function tabAppearance(button, reference, selected) {
  button.className = reference.className;
  button.setAttribute("aria-selected", String(selected));
  button.setAttribute("data-state", selected ? "active" : "inactive");
  button.tabIndex = selected ? 0 : -1;
}

function tabKeys(event) {
  const buttons = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')].filter(button => !button.hidden);
  const index = buttons.indexOf(event.currentTarget);
  const directions = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : directions[event.key] ? (index + directions[event.key] + buttons.length) % buttons.length : -1;
  if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
}

function syncNativeChrome(reference) {
  const group = reference.parentElement;
  const nativeTabs = [...group.querySelectorAll('[role="tab"]')].filter(button => button !== tab);
  const inactive = nativeTabs.find(button => button.getAttribute("aria-selected") !== "true");
  const selected = nativeTabs.find(button => button.getAttribute("aria-selected") === "true");
  if (!inactive || !selected) return;
  tabAppearance(tab, inactive, false);
  // Snapshot the global header only. Selection/navigation may later show a node inspector underneath.
  if (!nativeTabs.some(button => button.dataset.testid === "panel-tab-nodes")) return;
  const nativeHeader = reference.closest("nav")?.parentElement;
  if (!nativeHeader) return;
  const header = nativeHeader.cloneNode(true);
  header.querySelector('[data-testid="panel-tab-activity"]')?.remove();
  const signature = header.outerHTML;
  if (signature === chromeSignature) return;
  chromeSignature = signature;
  const clonedTabs = [...header.querySelectorAll('[role="tab"]')];
  const clonedGroup = clonedTabs[0]?.parentElement;
  if (!clonedGroup) return;
  for (const button of clonedTabs) {
    const name = button.dataset.testid?.replace("panel-tab-", "");
    tabAppearance(button, inactive, false);
    button.addEventListener("click", () => switchTab(name));
    button.addEventListener("keydown", tabKeys);
  }
  const activity = tab.cloneNode(true);
  activity.hidden = false;
  tabAppearance(activity, selected, true);
  activity.addEventListener("click", () => switchTab("activity"));
  activity.addEventListener("keydown", tabKeys);
  clonedGroup.prepend(activity);
  // Keep the native icon, dimensions and button variants, including hover/pressed classes.
  const close = header.querySelector('button[aria-pressed]');
  close?.addEventListener("click", () => stores()?.get("rightSidePanel")?.closePanel?.());
  for (const element of header.querySelectorAll("[id]")) element.removeAttribute("id");
  for (const button of header.querySelectorAll('[role="tab"]')) {
    button.removeAttribute("aria-controls");
    button.dataset.testid = button.dataset.testid?.replace("panel-tab-", "activity-tab-");
  }
  header.dataset.activityChrome = "true";
  page.querySelector('[data-activity-chrome="true"]')?.remove();
  page.prepend(header);
}

// The native inspector has no extension tab slot. Keep the DOM/Pinia bridge here.
function stores() {
  const root = document.querySelector("[data-v-app]");
  const pinia = root?.__vue_app__?.config.globalProperties.$pinia
    || document.querySelector('[data-testid="properties-panel"]')?.__vueParentComponent?.appContext.config.globalProperties.$pinia;
  return pinia?._s;
}

function report(error) {
  console.error("[liuxinyu.Activity]", error);
  app.extensionManager?.toast?.add({ severity: "error", summary: "活动页",
    detail: error.message || String(error), life: 8000 });
}

function refreshSoon() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => { frame = null; refresh(); });
}

function clearSelection() {
  app.canvas?.deselectAll?.();
  const canvasStore = stores()?.get("canvas");
  if (canvasStore?.selectedItems?.length) canvasStore.selectedItems = [];
}

function switchTab(name) {
  active = name === "activity";
  if (active) {
    clearSelection();
  } else {
    clearSelection();
    stores()?.get("rightSidePanel")?.openPanel?.(name);
  }
  updateVisibility();
  refreshSoon();
}

function updateVisibility() {
  if (!panel) return;
  panel.classList.toggle("liuxinyu-activity-selected", active);
  if (page) page.hidden = !active;
  if (tab) {
    const selected = stores()?.get("canvas")?.selectedItems?.length || 0;
    tab.hidden = Boolean(selected);
    tab.setAttribute("aria-selected", String(active));
  }
}

function yieldToErrors() {
  beforeRun = null;
  active = false;
  updateVisibility();
}

function observePanel() {
  const rightPanel = stores()?.get("rightSidePanel");
  if (!rightPanel) return;
  if (!boundPanelStores.has(rightPanel)) {
    boundPanelStores.add(rightPanel);
    // Native "See Error" can open the same underlying tab again, so observing
    // the tab value alone cannot detect every request hidden by our overlay.
    rightPanel.$onAction?.(({ name, args }) => {
      if (name === "openPanel" && args[0] === "errors") yieldToErrors();
    }, true);
  }
  if (rightPanel.activeTab === "errors" && lastNativeTab !== undefined && lastNativeTab !== "errors") yieldToErrors();
  lastNativeTab = rightPanel.activeTab;
  return rightPanel;
}

function startActivity(id) {
  const rightPanel = observePanel();
  const root = app.rootGraph || app.graph;
  if (!beforeRun || beforeRun.root !== root || beforeRun.rootId !== root?.id) {
    beforeRun = {
      root, rootId: root?.id, jobs: new Set(),
      isOpen: rightPanel?.isOpen ?? app.ui?.settings?.getSettingValue?.("Comfy.RightSidePanel.IsOpen") ?? false,
      tab: rightPanel?.activeTab, activity: active,
    };
  }
  beforeRun.jobs.add(id);
  openActivity();
}

function finishActivity(id, failed) {
  if (failed) { yieldToErrors(); return; }
  observePanel();
  if (!beforeRun?.jobs.delete(id) || beforeRun.jobs.size) return;
  const previous = beforeRun;
  beforeRun = null;
  const root = app.rootGraph || app.graph;
  if (previous.root !== root || previous.rootId !== root?.id) return;
  const rightPanel = stores()?.get("rightSidePanel");
  active = previous.activity;
  // Restore the native selection even when the panel will be collapsed.
  if (rightPanel) {
    if (previous.tab) rightPanel.activeTab = previous.tab;
    lastNativeTab = rightPanel.activeTab;
    if (previous.isOpen) rightPanel.openPanel?.();
    else rightPanel.closePanel?.();
  } else {
    app.ui?.settings?.setSettingValue?.("Comfy.RightSidePanel.IsOpen", previous.isOpen);
  }
  updateVisibility();
}

function buildPage() {
  follow.reset();
  page = document.createElement("div");
  page.className = "liuxinyu-activity-page";
  page.dataset.testid = "liuxinyu-activity-page";
  content = document.createElement("div"); content.className = "liuxinyu-activity-content";
  followControls = document.createElement("div");
  followControls.className = "liuxinyu-activity-follow"; followControls.hidden = true;
  const label = document.createElement("span"); label.textContent = "连续跟踪";
  followSwitch = document.createElement("button"); followSwitch.type = "button";
  followSwitch.setAttribute("role", "switch"); followSwitch.setAttribute("aria-label", "连续跟踪");
  followSwitch.title = "持续滚动到最后一个连续改变高度的节点底部";
  // Same structure and theme classes as the native settings Switch, without importing hashed chunks.
  followSwitch.className = "group inline-flex h-6 w-10 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full border-0 bg-transparent p-0 transition-shadow outline-none focus-visible:ring-1 focus-visible:ring-border-default transition-transform active:scale-90";
  const track = document.createElement("span");
  track.className = "pointer-events-none inline-flex h-5 w-9 items-center rounded-full border border-transparent bg-interface-stroke px-0.5 transition-colors group-data-[state=checked]:bg-primary-background";
  followThumb = document.createElement("span");
  followThumb.className = "pointer-events-none block size-4 rounded-full bg-base-background shadow-sm transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0";
  track.append(followThumb); followSwitch.append(track); followControls.append(label, followSwitch);
  followSwitch.addEventListener("click", () => { follow.enabled = !follow.enabled; syncFollowSwitch(); refreshSoon(); });
  syncFollowSwitch();
  grid = document.createElement("div"); grid.className = "liuxinyu-activity-grid";
  empty = document.createElement("p"); empty.className = "liuxinyu-activity-empty";
  empty.textContent = "当前没有正在运行的节点";
  content.append(empty, grid); page.append(followControls, content);
  return page;
}

function syncFollowSwitch() {
  followSwitch.setAttribute("aria-checked", String(follow.enabled));
  followSwitch.dataset.state = followThumb.dataset.state = follow.enabled ? "checked" : "unchecked";
}

function mount() {
  const next = document.querySelector('[data-testid="properties-panel"]');
  if (!next) return false;
  const reference = next.querySelector('[data-testid="panel-tab-parameters"]');
  if (!reference) return false;
  const tablist = reference.parentElement;
  if (next !== panel) {
    for (const card of cards.values()) card.destroy();
    cards.clear(); page?.remove(); tab?.remove(); panel = next;
    tab = document.createElement("button"); tab.type = "button";
    chromeSignature = "";
    tab.textContent = "活动";
    tab.setAttribute("role", "tab"); tab.dataset.testid = "panel-tab-activity";
    tab.addEventListener("click", () => switchTab("activity"));
    tab.addEventListener("keydown", tabKeys);
    panel.append(buildPage());
  }
  if (!boundTabGroups.has(tablist)) {
    boundTabGroups.add(tablist);
    // Selecting a native tab is independent of canvas navigation or execution updates.
    tablist.addEventListener("click", event => {
      if (event.target.closest('[role="tab"]') !== tab) { active = false; updateVisibility(); }
    });
  }
  if (tab.parentElement !== tablist) tablist.prepend(tab);
  if (page.parentElement !== panel) panel.append(page);
  syncNativeChrome(reference);
  updateVisibility();
  return true;
}

function openActivity() {
  active = true;
  clearSelection();
  const rightPanel = stores()?.get("rightSidePanel");
  if (typeof rightPanel?.openPanel === "function") rightPanel.openPanel();
  else app.ui?.settings?.setSettingValue?.("Comfy.RightSidePanel.IsOpen", true);
  refreshSoon();
  setTimeout(() => {
    if (active && !mount() && !missingPanelReported) {
      missingPanelReported = true;
      report(new Error("当前前端没有提供工作流总览侧栏，无法挂载活动页；请使用具有该侧栏的前端版本。"));
    }
  }, 2000);
}

function locate(match) {
  // Capture this path/node now. Card removal and subsequent updates do not cancel navigation.
  void revealNode(match).catch(report);
}

function refresh() {
  observePanel();
  const now = performance.now();
  if (now - lastPaint < 100) return;
  lastPaint = now;
  if (!mount() || !active || document.hidden || !panel.isConnected || content.clientHeight === 0) { follow.reset(); return; }
  const root = app.rootGraph || app.graph;
  const entries = state.entries(root);
  const live = new Set();
  const samples = [];
  const available = Math.max(240, grid.clientWidth || panel.clientWidth - 24);
  for (const entry of entries) {
    const matches = findNodes(root, entry.path);
    const match = matches.find(item => item.path === entry.path);
    if (!match) continue; // Never navigate an ambiguous bare ID into a different subgraph instance.
    const key = entry.path;
    live.add(key);
    let card = cards.get(key);
    if (card && card.node !== match.node) { card.destroy(); cards.delete(key); card = null; }
    if (!card) {
      card = new ActivityNodeView(match.node, app.canvas, () => locate(match));
      cards.set(key, card); grid.append(card.element);
    }
    try {
      const box = card.element.getBoundingClientRect();
      const viewport = grid.parentElement.getBoundingClientRect();
      // Check offscreen geometry/property-only widget changes too, without painting offscreen tiles.
      if (card.dirty || now - (card.lastRender || 0) >= 500 || (box.bottom >= viewport.top && box.top <= viewport.bottom)) {
        card.render(available); card.lastRender = now;
      }
      card.element.removeAttribute("data-error");
    } catch (error) {
      if (card.error !== error.message) {
        card.error = error.message;
        console.error(`[liuxinyu.Activity] ${key}`, error);
      }
      card.element.dataset.error = `节点预览失败：${error.message}。点击定位原节点。`;
    }
    samples.push({ card, jobId: entry.jobId, height: card.element.getBoundingClientRect().height });
  }
  for (const [key, card] of cards) if (!live.has(key)) { card.destroy(); cards.delete(key); }
  empty.hidden = cards.size > 0;
  // Match visual DOM order, which stays stable while new entries join.
  const order = new Map([...cards.values()].map((card, i) => [card, i]));
  samples.sort((a, b) => order.get(a.card) - order.get(b.card));
  const target = follow.sample(samples, now, root, available);
  followControls.hidden = !target;
  if (target && follow.enabled && followCardBottom(content, target.element)) refreshSoon();
}

app.registerExtension({
  name: "liuxinyu.Activity",
  setup() {
    if (installed) return;
    installed = true;
    const css = document.createElement("link"); css.rel = "stylesheet";
    css.href = new URL("./activity.css", import.meta.url).href; document.head.append(css);
    api.addEventListener("execution_start", ({ detail }) => {
      if (state.start(detail.prompt_id, app.rootGraph || app.graph)) startActivity(detail.prompt_id);
    });
    api.addEventListener("progress_state", ({ detail }) => {
      state.progress(detail, app.rootGraph || app.graph); refreshSoon();
    });
    api.addEventListener("executing", ({ detail }) => {
      state.executing(detail, app.rootGraph || app.graph); refreshSoon();
    });
    for (const type of ["execution_success", "execution_error", "execution_interrupted"]) {
      api.addEventListener(type, ({ detail }) => {
        state.finish(detail.prompt_id);
        finishActivity(detail.prompt_id, type === "execution_error");
        refreshSoon();
      });
    }
    // Hydrate if this extension is initialized after execution has already begun.
    const execution = stores()?.get("execution");
    for (const [id, nodes] of Object.entries(execution?.nodeProgressStatesByJob || {})) {
      if (Object.values(nodes).some(node => node.state === "running")) state.progress({ prompt_id: id, nodes }, app.rootGraph || app.graph);
    }
    void executionResume.start();
    observer = new MutationObserver(records => {
      if (records.some(record => !record.target.closest?.(".liuxinyu-activity-page"))) refreshSoon();
    });
    const resume = () => {
      observer.observe(document.body, { childList: true, subtree: true });
      clearInterval(timer); timer = setInterval(refreshSoon, 150); refreshSoon();
    };
    resume();
    document.addEventListener("visibilitychange", refreshSoon);
    window.addEventListener("pagehide", () => {
      follow.reset();
      observer.disconnect(); clearInterval(timer);
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      for (const card of cards.values()) card.destroy(); cards.clear();
    });
    window.addEventListener("pageshow", event => { if (event.persisted) resume(); });
    refreshSoon();
  },
  afterConfigureGraph() {
    follow.reset();
    for (const card of cards.values()) card.destroy(); cards.clear();
    void executionResume.restore(); refreshSoon();
  },
});
