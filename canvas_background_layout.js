// Duijvestijn's order-21 perfect squared square (side 112), in skyline order.
const SIZES = [50, 35, 27, 8, 19, 15, 17, 11, 6, 24, 29, 25, 9, 2, 7, 18, 16, 42, 4, 37, 33];

export function squareLayout() {
  const skyline = new Array(112).fill(0);
  return SIZES.map(size => {
    const y = Math.min(...skyline), x = skyline.indexOf(y);
    skyline.fill(y + size, x, x + size);
    return { x, y, width: size, height: size };
  });
}

function segments(tiles, horizontal) {
  const groups = new Map(), ids = tiles.map(() => []);
  tiles.forEach((tile, i) => {
    for (let side = 0; side < 2; side++) {
      const position = horizontal ? tile.y + side * tile.height : tile.x + side * tile.width;
      const start = horizontal ? tile.x : tile.y;
      const end = start + (horizontal ? tile.width : tile.height);
      if (!groups.has(position)) groups.set(position, []);
      groups.get(position).push({ start, end, i, side });
    }
  });
  let count = 0;
  for (const [, edges] of [...groups].sort((a, b) => a[0] - b[0])) {
    let end = -Infinity;
    for (const edge of edges.sort((a, b) => a.start - b.start)) {
      if (edge.start > end) count++;
      end = Math.max(end, edge.end);
      ids[edge.i][edge.side] = count - 1;
    }
  }
  return { ids, count };
}

const squares = squareLayout();
const horizontal = segments(squares, true), vertical = segments(squares, false);
const squareNeighbors = squares.map((a, i) => squares.flatMap((b, j) => {
  if (i === j) return [];
  const touches = [[0, 0], [112, 0], [-112, 0], [0, 112], [0, -112]].some(([dx, dy]) => {
    const x = b.x + dx, y = b.y + dy;
    const sharedX = Math.min(a.x + a.width, x + b.width) - Math.max(a.x, x);
    const sharedY = Math.min(a.y + a.height, y + b.height) - Math.max(a.y, y);
    return (sharedY > 0 && (a.x + a.width === x || x + b.width === a.x)) ||
      (sharedX > 0 && (a.y + a.height === y || y + b.height === a.y));
  });
  return touches ? [j] : [];
}));

function solve(matrix, rhs) {
  const size = rhs.length;
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    const value = matrix[col][col];
    if (!Number.isFinite(value) || Math.abs(value) < 1e-14) return null;
    for (let j = col; j < size; j++) matrix[col][j] /= value;
    rhs[col] /= value;
    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j < size; j++) matrix[row][j] -= factor * matrix[col][j];
      rhs[row] -= factor * rhs[col];
    }
  }
  return rhs;
}

function electricalBlock(ratios, images) {
  // Height = voltage difference; width = current; conductance = image width/height.
  const size = horizontal.count - 2;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0)), rhs = new Array(size).fill(0);
  horizontal.ids.forEach(([top, bottom], i) => {
    const conductance = ratios[images[i]];
    for (const [a, b] of [[top, bottom], [bottom, top]]) {
      if (a === 0 || a === size + 1) continue;
      matrix[a - 1][a - 1] += conductance;
      if (b === size + 1) rhs[a - 1] += conductance;
      else if (b !== 0) matrix[a - 1][b - 1] -= conductance;
    }
  });
  const interior = solve(matrix, rhs);
  if (!interior) return null;
  const ys = [0, ...interior, 1];
  const adjacency = Array.from({ length: vertical.count }, () => []);
  vertical.ids.forEach(([left, right], i) => {
    const [top, bottom] = horizontal.ids[i];
    const width = ratios[images[i]] * (ys[bottom] - ys[top]);
    adjacency[left].push([right, width]); adjacency[right].push([left, -width]);
  });
  const xs = new Array(vertical.count); xs[0] = 0;
  const queue = [0];
  for (let q = 0; q < queue.length; q++) {
    const a = queue[q];
    for (const [b, width] of adjacency[a]) {
      if (xs[b] === undefined) { xs[b] = xs[a] + width; queue.push(b); }
      else if (Math.abs(xs[b] - xs[a] - width) > 1e-8 * Math.max(1, Math.abs(xs[b]))) return null;
    }
  }
  const tiles = squares.map((_, i) => {
    const [a, b] = horizontal.ids[i], [c, d] = vertical.ids[i];
    return { x: Math.min(xs[c], xs[d]), y: Math.min(ys[a], ys[b]),
      width: Math.abs(xs[d] - xs[c]), height: Math.abs(ys[b] - ys[a]), image: images[i] };
  });
  return { tiles, width: xs.at(-1), height: 1 };
}

