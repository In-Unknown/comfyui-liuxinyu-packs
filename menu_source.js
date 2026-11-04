import { app } from "../../scripts/app.js";

// Mark only entries created by this package; keep their text and callbacks intact.
export function sourceMenuItems(items) {
  return items.map(item => item === null ? null : {
    ...item,
    className: [item.className, "liuxinyu-menu-source"].filter(Boolean).join(" "),
  });
}

app.registerExtension({
  name: "liuxinyu.MenuSource",
  setup() {
    if (document.getElementById("liuxinyu-menu-source-style")) return;
    const style = document.createElement("style");
    style.id = "liuxinyu-menu-source-style";
    style.textContent = `
      .litecontextmenu .litemenu-entry.liuxinyu-menu-source::after {
        content: "liuxinyu";
        float: right;
        margin-left: 20px;
        font-size: 0.8em;
        font-weight: normal;
        color: color-mix(in srgb, currentColor 65%, #7896b0);
        opacity: 0.85;
        pointer-events: none;
      }
      .litecontextmenu .litemenu-entry:not(.liuxinyu-menu-source):not(.separator) + .liuxinyu-menu-source,
      .litecontextmenu .liuxinyu-menu-source + .litemenu-entry:not(.liuxinyu-menu-source):not(.separator) {
        border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      }
    `;
    document.head.append(style);
  },
});
