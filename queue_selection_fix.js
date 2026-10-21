import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "liuxinyu.QueueSelectionBoundsFix",
  setup() {
    const style = document.createElement("style");
    style.id = "liuxinyu-queue-selection-bounds-fix";
    // The stock queue wrapper expands the top menu and pushes the selection
    // clipping surface down. Float only that wrapper below its action bars.
    style.textContent = `
      div:has(> [data-testid="top-menu-actionbars"]) {
        position: relative;
      }
      div:has(> [data-testid="top-menu-actionbars"])
        > div:has(> [data-testid="queue-progress-overlay"]) {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
  },
});
