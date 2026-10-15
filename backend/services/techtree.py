"""Tech-tree map of a research flow, in the spirit of "The Map of Physics".

Overview first, details on demand:
- Each topic is a rail that starts where the topic emerges. A topic that grew out of an
  earlier one branches off that topic's rail; the others branch off a glowing ORIGINS node.
- Citations between topics are drawn as one soft bundle per topic pair (width = count).
- Every paper is a dot on its rail (size = citations, glow = key paper). Hovering a dot shows
  the paper and its individual citation lines; hovering a rail or a bundle summarizes it.
- Clicking a dot pins it and traces what it builds on and what built on it. Titles appear
  next to the dots when zoomed in (or with the "제목" toggle).

`layout()` does the geometry (so it can be tested); `render_html()` turns it into a
self-contained interactive page.
"""

import html
import json
import math
import random
import statistics
from collections import Counter, defaultdict

TOP = 250  # title + era axis
LANE_GAP = 140
BUS_X = 230
ROOT_X = 95
X0 = 380  # x of the earliest year
CONTENT_W = 1450  # target width of the year axis
PX_PER_YEAR_RANGE = (18, 90)
DOT_GAP = 3
RAIL_LEAD = 34  # rail starts this far before its first dot
END_PAD = 90
RIGHT_PAD = 250  # room for rail-end labels

# Dark-mode categorical slots in the validated order. Each rail is also labeled and has its
# own row, so color is never the only cue.
LANE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"]
TEXT = "#f0efec"
TEXT_2 = "#c3c2b7"
TEXT_3 = "#8a8984"
SURFACE = "#0e1015"


