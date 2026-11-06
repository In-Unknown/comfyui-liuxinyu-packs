import { app } from "../../scripts/app.js";
import { MENU_ORDER } from "./menu_order.js";

const menuProviders = new Map();

// Factories run when the menu opens, so selection and busy states stay current.
export function registerMenuItem(id, providers) {
  if (menuProviders.has(id)) throw new Error(`重复的 liuxinyu 菜单 ID：${id}`);
  menuProviders.set(id, providers);
}

function collectMenuItems(context, args) {
  const ids = [...new Set(MENU_ORDER)];
  // Newly registered items remain deterministic even before their ID is listed.
  ids.push(...[...menuProviders.keys()].filter(id => !ids.includes(id)).sort());
  const items = [];
  for (const id of ids) {
    const item = menuProviders.get(id)?.[context]?.(...args);
    if (item) items.push(item);
  }
  return sourceMenuItems(items);
}

// Mark only entries created by this package; keep their text and callbacks intact.
export function sourceMenuItems(items) {
  return items.map(item => item === null ? null : {
    ...item,
    className: [item.className, "liuxinyu-menu-source"].filter(Boolean).join(" "),
  });
}

app.registerExtension({
  name: "liuxinyu.MenuSource",
  getCanvasMenuItems(...args) { return collectMenuItems("canvas", args); },
  getNodeMenuItems(...args) { return collectMenuItems("node", args); },
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
