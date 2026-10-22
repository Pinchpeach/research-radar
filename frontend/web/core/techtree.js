// Port of backend/services/techtree.py: the tech-tree poster. The page around the SVG
// (frontend/web/shared/poster.html) and its text are shared with the desktop app.

import STRINGS from "../shared/poster-strings.json" with { type: "json" };
import { mostCommon } from "./flow.js";
import { rng } from "./kmeans.js";

const TOP = 250, LANE_GAP = 140, BUS_X = 230, ROOT_X = 95, X0 = 380, CONTENT_W = 1450;
const PX_PER_YEAR_RANGE = [18, 90], DOT_GAP = 3, RAIL_LEAD = 34, END_PAD = 90, RIGHT_PAD = 250;
export const LANE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
const TEXT = "#f0efec", TEXT_2 = "#c3c2b7", TEXT_3 = "#8a8984", SURFACE = "#0e1015";

export { STRINGS };

export const short = (text, width) => {
  text = String(text || "").split(/\s+/).filter(Boolean).join(" ");
  return text.length <= width ? text : text.slice(0, width - 1).trimEnd() + "…";
};

export const dotRadius = (citations) => Math.min(11, 4 + 2.2 * Math.log10(1 + (citations || 0)));

const f1 = (x) => x.toFixed(1), f0 = (x) => x.toFixed(0);

export function curve(x0, y0, x1, y1) {
  if (Math.abs(y1 - y0) < 1) {
    const lift = 16 + Math.min(60, Math.abs(x1 - x0) * 0.12);
    return `M${f1(x0)},${f1(y0)}Q${f1((x0 + x1) / 2)},${f1(y0 - 2 * lift)} ${f1(x1)},${f1(y1)}`;
  }
  const dx = Math.max(40, Math.abs(x1 - x0) * 0.5);
  return `M${f1(x0)},${f1(y0)}C${f1(x0 + dx)},${f1(y0)} ${f1(x1 - dx)},${f1(y1)} ${f1(x1)},${f1(y1)}`;
}

