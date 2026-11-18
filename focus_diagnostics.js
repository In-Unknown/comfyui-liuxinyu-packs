// Opt-in diagnostics: importing this module does not install hooks or change focus.
let activeTrace;

export function startFocusTrace(onRecord) {
  if (activeTrace) {
    if (onRecord) activeTrace.subscribe(onRecord);
    return activeTrace;
  }
  const subscribers = new Set(onRecord ? [onRecord] : []);
  const records = [];
  const restores = [];
  const watched = new WeakMap();
  const listeners = [];
  let blurUntil = 0;
  let sequence = 0;
  let stopped = false;
  let lastInteraction = null;
  const element = value => value && ({
    tag: value.tagName ?? (value === window ? "WINDOW" : undefined),
    id: value.id || undefined,
    classes: typeof value.className === "string" ? value.className.slice(0, 200) : undefined,
  });
  const record = (kind, detail = {}) => {
    try {
      const item = { sequence: ++sequence, time: new Date().toISOString(), kind,
        hidden: document.hidden, hasFocus: document.hasFocus(),
        interactionAgeMs: lastInteraction === null ? null : Math.round(performance.now() - lastInteraction),
        activeElement: element(document.activeElement), ...detail };
      records.push(item);
      if (records.length > 1500) records.shift();
      for (const subscriber of subscribers) {
        try { subscriber(item); } catch { /* A failed sink cannot change focus. */ }
      }
    } catch { /* Diagnostics must never interrupt the observed operation. */ }
  };
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler, true);
    listeners.push(() => target.removeEventListener(type, handler, true));
  };
  for (const type of ["blur", "focus", "focusin", "focusout"]) {
    listen(window, type, event => {
      if (type === "blur" || type === "focusout") blurUntil = performance.now() + 500;
      record(type, { target: element(event.target), relatedTarget: element(event.relatedTarget),
        trusted: event.isTrusted });
    });
  }
  listen(document, "visibilitychange", () => record("visibilitychange"));
  listen(window, "pagehide", () => record("pagehide"));
  listen(window, "pageshow", () => record("pageshow"));
  const interact = (kind, event) => {
    const previous = lastInteraction;
    if (event.isTrusted) lastInteraction = performance.now();
    if (previous === null || performance.now() - previous >= 1000 || kind === "pointerdown")
      record(kind, { target: element(event.target), trusted: event.isTrusted });
  };
  listen(window, "pointerdown", event => interact("pointerdown", event));
  // No key values, text contents, form values, workflow data or screenshots.
  listen(window, "keydown", event => interact("keydown", event));
  const wrap = (target, key, label) => {
    if (!target || typeof target[key] !== "function") return;
    if (watched.get(target)?.get(key) === target[key]) return;
    const own = Object.getOwnPropertyDescriptor(target, key);
    const original = target[key];
    const wrapped = function (...args) {
      if (!stopped) {
        const suspicious = document.hidden || !document.hasFocus() || performance.now() < blurUntil;
        record(label, { target: element(this), suspicious,
          stack: new Error().stack?.split("\n").slice(1, 13).join("\n") });
      }
      return Reflect.apply(original, this, args);
    };
    try {
      Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapped });
      if (!watched.has(target)) watched.set(target, new Map());
      watched.get(target).set(key, wrapped);
      restores.push(() => {
        if (target[key] !== wrapped) return;
        if (own) Object.defineProperty(target, key, own);
        else delete target[key];
      });
    } catch { record("hook-unavailable", { method: label }); }
  };
  wrap(HTMLElement.prototype, "focus", "HTMLElement.focus");
  wrap(window, "focus", "window.focus");
  wrap(window.HTMLDialogElement?.prototype, "showModal", "dialog.showModal");
  const trace = {
    watch: wrap,
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    report: () => ({ version: 1, stopped, records: records.map(r => ({ ...r })) }),
    mark: () => record("user-reported-incident"),
    download() {
      const blob = new Blob([JSON.stringify(trace.report(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `comfy-focus-${Date.now()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    stop() {
      if (stopped) return;
      record("trace-stopped"); stopped = true;
      listeners.forEach(remove => remove());
      restores.reverse().forEach(restore => restore());
      activeTrace = undefined;
    },
  };
  activeTrace = trace;
  record("trace-started");
  return trace;
}
