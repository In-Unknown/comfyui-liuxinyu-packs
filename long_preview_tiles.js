// Coordinates stay in node pixels. Canvas zoom changes resolution, not layout.
export function choosePreviewLevel(levels, width, height, scale, zoom, dpr) {
  const density = scale * zoom * dpr;
  let selected = levels[0];
  for (const level of levels) {
    if (level.width / width >= density && level.height / height >= density) selected = level;
    else break;
  }
  return selected;
}

export function visiblePreviewTiles(level, geometry, scrollLeft, scrollTop) {
  const { width, height, viewportWidth, viewportHeight } = geometry;
  const clip = geometry.clip || { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
  const offsetX = Math.max(0, (viewportWidth - width) / 2);
  const offsetY = Math.max(0, (viewportHeight - height) / 2);
  const x0 = Math.max(0, scrollLeft + clip.left - offsetX) / width * level.width;
  const y0 = Math.max(0, scrollTop + clip.top - offsetY) / height * level.height;
  const x1 = Math.min(width, scrollLeft + clip.right - offsetX) / width * level.width;
  const y1 = Math.min(height, scrollTop + clip.bottom - offsetY) / height * level.height;
  if (!(x1 > x0 && y1 > y0)) return [];
  const size = level.tile_size;
  const cols = Math.ceil(level.width / size);
  const rows = Math.ceil(level.height / size);
  const tiles = [];
  // One adjacent tile anticipates scrolling without decoding the entire long image.
  for (let row = Math.max(0, Math.floor(y0 / size) - 1); row <= Math.min(rows - 1, Math.ceil(y1 / size)); row++) {
    for (let col = Math.max(0, Math.floor(x0 / size) - 1); col <= Math.min(cols - 1, Math.ceil(x1 / size)); col++) {
      const left = col * size / level.width * width;
      const top = row * size / level.height * height;
      const right = Math.min((col + 1) * size, level.width) / level.width * width;
      const bottom = Math.min((row + 1) * size, level.height) / level.height * height;
      tiles.push({ filename: level.filename ?? `${level.prefix}${row}_${col}.png`, left, top,
        width: right - left, height: bottom - top });
    }
  }
  return tiles;
}

export function previewURL(api, meta, filename = meta.filename) {
  return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: meta.subfolder || "", type: meta.type || "temp" })}`);
}

export class PreviewTiles {
  constructor(surface, api, overview) {
    this.surface = surface;
    this.api = api;
    this.overview = overview;
    this.cache = new Map();
  }

  clear() {
    for (const { image, element } of this.cache.values()) {
      image.onload = image.onerror = null;
      element.remove();
      image.removeAttribute("src");
    }
    this.cache.clear();
    if (this.overview) this.overview.style.display = "block";
  }

  showOverview() {
    // Keep decoded tiles cached, but exclude them from painting during zoom.
    for (const { element } of this.cache.values()) element.remove();
    if (this.overview) this.overview.style.display = "block";
  }

  render(meta, geometry, scrollLeft, scrollTop, zoom, dpr) {
    const levels = meta.display?.levels;
    if (!levels?.length) return;
    const [width, height] = meta.preview_size;
    const level = choosePreviewLevel(levels, width, height, geometry.scale, zoom, dpr);
    const tiles = visiblePreviewTiles(level, geometry, scrollLeft, scrollTop);
    const visible = new Set(tiles.map(tile => tile.filename));
    if (this.overview) this.overview.style.display = "none";
    for (const [name, { element }] of this.cache) {
      if (!visible.has(name)) element.remove();
    }
    for (const tile of tiles) {
      let entry = this.cache.get(tile.filename);
      if (!entry) {
        const element = document.createElement("div");
        element.style.cssText = "position:absolute; overflow:hidden; pointer-events:none; background-repeat:no-repeat;";
        element.style.backgroundImage = `url("${previewURL(this.api, meta, levels.at(-1).filename)}")`;
        const image = document.createElement("img");
        image.alt = "";
        image.decoding = "async";
        image.draggable = false;
        image.style.cssText = "display:block; width:100%; height:100%; max-width:none; max-height:none; opacity:0;";
        // Replace each blurred patch atomically, so transparent pixels aren't blended twice.
        image.onload = () => { element.style.backgroundImage = "none"; image.style.opacity = "1"; };
        element.appendChild(image);
        image.src = previewURL(this.api, meta, tile.filename);
        entry = { element, image };
      }
      this.cache.delete(tile.filename);
      this.cache.set(tile.filename, entry);
      Object.assign(entry.element.style, { left: `${tile.left}px`, top: `${tile.top}px`,
        width: `${tile.width}px`, height: `${tile.height}px`,
        backgroundSize: `${geometry.width}px ${geometry.height}px`, backgroundPosition: `${-tile.left}px ${-tile.top}px` });
      if (entry.element.parentElement !== this.surface) this.surface.appendChild(entry.element);
    }
    for (const [name, { image }] of this.cache) {
      if (this.cache.size <= Math.max(16, visible.size)) break;
      if (!visible.has(name)) {
        image.onload = image.onerror = null;
        image.removeAttribute("src");
        this.cache.delete(name);
      }
    }
  }
}