const pyMedian = (values) => {
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

export function layout(flow) {
  const nodes = flow.nodes.filter((n) => n.year).map((n) => ({ ...n }));
  if (!nodes.length) return { nodes: [], lanes: [], edges: [], bundles: [], width: 800, height: 400 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clusters = new Map(flow.clusters.map((c) => [c.lane, c]));
  const hubs = new Set(flow.clusters.map((c) => c.hub));
  const chain = (flow.chain || []).filter((id) => byId.has(id));

  const years = nodes.map((n) => n.year);
  const firstYear = Math.min(...years), lastYear = Math.max(...years);
  const span = Math.max(1, lastYear - firstYear);
  const ppy = Math.max(PX_PER_YEAR_RANGE[0], Math.min(PX_PER_YEAR_RANGE[1], CONTENT_W / span));
  const xOf = (year) => X0 + (year - firstYear) * ppy;

  // lanes: one rail each, dots spread along it so they never overlap
  const laneNumbers = [...new Set(nodes.map((n) => n.lane))].sort((a, b) => a - b);
  const lanes = laneNumbers.map((laneNo, row) => {
    const railY = TOP + row * LANE_GAP;
    const members = nodes.filter((n) => n.lane === laneNo)
      .sort((a, b) => a.year - b.year || (b.citations || 0) - (a.citations || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let prevX = -1e9, prevR = 0;
    for (const n of members) {
      n.r = dotRadius(n.citations);
      n.x = Math.max(xOf(n.year), prevX + prevR + n.r + DOT_GAP);
      n.y = railY;
      prevX = n.x; prevR = n.r;
    }
    const cluster = clusters.get(laneNo) || {};
    return {
      lane: laneNo,
      label: cluster.label ?? `topic ${laneNo + 1}`,
      color: LANE_COLORS[row % LANE_COLORS.length],
      rail_y: railY,
      x_start: members[0].x - RAIL_LEAD,
      size: members.length,
      years: [members[0].year, members[members.length - 1].year],
      origin: cluster.origin ?? null,
      hub: cluster.hub ?? null,
      frontier: (cluster.frontier || []).filter((id) => byId.has(id)),
      parent: null,
    };
  });
  const xEnd = Math.max(...nodes.map((n) => n.x)) + END_PAD;
  const laneByNo = new Map(lanes.map((l) => [l.lane, l]));
  for (const lane of lanes) lane.x_end = xEnd;
  for (const n of nodes) {
    const lane = laneByNo.get(n.lane);
    n.color = lane.color;
    n.lane_label = lane.label;
    n.glow = hubs.has(n.id) || (n.role === "foundation" && n.cited_by_in_set >= 3);
  }

  // individual citations (hidden until a paper is hovered or selected)
  const edges = [], pairEdges = new Map();
  for (const e of flow.edges) {
    const citing = byId.get(e.source), cited = byId.get(e.target);
    if (!citing || !cited) continue;
    edges.push({ s: citing.id, t: cited.id, path: curve(cited.x, cited.y, citing.x, citing.y), color: cited.color });
    if (citing.lane !== cited.lane) {
      const key = `${cited.lane},${citing.lane}`;
      if (!pairEdges.has(key)) pairEdges.set(key, []);
      pairEdges.get(key).push([citing, cited]);
    }
  }
  const pairs = [...pairEdges].map(([key, items]) => [key.split(",").map(Number), items]);

  // topic lineage: a topic branches off the earlier topic it cites most
  for (const lane of lanes) {
    const sources = [];
    for (const [[src, dst], items] of pairs) {
      if (dst === lane.lane && laneByNo.get(src).x_start < lane.x_start) for (let i = 0; i < items.length; i++) sources.push(src);
    }
    if (sources.length) lane.parent = mostCommon(sources)[0][0];
  }

  // bundles: one curve per topic pair, width by number of citations
  const bundles = [...pairs].sort((a, b) => b[1].length - a[1].length).map(([[src, dst], items]) => {
    const a = laneByNo.get(src), b = laneByNo.get(dst);
    let xFrom = pyMedian(items.map(([, cited]) => cited.x));
    let xTo = pyMedian(items.map(([citing]) => citing.x));
    const isBranch = b.parent === src;
    if (isBranch) {
      // the branch leaves the parent rail just before the child topic begins
      xTo = b.x_start;
      xFrom = Math.max(a.x_start + 10, Math.min(xFrom, xTo - 60));
    }
    return {
      from_lane: src,
      to_lane: dst,
      count: items.length,
      branch: isBranch,
      color: a.color,
      width: 2 + 1.6 * Math.sqrt(items.length),
      path: curve(xFrom, a.rail_y, xTo, b.rail_y),
      examples: [...items].sort((p, q) => (q[1].citations || 0) - (p[1].citations || 0)).slice(0, 4)
        .map(([citing, cited]) => ({ citing: citing.title, citing_year: citing.year, cited: cited.title, cited_year: cited.year })),
    };
  });

  const orphanYs = lanes.filter((l) => l.parent === null).map((l) => l.rail_y);
  const rootY = mean(orphanYs);
  const height = TOP + (lanes.length - 1) * LANE_GAP + 240;
  const width = xEnd + RIGHT_PAD;
  const step = span > 30 ? 10 : span > 10 ? 5 : 1;
  const ticks = [];
  for (let year = Math.floor(firstYear / step) * step; year < lastYear + step; year += step) {
    if (firstYear <= year && year <= lastYear + step / 2) ticks.push([year, xOf(year)]);
  }

  return {
    nodes, lanes, edges, bundles, chain, ticks,
    root: [ROOT_X, rootY],
    bus: [BUS_X, Math.min(...orphanYs, rootY), Math.max(...orphanYs, rootY)],
    width, height,
    years: [firstYear, lastYear],
    axis: { x0: X0, ppy, first: firstYear },
  };
}

// ---------------------------------------------------------------- rendering

export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]));

const format = (template, values) => template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

function svg(lay, title, text) {
  const W = lay.width, H = lay.height;
  const out = [
    `<svg id="map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f0(W)} ${f0(H)}" font-family="NanumSquareRound, Inter, system-ui, -apple-system, Segoe UI, sans-serif">`,
    "<defs>"
      + '<radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".9"/>'
      + '<stop offset=".2" stop-color="#fff" stop-opacity=".45"/>'
      + '<stop offset=".5" stop-color="#cfe0ff" stop-opacity=".1"/>'
      + '<stop offset="1" stop-color="#cfe0ff" stop-opacity="0"/></radialGradient>'
      + '<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" '
      + 'orient="auto"><path d="M0,0L8,4L0,8z" fill="context-stroke"/></marker>'
      + "</defs>",
    '<g id="viewport">',
    `<rect x="-4000" y="-4000" width="${f0(W + 8000)}" height="${f0(H + 8000)}" fill="${SURFACE}"/>`,
  ];

  // decoration: starfield + faint orbits
  const random = rng(7), uniform = (a, b) => a + (b - a) * random();
  let stars = "";
  for (let i = 0; i < Math.floor((W * H) / 9000); i++) {
    const r = [0.6, 0.8, 1.1][Math.floor(random() * 3)];
    stars += `<circle cx="${f0(uniform(0, W))}" cy="${f0(uniform(0, H))}" r="${r}" opacity="${uniform(0.15, 0.55).toFixed(2)}"/>`;
  }
  out.push(`<g fill="#fff" pointer-events="none">${stars}</g>`);
  const cx = W * 0.6, cy = H * 0.55;
  out.push('<g fill="none" stroke="#fff" stroke-opacity=".06" stroke-width="2" pointer-events="none">'
    + [[0.42, 0.2, -24], [0.32, 0.27, -38], [0.24, 0.14, -14]].map(([rx, ry, rot]) =>
      `<ellipse cx="${f0(cx)}" cy="${f0(cy)}" rx="${f0(W * rx)}" ry="${f0(H * ry)}" transform="rotate(${rot} ${f0(cx)} ${f0(cy)})"/>`).join("")
    + "</g>");

  // title
  const [first, last] = lay.years;
  const letters = [...title].reduce((n, ch) => n + (ch >= "가" && ch <= "힣" ? 2 : 1), 0);
  const titleSize = Math.max(26, Math.min(52, (W - 160) / Math.max(1, letters) / 0.75));
  out.push(`<text class="map-title" x="${f0(W / 2)}" y="92" text-anchor="middle" fill="${TEXT}" font-size="${f0(titleSize)}" font-weight="300" letter-spacing="6">${esc(title.toUpperCase())}</text>`
    + `<text class="map-title" x="${f0(W / 2)}" y="128" text-anchor="middle" fill="${TEXT_2}" font-size="17" letter-spacing="2">`
    + esc(format(text.subtitle, { papers: lay.nodes.length, topics: lay.lanes.length, first, last })) + "</text>");

  // era grid; the year numbers live in the screen-space ruler so they stay readable
  const axisY = TOP - 80;
  out.push('<g pointer-events="none">');
  for (const [, x] of lay.ticks) {
    out.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${axisY + 12}" y2="${f0(H - 150)}" stroke="#fff" stroke-opacity=".05" stroke-dasharray="2 6"/>`);
  }
  out.push("</g>");

  // origin + bus for topics without a parent topic
  const [rx, ry] = lay.root, [busX, busTop, busBottom] = lay.bus;
  out.push(`<g fill="none" stroke="${TEXT_2}" stroke-width="2.5" stroke-opacity=".8" pointer-events="none">`
    + `<path d="M${f0(rx)},${f1(ry)}H${busX}"/><path d="M${busX},${f1(busTop)}V${f1(busBottom)}"/></g>`);
  for (const lane of lay.lanes) {
    if (lane.parent === null) {
      out.push(`<path d="M${busX},${f1(lane.rail_y)}H${f1(lane.x_start)}" stroke="${lane.color}" stroke-width="2" stroke-opacity=".45" stroke-dasharray="3 5" fill="none" pointer-events="none"/>`);
    }
  }

  // bundles (big flow between topics)
  out.push('<g id="bundles" fill="none">');
  lay.bundles.forEach((b, i) => {
    out.push(`<path class="bundle${b.branch ? " branch" : ""}" data-i="${i}" d="${b.path}" stroke="${b.color}" stroke-width="${f1(b.width)}" stroke-opacity="${b.branch ? ".8" : ".35"}" stroke-linecap="round"/>`
      + `<path class="hit bundle-hit" data-i="${i}" d="${b.path}" stroke="transparent" stroke-width="18"/>`);
  });
  out.push("</g>");

  // rails
  out.push('<g id="rails">');
  for (const lane of lay.lanes) {
    const d = `M${f1(lane.x_start)},${f1(lane.rail_y)}H${f1(lane.x_end)}`;
    out.push(`<path class="rail" data-lane="${lane.lane}" d="${d}" stroke="${lane.color}" stroke-width="5" stroke-linecap="round" marker-end="url(#arrow)" fill="none"/>`
      + `<path class="hit rail-hit" data-lane="${lane.lane}" d="${d}" stroke="transparent" stroke-width="22" fill="none"/>`);
  }
  out.push("</g>");

  // individual citations, hidden until needed
  out.push('<g id="edges" fill="none" pointer-events="none">');
  for (const e of lay.edges) out.push(`<path class="edge" data-s="${esc(e.s)}" data-t="${esc(e.t)}" d="${e.path}" stroke="${e.color}" stroke-width="1.8"/>`);
  out.push("</g>");

  // glows
  out.push('<g pointer-events="none">');
  for (const n of lay.nodes) {
    if (n.glow) out.push(`<circle class="halo" data-id="${esc(n.id)}" cx="${f1(n.x)}" cy="${f1(n.y)}" r="${40 + 8 * Math.min(5, n.cited_by_in_set)}" fill="url(#glow)"/>`);
  }
  out.push("</g>");

  // dots (papers): fill shows topic, outline shows role
  out.push('<g id="dots">');
  for (const n of lay.nodes) {
    const { x, y, r } = n;
    let mark;
    if (n.role === "foundation") {
      mark = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${SURFACE}" stroke="${TEXT}" stroke-width="2.2"/>`;
    } else {
      const ring = n.bookmarked ? ` stroke="${TEXT}" stroke-width="2.5"` : ` stroke="${SURFACE}" stroke-width="2"`;
      mark = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${n.color}"${ring}/>`;
    }
    const star = n.bookmarked ? `<text x="${f1(x)}" y="${f1(y - r - 4)}" text-anchor="middle" font-size="11" fill="${TEXT}">★</text>` : "";
    out.push(`<g class="dot" data-id="${esc(n.id)}" tabindex="0">${mark}${star}<circle class="hit" cx="${f1(x)}" cy="${f1(y)}" r="${f1(r + 6)}" fill="transparent"/></g>`);
  }
  out.push("</g>");

  // topic name at the rail start and a summary at the rail end (paper titles are placed by the script)
  out.push(`<g pointer-events="none" stroke="${SURFACE}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">`);
  for (const lane of lay.lanes) {
    const y = lane.rail_y;
    // a topic that starts late would push its label past the arrow; right-align it instead
    const labelW = lane.label.length * 17 * 0.72;
    const endAligned = lane.x_start + labelW > lane.x_end;
    const labelX = endAligned ? lane.x_end : lane.x_start;
    out.push(`<text class="lane-label" data-ax="${f1(labelX)}" data-ay="${f1(y)}" x="${f1(labelX)}" y="${f1(y - 22)}"${endAligned ? ' text-anchor="end"' : ""} `
      + `font-size="17" font-weight="700" letter-spacing="1.5" fill="${lane.color}">${esc(lane.label.toUpperCase())}</text>`
      + `<text class="lane-label" data-ax="${f1(lane.x_end)}" data-ay="${f1(y)}" x="${f1(lane.x_end + 18)}" y="${f1(y + 5)}" font-size="14" fill="${TEXT_2}">`
      + esc(format(text.lane_end, { n: lane.size, first: lane.years[0], last: lane.years[1] })) + "</text>");
  }
  out.push("</g>");

  out.push(`<circle cx="${f0(rx)}" cy="${f1(ry)}" r="80" fill="url(#glow)" pointer-events="none"/>`
    + `<text x="${f0(rx)}" y="${f1(ry + 4)}" text-anchor="middle" fill="#0b0b0b" font-size="11" font-weight="700" pointer-events="none">${esc(text.origins)}</text>`);

  // how to read
  const ly = H - 135;
  text.notes.forEach((line, i) => {
    out.push(`<text x="${ROOT_X - 40}" y="${ly + i * 21}" fill="${i === 0 ? TEXT : TEXT_3}" font-size="${i === 0 ? 14 : 12.5}" font-weight="${i === 0 ? 700 : 400}" pointer-events="none" class="note">${esc(line)}</text>`);
  });

  // screen-space layer: paper titles and the year ruler, drawn by the script at a fixed size
  out.push(`</g><g id="titles" pointer-events="none" font-size="11" stroke="${SURFACE}" stroke-width="4" paint-order="stroke" stroke-linejoin="round"></g></svg>`);
  return out.join("");
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));