def short(text: str, width: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def dot_radius(citations: int) -> float:
    return min(11.0, 4 + 2.2 * math.log10(1 + (citations or 0)))


def curve(x0: float, y0: float, x1: float, y1: float) -> str:
    """S-curve between two rails (or an arc along one rail)."""
    if abs(y1 - y0) < 1:
        lift = 16 + min(60, abs(x1 - x0) * 0.12)
        return f"M{x0:.1f},{y0:.1f}Q{(x0 + x1) / 2:.1f},{y0 - 2 * lift:.1f} {x1:.1f},{y1:.1f}"
    dx = max(40.0, abs(x1 - x0) * 0.5)
    return f"M{x0:.1f},{y0:.1f}C{x0 + dx:.1f},{y0:.1f} {x1 - dx:.1f},{y1:.1f} {x1:.1f},{y1:.1f}"


def layout(flow: dict) -> dict:
    nodes = [dict(n) for n in flow["nodes"] if n.get("year")]
    if not nodes:
        return {"nodes": [], "lanes": [], "edges": [], "bundles": [], "width": 800, "height": 400}

    by_id = {n["id"]: n for n in nodes}
    clusters = {c["lane"]: c for c in flow["clusters"]}
    hubs = {c["hub"] for c in flow["clusters"]}
    chain = [nid for nid in flow.get("chain") or [] if nid in by_id]

    years = [n["year"] for n in nodes]
    first_year, last_year = min(years), max(years)
    span = max(1, last_year - first_year)
    ppy = max(PX_PER_YEAR_RANGE[0], min(PX_PER_YEAR_RANGE[1], CONTENT_W / span))

    def x_of(year: float) -> float:
        return X0 + (year - first_year) * ppy

    # ---- lanes: one rail each, dots spread along it so they never overlap ----
    lane_numbers = sorted({n["lane"] for n in nodes})
    lanes = []
    for row, lane_no in enumerate(lane_numbers):
        rail_y = TOP + row * LANE_GAP
        members = sorted(
            (n for n in nodes if n["lane"] == lane_no),
            key=lambda n: (n["year"], -(n["citations"] or 0), n["id"]),
        )
        prev_x, prev_r = -1e9, 0.0
        for n in members:
            n["r"] = dot_radius(n["citations"])
            n["x"] = max(x_of(n["year"]), prev_x + prev_r + n["r"] + DOT_GAP)
            n["y"] = rail_y
            prev_x, prev_r = n["x"], n["r"]
        cluster = clusters.get(lane_no, {})
        lanes.append(
            {
                "lane": lane_no,
                "label": cluster.get("label", f"topic {lane_no + 1}"),
                "color": LANE_COLORS[row % len(LANE_COLORS)],
                "rail_y": rail_y,
                "x_start": members[0]["x"] - RAIL_LEAD,
                "size": len(members),
                "years": (members[0]["year"], members[-1]["year"]),
                "origin": cluster.get("origin"),
                "hub": cluster.get("hub"),
                "frontier": [nid for nid in cluster.get("frontier", []) if nid in by_id],
                "parent": None,
            }
        )
    x_end = max(n["x"] for n in nodes) + END_PAD
    lane_by_no = {lane["lane"]: lane for lane in lanes}
    for lane in lanes:
        lane["x_end"] = x_end
    for n in nodes:
        lane = lane_by_no[n["lane"]]
        n["color"] = lane["color"]
        n["lane_label"] = lane["label"]
        n["glow"] = n["id"] in hubs or (n["role"] == "foundation" and n["cited_by_in_set"] >= 3)

    # ---- individual citations (hidden until a paper is hovered or selected) ----
    edges, pair_edges = [], defaultdict(list)
    for e in flow["edges"]:
        citing, cited = by_id.get(e["source"]), by_id.get(e["target"])
        if not citing or not cited:
            continue
        edges.append({"s": citing["id"], "t": cited["id"], "path": curve(cited["x"], cited["y"], citing["x"], citing["y"]),
                      "color": cited["color"]})
        if citing["lane"] != cited["lane"]:
            pair_edges[(cited["lane"], citing["lane"])].append((citing, cited))

    # ---- topic lineage: a topic branches off the earlier topic it cites most ----
    for lane in lanes:
        counts = Counter(
            src for (src, dst), items in pair_edges.items() if dst == lane["lane"]
            for _ in items
            if lane_by_no[src]["x_start"] < lane["x_start"]
        )
        if counts:
            lane["parent"] = counts.most_common(1)[0][0]

    # ---- bundles: one curve per topic pair, width by number of citations ----
    bundles = []
    for (src, dst), items in sorted(pair_edges.items(), key=lambda kv: -len(kv[1])):
        a, b = lane_by_no[src], lane_by_no[dst]
        x_from = statistics.median(cited["x"] for _, cited in items)
        x_to = statistics.median(citing["x"] for citing, _ in items)
        is_branch = b["parent"] == src
        if is_branch:
            # the branch leaves the parent rail just before the child topic begins
            x_to = b["x_start"]
            x_from = max(a["x_start"] + 10, min(x_from, x_to - 60))
        bundles.append(
            {
                "from_lane": src,
                "to_lane": dst,
                "count": len(items),
                "branch": is_branch,
                "color": a["color"],
                "width": 2 + 1.6 * math.sqrt(len(items)),
                "path": curve(x_from, a["rail_y"], x_to, b["rail_y"]),
                "examples": [
                    {"citing": citing["title"], "citing_year": citing["year"],
                     "cited": cited["title"], "cited_year": cited["year"]}
                    for citing, cited in sorted(items, key=lambda it: -(it[1]["citations"] or 0))[:4]
                ],
            }
        )

    orphan_ys = [lane["rail_y"] for lane in lanes if lane["parent"] is None]
    root_y = statistics.mean(orphan_ys)
    height = TOP + (len(lanes) - 1) * LANE_GAP + 240
    width = x_end + RIGHT_PAD

    step = 10 if span > 30 else 5 if span > 10 else 1
    ticks = [
        (year, x_of(year))
        for year in range((first_year // step) * step, last_year + step, step)
        if first_year <= year <= last_year + step / 2
    ]

    return {
        "nodes": nodes,
        "lanes": lanes,
        "edges": edges,
        "bundles": bundles,
        "chain": chain,
        "ticks": ticks,
        "root": (ROOT_X, root_y),
        "bus": (BUS_X, min(orphan_ys + [root_y]), max(orphan_ys + [root_y])),
        "width": width,
        "height": height,
        "years": (first_year, last_year),
    }


# ---------------------------------------------------------------- rendering


def _t(value) -> str:
    return html.escape(str(value), quote=True)


def _svg(lay: dict, title: str) -> str:
    W, H = lay["width"], lay["height"]
    by_id = {n["id"]: n for n in lay["nodes"]}
    out = [
        f'<svg id="map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
        f'font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif">',
        "<defs>"
        '<radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".9"/>'
        '<stop offset=".2" stop-color="#fff" stop-opacity=".45"/>'
        '<stop offset=".5" stop-color="#cfe0ff" stop-opacity=".1"/>'
        '<stop offset="1" stop-color="#cfe0ff" stop-opacity="0"/></radialGradient>'
        '<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" '
        'orient="auto"><path d="M0,0L8,4L0,8z" fill="context-stroke"/></marker>'
        "</defs>",
        '<g id="viewport">',
        f'<rect x="-4000" y="-4000" width="{W + 8000:.0f}" height="{H + 8000:.0f}" fill="{SURFACE}"/>',
    ]

    # decoration: starfield + faint orbits
    rng = random.Random(7)
    stars = "".join(
        f'<circle cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(0, H):.0f}" r="{rng.choice([0.6, 0.8, 1.1])}" '
        f'opacity="{rng.uniform(.15, .55):.2f}"/>'
        for _ in range(int(W * H / 9000))
    )
    out.append(f'<g fill="#fff" pointer-events="none">{stars}</g>')
    cx, cy = W * 0.6, H * 0.55
    out.append(
        '<g fill="none" stroke="#fff" stroke-opacity=".06" stroke-width="2" pointer-events="none">'
        + "".join(
            f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{W * rx:.0f}" ry="{H * ry:.0f}" '
            f'transform="rotate({rot} {cx:.0f} {cy:.0f})"/>'
            for rx, ry, rot in [(0.42, 0.2, -24), (0.32, 0.27, -38), (0.24, 0.14, -14)]
        )
        + "</g>"
    )

    # title
    first, last = lay["years"]
    # shrink long titles so they stay within the map width (~0.75 em per letter with the tracking)
    title_size = max(26, min(52, (W - 160) / max(1, len(title)) / 0.75))
    out.append(
        f'<text x="{W / 2:.0f}" y="92" text-anchor="middle" fill="{TEXT}" font-size="{title_size:.0f}" font-weight="300" '
        f'letter-spacing="6">{_t(title.upper())}</text>'
        f'<text x="{W / 2:.0f}" y="128" text-anchor="middle" fill="{TEXT_2}" font-size="17" letter-spacing="2">'
        f"연구 발전 지도 · {len(lay['nodes'])} papers · {len(lay['lanes'])} topics · {first}–{last}</text>"
    )

    # era axis
    axis_y = TOP - 80
    out.append(f'<g font-size="13" fill="{TEXT_3}" text-anchor="middle" pointer-events="none">')
    for year, x in lay["ticks"]:
        out.append(
            f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{axis_y + 12}" y2="{H - 150:.0f}" stroke="#fff" '
            f'stroke-opacity=".05" stroke-dasharray="2 6"/><text x="{x:.1f}" y="{axis_y}">{year}</text>'
        )
    out.append("</g>")

    # origin + bus for topics without a parent topic
    rx, ry = lay["root"]
    bus_x, bus_top, bus_bottom = lay["bus"]
    out.append(
        f'<g fill="none" stroke="{TEXT_2}" stroke-width="2.5" stroke-opacity=".8" pointer-events="none">'
        f'<path d="M{rx:.0f},{ry:.1f}H{bus_x}"/><path d="M{bus_x},{bus_top:.1f}V{bus_bottom:.1f}"/></g>'
    )
    for lane in lay["lanes"]:
        if lane["parent"] is None:
            out.append(
                f'<path d="M{bus_x},{lane["rail_y"]:.1f}H{lane["x_start"]:.1f}" stroke="{lane["color"]}" '
                f'stroke-width="2" stroke-opacity=".45" stroke-dasharray="3 5" fill="none" pointer-events="none"/>'
            )

    # bundles (big flow between topics)
    out.append('<g id="bundles" fill="none">')
    for i, b in enumerate(lay["bundles"]):
        opacity = ".8" if b["branch"] else ".35"
        out.append(
            f'<path class="bundle{" branch" if b["branch"] else ""}" data-i="{i}" d="{b["path"]}" '
            f'stroke="{b["color"]}" stroke-width="{b["width"]:.1f}" stroke-opacity="{opacity}" stroke-linecap="round"/>'
            f'<path class="hit bundle-hit" data-i="{i}" d="{b["path"]}" stroke="transparent" stroke-width="18"/>'
        )
    out.append("</g>")

    # rails
    out.append('<g id="rails">')
    for lane in lay["lanes"]:
        c, y = lane["color"], lane["rail_y"]
        out.append(
            f'<path class="rail" data-lane="{lane["lane"]}" d="M{lane["x_start"]:.1f},{y:.1f}H{lane["x_end"]:.1f}" '
            f'stroke="{c}" stroke-width="5" stroke-linecap="round" marker-end="url(#arrow)" fill="none"/>'
            f'<path class="hit rail-hit" data-lane="{lane["lane"]}" d="M{lane["x_start"]:.1f},{y:.1f}H{lane["x_end"]:.1f}" '
            f'stroke="transparent" stroke-width="22" fill="none"/>'
        )
    out.append("</g>")

    # individual citations, hidden until needed
    out.append('<g id="edges" fill="none" pointer-events="none">')
    for e in lay["edges"]:
        out.append(
            f'<path class="edge" data-s="{_t(e["s"])}" data-t="{_t(e["t"])}" d="{e["path"]}" '
            f'stroke="{e["color"]}" stroke-width="1.8"/>'
        )
    out.append("</g>")

    # glows
    out.append('<g pointer-events="none">')
    for n in lay["nodes"]:
        if n["glow"]:
            r = 40 + 8 * min(5, n["cited_by_in_set"])
            out.append(f'<circle class="halo" data-id="{_t(n["id"])}" cx="{n["x"]:.1f}" cy="{n["y"]:.1f}" r="{r}" fill="url(#glow)"/>')
    out.append("</g>")

    # dots (papers) — fill shows topic; outline shows role
    out.append('<g id="dots">')
    for n in lay["nodes"]:
        x, y, r = n["x"], n["y"], n["r"]
        if n["role"] == "foundation":
            mark = f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{SURFACE}" stroke="{TEXT}" stroke-width="2.2"/>'
        else:
            ring = f' stroke="{TEXT}" stroke-width="2.5"' if n["bookmarked"] else f' stroke="{SURFACE}" stroke-width="2"'
            mark = f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{n["color"]}"{ring}/>'
        star = (
            f'<text x="{x:.1f}" y="{y - r - 4:.1f}" text-anchor="middle" font-size="11" fill="{TEXT}">★</text>'
            if n["bookmarked"] else ""
        )
        out.append(
            f'<g class="dot" data-id="{_t(n["id"])}" tabindex="0">{mark}{star}'
            f'<circle class="hit" cx="{x:.1f}" cy="{y:.1f}" r="{r + 6:.1f}" fill="transparent"/>'
            f'<text class="dot-label" x="{x + 4:.1f}" y="{y - r - 6:.1f}" transform="rotate(-35 {x + 4:.1f} {y - r - 6:.1f})" '
            f'font-size="10" fill="{TEXT_2}">{n["year"]} · {_t(short(n["title"], 40))}</text></g>'
        )
    out.append("</g>")

    # minimal labels for the overview: topic name at the rail start, key paper per topic, rail end
    out.append(f'<g pointer-events="none" stroke="{SURFACE}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">')
    for lane in lay["lanes"]:
        y = lane["rail_y"]
        # a topic that starts late would push its label past the arrow; right-align it instead
        label_w = len(lane["label"]) * 17 * 0.72
        anchor = ' text-anchor="end"' if lane["x_start"] + label_w > lane["x_end"] else ""
        label_x = lane["x_end"] if anchor else lane["x_start"]
        out.append(
            f'<text x="{label_x:.1f}" y="{y - 22:.1f}"{anchor} font-size="17" font-weight="700" letter-spacing="1.5" '
            f'fill="{lane["color"]}">{_t(lane["label"].upper())}</text>'
            f'<text x="{lane["x_end"] + 18:.1f}" y="{y + 5:.1f}" font-size="14" fill="{TEXT_2}">'
            f'{lane["size"]} papers · {lane["years"][0]}–{lane["years"][1]}</text>'
        )
        hub = by_id.get(lane["hub"])
        if hub:
            out.append(
                f'<text class="hub-label" data-id="{_t(hub["id"])}" x="{hub["x"]:.1f}" y="{y + hub["r"] + 18:.1f}" '
                f'text-anchor="middle" font-size="13" fill="{TEXT}">{_t(short(hub["title"], 38))}</text>'
            )
    out.append("</g>")

    out.append(
        f'<circle cx="{rx:.0f}" cy="{ry:.1f}" r="80" fill="url(#glow)" pointer-events="none"/>'
        f'<text x="{rx:.0f}" y="{ry + 4:.1f}" text-anchor="middle" fill="#0b0b0b" font-size="11" font-weight="700" '
        f'pointer-events="none">ORIGINS</text>'
    )

    # how to read
    ly = H - 135
    notes = [
        "How to read this map",
        "· Each rail is a research topic; time runs left to right. A topic branches off the topic it grew from.",
        "· Soft curves between rails are citations between topics — thicker means more.",
        "· Dots are papers (bigger = more cited, glow = key paper, ○ = foundational work, ★ = bookmarked).",
        "· Hover a dot, rail, or curve for a quick look; click to pin its card (× or empty space closes it).",
        "· A pinned paper also lights up its lineage. Zoom in to see titles.",
    ]
    for i, line in enumerate(notes):
        out.append(
            f'<text x="{ROOT_X - 40}" y="{ly + i * 21}" fill="{TEXT if i == 0 else TEXT_3}" '
            f'font-size="{14 if i == 0 else 12.5}" font-weight="{700 if i == 0 else 400}" pointer-events="none">{_t(line)}</text>'
        )

    out.append("</g></svg>")
    return "".join(out)


TEMPLATE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
  html,body{margin:0;height:100%;background:__SURFACE__;overflow:hidden;font-family:Inter,system-ui,sans-serif}
  #wrap{position:relative;width:100%;height:100%;cursor:grab}
  #wrap.drag{cursor:grabbing}
  svg{width:100%;height:100%;display:block}
  .dot{cursor:pointer;outline:none}
  .dot circle:first-child{transition:r .12s}
  .dot:hover circle:first-child,.dot:focus circle:first-child{stroke:#fff;stroke-width:3}
  .dot-label{opacity:0;pointer-events:none;transition:opacity .15s}
  .show-labels .dot-label{opacity:1}
  .edge{opacity:0;transition:opacity .12s}
  .edge.peek,.edge.on{opacity:.95}
  .bundle,.rail,.dot,.halo,.hub-label{transition:opacity .15s}
  .bundle-hit,.rail-hit{cursor:help}
  .bundle.hover{stroke-opacity:.9}
  .focus .bundle,.focus .halo,.focus .hub-label{opacity:.12}
  .focus .rail{opacity:.35}
  .focus .dot{opacity:.18}
  .focus .dot.on,.focus .halo.on{opacity:1}
  .focus .dot.on .dot-label{opacity:1}
  #bar{position:absolute;top:12px;right:12px;display:flex;gap:6px}
  #bar button{background:#1f232c;color:#f0efec;border:1px solid #3a3f4b;border-radius:8px;padding:6px 10px;
    font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  #bar button.active{background:#f0efec;color:#0e1015}
  #tip{position:absolute;pointer-events:none;background:#f0efec;color:#0e1015;border-radius:10px;padding:10px 12px;
    font-size:12px;line-height:1.5;max-width:340px;box-shadow:0 8px 28px rgba(0,0,0,.5);display:none}
  #tip b{display:block;font-size:13px;margin-bottom:2px}
  #tip .k{color:#52514e}
  #tip .chip{display:inline-block;border-radius:999px;padding:0 7px;font-size:11px;color:#fff;margin-bottom:4px}
  #tip ul{margin:4px 0 0;padding-left:16px}
  #pin{position:absolute;max-width:360px;background:#f0efec;color:#0e1015;border-radius:12px;padding:12px 14px 12px;
    font-size:12.5px;line-height:1.5;box-shadow:0 12px 36px rgba(0,0,0,.6);display:none;cursor:auto;
    border-top:4px solid var(--accent,#f0efec)}
  #pin b{display:block;font-size:13.5px;margin:2px 22px 2px 0}
  #pin .k{color:#52514e}
  #pin .chip{display:inline-block;border-radius:999px;padding:0 7px;font-size:11px;color:#fff;margin:0 22px 4px 0}
  #pin ul{margin:4px 0 0;padding-left:16px}
  #pin a{color:#1c5cab;font-weight:600}
  #pin .actions{margin-top:8px}
  #pin #close{position:absolute;top:6px;right:8px;width:26px;height:26px;border:0;border-radius:6px;background:none;
    color:#52514e;font-size:18px;line-height:1;cursor:pointer}
  #pin #close:hover{background:#e0dfda;color:#0e1015}
  #pinmark{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px solid #f0efec;border-radius:50%;
    pointer-events:none;display:none;box-shadow:0 0 0 3px rgba(240,239,236,.25)}
</style></head>
<body><div id="wrap">
__SVG__
<div id="bar">
  <button id="labels" title="Show every paper title">제목</button>
  <button id="lineage" title="Highlight the longest citation chain">핵심 계보</button>
  <button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">−</button>
  <button id="fit" title="Fit to screen">전체 보기</button>
</div>
<div id="tip" role="tooltip"></div>
<div id="pinmark"></div>
<div id="pin" role="dialog" aria-label="Details"><button id="close" aria-label="Close" title="Close (Esc)">×</button><div id="pinbody"></div></div>
</div>
<script>
const DATA = __DATA__;
const $ = id => document.getElementById(id);
const svg = $("map"), vp = $("viewport"), wrap = $("wrap"), tip = $("tip");
const W = DATA.width, H = DATA.height, LABEL_ZOOM = 1.8;
let s = 1, tx = 0, ty = 0, fitScale = 1, labelsOn = false;

// ---------- pan & zoom ----------
function apply() {
  vp.setAttribute("transform", `translate(${tx},${ty}) scale(${s})`);
  svg.classList.toggle("show-labels", labelsOn || s >= fitScale * LABEL_ZOOM);
  placePin();
}
function fit() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s = fitScale = Math.min(w / W, h / H); tx = (w - W * s) / 2; ty = (h - H * s) / 2; apply();
}
function zoom(f, cx, cy) {
  cx ??= wrap.clientWidth / 2; cy ??= wrap.clientHeight / 2;
  const ns = Math.max(fitScale * 0.5, Math.min(fitScale * 8, s * f));
  tx = cx - (cx - tx) * ns / s; ty = cy - (cy - ty) * ns / s; s = ns; apply();
}
wrap.addEventListener("wheel", e => { e.preventDefault(); const r = wrap.getBoundingClientRect();
  zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
let drag = null, moved = false;
wrap.addEventListener("pointerdown", e => { if (e.target.closest("#bar,#pin")) return;
  drag = { x: e.clientX, y: e.clientY, tx, ty }; moved = false; wrap.classList.add("drag"); });
window.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; hideTip(); } tx = drag.tx + dx; ty = drag.ty + dy; apply(); });
window.addEventListener("pointerup", () => { drag = null; wrap.classList.remove("drag"); });
$("zin").onclick = () => zoom(1.4); $("zout").onclick = () => zoom(1 / 1.4); $("fit").onclick = fit;
$("labels").onclick = e => { labelsOn = !labelsOn; e.currentTarget.classList.toggle("active", labelsOn); apply(); };
window.addEventListener("resize", fit);

// ---------- data ----------
const nodes = Object.fromEntries(DATA.nodes.map(n => [n.id, n]));
const lanes = Object.fromEntries(DATA.lanes.map(l => [l.lane, l]));
const cites = {}, citedBy = {};
for (const e of DATA.edges) { (cites[e.s] ??= []).push(e.t); (citedBy[e.t] ??= []).push(e.s); }
const reach = (start, g) => { const seen = new Set(), st = [start];
  while (st.length) for (const n of g[st.pop()] || []) if (!seen.has(n)) { seen.add(n); st.push(n); } return seen; };
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dotEls = [...document.querySelectorAll(".dot")], edgeEls = [...document.querySelectorAll(".edge")];
const haloEls = [...document.querySelectorAll(".halo")];
const chip = (label, color) => `<span class="chip" style="background:${color}">${esc(label)}</span>`;

// ---------- tooltip ----------
function showTip(html, e) { tip.innerHTML = html; tip.style.display = "block"; moveTip(e); }
function moveTip(e) { const r = wrap.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
  if (x + w > wrap.clientWidth - 8) x = e.clientX - r.left - w - 16;
  if (y + h > wrap.clientHeight - 8) y = e.clientY - r.top - h - 16;
  tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px"; }
function hideTip() { tip.style.display = "none"; }

function paperTip(n) {
  const anc = reach(n.id, cites).size, desc = reach(n.id, citedBy).size;
  const role = n.role === "foundation" ? " · ○ foundational work" : "";
  return chip(n.lane_label, n.color) + `<b>${esc(n.title)}</b>` +
    `<span class="k">${esc((n.authors || []).join(", ") || "—")}</span><br>` +
    `${n.year} · ${n.citations.toLocaleString()} citations${n.bookmarked ? " · ★ bookmarked" : ""}${role}<br>` +
    `<span class="k">Builds on ${anc} · led to ${desc} papers in this map</span>`;
}
function laneTip(l) {
  const t = id => nodes[id] ? `${esc(nodes[id].title)} (${nodes[id].year})` : "—";
  return chip(l.label, l.color) + `<b>${l.size} papers · ${l.years[0]}–${l.years[1]}</b>` +
    `<span class="k">Origin</span> ${t(l.origin)}<br><span class="k">Key paper</span> ${t(l.hub)}<br>` +
    `<span class="k">Latest</span><ul>${l.frontier.map(id => `<li>${t(id)}</li>`).join("")}</ul>`;
}
function bundleTip(b) {
  const a = lanes[b.from_lane], c = lanes[b.to_lane];
  return `${chip(a.label, a.color)} → ${chip(c.label, c.color)}` +
    `<b>${b.count} citation${b.count === 1 ? "" : "s"}${b.branch ? " · where this topic branched off" : ""}</b>` +
    `<ul>${b.examples.map(x => `<li>${esc(x.citing)} (${x.citing_year}) <span class="k">cites</span> ${esc(x.cited)} (${x.cited_year})</li>`).join("")}</ul>`;
}

// ---------- hover: peek at a paper's own citation lines ----------
function peek(id, on) {
  if (svg.classList.contains("focus")) return;
  edgeEls.forEach(el => { if (el.dataset.s === id || el.dataset.t === id) el.classList.toggle("peek", on); });
}
dotEls.forEach(el => {
  const id = el.dataset.id;
  el.addEventListener("pointerenter", e => { if (!drag) { showTip(paperTip(nodes[id]), e); peek(id, true); } });
  el.addEventListener("pointermove", moveTip);
  el.addEventListener("pointerleave", () => { hideTip(); peek(id, false); });
  el.addEventListener("click", e => { if (!moved) { e.stopPropagation(); select(id); } });
  el.addEventListener("keydown", e => { if (e.key === "Enter") select(id); });
});
document.querySelectorAll(".rail-hit").forEach(el => {
  const lane = lanes[el.dataset.lane];
  el.addEventListener("pointerenter", e => !drag && showTip(laneTip(lane), e));
  el.addEventListener("pointermove", moveTip); el.addEventListener("pointerleave", hideTip);
  el.addEventListener("click", e => { if (!moved) { e.stopPropagation(); clearFocus();
    pin(laneTip(lane), toMap(e), lane.color, "lane:" + lane.lane); } });
});
document.querySelectorAll(".bundle-hit").forEach(el => {
  const line = document.querySelector(`.bundle[data-i="${el.dataset.i}"]`), b = DATA.bundles[el.dataset.i];
  el.addEventListener("pointerenter", e => { if (!drag) { showTip(bundleTip(b), e); line.classList.add("hover"); } });
  el.addEventListener("pointermove", moveTip);
  el.addEventListener("pointerleave", () => { hideTip(); line.classList.remove("hover"); });
  el.addEventListener("click", e => { if (!moved) { e.stopPropagation(); clearFocus();
    pin(bundleTip(b), toMap(e), lanes[b.from_lane].color, "bundle:" + el.dataset.i); } });
});

// ---------- pinned card: opens on click, stays until background / × / Esc ----------
let pinned = null; // { key, x, y } in map coordinates
const pinEl = $("pin"), pinMark = $("pinmark");
function toMap(e) { const r = wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left - tx) / s, y: (e.clientY - r.top - ty) / s }; }
function pin(html, at, accent, key) {
  hideTip();
  $("pinbody").innerHTML = html;
  pinEl.style.setProperty("--accent", accent);
  pinned = { key, x: at.x, y: at.y, right: null, above: null };
  pinEl.style.display = pinMark.style.display = "block";
  placePin();
  $("close").focus({ preventScroll: true });
}
function placePin() {
  if (!pinned) return;
  // follow the anchor as the map pans and zooms; flip to stay inside the frame
  // keep the side the card opened on; flip only when it would leave the frame
  const ax = pinned.x * s + tx, ay = pinned.y * s + ty, w = pinEl.offsetWidth, h = pinEl.offsetHeight;
  const W2 = wrap.clientWidth, H2 = wrap.clientHeight;
  const fitsRight = ax + 18 + w <= W2 - 8, fitsLeft = ax - 18 - w >= 8;
  const fitsAbove = ay - 14 - h >= 8, fitsBelow = ay + 18 + h <= H2 - 8;
  if (pinned.right === null) pinned.right = fitsRight || !fitsLeft;
  else if (pinned.right && !fitsRight && fitsLeft) pinned.right = false;
  else if (!pinned.right && !fitsLeft && fitsRight) pinned.right = true;
  if (pinned.above === null) pinned.above = fitsAbove || !fitsBelow;
  else if (pinned.above && !fitsAbove && fitsBelow) pinned.above = false;
  else if (!pinned.above && !fitsBelow && fitsAbove) pinned.above = true;
  let x = pinned.right ? ax + 18 : ax - w - 18, y = pinned.above ? ay - h - 14 : ay + 18;
  x = Math.min(x, W2 - w - 8); y = Math.min(y, H2 - h - 8);
  pinEl.style.left = Math.max(8, x) + "px"; pinEl.style.top = Math.max(8, y) + "px";
  pinMark.style.left = ax + "px"; pinMark.style.top = ay + "px";
  const inside = ax > -20 && ay > -20 && ax < W2 + 20 && ay < H2 + 20;
  pinMark.style.display = inside ? "block" : "none";
}
function unpin() { pinned = null; pinEl.style.display = pinMark.style.display = "none"; }

