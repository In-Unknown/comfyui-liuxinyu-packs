import { mosaicLayout, createHierarchy } from "./canvas_background_layout.js";

// The extension loader also imports root JS files in the page; only a worker listens.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try {
      const layout = mosaicLayout(data.ratios, data.seed);
      const hierarchy = createHierarchy(layout, data.levels, data.seed);
      self.postMessage({ layout, hierarchy });
    } catch (error) { self.postMessage({ error: error.message }); }
  };
}