export function mergeable(a, b, epsilon = 1e-8) {
  const near = (x, y) => Math.abs(x - y) <= epsilon;
  return (near(a.x, b.x) && near(a.width, b.width) && (near(a.y + a.height, b.y) || near(b.y + b.height, a.y))) ||
    (near(a.y, b.y) && near(a.height, b.height) && (near(a.x + a.width, b.x) || near(b.x + b.width, a.x)));
}

export function validLayout(layout, ratios) {
  const { tiles, width, height } = layout;
  if (!(width > 0 && height > 0)) return false;
  const epsilon = 1e-8 * Math.max(1, width, height);
  let area = 0;
  for (let i = 0; i < tiles.length; i++) {
    const a = tiles[i];
    if (![a.x, a.y, a.width, a.height].every(Number.isFinite) || Math.min(a.width, a.height) <= epsilon) return false;
    if (a.x < -epsilon || a.y < -epsilon || a.x + a.width > width + epsilon || a.y + a.height > height + epsilon) return false;
    if (Math.abs(a.width / a.height / ratios[a.image] - 1) > 1e-7) return false;
    area += a.width * a.height;
    for (let j = 0; j < i; j++) {
      const b = tiles[j];
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > epsilon &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > epsilon) return false;
      if (mergeable(a, b, epsilon)) return false;
    }
  }
  if (Math.abs(area - width * height) > epsilon * Math.max(width, height)) return false;
  // A repeated period must pass the same test across its right and bottom seams.
  for (const [dx, dy] of [[width, 0], [0, height]]) {
    const end = tiles.filter(t => dx ? Math.abs(t.x + t.width - width) < epsilon : Math.abs(t.y + t.height - height) < epsilon);
    const start = tiles.filter(t => dx ? Math.abs(t.x) < epsilon : Math.abs(t.y) < epsilon);
    for (const a of end) for (const b of start) if (mergeable(a, { ...b, x: b.x + dx, y: b.y + dy }, epsilon)) return false;
  }
  return true;
}

export function affineLayout(ratios, order) {
  // Constructive fallback: each image fills its own affinely scaled perfect square.
  let width = 0;
  const tiles = [];
  for (const image of order) {
    const ratio = ratios[image];
    for (const tile of squares) tiles.push({ x: width + tile.x / 112 * ratio, y: tile.y / 112,
      width: tile.width / 112 * ratio, height: tile.height / 112, image });
    width += ratio;
  }
  return { tiles, width, height: 1, method: "affine" };
}

function scatterImages(images, seed) {
  const neighbors = squareNeighbors;
  const remaining = new Map(); images.forEach(image => remaining.set(image, (remaining.get(image) || 0) + 1));
  const assigned = new Array(squares.length);
  for (let step = 0; step < squares.length; step++) {
    let target = -1, priority = -Infinity;
    for (let i = 0; i < squares.length; i++) if (assigned[i] === undefined) {
      const saturation = new Set(neighbors[i].map(j => assigned[j]).filter(value => value !== undefined)).size;
      const score = saturation * 100 + neighbors[i].length + positionSeed(seed, step, i) / 2 ** 32;
      if (score > priority) { target = i; priority = score; }
    }
    let choice, best = Infinity;
    for (const [image, count] of remaining) if (count) {
      let score = neighbors[target].filter(i => assigned[i] === image).length * 1000;
      for (let i = 0; i < squares.length; i++) if (assigned[i] === image) {
        const a = squares[target], b = squares[i];
        score += 112 / Math.max(1, Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2));
      }
      score += positionSeed(seed, step, image, 83) / 2 ** 32;
      if (score < best) { choice = image; best = score; }
    }
    assigned[target] = choice; remaining.set(choice, remaining.get(choice) - 1);
  }
  return assigned;
}