// ---------- focus: selected paper's lineage, or the key lineage ----------
function focus(ids, edgeOk) {
  svg.classList.add("focus");
  edgeEls.forEach(el => { el.classList.remove("peek"); el.classList.toggle("on", edgeOk(el.dataset.s, el.dataset.t)); });
  dotEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
  haloEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
}
function clearFocus() {
  svg.classList.remove("focus");
  [...dotEls, ...edgeEls, ...haloEls].forEach(el => el.classList.remove("on", "peek"));
  $("lineage").classList.remove("active");
}
function dismiss() { clearFocus(); unpin(); }
function select(id) {
  const anc = reach(id, cites), desc = reach(id, citedBy), ids = new Set([id, ...anc, ...desc]);
  // s cites t: keep edges that run among the ancestors or among the descendants
  focus(ids, (s, t) => ((s === id || anc.has(s)) && anc.has(t)) || (desc.has(s) && (t === id || desc.has(t))));
  const n = nodes[id];
  $("lineage").classList.remove("active");
  pin(paperTip(n) + `<div class="actions"><span class="k">Lineage highlighted on the map.</span>` +
      (n.url ? ` <a href="${esc(n.url)}" target="_blank" rel="noopener">Open paper ↗</a>` : "") + `</div>`,
      { x: n.x, y: n.y }, n.color, "dot:" + id);
}
// a click on empty map (not a drag) closes the card
wrap.addEventListener("click", e => { if (!moved && !e.target.closest(".dot,.rail-hit,.bundle-hit,#bar,#pin")) dismiss(); });
$("close").onclick = e => { e.stopPropagation(); dismiss(); };
window.addEventListener("keydown", e => { if (e.key === "Escape") dismiss(); });
$("lineage").onclick = e => { e.stopPropagation();
  if (e.currentTarget.classList.contains("active")) return clearFocus();
  const c = DATA.chain, pairs = new Set(c.slice(1).map((id, i) => id + ">" + c[i]));
  unpin(); focus(new Set(c), (s, t) => pairs.has(s + ">" + t));
  e.currentTarget.classList.add("active"); };
