import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function chooseFileVersion(path, savedAt, modified, manual = false) {
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "max-width:560px;width:calc(100% - 48px);padding:24px;border:1px solid #777;border-radius:12px;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#eee);box-shadow:0 12px 48px #0008;";
  const title = document.createElement("h2");
  title.textContent = manual ? "同步实际工作流文件" : "工作流文件有新变动";
  title.style.cssText = "font-size:18px;margin:0 0 16px";
  const message = document.createElement("p");
  message.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7";
  message.textContent = `${path}\n\n上次前端保存：${new Date(savedAt).toLocaleString()}\n后端文件修改：${new Date(modified).toLocaleString()}\n\n页面已按原方式恢复。是否将当前页面同步到实际文件的最新内容？同步会替换当前页面内容；什么都不做则继续编辑当前内容。`;
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap;margin-top:20px";
  const keep = document.createElement("button");
  keep.textContent = "什么都不做";
  keep.autofocus = true;
  const sync = document.createElement("button");
  sync.textContent = "同步到实际文件";
  for (const button of [keep, sync]) {
    button.type = "button";
    button.style.cssText = "padding:10px 16px;border:1px solid #888;border-radius:6px;background:var(--comfy-input-bg,#333);color:inherit;cursor:pointer";
  }
  actions.append(keep, sync);
  dialog.append(title, message, actions);
  dialog.setAttribute("aria-label", title.textContent);
  document.body.append(dialog);
  let syncing = false;
  const result = new Promise((resolve) => {
    keep.onclick = () => dialog.close("keep");
    sync.onclick = () => {
      // Keep the canvas inert until native frame callbacks have initialized
      // socket types. Otherwise a user edit during that wait could be saved
      // into the new baseline without ever reaching the file.
      syncing = true;
      keep.disabled = sync.disabled = true;
      message.textContent = "正在读取实际文件并完成节点初始化…";
      dialog.setAttribute("aria-busy", "true");
      resolve("sync");
    };
    dialog.addEventListener("cancel", (event) => {
      if (syncing) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "sync" ? "sync" : dialog.returnValue === "stale" ? "stale" : "keep");
      dialog.remove();
    }, { once: true });
  });
  dialog.showModal();
  return { result, cancel: () => dialog.close("stale"), finish: () => dialog.close() };
}