export function mosaicLayout(ratios, seed) {
  if (!ratios.length || ratios.some(r => !Number.isFinite(r) || r <= 0)) throw new Error("图片尺寸无效");
  const order = ratios.map((_, i) => i);
  let random = seed >>> 0;
  let best = null, bestScore = Infinity;
  for (let attempt = 0; attempt < (ratios.length > 1 ? 40 : 1); attempt++) {
    for (let i = order.length - 1; i > 0; i--) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const j = random % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const tiles = [];
    let width = 0, failed = false;
    for (let group = 0; group < Math.ceil(ratios.length / 21); group++) {
      const images = squares.map((_, i) => order[(group * 21 + i) % order.length]);
      // Shuffle occurrences as well as the source list, preserving balanced usage.
      for (let i = images.length - 1; i > 0; i--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const j = random % (i + 1); [images[i], images[j]] = [images[j], images[i]];
      }
      const block = electricalBlock(ratios, scatterImages(images, random));
      if (!block || !validLayout(block, ratios)) { failed = true; break; }
      tiles.push(...block.tiles.map(tile => ({ ...tile, x: tile.x + width })));
      width += block.width;
    }
    const layout = { tiles, width, height: 1, method: "electrical" };
    if (!failed && validLayout(layout, ratios)) {
      const score = separationScore(layout);
      if (score < bestScore) { best = layout; bestScore = score; }
    }
  }
  if (best) return best;
  const fallback = affineLayout(ratios, order);
  if (!validLayout(fallback, ratios)) throw new Error("图片比例跨度超出数值精度，未更改原背景");
  return fallback;
}

// Shared edges dominate; among similarly separated candidates prefer distant copies.
// Evaluate repeat seams too, before spatial and nested variants are constructed.
export function separationScore(layout) {
  let contact = 0, proximity = 0;
  for (const a of layout.tiles) for (const b of layout.tiles) {
    if (a.image !== b.image) continue;
    for (const [dx, dy] of [[0, 0], [layout.width, 0], [0, 1]]) {
      if (!dx && !dy && a === b) continue;
      const x = b.x + dx, y = b.y + dy;
      const overlapX = Math.min(a.x + a.width, x + b.width) - Math.max(a.x, x);
      const overlapY = Math.min(a.y + a.height, y + b.height) - Math.max(a.y, y);
      if (Math.abs(a.x + a.width - x) < 1e-9 || Math.abs(x + b.width - a.x) < 1e-9) contact += Math.max(0, overlapY);
      if (Math.abs(a.y + a.height - y) < 1e-9 || Math.abs(y + b.height - a.y) < 1e-9) contact += Math.max(0, overlapX);
      const distance = Math.hypot((a.x + a.width / 2 - x - b.width / 2) / layout.width, a.y + a.height / 2 - y - b.height / 2);
      proximity += Math.sqrt(a.width * a.height * b.width * b.height) / layout.width / (0.02 + distance);
    }
  }
  return 1000 * contact / (1 + layout.width) + proximity;
}

export function positionSeed(seed, ...coordinates) {
  let value = seed >>> 0;
  for (const coordinate of coordinates) {
    value = Math.imul(value ^ (coordinate | 0), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
  }
  return value >>> 0;
}

function edgeProfiles(layout) {
  const edges = { left: [], right: [], top: [], bottom: [] };
  for (const tile of layout.tiles) {
    if (Math.abs(tile.x) < 1e-10) edges.left.push([tile.y, tile.y + tile.height, tile.image]);
    if (Math.abs(tile.x + tile.width - layout.width) < 1e-10) edges.right.push([tile.y, tile.y + tile.height, tile.image]);
    if (Math.abs(tile.y) < 1e-10) edges.top.push([tile.x / layout.width, (tile.x + tile.width) / layout.width, tile.image]);
    if (Math.abs(tile.y + tile.height - 1) < 1e-10) edges.bottom.push([tile.x / layout.width, (tile.x + tile.width) / layout.width, tile.image]);
  }
  return sortEdges(edges);
}

function sortEdges(edges) {
  for (const intervals of Object.values(edges)) intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return edges;
}

function compatibleEdges(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (Math.abs(x[0] - y[0]) < 1e-10) {
      if (Math.abs(x[1] - y[1]) < 1e-10) return false;
      if (x[1] < y[1]) i++; else j++;
    } else if (x[0] < y[0]) i++; else j++;
  }
  return true;
}

