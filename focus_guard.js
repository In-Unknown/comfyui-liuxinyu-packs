import { app } from "../../scripts/app.js";

const documents = new WeakSet();
const canvases = new WeakSet();

function inactive(document) {
  return document.hidden || !document.hasFocus();
}

function protectCanvas(canvas) {
  if (!canvas || canvases.has(canvas)) return;
  canvases.add(canvas);
  const focus = canvas.focus;
  canvas.focus = function (...args) {
    // Native legacy search closes by focusing the canvas immediately and again
    // after 20 ms. Neither call should reactivate a background browser window.
    if (inactive(this.ownerDocument)) return;
    return focus.apply(this, args);
  };
}

function setup() {
  if (!documents.has(document)) {
    documents.add(document);
    document.addEventListener("blur", event => {
      // Native property editors and legacy search register blur => this.focus().
      // During window deactivation hasFocus() can still describe the old state.
      // A null relatedTarget means there is no known in-page focus destination;
      // never pull focus back synchronously in that transition (including chrome).
      if (event.target?.matches?.(".graphdialog input.value") &&
          (event.relatedTarget == null || inactive(document))) {
        event.stopImmediatePropagation();
      }
    }, true);
  }
  protectCanvas(app.canvas?.canvas);
}

app.registerExtension({
  name: "liuxinyu.BackgroundFocusGuard",
  setup,
  afterConfigureGraph: setup,
});
