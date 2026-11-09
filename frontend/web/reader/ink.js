// Geometry of handwriting: no DOM here, so the export and the tests use the same code.
//
// Items live in page units: a PDF page's points at zoom 1 (top-left origin, y down), or a note
// page's 595 × 842 (A4). Shapes:
//   ink:       { id, type: "ink", color, width, pen?, points: [[x, y, pressure], ...] }
//              pen: "fountain" (the default, as before pens had types), "ballpoint" or "brush"
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

// How each pen answers pressure (0..1 from a stylus; 0 means none, from a mouse or a finger), like
// the note apps' pens: a fountain pen swells with pressure, a ballpoint barely, a brush a lot and
// tapers at both ends.
export const PEN_TYPES = ["fountain", "ballpoint", "brush"];
const PRESSURE = { fountain: [0.35, 1.1], ballpoint: [0.85, 0.3], brush: [0.15, 1.7] };

/** Half the stroke's width at each point: pressure from a pen makes it thicker or thinner. */
function radii(points, width, pen = "fountain") {
  const [base, gain] = PRESSURE[pen] || PRESSURE.fountain;
  let r = points.map((p) => (width / 2) * (p.length > 2 && p[2] > 0 ? base + gain * p[2] : 1));
  if (pen === "brush" && points.length > 2) { // a brush's tips: thin over the first and last stretch of the line
    const along = [0];
    for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const total = along[along.length - 1], tip = Math.min(total * 0.2, width * 6) || 1;
    r = r.map((v, i) => v * Math.max(0.25, Math.min(1, along[i] / tip, (total - along[i]) / tip)));
  }
  // smooth, so a jittery pressure sensor doesn't make the line lumpy
  return r.map((v, i) => (r[Math.max(0, i - 1)] + 2 * v + r[Math.min(r.length - 1, i + 1)]) / 4);
}

/** The outline of an ink stroke as a closed polygon, with round ends. */
export function strokeOutline(points, width, pen = "fountain") {
  if (!points.length) return [];
  const r = radii(points, width, pen);
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

/** A copy of the item scaled by k around (ox, oy): the lasso's resize handle. */
export function scaled(item, ox, oy, k) {
  const at = (v, o) => round(o + (v - o) * k);
  if (item.type === "text") return { ...item, x: at(item.x, ox), y: at(item.y, oy), w: round(item.w * k), size: round(Math.max(4, item.size * k)) };
  return { ...item, width: round(Math.max(0.2, item.width * k)), points: item.points.map(([x, y, ...rest]) => [at(x, ox), at(y, oy), ...rest]) };
}

/** Points along the line no further apart than `step`, so an eraser can't slip between them. */
function densify(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k < n; k++) out.push(a.map((v, j) => v + ((b[j] ?? v) - v) * (k / n)));
    out.push(b);
  }
  return out;
}

/**
 * A partial eraser (the note apps' "erase by area"): what is left of an ink or highlighter stroke
 * once a circle of radius `r` at (x, y) has rubbed through it. null when the circle misses it;
 * otherwise the pieces on either side (maybe none), each a copy of the item with a new id.
 */
export function eraseFrom(item, x, y, r) {
  if (item.type === "text" || !hits(item, x, y, r)) return null;
  const reach = r + item.width / 2;
  const pts = densify(item.points, Math.max(0.5, reach / 3));
  const pieces = [];
  let run = [];
  for (const p of pts) {
    if (Math.hypot(p[0] - x, p[1] - y) <= reach) { if (run.length) pieces.push(run); run = []; }
    else run.push(p);
  }
  if (run.length) pieces.push(run);
  if (pieces.length === 1 && pieces[0].length === pts.length) return null;
  return pieces.filter((piece) => piece.length > 1).map((piece) => ({ ...item, id: newId(), points: simplify(piece, 0.2) }));
}

/**
 * "Draw and hold" (GoodNotes, Samsung Notes): the shape a rough stroke was meant to be, as the
 * points of a clean one, or null when it is none of them. A line; a closed loop with three or four
 * corners is a triangle or a rectangle-like quadrilateral; a smooth closed loop is an ellipse.
 * Pressure is kept as the stroke's average.
 */
export function recognizeShape(points) {
  if (points.length < 3) return null;
  const pressure = points.reduce((sum, p) => sum + (p[2] || 0), 0) / points.length;
  const at = ([x, y]) => [round(x), round(y), Math.round(pressure * 100) / 100];
  const first = points[0], last = points[points.length - 1];
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const diagonal = Math.hypot(x1 - x0, y1 - y0);
  if (length < 8 || diagonal < 6) return null;
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  // a line: no point strays far from the line between the ends
  if (chord > 0.8 * length && Math.max(...points.map((p) => segmentDistance(p, first, last))) <= Math.max(1.5, 0.06 * chord)) {
    return [at(first), at(last)];
  }
  if (chord > 0.25 * diagonal) return null; // its ends far apart: not a closed shape
  // corners: what is left of the loop after dropping the points that add little
  const loop = [...points, first];
  let corners = simplify(loop.map(([x, y]) => [x, y]), 0.1 * diagonal).slice(0, -1);
  // where the stroke started (or a wobble) can leave a "corner" on a straight side: drop it
  for (let changed = true; changed && corners.length > 3;) {
    changed = false;
    for (let i = 0; i < corners.length; i++) {
      const prev = corners[(i + corners.length - 1) % corners.length], next = corners[(i + 1) % corners.length];
      if (segmentDistance(corners[i], prev, next) < 0.08 * diagonal) { corners.splice(i, 1); changed = true; break; }
    }
  }
  if (corners.length === 3) return [...corners, corners[0]].map(at);
  if (corners.length === 4) return [...corners, corners[0]].map(at);
  // an ellipse: every point about as far from the centre as the box says it should be
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  if (rx < 2 || ry < 2) return null;
  const off = points.map(([x, y]) => Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1));
  if (off.reduce((a, b) => a + b, 0) / off.length > 0.2) return null;
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))); // Ramanujan
  if (length > 1.5 * perimeter) return null; // went round more than once, or scribbled
  return Array.from({ length: 49 }, (_, k) => at([cx + rx * Math.cos((2 * Math.PI * k) / 48), cy + ry * Math.sin((2 * Math.PI * k) / 48)]));
}

/** Colours are kept to #rgb / #rrggbb, so nothing else ever reaches an SVG attribute. */
export const safeColour = (c, fallback = "#1b1b1a") => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : fallback);

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
