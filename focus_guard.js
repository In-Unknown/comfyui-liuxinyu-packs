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
      // Stop that target handler only when focus has left the page; normal
      // in-page editing and all unrelated inputs retain their original events.
      if (event.target?.matches?.(".graphdialog input.value") && inactive(document)) {
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
