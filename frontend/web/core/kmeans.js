// k-means on sparse TF-IDF rows, as scikit-learn's KMeans(n_init=10) does it: greedy k-means++
// seeding, Lloyd iterations, best of several runs by inertia. Seeded, so a map is the same
// every time it is drawn (the clusters can differ from the desktop app's, which uses numpy's RNG).

/** Small seeded PRNG (mulberry32), returns floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sqNorm = (row) => { let s = 0; for (const w of row.values()) s += w * w; return s; };

function dist(row, rowNorm, center, centerNorm) {
  let d = 0;
  for (const [i, w] of row) d += w * center[i];
  return Math.max(0, rowNorm - 2 * d + centerNorm);
}

const dense = (row, size) => { const c = new Float64Array(size); for (const [i, w] of row) c[i] = w; return c; };
const denseNorm = (c) => { let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * c[i]; return s; };

function pickWeighted(weights, random) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Math.floor(random() * weights.length);
  let r = random() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; }
  return weights.length - 1;
}

function seedCenters(rows, norms, k, size, random) {
  const trials = 2 + Math.floor(Math.log(k));
  const first = Math.floor(random() * rows.length);
  const centers = [dense(rows[first], size)];
  let closest = rows.map((row, i) => dist(row, norms[i], centers[0], norms[first]));
  while (centers.length < k) {
    let best = null;
    for (let t = 0; t < trials; t++) {
      const cand = pickWeighted(closest, random);
      const c = dense(rows[cand], size), cn = norms[cand];
      const next = rows.map((row, i) => Math.min(closest[i], dist(row, norms[i], c, cn)));
      const pot = next.reduce((a, b) => a + b, 0);
      if (!best || pot < best.pot) best = { c, next, pot };
    }
    centers.push(best.c);
    closest = best.next;
  }
  return centers;
}

function lloyd(rows, norms, centers, size, maxIter, tol) {
  const n = rows.length, k = centers.length;
  let labels = new Array(n).fill(0), inertia = 0;
  for (let it = 0; it < maxIter; it++) {
    const cn = centers.map(denseNorm);
    inertia = 0;
    const d = rows.map((row, i) => {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const v = dist(row, norms[i], centers[c], cn[c]); if (v < bd) { bd = v; best = c; } }
      labels[i] = best;
      inertia += bd;
      return bd;
    });
    const sums = centers.map(() => new Float64Array(size)), counts = new Array(k).fill(0);
    rows.forEach((row, i) => { counts[labels[i]] += 1; for (const [j, w] of row) sums[labels[i]][j] += w; });
    for (let c = 0; c < k; c++) {
      if (!counts[c]) { // empty cluster: move it to the point farthest from its center
        const far = d.indexOf(Math.max(...d));
        d[far] = 0;
        sums[c] = dense(rows[far], size);
        counts[c] = 1;
      }
      for (let j = 0; j < size; j++) sums[c][j] /= counts[c];
    }
    let shift = 0;
    for (let c = 0; c < k; c++) for (let j = 0; j < size; j++) shift += (sums[c][j] - centers[c][j]) ** 2;
    centers = sums;
    if (shift <= tol) break;
  }
  // final assignment against the final centers
  const cn = centers.map(denseNorm);
  inertia = 0;
  rows.forEach((row, i) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const v = dist(row, norms[i], centers[c], cn[c]); if (v < bd) { bd = v; best = c; } }
    labels[i] = best;
    inertia += bd;
  });
  return { labels, centers, inertia };
}

/** { labels, centers } for `rows` (sparse Maps over `size` terms). */
export function kmeans(rows, k, size, { nInit = 10, maxIter = 300, seed = 0 } = {}) {
  const norms = rows.map(sqNorm);
  // tolerance relative to the data's variance, like scikit-learn (tol=1e-4)
  const mean = new Float64Array(size);
  for (const row of rows) for (const [i, w] of row) mean[i] += w / rows.length;
  let variance = 0;
  for (const row of rows) variance += sqNorm(row);
  variance = (variance / rows.length - denseNorm(mean)) / size;
  const tol = 1e-4 * Math.max(variance, 0);
  const random = rng(seed);
  let best = null;
  for (let run = 0; run < nInit; run++) {
    const result = lloyd(rows, norms, seedCenters(rows, norms, k, size, random), size, maxIter, tol);
    if (!best || result.inertia < best.inertia) best = result;
  }
  return best;
}
