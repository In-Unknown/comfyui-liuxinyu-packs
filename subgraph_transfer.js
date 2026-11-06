import { app } from "../../scripts/app.js";

// Native conversion removes the old hosts before adding their replacements.
// Their child definitions are still needed even when no other host exists.
export function installSubgraphTransferFix(Graph) {
  const prototype = Graph?.prototype;
  if (!prototype || prototype._liuxinyuSubgraphTransferFix) return;
  const convert = prototype._convertToSubgraphImpl;
  const remove = prototype.removeNode;
  if (typeof convert !== "function" || typeof remove !== "function") return;
  const transfers = new WeakMap();
  prototype._convertToSubgraphImpl = function (selection, ...args) {
    const previous = transfers.get(this);
    transfers.set(this, selection);
    try {
      return convert.call(this, selection, ...args);
    } finally {
      if (previous) transfers.set(this, previous);
      else transfers.delete(this);
    }
  };
  prototype.removeNode = function (node, ...args) {
    const selection = transfers.get(this);
    const group = selection?.size === 1 ? selection.values().next().value : null;
    const moving = selection?.has(node) || group?.children?.has(node);
    if (!moving || !node.isSubgraphNode?.()) return remove.call(this, node, ...args);
    // Skip only the native child-definition garbage-collection branch. Native
    // removal still disconnects this host, releases its widgets and runs its
    // onRemoved hook. No temporary nodes or graph data are introduced.
    const own = Object.getOwnPropertyDescriptor(node, "isSubgraphNode");
    Object.defineProperty(node, "isSubgraphNode", { configurable: true, value: () => false });
    try {
      return remove.call(this, node, ...args);
    } finally {
      if (own) Object.defineProperty(node, "isSubgraphNode", own);
      else delete node.isSubgraphNode;
    }
  };
  Object.defineProperty(prototype, "_liuxinyuSubgraphTransferFix", { value: true });
}

app.registerExtension({
  name: "liuxinyu.SubgraphTransferFix",
  setup() { installSubgraphTransferFix(LiteGraph.LGraph); },
});
