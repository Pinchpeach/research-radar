// The handwriting geometry (frontend/web/reader/ink.js): pen types, partial erasing, shapes, scaling.

import assert from "node:assert/strict";
import { test } from "node:test";
import { eraseFrom, PEN_TYPES, recognizeShape, scaled, strokeOutline } from "../../frontend/web/reader/ink.js";

const wobble = (pts, amount = 0.6) => pts.map(([x, y], i) => [x + Math.sin(i * 1.7) * amount, y + Math.cos(i * 2.3) * amount, 0.5]);
const along = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const width = (outline) => Math.max(...outline.map((p) => p[1])) - Math.min(...outline.map((p) => p[1]));

test("pen types answer pressure differently; a brush tapers", () => {
  assert.deepEqual(PEN_TYPES, ["fountain", "ballpoint", "brush"]);
  const hard = along([0, 0], [100, 0], 20).map(([x, y]) => [x, y, 1]), soft = hard.map(([x, y]) => [x, y, 0.1]);
  const spread = (pen) => width(strokeOutline(hard, 4, pen)) - width(strokeOutline(soft, 4, pen));
  assert.ok(spread("ballpoint") < spread("fountain") && spread("fountain") < spread("brush"));
  assert.deepEqual(strokeOutline(hard, 4), strokeOutline(hard, 4, "fountain")); // the default, as before
  const brush = strokeOutline(along([0, 0], [100, 0], 20).map(([x, y]) => [x, y, 0]), 4, "brush");
  const nearTip = brush.filter(([x]) => x < 2).map(([, y]) => Math.abs(y));
  assert.ok(Math.max(...nearTip) < 1.5); // thin at the start, though full width is 2 either side
});

test("the partial eraser cuts a stroke in two, leaves a missed one alone, removes a small one", () => {
  const line = { id: "a", type: "ink", color: "#000", width: 2, points: along([0, 0], [100, 0], 2).map(([x, y]) => [x, y, 0.5]) };
  const pieces = eraseFrom(line, 50, 0, 5);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.id !== "a" && p.color === "#000" && p.type === "ink"));
  assert.ok(Math.max(...pieces[0].points.map((p) => p[0])) < 45 && Math.min(...pieces[1].points.map((p) => p[0])) > 55);
  assert.equal(eraseFrom(line, 50, 30, 5), null);
  assert.deepEqual(eraseFrom({ ...line, points: [[48, 0, 0.5], [52, 0, 0.5]] }, 50, 0, 5), []);
  assert.equal(eraseFrom({ id: "t", type: "text", x: 0, y: 0, w: 50, size: 12, text: "hi" }, 10, 5, 5), null);
});

test("draw and hold: lines, triangles, rectangles and ellipses; scribbles stay as they are", () => {
  const rough = wobble(along([10, 10], [200, 60], 40)), line = recognizeShape(rough);
  assert.equal(line.length, 2);
  [rough[0], rough[40]].forEach(([x, y], i) => assert.ok(Math.hypot(line[i][0] - x, line[i][1] - y) < 0.2)); // from end to end
  const rect = [...along([60, 0], [100, 0], 10), ...along([100, 0], [100, 50], 10), ...along([100, 50], [0, 50], 20), ...along([0, 50], [0, 0], 10), ...along([0, 0], [55, 0], 10)];
  assert.equal(recognizeShape(wobble(rect)).length, 5); // four corners and back, though it started mid-side
  const tri = [...along([0, 100], [50, 0], 15), ...along([50, 0], [100, 100], 15), ...along([100, 100], [2, 99], 15)];
  assert.equal(recognizeShape(wobble(tri)).length, 4);
  const circle = Array.from({ length: 60 }, (_, k) => [50 + 40 * Math.cos((2 * Math.PI * k) / 60), 50 + 30 * Math.sin((2 * Math.PI * k) / 60)]);
  const ellipse = recognizeShape(wobble(circle, 1));
  assert.equal(ellipse.length, 49);
  assert.ok(ellipse.every(([x, y]) => Math.abs(Math.hypot((x - 50) / 40, (y - 50) / 30) - 1) < 0.1));
  const zigzag = Array.from({ length: 30 }, (_, i) => [i * 5, i % 2 ? 0 : 40, 0.5]);
  assert.equal(recognizeShape(zigzag), null);
  assert.equal(recognizeShape([[0, 0], [1, 1], [2, 2]]), null); // too small to mean anything
});

test("scaling around a point, for the lasso's resize handle", () => {
  const ink = { type: "ink", width: 2, points: [[10, 10, 0.5], [20, 30, 0.7]] };
  assert.deepEqual(scaled(ink, 10, 10, 2), { type: "ink", width: 4, points: [[10, 10, 0.5], [30, 50, 0.7]] });
  const text = { type: "text", x: 20, y: 20, w: 100, size: 12 };
  assert.deepEqual(scaled(text, 10, 10, 0.5), { type: "text", x: 15, y: 15, w: 50, size: 6 });
});
