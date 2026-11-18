import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { startFocusTrace } from "./focus_diagnostics.js";

export function createFocusSink(send, session) {
  const pending = [];
  let busy = false;
  let dropped = 0;
  return {
    add(record) {
      pending.push(record);
      if (pending.length > 400) { pending.shift(); dropped++; }
    },
    async flush() {
      if (busy || !pending.length) return;
      busy = true;
      const batch = pending.splice(0, 10);
      const lost = dropped; dropped = 0;
      try {
        await send({ session, dropped: lost, records: batch });
      } catch {
        // Keep newest evidence during an outage, without unbounded retries.
        pending.unshift(...batch);
        dropped += lost;
        if (pending.length > 400) { dropped += pending.length - 400; pending.splice(0, pending.length - 400); }
      } finally { busy = false; }
    },
  };
}

let installed = false;
let trace;
app.registerExtension({
  name: "liuxinyu.FocusMonitor",
  setup() {
    if (installed) return;
    installed = true;
    const session = crypto.randomUUID();
    const sink = createFocusSink(async body => {
      const response = await api.fetchApi("/liuxinyu/focus/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000), keepalive: true,
      });
      if (!response.ok) throw new Error(`Focus log HTTP ${response.status}`);
    }, session);
    trace = startFocusTrace(record => {
      const stack = record.stack?.replace(/([?])[^ \n)]+/g, "?…").slice(0, 3000);
      sink.add({ ...record, stack, viewport: [innerWidth, innerHeight],
        userActivation: { active: navigator.userActivation?.isActive ?? false,
          hasBeenActive: navigator.userActivation?.hasBeenActive ?? false } });
    });
    // Canvas already has its own guard wrapper, which may hold a pre-trace
    // native focus reference. Observe that entry as well as the DOM prototype.
    trace.watch?.(app.canvas?.canvas, "focus", "canvas.focus");
    window.comfyFocusTrace = trace;
    setInterval(() => { void sink.flush(); }, 2000);
    document.addEventListener("visibilitychange", () => { void sink.flush(); });
    window.addEventListener("pagehide", () => { void sink.flush(); });
    void sink.flush();
  },
  afterConfigureGraph() { trace?.watch?.(app.canvas?.canvas, "focus", "canvas.focus"); },
});
