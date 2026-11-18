// Older servers replay only `executing` on reconnect. Feed that confirmed node
// through the frontend's native progress channel until a complete snapshot arrives.
export function installExecutionResume(api, getRoot, onRestore, report) {
  let ready = false, complete = false, pending = null, job = null, lookup = null, revision = 0;
  let snapshot = null;
  let emitted = null;
  const ownEvents = new WeakSet();

  function publish() {
    const root = getRoot();
    if (!ready || !job || root?.id !== job.workflowId) return;
    if (complete) {
      if (snapshot?.prompt_id === job.id) onRestore(job.id, root, snapshot);
      return;
    }
    if (pending == null) return;
    const key = `${job.id}:${pending}`;
    if (emitted === key) return;
    const nodeId = String(pending);
    const detail = { prompt_id: job.id, nodes: { [nodeId]: {
      node_id: nodeId, display_node_id: nodeId, prompt_id: job.id,
      state: "running", value: 0, max: 1,
    } } };
    ownEvents.add(detail);
    emitted = key;
    onRestore(job.id, root);
    api.dispatchEvent(new CustomEvent("progress_state", { detail }));
  }

  async function restore() {
    if (!ready || (pending == null && !snapshot)) return;
    if (job) { publish(); return; }
    if (lookup) return lookup;
    const ticket = revision;
    lookup = (async () => {
      try {
        const response = await api.fetchApi("/queue");
        if (!response.ok) throw new Error(`恢复运行状态：队列 HTTP ${response.status}`);
        const queue = await response.json();
        if (ticket !== revision) return;
        const running = queue.queue_running || [];
        const candidates = running.filter(entry => !api.clientId || entry[3]?.client_id === api.clientId);
        if (candidates.length !== 1) return;
        const entry = candidates[0];
        const workflowId = entry[3]?.extra_pnginfo?.workflow?.id;
        if (!workflowId) return;
        job = { id: entry[1], workflowId };
        publish();
      } catch (error) { report(error); }
    })().finally(() => { lookup = null; });
    return lookup;
  }

  api.addEventListener("progress_state", ({ detail }) => {
    if (!ownEvents.has(detail)) {
      complete = true;
      snapshot = detail;
    }
  });
  api.addEventListener("executing", ({ detail }) => {
    pending = typeof detail === "object" ? detail?.display_node ?? detail?.node : detail;
    if (pending == null) {
      if (!complete && job && emitted) {
        const detail = { prompt_id: job.id, nodes: {} };
        ownEvents.add(detail);
        api.dispatchEvent(new CustomEvent("progress_state", { detail }));
      }
      revision++; job = null; emitted = null; return;
    }
    void restore();
  });
  const reset = () => { revision++; complete = false; snapshot = null; pending = null; job = null; emitted = null; };
  api.addEventListener("reconnecting", reset);
  api.addEventListener("execution_start", reset);
  for (const name of ["execution_success", "execution_error", "execution_interrupted"]) api.addEventListener(name, reset);
  return { start() { ready = true; return restore(); }, restore };
}