fit();
</script></body></html>"""


def render_html(flow: dict, title: str) -> str:
    lay = layout(flow)
    data = {
        "width": lay["width"],
        "height": lay["height"],
        "chain": lay.get("chain", []),
        "edges": [{"s": e["s"], "t": e["t"]} for e in lay["edges"]],
        "nodes": [
            {key: n.get(key) for key in ("id", "title", "authors", "year", "citations", "url", "role",
                                          "bookmarked", "cited_by_in_set", "lane_label", "color", "x", "y")}
            for n in lay["nodes"]
        ],
        "lanes": [
            {key: lane[key] for key in ("lane", "label", "color", "size", "years", "origin", "hub", "frontier")}
            for lane in lay["lanes"]
        ],
        "bundles": [
            {key: b[key] for key in ("from_lane", "to_lane", "count", "branch", "examples")}
            for b in lay.get("bundles", [])
        ],
    }
    page_title = f"The Map of {title}"
    return (
        TEMPLATE.replace("__TITLE__", _t(page_title))
        .replace("__SURFACE__", SURFACE)
        .replace("__SVG__", _svg(lay, page_title) if lay["nodes"] else "<p style='color:#fff'>No dated papers.</p>")
        .replace("__DATA__", json.dumps(data).replace("</", "<\\/"))
    )