async function finishLoadFrames() {
  // Native applyMatchType (dynamicWidgets.ts) initializes in rAF, AFTER
  // loadGraphData resolves. Its connection notifications also enqueue
  // microtasks (e.g. StructuredDataTypes). The following frame is a barrier
  // after those callbacks, including callbacks registered during that frame.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

let beforeLoad = () => {};
let afterLoad = () => {};
let manualCheck;

// Report the fields considered by the native dirty check. This deliberately
// does not normalize the live graph or change its saved baseline.
function describeWorkflowDifferences(before, after) {
  const lines = [];
  const limit = 60;
  const preview = (value) => {
    const text = JSON.stringify(value) ?? "(不存在)";
    return text.length > 160 ? text.slice(0, 160) + "…" : text;
  };
  function visit(a, b, path) {
    if (lines.length >= limit || Object.is(a, b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      // Node order does not matter to the native tracker. Match by ID so a
      // reordered canvas doesn't obscure the node that actually changed.
      if (path === "nodes" && Array.isArray(a) &&
          [...a, ...b].every((node) => node && node.id != null) &&
          new Set(a.map(node => node.id)).size === a.length &&
          new Set(b.map(node => node.id)).size === b.length) {
        const left = new Map(a.map(node => [node.id, node]));
        const right = new Map(b.map(node => [node.id, node]));
        for (const id of new Set([...left.keys(), ...right.keys()])) {
          visit(left.get(id), right.get(id), `${path}[id=${id}]`);
        }
        return;
      }
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (path === "extra" && key === "ds") continue;
        visit(a[key], b[key], `${path}.${key}`);
      }
    } else {
      lines.push(`${path}\n  ${preview(a)} → ${preview(b)}`);
    }
  }
  for (const key of ["nodes", "extra", "links", "floatingLinks", "reroutes", "groups", "definitions", "subgraphs"]) {
    visit(key === "extra" ? before?.extra ?? {} : before?.[key],
      key === "extra" ? after?.extra ?? {} : after?.[key], key);
  }
  if (lines.length >= limit) lines.push("仅显示前 60 处差异。");
  return lines.join("\n") || "未发现字段差异。";
}

function showUnsavedDifferences() {
  const workflow = app.extensionManager?.workflow?.activeWorkflow;
  const tracker = workflow?.changeTracker;
  if (!tracker) return;
  const active = tracker.activeState ?? workflow.activeState;
  const report = [
    `工作流：${workflow.path}\n未保存标记：${Boolean(workflow.isModified)}`,
    "已保存基准 → 前端已记录状态：\n" + describeWorkflowDifferences(tracker.initialState, active),
    "前端已记录状态 → 当前画布：\n" + describeWorkflowDifferences(active, app.rootGraph.serialize()),
  ].join("\n\n");
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(900px,90vw);padding:20px;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#eee)";
  const title = document.createElement("h2");
  title.textContent = "查看未保存差异";
  const description = document.createElement("p");
  description.textContent = "此处仅显示差异，不保存或清除标记。可选中文本复制；包含发生变化的字段值。";
  const text = document.createElement("textarea");
  text.readOnly = true;
  text.value = report;
  text.setAttribute("aria-label", "未保存差异报告");
  text.style.cssText = "width:100%;height:55vh;box-sizing:border-box";
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(title, description, text, close);
  dialog.setAttribute("aria-label", title.textContent);
  document.body.append(dialog);
  dialog.showModal();
}

app.registerExtension({
  name: "liuxinyu.WorkflowFileSync",
  setup() {
    const manager = app.extensionManager;
    const workflows = manager?.workflow;
    // ComfyUI currently exposes no public draft-store API. Keep this adapter
    // here; never patch its restoration, loading, or eviction methods.
    const drafts = workflows?._p?._s?.get("workflowDraftV2");
    if (!drafts?.$onAction || !workflows?.$onAction) {
      console.warn("[liuxinyu] Workflow file sync: this frontend does not expose the V2 draft store.");
      return;
    }
    const storageKey = `liuxinyu.WorkflowFileSync.v1:${api.api_base}:${api.user || "default"}`;
    const records = new Map(Object.entries(readJSON(storageKey) || {}));
    const index = readJSON("Comfy.Workflow.DraftIndex.v2:personal");
    // Capture the previous session's save times before normal restoration
    // writes fresh drafts. Reading this index does not change recovery.
    for (const entry of Object.values(index?.entries || {})) {
      if (entry.isTemporary || !Number.isFinite(entry.updatedAt)) continue;
      const previous = records.get(entry.path) || {};
      // Once observed, only an actual save advances our boundary. Restoration
      // can rewrite the native draft timestamp without any new user save.
      if (!Number.isFinite(previous.savedAt)) records.set(entry.path, { ...previous, savedAt: entry.updatedAt });
    }
    let restoring = true;
    let syncing = false;
    let generation = 0;
    let checkTimer;
    let restoreTimer;
    let checking = false;
    let checkAgain = false;
    let forceAgain = false;
    let cancelPrompt;

    function persist() {
      // Metadata only, bounded independently of workflow size.
      while (records.size > 100) records.delete(records.keys().next().value);
      try {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(records)));
      } catch (error) {
        console.warn("[liuxinyu] Could not remember workflow file sync metadata:", error);
      }
    }

    function rememberSave(path, savedAt) {
      if (!Number.isFinite(savedAt)) return;
      if (checking && workflows.activeWorkflow?.path === path) {
        generation++;
        cancelPrompt?.();
        checkAgain = true;
      }
      const previous = records.get(path) || {};
      records.delete(path);
      records.set(path, { ...previous, savedAt });
      persist();
    }

    persist();

    drafts.$onAction(({ name, args, after }) => {
      if (name !== "saveDraft" || restoring || syncing) return;
      after((saved) => {
        // Autosaving the canvas is not a decision about a newer backend file.
        // Keep both the open question and its time boundary until the user chooses.
        if (cancelPrompt && args[0] === workflows.activeWorkflow?.path) return;
        if (saved) rememberSave(args[0], drafts.getDraft(args[0])?.updatedAt);
      });
    }, true);
    workflows.$onAction(({ name, args, after }) => {
      if (name !== "saveWorkflow") return;
      after(() => rememberSave(args[0].path, args[0].lastModified));
    }, true);

    function scheduleCheck(force = false) {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        if (!restoring && !syncing) void checkCurrent({ force });
      }, 0);
    }

    beforeLoad = () => {
      clearTimeout(restoreTimer);
      restoring = true;
      generation++;
      cancelPrompt?.();
    };
    afterLoad = () => {
      // Do not hold up the original load/restore lifecycle or its autosaves.
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoring = false;
        if (!syncing) void checkCurrent();
      }, 0);
    };

    async function fileInfo(path) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      const filename = path.slice(directory.length + 1);
      const response = await api.fetchApi(`/userdata?dir=${encodeURIComponent(directory)}&recurse=false&full_info=true`, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`文件信息读取失败 (${response.status})`);
      return (await response.json()).find((file) => file.path === filename) || null;
    }

    function warn(error) {
      console.warn("[liuxinyu] Workflow file sync:", error);
      manager.toast?.add({ severity: "warn", summary: "工作流文件同步未完成", detail: "请稍后切回页面重试。" });
    }

    async function checkCurrent({ force = false, notifyOnError = true } = {}) {
      if (checking) { checkAgain = true; forceAgain ||= force; return; }
      const workflow = workflows.activeWorkflow;
      if (!workflow?.isPersisted || !workflow.path.startsWith("workflows/")) return;
      const path = workflow.path;
      const ticket = generation;
      const isCurrent = () => ticket === generation && workflow === workflows.activeWorkflow && workflow.path === path;
      // Without any previous frontend save, there is no historical interval
      // to test. Start tracking from this first opening.
      if (!records.has(path)) rememberSave(path, Date.now());
      const record = records.get(path);
      const savedAt = record.savedAt;
      checking = true;
      let finishPrompt;
      try {
        const info = await fileInfo(path);
        if (!isCurrent() || !info) return;
        const revision = `${info.modified}:${info.size}`;
        if (!force && (!(info.modified > savedAt) || record.acknowledged === revision)) return;
        // File mtime defines a change, including edit-then-revert. Do not
        // suppress the question because the two JSON contents are equal.
        const prompt = chooseFileVersion(path, savedAt, info.modified, force);
        cancelPrompt = prompt.cancel;
        const choice = await prompt.result;
        cancelPrompt = undefined;
        finishPrompt = prompt.finish;
        if (!isCurrent() || choice === "stale") return;
        if (choice === "keep") {
          records.set(path, { ...records.get(path), acknowledged: revision });
          persist();
          return;
        }

        // Fetch only after the user chooses sync, so changes made while the
        // question was open are included. No write request is made.
        const latestInfo = await fileInfo(path);
        const response = await api.getUserData(path, { cache: "no-store" });
        if (!response.ok || !latestInfo) throw new Error(`工作流文件读取失败 (${response.status})`);
        const content = await response.text();
        const graph = JSON.parse(content);
        if (!graph || !Array.isArray(graph.nodes)) throw new Error("文件不是画布工作流");
        if (!isCurrent()) return;
        const backup = JSON.parse(JSON.stringify(workflow.activeState));
        const previousFile = {
          originalContent: workflow.originalContent,
          content: workflow.content,
          lastModified: workflow.lastModified,
          size: workflow.size,
        };
        const previousInitial = JSON.parse(JSON.stringify(workflow.changeTracker.initialState));
        syncing = true;
        try {
          const loaded = await app.loadGraphData(graph, true, true, workflow);
          if (loaded === false) throw new Error("工作流加载失败");
          const loadedGeneration = generation;
          await finishLoadFrames();
          // Another load can still be triggered programmatically while the
          // modal is open. Never adopt that graph as this workflow's baseline.
          if (generation !== loadedGeneration || workflow !== workflows.activeWorkflow || workflow.path !== path) return;
          workflow.originalContent = content;
          workflow.content = content;
          workflow.lastModified = latestInfo.modified;
          workflow.size = latestInfo.size;
          // Load hooks AND native frame-based socket initialization are now
          // complete. Only this explicit sync adopts the initialized graph.
          workflow.changeTracker.reset(app.rootGraph.serialize());
          workflow.changeTracker.updateModified();
          drafts.removeDraft(path);
          records.set(path, { ...records.get(path), acknowledged: `${latestInfo.modified}:${latestInfo.size}` });
          persist();
        } catch (error) {
          // A failed graph load may already have cleared the canvas. Restore
          // the user's state and keep a recoverable draft in that case.
          try {
            await app.loadGraphData(backup, true, true, workflow);
          } finally {
            Object.assign(workflow, previousFile);
            workflow.changeTracker.initialState = previousInitial;
            workflow.isModified = true;
            drafts.saveDraft(path, JSON.stringify(backup), { name: workflow.key, isTemporary: false });
          }
          throw error;
        } finally {
          syncing = false;
        }
      } catch (error) {
        if (notifyOnError) warn(error);
      } finally {
        finishPrompt?.();
        checking = false;
        if (checkAgain) {
          checkAgain = false;
          const forceNext = forceAgain;
          forceAgain = false;
          scheduleCheck(forceNext);
        }
      }
    }

    manualCheck = () => scheduleCheck(true);
    api.addEventListener("reconnected", () => scheduleCheck());
    window.addEventListener("focus", () => scheduleCheck());
    setInterval(() => {
      if (document.visibilityState === "visible" && !restoring && !syncing && !checking) {
        void checkCurrent({ notifyOnError: false });
      }
    }, 5000);
  },
  beforeLoadGraph() { beforeLoad(); },
  afterLoadGraph() { afterLoad(); },
  getCanvasMenuItems() {
    return [
      ...(manualCheck ? [{ content: "检查/同步后端工作流文件", callback: () => manualCheck() }] : []),
      { content: "查看未保存差异", callback: showUnsavedDifferences },
    ];
  },
});