function compatibleFamilies(a, b) {
  return compatibleEdges(a.edges.right, b.edges.left) && compatibleEdges(b.edges.right, a.edges.left) &&
    compatibleEdges(a.edges.bottom, b.edges.top) && compatibleEdges(b.edges.bottom, a.edges.top);
}

function compatibleBank(candidates) {
  // At most eight candidates: exhaustive selection keeps the largest safe palette.
  let best = [];
  for (let mask = 1; mask < 2 ** candidates.length; mask++) {
    const chosen = candidates.filter((_, i) => mask & (1 << i));
    if (chosen.length <= best.length) continue;
    if (chosen.every((a, i) => chosen.slice(i).every(b => compatibleFamilies(a, b)))) best = chosen;
  }
  return best;
}

function orientedSquares(orientation) {
  return squares.map(tile => {
    let x = tile.x / 112, y = tile.y / 112;
    const size = tile.width / 112;
    if (orientation & 4) x = 1 - x - size;
    for (let turn = 0; turn < (orientation & 3); turn++) [x, y] = [1 - y - size, x];
    return { x, y, size };
  });
}

function placedEdge(child, side) {
  const offset = side === "left" || side === "right" ? child.y : child.x;
  return child.family.edges[side].map(([a, b, image]) => [offset + a * child.size, offset + b * child.size, image]);
}

function sameImageContact(a, b) {
  let i = 0, j = 0, score = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x[2] === y[2]) score += Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0]));
    if (x[1] < y[1]) i++; else j++;
  }
  return score;
}

function childJoint(a, b, side, opposite, cache) {
  const key = [a.family.id, b.family.id, side, a.x, a.y, a.size, b.x, b.y, b.size].join(":");
  if (!cache.has(key)) {
    const left = placedEdge(a, side), right = placedEdge(b, opposite);
    cache.set(key, { safe: compatibleEdges(left, right), contact: sameImageContact(left, right) });
  }
  return cache.get(key);
}

function childrenContact(children, cache) {
  let score = 0;
  for (const a of children) for (const b of children) {
    if (a === b) continue;
    if (Math.abs(a.x + a.size - b.x) < 1e-10) score += childJoint(a, b, "right", "left", cache).contact;
    if (Math.abs(a.y + a.size - b.y) < 1e-10) score += childJoint(a, b, "bottom", "top", cache).contact;
  }
  return score;
}

function safeChildren(children, cache) {
  for (const a of children) for (const b of children) {
    if (a === b) continue;
    if (Math.abs(a.x + a.size - b.x) < 1e-10 &&
        !childJoint(a, b, "right", "left", cache).safe) return false;
    if (Math.abs(a.y + a.size - b.y) < 1e-10 &&
        !childJoint(a, b, "bottom", "top", cache).safe) return false;
  }
  return true;
}

function outside(child) {
  return Math.abs(child.x) < 1e-10 || Math.abs(child.y) < 1e-10 ||
    Math.abs(child.x + child.size - 1) < 1e-10 || Math.abs(child.y + child.size - 1) < 1e-10;
}

function parentEdges(children) {
  const edges = { left: [], right: [], top: [], bottom: [] };
  for (const child of children) {
    if (Math.abs(child.x) < 1e-10) edges.left.push(...placedEdge(child, "left"));
    if (Math.abs(child.x + child.size - 1) < 1e-10) edges.right.push(...placedEdge(child, "right"));
    if (Math.abs(child.y) < 1e-10) edges.top.push(...placedEdge(child, "top"));
    if (Math.abs(child.y + child.size - 1) < 1e-10) edges.bottom.push(...placedEdge(child, "bottom"));
  }
  return sortEdges(edges);
}

