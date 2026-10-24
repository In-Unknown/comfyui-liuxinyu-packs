// Use the same column search, partial last row and pixel-size cap as PreviewImage.
export function layoutThumbnailGrid(grid, images, width, height) {
  if (!width || !height || !images.length || images.some(img => !img.naturalWidth || !img.naturalHeight)) return;
  const ratio = images[0].naturalWidth / images[0].naturalHeight;
  const compact = images.every(img => img.naturalWidth / img.naturalHeight === ratio);
  let layoutImages = images;
  if (!compact) {
    const side = images.reduce((max, img) => Math.max(max, img.naturalWidth, img.naturalHeight), 0);
    layoutImages = [{ naturalWidth: side, naturalHeight: side }];
    layoutImages.length = images.length;
  }
  const layout = window.comfyAPI.imagePreview.calculateImageGrid(layoutImages, width, height);
  const { cols, rows, cellWidth, cellHeight } = layout;
  // Fractional tracks share boundaries; rounding every cell leaves a strip at the edge.
  grid.style.width = `${cols * cellWidth}px`;
  grid.style.height = `${rows * cellHeight}px`;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  return { ...layout, compact };
}

// Variable-width cells share a row height, so mixed cropped ratios need no letterboxing.
export function layoutThumbnailRows(grid, images, width, height) {
  if (!(width > 0 && height > 0) || !images.length ||
      images.some(img => !(img.naturalWidth > 0 && img.naturalHeight > 0))) return;
  const ratios = images.map(img => img.naturalWidth / img.naturalHeight);
  const maxHeight = images.reduce((max, img) => Math.max(max, img.naturalHeight), 0);
  const cumulative = [0];
  for (const ratio of ratios) cumulative.push(cumulative[cumulative.length - 1] + ratio);
  const totalRatio = cumulative[cumulative.length - 1];
  let best;
  for (let cols = 1; cols <= images.length; cols++) {
    const rows = Math.ceil(images.length / cols);
    let widest = 0;
    for (let start = 0; start < images.length; start += cols) {
      widest = Math.max(widest, cumulative[Math.min(start + cols, images.length)] - cumulative[start]);
    }
    const rowHeight = Math.min(height / rows, width / widest, maxHeight);
    const area = totalRatio * rowHeight * rowHeight;
    if (!best || area > best.area) best = { cols, rows, rowHeight, width: widest * rowHeight, area };
  }
  grid.style.display = "block";
  grid.style.position = "relative";
  grid.style.width = `${best.width}px`;
  grid.style.height = `${best.rows * best.rowHeight}px`;
  let x = 0;
  [...grid.children].forEach((cell, index) => {
    if (index % best.cols === 0) x = 0;
    const cellWidth = ratios[index] * best.rowHeight;
    Object.assign(cell.style, {
      position: "absolute", left: `${x}px`, top: `${Math.floor(index / best.cols) * best.rowHeight}px`,
      width: `${cellWidth}px`, height: `${best.rowHeight}px`,
    });
    x += cellWidth;
  });
  return best;
}
