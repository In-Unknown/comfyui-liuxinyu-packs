import { app } from "../../scripts/app.js";

const installed = new WeakSet();

// Follow native group traversal, but let native code decide which items move.
function descendants(items, found = new Set()) {
  for (const item of items ?? []) {
    if (found.has(item) || item.pinned) continue;
    found.add(item);
    descendants(item.children, found);
  }
  return found;
}

export function installAxisDrag(canvas, keyboard = window) {
  if (!canvas || installed.has(canvas) || !canvas._startDraggingItems) return;
  installed.add(canvas);
  let drag = null;
  let movingEvent = null;

  const dirty = () => canvas.setDirty(true, true);
  function finish() {
    if (!drag) return;
    for (const [item, record] of drag.items) {
      if (item.move !== record.wrapper) continue;
      if (record.descriptor) Object.defineProperty(item, "move", record.descriptor);
      else delete item.move;
    }
    drag = null;
    dirty();
  }
  function valid() {
    if (drag && (canvas.graph !== drag.graph || !canvas.isDragging)) finish();
    return drag;
  }
  function chooseAxis(dx, dy) {
    if (drag.shift && drag.axis === null && (dx !== 0 || dy !== 0)) {
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
    }
  }
  function project(item, record) {
    const blocked = 1 - drag.axis;
    const delta = record.start[blocked] - item.pos[blocked];
    if (delta) record.move.call(item, blocked === 0 ? delta : 0, blocked === 1 ? delta : 0, true);
  }
  function shift(pressed) {
    if (!valid() || drag.shift === pressed) return;
    drag.shift = pressed;
    drag.axis = null;
    if (pressed) {
      const record = drag.items.get(drag.anchor);
      if (record) chooseAxis(drag.anchor.pos[0] - record.start[0], drag.anchor.pos[1] - record.start[1]);
      if (drag.axis !== null) {
        for (const [item, record] of drag.items) if (record.moved) project(item, record);
      }
    } else {
      // Restore the position native dragging would have reached, including all
      // movement filtered out while Shift was held. Keyup needs no mousemove.
      for (const [item, record] of drag.items) {
        if (!record.moved) continue;
        const dx = record.free[0] - item.pos[0], dy = record.free[1] - item.pos[1];
        if (dx || dy) record.move.call(item, dx, dy, true);
      }
    }
    dirty();
  }

  const start = canvas._startDraggingItems;
  canvas._startDraggingItems = function (item, pointer, ...args) {
    finish();
    const result = start.call(this, item, pointer, ...args);
    if (!this.isDragging || this.state?.ghostNodeId != null) return result;
    drag = { graph: this.graph, shift: !!(movingEvent ?? pointer.eDown)?.shiftKey, axis: null, anchor: null,
      origin: [pointer.eDown?.canvasX ?? item.pos[0], pointer.eDown?.canvasY ?? item.pos[1]], items: new Map() };
    for (const target of descendants(this.selectedItems)) {
      if (!target.pos || typeof target.move !== "function") continue;
      const record = { start: [...target.pos], free: [...target.pos], move: target.move,
        descriptor: Object.getOwnPropertyDescriptor(target, "move"), moved: false, wrapper: null };
      record.wrapper = function (dx, dy, ...rest) {
        if (!valid() || canvas.read_only || canvas.dragging_canvas) return record.move.call(this, dx, dy, ...rest);
        record.free[0] += dx;
        record.free[1] += dy;
        if (dx || dy) {
          record.moved = true;
          drag.anchor ??= this;
          chooseAxis(record.free[0] - record.start[0], record.free[1] - record.start[1]);
        }
        if (drag.axis !== null) {
          if (drag.axis === 0) dy = record.start[1] - this.pos[1];
          else dx = record.start[0] - this.pos[0];
        }
        const result = record.move.call(this, dx, dy, ...rest);
        if (drag?.axis === null) record.free = [...this.pos];
        return result;
      };
      drag.items.set(target, record);
      target.move = record.wrapper;
    }
    // CanvasPointer.finally is an accessor: assigning it executes the previous
    // callback immediately. Leave it entirely under native lifecycle control.
    return result;
  };

  const move = canvas.processMouseMove;
  canvas.processMouseMove = function (event, ...args) {
    shift(!!event.shiftKey);
    movingEvent = event;
    try { return move.call(this, event, ...args); }
    finally { movingEvent = null; valid(); }
  };
  const end = canvas._processDraggedItems;
  canvas._processDraggedItems = function (event, ...args) {
    try {
      return endDrag.call(this, event, ...args);
    } finally {
      // onDragEnd runs before native pointer.reset() closes the undo transaction.
      finish();
    }
  };
  function endDrag(event, ...args) {
    shift(!!event.shiftKey);
    if (!valid() || drag.axis === null) return end.call(this, event, ...args);
    // Native Shift/always-snap must not change the origin axis or group spacing.
    const graph = this.graph;
    const descriptor = Object.getOwnPropertyDescriptor(graph, "snapToGrid");
    const snap = graph.snapToGrid;
    graph.snapToGrid = function (items, ...values) {
      if (items !== canvas.selectedItems) return snap.call(this, items, ...values);
    };
    try { return end.call(this, event, ...args); }
    finally {
      if (descriptor) Object.defineProperty(graph, "snapToGrid", descriptor);
      else delete graph.snapToGrid;
    }
  }

  const draw = canvas.onDrawForeground;
  canvas.onDrawForeground = function (ctx, ...args) {
    const result = draw?.call(this, ctx, ...args);
    if (!valid() || drag.axis === null || !drag.anchor) return result;
    const record = drag.items.get(drag.anchor);
    const [x, y] = drag.origin;
    const endX = x + drag.anchor.pos[0] - record.start[0];
    const endY = y + drag.anchor.pos[1] - record.start[1];
    const scale = this.ds.scale || 1;
    ctx.save();
    try {
      ctx.strokeStyle = "#64c8ff";
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY); ctx.stroke();
      ctx.setLineDash([]);
      const radius = 4 / scale;
      for (const point of [[x, y], [endX, endY]]) {
        ctx.beginPath(); ctx.arc(...point, radius, 0, Math.PI * 2); ctx.stroke();
      }
    } finally { ctx.restore(); }
    return result;
  };

  keyboard.addEventListener("keydown", event => {
    if (event.key === "Shift") shift(true);
  }, true);
  keyboard.addEventListener("keyup", event => {
    if (event.key === "Shift") shift(false);
  }, true);
  keyboard.addEventListener("blur", () => shift(false));
  const cancel = canvas.processMouseCancel;
  canvas.processMouseCancel = function (...args) {
    finish();
    return cancel?.apply(this, args);
  };
}

app.registerExtension({ name: "liuxinyu.AxisDrag", setup() { installAxisDrag(app.canvas); } });