/** The interactive poster page. `template` is frontend/web/shared/poster.html. */
export function renderHtml(flow, title, lang, template) {
  const text = STRINGS[lang] || STRINGS.en;
  const lay = layout(flow);
  const data = {
    width: lay.width,
    height: lay.height,
    axis: lay.axis || { x0: X0, ppy: PX_PER_YEAR_RANGE[0], first: 0 },
    years: lay.years || [0, 0],
    chain: lay.chain || [],
    edges: lay.edges.map((e) => ({ s: e.s, t: e.t })),
    nodes: lay.nodes.map((n) => pick(n, ["id", "title", "authors", "year", "citations", "url", "open_access_url", "role", "bookmarked",
      "cited_by_in_set", "lane_label", "color", "x", "y", "r", "glow"])),
    lanes: lay.lanes.map((l) => pick(l, ["lane", "label", "color", "size", "years", "origin", "hub", "frontier"])),
    bundles: (lay.bundles || []).map((b) => pick(b, ["from_lane", "to_lane", "count", "branch", "examples"])),
  };
  const pageTitle = format(text.page_title, { title });
  const values = {
    __LANG__: STRINGS[lang] ? lang : "en",
    __TITLE__: esc(pageTitle),
    __SURFACE__: SURFACE,
    __SVG__: lay.nodes.length ? svg(lay, title, text) : `<p style='color:#fff'>${esc(text.no_papers)}</p>`,
    __TEXT__: JSON.stringify(text.js).replaceAll("</", "<\\/"),
    __DATA__: JSON.stringify(data).replaceAll("</", "<\\/"),
  };
  // one pass, so text inside one value (a paper title, say) is never mistaken for a placeholder;
  // CRLF from a Windows checkout becomes LF, like Python's text mode reads it
  return template.replace(/\r\n?/g, "\n").replace(new RegExp(Object.keys(values).join("|"), "g"), (m) => values[m]);
}
