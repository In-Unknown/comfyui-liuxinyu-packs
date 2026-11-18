// Observe displayed geometry, never streaming text or the original canvas position.
export class ActivityFollow {
  constructor() { this.enabled = true; this.reset(); }

  reset() { this.items = []; this.root = null; this.width = null; this.since = 0; }

  sample(items, now, root, width) {
    const changed = root !== this.root || width !== this.width || items.length !== this.items.length
      || items.some((item, i) => item.card !== this.items[i].card || item.jobId !== this.items[i].jobId);
    if (changed) {
      this.root = root; this.width = width; this.since = now;
      this.items = items.map(item => ({ ...item, last: null, continuous: false }));
      return null;
    }
    let target = null;
    for (let i = 0; i < items.length; i++) {
      const previous = this.items[i];
      if (previous.last !== null && now - previous.last > 2000) {
        previous.last = null; previous.continuous = false;
      }
      if (Math.abs(items[i].height - previous.height) > 0.5) {
        previous.height = items[i].height;
        if (now - this.since > 2000) {
          previous.continuous = previous.last !== null;
          previous.last = now;
        }
      }
      if (previous.continuous) target = previous.card;
    }
    return target;
  }
}

export function followCardBottom(content, element) {
  const viewport = content.getBoundingClientRect();
  const bottom = element.getBoundingClientRect().bottom;
  const next = content.scrollTop + bottom - (viewport.top + content.clientTop + content.clientHeight) + 12;
  const top = Math.max(0, Math.min(content.scrollHeight - content.clientHeight, next));
  if (Math.abs(content.scrollTop - top) <= 0.5) return false;
  content.scrollTop = top;
  return true;
}