export function createHierarchy(layout, levels, seed) {
  let nextId = 0;
  const joints = new Map();
  const reflected = Array.from({ length: 4 }, (_, orientation) => {
    const tiles = layout.tiles.map(tile => ({ ...tile,
      x: orientation & 1 ? layout.width - tile.x - tile.width : tile.x,
      y: orientation & 2 ? 1 - tile.y - tile.height : tile.y }));
    const leaf = { ...layout, tiles };
    return { id: nextId++, depth: 0, tiles, edges: edgeProfiles(leaf) };
  });
  let families = compatibleBank(reflected), depth = 0;
  const banks = [families];
  for (let level = 1; level <= Math.max(0, Math.min(10, Math.floor(levels))); level++) {
    const candidates = [];
    for (let orientation = 0; orientation < 8; orientation++) {
      const geometry = orientedSquares(orientation);
      let first, firstScore = Infinity;
      for (let attempt = 0; attempt < 8; attempt++) {
        const children = geometry.map((tile, index) => {
          // Keep external boundaries compact; deeper refinement is inside the region.
          const bank = level > 3 && outside(tile) ? banks[2] : families;
          return { ...tile, family: bank[attempt === 0 ? 0 : positionSeed(seed, level, orientation, attempt, index) % bank.length] };
        });
        if (safeChildren(children, joints)) {
          const score = childrenContact(children, joints);
          if (score < firstScore) { first = children; firstScore = score; }
        }
      }
      if (!first) continue;
      const family = { id: nextId++, depth: level, edges: parentEdges(first), variants: [first] };
      if (!compatibleFamilies(family, family)) continue;
      // Vary interiors while keeping this family's external edge profile identical.
      // Every occurrence can independently select a variant without changing seams.
      for (let attempt = 1; attempt <= 12 && family.variants.length < 5; attempt++) {
        const children = first.map((child, index) => outside(child) ? child : { ...child,
          family: families[positionSeed(seed, level, orientation, attempt, index, 83) % families.length] });
        if (children.every((child, i) => child.family === first[i].family)) continue;
        if (family.variants.some(variant => variant.every((child, i) => child.family === children[i].family))) continue;
        if (safeChildren(children, joints)) family.variants.push(children);
      }
      const scored = family.variants.map(children => ({ children, score: childrenContact(children, joints) })).sort((a, b) => a.score - b.score);
      family.variants = scored.filter(item => item.score <= scored[0].score + 0.03).map(item => item.children);
      candidates.push(family);
    }
    const bank = compatibleBank(candidates);
    if (!bank.length) break;
    families = bank; banks.push(bank); depth = level;
  }
  return { families, depth, width: layout.width, seed, regions: new Map(), contacts: new Map() };
}

export function regionFamily(hierarchy, column, row) {
  const key = `${column}:${row}`;
  if (hierarchy.regions.has(key)) return hierarchy.regions.get(key);
  const seed = positionSeed(hierarchy.seed, column, row, 719);
  const rank = (x, y) => ((x % 2 + 2) % 2) + 2 * ((y % 2 + 2) % 2);
  const neighbors = [[-1, 0, "left", "right"], [1, 0, "right", "left"], [0, -1, "top", "bottom"], [0, 1, "bottom", "top"]]
    .filter(([dx, dy]) => rank(column + dx, row + dy) < rank(column, row))
    .map(([dx, dy, side, opposite]) => ({ side, opposite, family: regionFamily(hierarchy, column + dx, row + dy).family }));
  let family, best = Infinity;
  for (let i = 0; i < hierarchy.families.length; i++) {
    const candidate = hierarchy.families[(seed + i) % hierarchy.families.length];
    let score = 0;
    for (const neighbor of neighbors) {
      const pair = `${candidate.id}:${neighbor.family.id}:${neighbor.side}`;
      if (!hierarchy.contacts.has(pair)) hierarchy.contacts.set(pair, sameImageContact(candidate.edges[neighbor.side], neighbor.family.edges[neighbor.opposite]));
      score += hierarchy.contacts.get(pair);
    }
    if (score < best) { family = candidate; best = score; }
  }
  const result = { family, seed };
  if (hierarchy.regions.size >= 512) hierarchy.regions.delete(hierarchy.regions.keys().next().value);
  hierarchy.regions.set(key, result);
  return result;
}

export function regionChildren(family, seed) {
  if (!family.variants) return null;
  return family.variants[positionSeed(seed, family.id, 991) % family.variants.length];
}
