import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let pendingRefresh;

export function refreshNodeSearch() {
  if (!pendingRefresh) {
    // registerNodes updates both LiteGraph and the modern search's Vue store.
    pendingRefresh = app.registerNodes().finally(() => {
      pendingRefresh = undefined;
    });
  }
  return pendingRefresh;
}

function refreshAfterReconnect() {
  refreshNodeSearch().catch((error) => {
    console.error("[liuxinyu] Failed to refresh node search:", error);
  });
}

app.registerExtension({
  name: "liuxinyu.NodeSearchSync",
  async setup() {
    await refreshNodeSearch();
    api.addEventListener("reconnected", refreshAfterReconnect);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) refreshAfterReconnect();
    });
  },
});
