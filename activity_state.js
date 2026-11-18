// Execution IDs may belong to loop expansions; display_node_id identifies the saved node.
export class ActivityState {
  constructor() {
    this.jobs = new Map();
    this.order = 0;
    this.currentJobId = null;
    this.finished = new Set();
  }

  start(id, root) {
    if (!id || this.jobs.has(id) || this.finished.has(id)) return false;
    this.currentJobId = id;
    this.jobs.set(id, { root, rootId: root?.id, nodes: new Map(), order: ++this.order });
    return true;
  }

  progress(detail, root) {
    const id = detail?.prompt_id;
    if (!id) return;
    this.start(id, root);
    const job = this.jobs.get(id);
    if (!job) return;
    job.hasProgressSnapshot = true;
    const next = new Map();
    for (const [executionId, state] of Object.entries(detail.nodes || {})) {
      if (state.state !== "running") continue;
      const path = String(state.display_node_id ?? state.node_id ?? executionId);
      const previous = next.get(path) || job.nodes.get(path);
      next.set(path, { path, state, order: previous?.order ?? ++this.order });
    }
    job.nodes = next;
  }

  finish(id) {
    if (!id) return;
    this.jobs.delete(id);
    this.finished.add(id);
    if (this.finished.size > 256) this.finished.delete(this.finished.values().next().value);
    if (this.currentJobId === id) this.currentJobId = null;
  }

  executing(detail, root) {
    const id = detail?.prompt_id || this.currentJobId;
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.root !== root || job.hasProgressSnapshot) return;
    const path = typeof detail === "object" ? detail?.display_node_id ?? detail?.display_node ?? detail?.node : detail;
    job.nodes.clear();
    if (path != null) job.nodes.set(String(path), { path: String(path), state: { state: "running" }, order: ++this.order });
  }

  entries(root) {
    const entries = new Map();
    for (const [jobId, job] of this.jobs) {
      if (job.root !== root || job.rootId !== root?.id) continue;
      for (const entry of job.nodes.values()) {
        if (!entries.has(entry.path)) entries.set(entry.path, { ...entry, jobId, root });
      }
    }
    return [...entries.values()].sort((a, b) => a.order - b.order);
  }

  clear() { this.jobs.clear(); this.finished.clear(); this.currentJobId = null; }
}
