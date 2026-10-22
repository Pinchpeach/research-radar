// Geometry of handwriting: no DOM here, so the export and the tests use the same code.
//
// Items live in page units: a PDF page's points at zoom 1 (top-left origin, y down), or a note
// page's 595 × 842 (A4). Shapes:
//   ink:       { id, type: "ink", color, width, points: [[x, y, pressure], ...] }
//   highlight: { id, type: "highlight", color, width, points: [[x, y], ...] }
//   text:      { id, type: "text", color, size, x, y, w, text }   (x, y: top-left of the box)

export const HIGHLIGHT_OPACITY = 0.35;
export const TEXT_LINE = 1.3; // line height, in font sizes

const round = (v) => Math.round(v * 10) / 10;

/** Drop points that add nothing (Ramer–Douglas–Peucker), keeping the ends. */
export function simplify(points, tolerance = 0.35) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]).map((p) => p.map(round));
}

/** Distance from point p to the segment a–b. */
export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Half the stroke's width at each point: pressure from a pen makes it thicker or thinner. */
function radii(points, width) {
  const r = points.map((p) => (width / 2) * (p.length > 2 && p[2] > 0 ? 0.35 + 1.1 * p[2] : 1));
  // smooth, so a jittery pressure sensor doesn't make the line lumpy
  return r.map((v, i) => (r[Math.max(0, i - 1)] + 2 * v + r[Math.min(r.length - 1, i + 1)]) / 4);
}

/** The outline of an ink stroke as a closed polygon, with round ends. */
export function strokeOutline(points, width) {
  if (!points.length) return [];
  const r = radii(points, width);
  if (points.length === 1) return circle(points[0], r[0]);
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    left.push([points[i][0] - dy * r[i], points[i][1] + dx * r[i]]);
    right.push([points[i][0] + dy * r[i], points[i][1] - dx * r[i]]);
  }
  const cap = (p, from, rad) => { // half circle from `from` around p, on the far side
    const start = Math.atan2(from[1] - p[1], from[0] - p[0]), out = [];
    for (let k = 1; k < 6; k++) out.push([p[0] + rad * Math.cos(start - (Math.PI * k) / 6), p[1] + rad * Math.sin(start - (Math.PI * k) / 6)]);
    return out;
  };
  const last = points.length - 1;
  return [...left, ...cap(points[last], left[last], r[last]), ...right.reverse(), ...cap(points[0], right[right.length - 1], r[0])];
}

function circle(p, r) {
  return Array.from({ length: 12 }, (_, k) => [p[0] + r * Math.cos((Math.PI * k) / 6), p[1] + r * Math.sin((Math.PI * k) / 6)]);
}

/** SVG path data for a polygon; `flipY` maps y to -y (pdf-lib draws SVG paths with y up). */
export function polygonPath(poly, flipY = false) {
  if (!poly.length) return "";
  const s = flipY ? -1 : 1;
  return `M${poly.map(([x, y]) => `${round(x)} ${round(s * y)}`).join("L")}Z`;
}

/** SVG path data for a highlighter's centre line, smoothed through the midpoints. */
export function linePath(points, flipY = false) {
  if (!points.length) return "";
  const s = flipY ? -1 : 1, p = (q) => `${round(q[0])} ${round(s * q[1])}`;
  if (points.length < 3) return `M${p(points[0])}L${p(points[points.length - 1])}`;
  let d = `M${p(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
    d += `Q${p(points[i])} ${p(mid)}`;
  }
  return `${d}L${p(points[points.length - 1])}`;
}

/** Lines of a text box, wrapped at its width with a rough character measure (export matches screen). */
export function textLines(item, measure = (s) => s.length * item.size * 0.55) {
  const out = [];
  for (const para of String(item.text || "").split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (line && measure(line + word) > item.w) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line += word;
    }
    out.push(line);
  }
  return out;
}

export function bbox(item) {
  if (item.type === "text") {
    const lines = textLines(item).length;
    return [item.x, item.y, item.x + item.w, item.y + lines * item.size * TEXT_LINE];
  }
  const pad = item.width / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of item.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Does the point (x, y) touch the item, within `tolerance` page units? */
export function hits(item, x, y, tolerance = 4) {
  const [x0, y0, x1, y1] = bbox(item);
  if (x < x0 - tolerance || x > x1 + tolerance || y < y0 - tolerance || y > y1 + tolerance) return false;
  if (item.type === "text") return true;
  const reach = item.width / 2 + tolerance, pts = item.points;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i++) if (segmentDistance([x, y], pts[i - 1], pts[i]) <= reach) return true;
  return false;
}

export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Items caught by a lasso: most of their points (or a text box's centre) inside the loop. */
export function lassoed(items, poly) {
  if (poly.length < 3) return [];
  return items.filter((item) => {
    if (item.type === "text") {
      const [x0, y0, x1, y1] = bbox(item);
      return pointInPolygon(poly, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    const inside = item.points.filter(([x, y]) => pointInPolygon(poly, x, y)).length;
    return inside >= Math.max(1, item.points.length / 2);
  });
}

/** A copy of the item moved by (dx, dy). */
export function moved(item, dx, dy) {
  if (item.type === "text") return { ...item, x: round(item.x + dx), y: round(item.y + dy) };
  return { ...item, points: item.points.map(([x, y, ...rest]) => [round(x + dx), round(y + dy), ...rest]) };
}

/** Colours are kept to #rgb / #rrggbb, so nothing else ever reaches an SVG attribute. */
export const safeColour = (c, fallback = "#1b1b1a") => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : fallback);

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
