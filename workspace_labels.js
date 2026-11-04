import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PANEL = '[data-testid="workflows-sidebar"]';
const TREE_PREFIX = "tree-node-root/";

function externalFileForClick(event) {
  if (event.button !== 0 || event.defaultPrevented) return null;
  const target = event.target;
  if (!target?.closest?.(PANEL) || target.closest('button, input, textarea, [contenteditable="true"], .node-actions')) return null;
  // The native tree handles clicks on the whole row, including its file icon.
  const row = target.closest(".p-tree-node-content");
  const leaf = row?.querySelector('.tree-leaf[data-testid^="tree-node-root/"]');
  const key = leaf?.getAttribute("data-testid");
  if (!key?.startsWith(TREE_PREFIX)) return null;
  return key.slice(TREE_PREFIX.length);
}

function installExternalFileOpener() {
  const pending = new Set();
  const nativeClicks = new WeakSet();
  let latestClick = 0;
  document.addEventListener("click", async (event) => {
    if (nativeClicks.has(event)) return;
    const path = externalFileForClick(event);
    if (!path) return;
    // Stop native openWorkflow before it tries to parse this document as JSON.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail > 1 || pending.has(path)) return;
    const clickId = ++latestClick;
    pending.add(path);
    try {
      const response = await api.fetchApi("/liuxinyu/workspace/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.action === "workflow" && clickId === latestClick && event.target.isConnected) {
        // Replay only this checked click through the native tree handler.
        // No loading API is called for documents, even if native loading
        // would clear the canvas before discovering an invalid graph.
        const replay = new MouseEvent("click", {
          bubbles: true, cancelable: true, composed: true,
          button: event.button, detail: 1,
          ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
          altKey: event.altKey, metaKey: event.metaKey,
        });
        nativeClicks.add(replay);
        event.target.dispatchEvent(replay);
      }
    } catch (error) {
      app.extensionManager.toast.add({
        severity: "error", summary: "无法打开工作区文件",
        detail: `${path}\n${error.message}`, life: 8000,
      });
    } finally {
      pending.delete(path);
    }
  }, true);
}

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function setAttribute(element, name, value) {
  if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function updateWorkspacePanel(panel) {
  const title = panel.querySelector('.comfy-vue-side-bar-header span[title]');
  setText(title, "工作区");
  setAttribute(title, "title", "工作区");
  setAttribute(panel.querySelector('input[placeholder]'), "placeholder", "搜索工作区…");

  // TreeExplorer keeps the full path in its key even though the native label
  // strips the suffix. Read that key, not the label or a guessed extension.
  for (const leaf of panel.querySelectorAll('.tree-leaf[data-testid^="tree-node-"]')) {
    const key = leaf.getAttribute("data-testid");
    const filename = key.slice(key.lastIndexOf("/") + 1);
    // EditableText replaces this span with an input while renaming. Leave
    // its editing value and native rename/save behavior untouched.
    const label = leaf.querySelector('.node-label .editable-text > span');
    if (filename) setText(label, filename);
  }
}

app.registerExtension({
  name: "liuxinyu.WorkspaceLabels",
  setup() {
    installExternalFileOpener();
    // Follow WorkflowFileSync's store adapter. Keep the tab ID/component so
    // native navigation, shortcuts and workflow persistence stay intact.
    const tabs = app.extensionManager?.workflow?._p?._s?.get("sidebarTab");
    const tab = tabs?.sidebarTabs?.find((item) => item.id === "workflows");
    if (tab) {
      tab.title = tab.tooltip = tab.label = "工作区";
    } else {
      console.warn("[liuxinyu] Workspace labels: workflow sidebar tab is unavailable.");
    }

    // There is no public extension API for native tree labels. Limit this
    // display adapter to the workflow panel; never rewrite global i18n keys.
    // Observe mounting as well as tree updates (search, bookmarks, rename).
    let scheduled = false;
    const options = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid", "placeholder", "title"],
    };
    const refresh = () => {
      scheduled = false;
      observer.disconnect();
      try {
        for (const panel of document.querySelectorAll(PANEL)) updateWorkspacePanel(panel);
      } finally {
        observer.observe(document.body, options);
      }
    };
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest(PANEL)) return true;
        return Array.from(record.addedNodes).some((node) =>
          node.nodeType === 1 && (node.matches(PANEL) || node.querySelector(PANEL)));
      });
      if (!relevant || scheduled) return;
      scheduled = true;
      requestAnimationFrame(refresh);
    });
    refresh();
  },
});
