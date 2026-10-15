"""Tech-tree poster of a research-flow map, in the style of "The Map of Physics".

Each topic is a colored rail running left to right through time. Papers are cards hanging
from stations on their rail. Citations between topics are routed as rounded orthogonal
connectors: out of the cited card, through the gap between year columns, along a channel
above the citing topic's rail, and into the citing card. A glowing root feeds every rail,
and each rail ends in a box listing its frontier papers.

`layout()` does all the geometry (so it can be tested); `render_html()` turns it into a
self-contained HTML page with pan/zoom, hover, and path highlighting.
"""

import html
import math
import json
import random
from collections import defaultdict

CARD_W, CARD_H = 176, 70
ROW_GAP = 12
COL_GAP = 36
MIN_COL = CARD_W + COL_GAP
SKIP_PX = 40  # extra space per empty era between two columns
MAX_SKIP_PX = 160
BIN_SIZES = (1, 2, 3, 5, 10)
TARGET_ASPECT = 1.8  # poster-like width : height

ROOT_X = 110
BUS_X = 250
FIRST_COL_X = BUS_X + 70 + CARD_W / 2
TOP = 230  # title + era axis
RAIL_PAD = 66  # space above a rail: lane label, then connector channels
STEM = 24  # rail to first card
LANE_BOTTOM = 34
PANEL_GAP = 110
PANEL_W = 280
CHANNEL_STEP = 4
GUTTER_STEP = 4

# Dark-mode categorical slots, in the validated order. Lanes are also labeled and
# separated by position, so color is never the only cue.
LANE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"]
TEXT = "#f0efec"
TEXT_2 = "#c3c2b7"
TEXT_3 = "#8a8984"
SURFACE = "#0e1015"
CARD = "#171a21"


def wrap(text: str, width: int, lines: int) -> list[str]:
    words, out, line = text.split(), [], ""
    for word in words:
        if line and len(line) + 1 + len(word) > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    out.append(line)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = out[-1][: width - 1].rstrip() + "…"
    return [part if len(part) <= width else part[: width - 1] + "…" for part in out]


def rounded_path(points: list[tuple[float, float]], radius: float = 10) -> str:
    """SVG path through `points` with rounded corners."""
    points = [p for i, p in enumerate(points) if i == 0 or p != points[i - 1]]
    if len(points) < 2:
        return ""
    parts = [f"M{points[0][0]:.1f},{points[0][1]:.1f}"]
    for prev, corner, nxt in zip(points, points[1:], points[2:]):
        d_in = ((corner[0] - prev[0]) ** 2 + (corner[1] - prev[1]) ** 2) ** 0.5
        d_out = ((nxt[0] - corner[0]) ** 2 + (nxt[1] - corner[1]) ** 2) ** 0.5
        r = min(radius, d_in / 2, d_out / 2)
        if r <= 0.5:
            parts.append(f"L{corner[0]:.1f},{corner[1]:.1f}")
            continue
        ax = corner[0] - (corner[0] - prev[0]) / d_in * r
        ay = corner[1] - (corner[1] - prev[1]) / d_in * r
        bx = corner[0] + (nxt[0] - corner[0]) / d_out * r
        by = corner[1] + (nxt[1] - corner[1]) / d_out * r
        parts.append(f"L{ax:.1f},{ay:.1f}Q{corner[0]:.1f},{corner[1]:.1f} {bx:.1f},{by:.1f}")
    parts.append(f"L{points[-1][0]:.1f},{points[-1][1]:.1f}")
    return "".join(parts)


def era_of(year: int, bin_size: int) -> int:
    return (year // bin_size) * bin_size


def era_label(era: int, bin_size: int) -> str:
    return str(era) if bin_size == 1 else f"{era}–{str(era + bin_size - 1)[-2:]}"


def column_positions(eras: list[int], bin_size: int) -> dict[int, float]:
    """One column per era that has papers; empty eras in between add a little space."""
    xs, x, prev = {}, FIRST_COL_X, None
    for era in sorted(set(eras)):
        if prev is not None:
            skipped = (era - prev) // bin_size - 1
            x += MIN_COL + min(MAX_SKIP_PX, skipped * SKIP_PX)
        xs[era] = x
        prev = era
    return xs


def layout(flow: dict, bin_size: int | None = None) -> dict:
    """Lay out the poster. Without `bin_size`, picks the finest era size that keeps it poster-shaped."""
    if bin_size is None:
        options = [layout(flow, size) for size in BIN_SIZES]
        # closest to the target shape; ties go to the finer era size
        return min(options, key=lambda lay: abs(math.log(lay["width"] / lay["height"] / TARGET_ASPECT)))
    nodes = [dict(n) for n in flow["nodes"] if n.get("year")]
    if not nodes:
        return {"nodes": [], "lanes": [], "edges": [], "width": 800, "height": 400, "bin_size": bin_size}
    for n in nodes:
        n["era"] = era_of(n["year"], bin_size)

    by_id = {n["id"]: n for n in nodes}
    clusters = {c["lane"]: c for c in flow["clusters"]}
    hubs = {c["hub"] for c in flow["clusters"]}
    chain = [nid for nid in flow.get("chain") or [] if nid in by_id]

    cols = column_positions([n["era"] for n in nodes], bin_size)
    col_eras = sorted(cols)
    col_index = {era: i for i, era in enumerate(col_eras)}

    def gutter_left(era: int) -> float:
        i = col_index[era]
        return (cols[col_eras[i - 1]] + cols[era]) / 2 if i else cols[era] - CARD_W / 2 - COL_GAP / 2

    def gutter_right(era: int) -> float:
        i = col_index[era]
        if i + 1 < len(col_eras):
            return (cols[era] + cols[col_eras[i + 1]]) / 2
        return cols[era] + CARD_W / 2 + COL_GAP / 2

    # ---- lanes and cards ----
    lanes, y = [], TOP
    for lane_no in sorted({n["lane"] for n in nodes}):
        members = [n for n in nodes if n["lane"] == lane_no]
        stacks = defaultdict(list)
        for n in members:
            stacks[n["era"]].append(n)
        rows = max(len(s) for s in stacks.values())
        rail_y = y + RAIL_PAD
        for era, stack in stacks.items():
            # oldest first, so time also reads top to bottom inside an era
            stack.sort(key=lambda n: (n["year"], -(n["citations"] or 0), n["id"]))
            for row, n in enumerate(stack):
                n["x"] = cols[era]
                n["top"] = rail_y + STEM + row * (CARD_H + ROW_GAP)
                n["cy"] = n["top"] + CARD_H / 2
                n["row"] = row
        height = RAIL_PAD + STEM + rows * (CARD_H + ROW_GAP) - ROW_GAP + LANE_BOTTOM
        cluster = clusters.get(lane_no, {})
        lanes.append(
            {
                "lane": lane_no,
                "label": cluster.get("label", f"topic {lane_no + 1}"),
                "color": LANE_COLORS[lane_no % len(LANE_COLORS)],
                "top": y,
                "height": height,
                "rail_y": rail_y,
                "x_end": None,  # set below
                "stations": sorted({cols[year] for year in stacks}),
                "stems": [(cols[era], rail_y, s[-1]["top"]) for era, s in stacks.items()],
                "size": len(members),
                "years": (min(n["year"] for n in members), max(n["year"] for n in members)),
                "frontier": [by_id[nid] for nid in cluster.get("frontier", []) if nid in by_id],
            }
        )
        y += height

    last_x = cols[col_eras[-1]]
    panel_x = last_x + CARD_W / 2 + PANEL_GAP
    for lane in lanes:
        lane["x_end"] = panel_x
    lane_by_no = {lane["lane"]: lane for lane in lanes}

    # ---- connectors ----
    edges = []
    channel_use = defaultdict(int)
    gutter_use = defaultdict(int)
    for e in flow["edges"]:
        citing, cited = by_id.get(e["source"]), by_id.get(e["target"])
        if not citing or not cited:
            continue
        if citing["lane"] == cited["lane"]:
            if citing["era"] == cited["era"]:
                continue  # stacked in the same column; the stem already joins them
            # same topic: the rail already implies continuity; drawn as an arc, shown on focus
            x0, y0 = cited["x"], lane_by_no[cited["lane"]]["rail_y"]
            x1 = citing["x"]
            lift = 14 + min(36, abs(x1 - x0) * 0.08)
            path = f"M{x0:.1f},{y0:.1f}Q{(x0 + x1) / 2:.1f},{y0 - 2 * lift:.1f} {x1:.1f},{y0:.1f}"
            edges.append({"s": citing["id"], "t": cited["id"], "kind": "within", "path": path,
                          "color": lane_by_no[cited["lane"]]["color"]})
            continue
        target_lane = lane_by_no[citing["lane"]]
        k = channel_use[citing["lane"]]
        channel_use[citing["lane"]] += 1
        channel_y = target_lane["rail_y"] - 10 - (k % 6) * CHANNEL_STEP  # stays below the lane label
        g_out_key, g_in_key = ("R", cited["era"]), ("L", citing["era"])
        g_out = gutter_right(cited["era"]) + (gutter_use[g_out_key] % 5 - 2) * GUTTER_STEP
        g_in = gutter_left(citing["era"]) + (gutter_use[g_in_key] % 5 - 2) * GUTTER_STEP
        gutter_use[g_out_key] += 1
        gutter_use[g_in_key] += 1
        points = [
            (cited["x"] + CARD_W / 2, cited["cy"]),
            (g_out, cited["cy"]),
            (g_out, channel_y),
            (g_in, channel_y),
            (g_in, citing["cy"]),
            (citing["x"] - CARD_W / 2, citing["cy"]),
        ]
        edges.append({"s": citing["id"], "t": cited["id"], "kind": "cross", "path": rounded_path(points),
                      "color": lane_by_no[cited["lane"]]["color"]})

    rails_top, rails_bottom = lanes[0]["rail_y"], lanes[-1]["rail_y"]
    root_y = (rails_top + rails_bottom) / 2
    height = y + 220  # room for the legend block
    width = panel_x + PANEL_W + 70

    years = [n["year"] for n in nodes]
    ticks = [(era_label(era, bin_size), cols[era]) for era in col_eras]

    for n in nodes:
        n["lane_color"] = lane_by_no[n["lane"]]["color"]
        n["lane_label"] = lane_by_no[n["lane"]]["label"]
        n["glow"] = n["id"] in hubs or (n["role"] == "foundation" and n["cited_by_in_set"] >= 3)

    return {
        "nodes": nodes,
        "lanes": lanes,
        "edges": edges,
        "chain": chain,
        "ticks": ticks,
        "root": (ROOT_X, root_y),
        "bus": (BUS_X, rails_top, rails_bottom),
        "panel_x": panel_x,
        "width": width,
        "height": height,
        "years": (min(years), max(years)),
        "bin_size": bin_size,
        "legend_y": y + 40,
    }


# ---------------------------------------------------------------- rendering


def _t(value) -> str:
    return html.escape(str(value), quote=True)


def _svg(lay: dict, title: str) -> str:
    W, H = lay["width"], lay["height"]
    out = [
        f'<svg id="map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
        f'font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif">',
        "<defs>"
        '<radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".95"/>'
        '<stop offset=".18" stop-color="#fff" stop-opacity=".55"/>'
        '<stop offset=".45" stop-color="#cfe0ff" stop-opacity=".12"/>'
        '<stop offset="1" stop-color="#cfe0ff" stop-opacity="0"/></radialGradient>'
        '<marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" '
        'orient="auto-start-reverse"><path d="M0,0L8,4L0,8z" fill="context-stroke"/></marker>'
        "</defs>",
        '<g id="viewport">',
        f'<rect x="-4000" y="-4000" width="{W + 8000:.0f}" height="{H + 8000:.0f}" fill="{SURFACE}"/>',
    ]

    # starfield + orbits (decoration, deterministic)
    rng = random.Random(7)
    stars = "".join(
        f'<circle cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(0, H):.0f}" r="{rng.choice([0.6, 0.8, 1.1]):.1f}" '
        f'opacity="{rng.uniform(.15, .6):.2f}"/>'
        for _ in range(int(W * H / 9000))
    )
    out.append(f'<g fill="#fff" class="deco">{stars}</g>')
    cx, cy = W * 0.62, H * 0.52
    orbits = "".join(
        f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{W * rx:.0f}" ry="{H * ry:.0f}" '
        f'transform="rotate({rot} {cx:.0f} {cy:.0f})"/>'
        for rx, ry, rot in [(0.42, 0.16, -28), (0.33, 0.22, -40), (0.25, 0.12, -18)]
    )
    out.append(f'<g class="deco" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width="2">{orbits}</g>')

    # title
    out.append(
        f'<text x="{W / 2:.0f}" y="92" text-anchor="middle" fill="{TEXT}" font-size="54" '
        f'font-weight="300" letter-spacing="6">{_t(title.upper())}</text>'
    )
    first, last = lay["years"]
    out.append(
        f'<text x="{W / 2:.0f}" y="130" text-anchor="middle" fill="{TEXT_2}" font-size="18" letter-spacing="2">'
        f"연구 발전 지도 · {len(lay['nodes'])} papers · {first}–{last}</text>"
    )

    # era axis
    axis_y = TOP - 30
    out.append(f'<g class="axis" font-size="13" fill="{TEXT_3}" text-anchor="middle">')
    for year, x in lay["ticks"]:
        out.append(
            f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{axis_y + 10}" y2="{lay["height"] - 230:.0f}" '
            f'stroke="#fff" stroke-opacity=".05" stroke-dasharray="2 6"/>'
            f'<text x="{x:.1f}" y="{axis_y}">{year}</text>'
        )
    out.append("</g>")

    # root + bus
    rx, ry = lay["root"]
    bus_x, bus_top, bus_bottom = lay["bus"]
    out.append(
        f'<path d="M{rx:.0f},{ry:.0f}H{bus_x}" stroke="{TEXT_2}" stroke-width="2.5" fill="none"/>'
        f'<path d="M{bus_x},{bus_top:.0f}V{bus_bottom:.0f}" stroke="{TEXT_2}" stroke-width="2.5" fill="none"/>'
    )

    # rails, stations, stems, frontier boxes (lane labels go on top of connectors, below)
    lane_labels = []
    for lane in lay["lanes"]:
        c, ry_ = lane["color"], lane["rail_y"]
        out.append(f'<g class="lane" data-lane="{lane["lane"]}">')
        out.append(
            f'<path d="{rounded_path([(bus_x, ry_ - 0.01), (bus_x, ry_), (lane["x_end"], ry_)], 12)}" '
            f'stroke="{c}" stroke-width="3.5" fill="none" marker-end="url(#arrow)"/>'
        )
        out.append(f'<circle cx="{bus_x}" cy="{ry_:.1f}" r="5" fill="{c}"/>')
        lane_labels.append(
            # dark outline so connectors crossing the label run visually behind it
            f'<text x="{bus_x + 16}" y="{ry_ - 42:.1f}" font-size="13" stroke="{SURFACE}" '
            f'stroke-width="5" paint-order="stroke" stroke-linejoin="round">'
            f'<tspan fill="{c}" font-weight="700" letter-spacing="1.5">{_t(lane["label"].upper())}</tspan>'
            f'<tspan fill="{TEXT_3}" font-size="11" dx="10">'
            f'{lane["size"]} papers · {lane["years"][0]}–{lane["years"][1]}</tspan></text>'
        )
        for x, y0, y1 in lane["stems"]:
            out.append(f'<path d="M{x:.1f},{y0:.1f}V{y1:.1f}" stroke="{c}" stroke-opacity=".55" stroke-width="1.5"/>')
        for x in lane["stations"]:
            out.append(f'<circle cx="{x:.1f}" cy="{ry_:.1f}" r="5.5" fill="{SURFACE}" stroke="{c}" stroke-width="2.5"/>')

        # frontier box
        px = lane["x_end"] + 12
        items = lane["frontier"][:3]
        box_h = 34 + 30 * max(1, len(items))
        out.append(
            f'<rect x="{px:.1f}" y="{ry_ - 22:.1f}" width="{PANEL_W - 20}" height="{box_h}" rx="8" '
            f'fill="{CARD}" fill-opacity=".85" stroke="{c}" stroke-width="1.5"/>'
            f'<text x="{px + 14:.1f}" y="{ry_ - 2:.1f}" fill="{c}" font-size="11" font-weight="700" '
            f'letter-spacing="1.5">FRONTIER</text>'
        )
        for i, n in enumerate(items):
            line = wrap(n["title"], 36, 1)[0]
            out.append(
                f'<text x="{px + 14:.1f}" y="{ry_ + 20 + i * 30:.1f}" fill="{TEXT}" font-size="12" '
                f'class="frontier" data-id="{_t(n["id"])}">{_t(line)}</text>'
                f'<text x="{px + 14:.1f}" y="{ry_ + 34 + i * 30:.1f}" fill="{TEXT_3}" font-size="10">'
                f'{n["year"]} · {_t((n["authors"] or ["—"])[0])}</text>'
            )
        out.append("</g>")

    # connectors
    out.append('<g id="edges" fill="none">')
    for e in lay["edges"]:
        cls = "edge " + e["kind"]
        out.append(
            f'<path class="{cls}" data-s="{_t(e["s"])}" data-t="{_t(e["t"])}" d="{e["path"]}" '
            f'stroke="{e["color"]}" stroke-width="{2 if e["kind"] == "cross" else 2.5}"/>'
        )
    out.append("</g>")
    out.append(f'<g class="lane-labels">{"".join(lane_labels)}</g>')

    # glows behind cards
    out.append('<g class="glows" pointer-events="none">')
    for n in lay["nodes"]:
        if n["glow"]:
            r = 70 + 12 * min(5, n["cited_by_in_set"])
            out.append(
                f'<circle class="halo" data-id="{_t(n["id"])}" cx="{n["x"]:.1f}" cy="{n["cy"]:.1f}" r="{r}" fill="url(#glow)"/>'
            )
    out.append("</g>")

    # cards
    out.append('<g id="nodes">')
    for n in lay["nodes"]:
        x0, top = n["x"] - CARD_W / 2, n["top"]
        dash = ' stroke-dasharray="4 3"' if n["role"] == "foundation" else ""
        author = (n["authors"] or ["—"])[0]
        lines = wrap(n["title"], 27, 2)
        badge = "★ " if n["bookmarked"] else "◆ " if n["role"] == "foundation" else ""
        out.append(
            f'<g class="node" data-id="{_t(n["id"])}" tabindex="0">'
            f'<rect x="{x0:.1f}" y="{top:.1f}" width="{CARD_W}" height="{CARD_H}" rx="7" fill="{CARD}" '
            f'stroke="{n["lane_color"]}" stroke-opacity=".9" stroke-width="{2.2 if n["glow"] else 1.2}"{dash}/>'
            f'<rect x="{x0:.1f}" y="{top:.1f}" width="4" height="{CARD_H}" rx="2" fill="{n["lane_color"]}"/>'
            f'<text x="{x0 + 12:.1f}" y="{top + 16:.1f}" font-size="10.5" fill="{TEXT_2}">'
            f'{badge}{n["year"]} · {_t(author)}</text>'
        )
        for i, line in enumerate(lines):
            out.append(
                f'<text x="{x0 + 12:.1f}" y="{top + 33 + i * 15:.1f}" font-size="12.5" fill="{TEXT}" '
                f'font-weight="600">{_t(line)}</text>'
            )
        out.append(
            f'<text x="{x0 + CARD_W - 10:.1f}" y="{top + CARD_H - 8:.1f}" font-size="10" fill="{TEXT_3}" '
            f'text-anchor="end">{n["citations"]:,} cites</text></g>'
        )
    out.append("</g>")

    # root glow on top of the bus
    out.append(
        f'<circle cx="{rx:.0f}" cy="{ry:.0f}" r="95" fill="url(#glow)"/>'
        f'<text x="{rx:.0f}" y="{ry + 4:.0f}" text-anchor="middle" fill="#0b0b0b" font-size="11" '
        f'font-weight="700">ORIGINS</text>'
    )

    # legend block (bottom left, like the poster's notes)
    ly = lay["legend_y"]
    legend = [
        "How to read this map",
        "· Each colored rail is a research topic; time runs left to right.",
        "· Cards are papers. Glow = hub (most cited inside this map) or a key foundation.",
        "· ★ bookmarked   ◆ foundational work (dashed card) cited by several of your papers.",
        "· Lines between rails are citations from one topic to another, colored by the cited topic.",
        "· Click a card to trace what it builds on and what built on it.",
    ]
    for i, line in enumerate(legend):
        out.append(
            f'<text x="{BUS_X - 140}" y="{ly + i * 22}" fill="{TEXT if i == 0 else TEXT_2}" '
            f'font-size="{14 if i == 0 else 13}" font-weight="{700 if i == 0 else 400}">{_t(line)}</text>'
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
  .node{cursor:pointer}
  .node:hover rect:first-child,.node:focus rect:first-child{stroke-width:2.6}
  .edge{transition:opacity .15s;stroke-opacity:.75}
  .edge.within{opacity:0}
  .dim .node,.dim .halo,.dim .edge.cross{opacity:.12}
  .dim .node.on,.dim .halo.on{opacity:1}
  .dim .edge.on{opacity:1;stroke-width:3}
  #bar{position:absolute;top:12px;right:12px;display:flex;gap:6px}
  #bar button{background:#1f232c;color:#f0efec;border:1px solid #3a3f4b;border-radius:8px;padding:6px 10px;
    font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  #bar button.active{background:#f0efec;color:#0e1015}
  #tip{position:absolute;pointer-events:none;background:#f0efec;color:#0e1015;border-radius:8px;padding:8px 10px;
    font-size:12px;line-height:1.45;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,.45);display:none}
  #tip b{display:block;margin-bottom:2px}
  #info{position:absolute;left:12px;bottom:12px;max-width:420px;background:#1b1e26f2;color:#f0efec;
    border:1px solid #3a3f4b;border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.5;display:none}
  #info a{color:#86b6ef}
  #info .muted{color:#c3c2b7}
  #info button{float:right;background:none;border:0;color:#c3c2b7;font-size:16px;cursor:pointer}
</style></head>
<body><div id="wrap">
__SVG__
<div id="bar">
  <button id="lineage" title="Highlight the longest citation chain">핵심 계보</button>
  <button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">−</button>
  <button id="fit" title="Fit to screen">전체 보기</button>
</div>
<div id="tip"></div>
<div id="info"><button id="close" aria-label="Close">×</button><div id="infobody"></div></div>
</div>
<script>
const DATA = __DATA__;
const svg = document.getElementById("map"), vp = document.getElementById("viewport"), wrap = document.getElementById("wrap");
const W = DATA.width, H = DATA.height;
let s = 1, tx = 0, ty = 0;
const apply = () => vp.setAttribute("transform", `translate(${tx},${ty}) scale(${s})`);
svg.setAttribute("viewBox", `0 0 ${wrap.clientWidth} ${wrap.clientHeight}`);
function fit() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s = Math.min(w / W, h / H); tx = (w - W * s) / 2; ty = (h - H * s) / 2; apply();
}
function zoom(f, cx, cy) {
  cx ??= wrap.clientWidth / 2; cy ??= wrap.clientHeight / 2;
  const ns = Math.max(0.1, Math.min(4, s * f)); tx = cx - (cx - tx) * ns / s; ty = cy - (cy - ty) * ns / s; s = ns; apply();
}
wrap.addEventListener("wheel", e => { e.preventDefault(); const r = wrap.getBoundingClientRect();
  zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
let drag = null, moved = false;
wrap.addEventListener("pointerdown", e => { if (e.target.closest("#bar,#info")) return;
  drag = { x: e.clientX, y: e.clientY, tx, ty }; moved = false; wrap.classList.add("drag"); });
window.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; tx = drag.tx + dx; ty = drag.ty + dy; apply(); });
window.addEventListener("pointerup", () => { drag = null; wrap.classList.remove("drag"); });
document.getElementById("zin").onclick = () => zoom(1.25);
document.getElementById("zout").onclick = () => zoom(0.8);
document.getElementById("fit").onclick = fit;
window.addEventListener("resize", fit);

const nodes = Object.fromEntries(DATA.nodes.map(n => [n.id, n]));
const cites = {}, citedBy = {};
for (const e of DATA.edges) { (cites[e.s] ??= []).push(e.t); (citedBy[e.t] ??= []).push(e.s); }
function reach(start, graph) { const seen = new Set(), stack = [start];
  while (stack.length) for (const n of graph[stack.pop()] || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen; }
const nodeEls = [...document.querySelectorAll(".node")], edgeEls = [...document.querySelectorAll(".edge")];
const haloEls = [...document.querySelectorAll(".halo")];
function highlight(ids, edgeOk) {
  svg.classList.add("dim");
  nodeEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
  haloEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
  edgeEls.forEach(el => el.classList.toggle("on", edgeOk(el.dataset.s, el.dataset.t)));
}
function clear() { svg.classList.remove("dim"); [...nodeEls, ...edgeEls, ...haloEls].forEach(el => el.classList.remove("on"));
  document.getElementById("info").style.display = "none"; document.getElementById("lineage").classList.remove("active"); }
const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function select(id) {
  const anc = reach(id, cites), desc = reach(id, citedBy), ids = new Set([id, ...anc, ...desc]);
  // an edge s→t (s cites t) is on the path if it runs among the ancestors or among the descendants
  highlight(ids, (s, t) => ((s === id || anc.has(s)) && anc.has(t)) || (desc.has(s) && (t === id || desc.has(t))));
  const n = nodes[id];
  document.getElementById("infobody").innerHTML =
    `<b>${esc(n.title)}</b><br><span class="muted">${esc((n.authors || []).join(", "))} · ${n.year} · ${n.citations.toLocaleString()} citations</span><br>` +
    `<span class="muted">Topic: ${esc(n.lane_label)}</span><br>` +
    `Builds on <b>${anc.size}</b> paper${anc.size === 1 ? "" : "s"} in this map · led to <b>${desc.size}</b><br>` +
    (n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">Open paper ↗</a>` : "");
  document.getElementById("info").style.display = "block";
  document.getElementById("lineage").classList.remove("active");
}
nodeEls.forEach(el => {
  el.addEventListener("click", e => { if (!moved) { e.stopPropagation(); select(el.dataset.id); } });
  el.addEventListener("keydown", e => { if (e.key === "Enter") select(el.dataset.id); });
  el.addEventListener("pointerenter", () => { const n = nodes[el.dataset.id], tip = document.getElementById("tip");
    tip.innerHTML = `<b>${esc(n.title)}</b>${esc((n.authors || []).join(", "))}<br>${n.year} · ${n.citations.toLocaleString()} citations` +
      `<br>Cited by ${n.cited_by_in_set} in this map` + (n.bookmarked ? " · ★ bookmarked" : "") + (n.role === "foundation" ? " · ◆ foundation" : "");
    tip.style.display = "block"; });
  el.addEventListener("pointermove", e => { const tip = document.getElementById("tip"), r = wrap.getBoundingClientRect();
    tip.style.left = Math.min(e.clientX - r.left + 14, wrap.clientWidth - 330) + "px"; tip.style.top = (e.clientY - r.top + 14) + "px"; });
  el.addEventListener("pointerleave", () => document.getElementById("tip").style.display = "none");
});
document.querySelectorAll(".frontier").forEach(el => { el.style.cursor = "pointer";
  el.addEventListener("click", e => { e.stopPropagation(); select(el.dataset.id); }); });
wrap.addEventListener("click", e => { if (!moved && !e.target.closest(".node,#bar,#info,.frontier")) clear(); });
document.getElementById("close").onclick = clear;
document.getElementById("lineage").onclick = e => { e.stopPropagation();
  if (e.currentTarget.classList.contains("active")) return clear();
  const chain = DATA.chain, ids = new Set(chain), pairs = new Set(chain.slice(1).map((id, i) => id + ">" + chain[i]));
  highlight(ids, (s, t) => pairs.has(s + ">" + t));
  document.getElementById("info").style.display = "none"; e.currentTarget.classList.add("active"); };
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
                                          "bookmarked", "cited_by_in_set", "lane_label")}
            for n in lay["nodes"]
        ],
    }
    page_title = f"The Map of {title}"
    return (
        TEMPLATE.replace("__TITLE__", _t(page_title))
        .replace("__SURFACE__", SURFACE)
        .replace("__SVG__", _svg(lay, page_title) if lay["nodes"] else "<p style='color:#fff'>No dated papers.</p>")
        .replace("__DATA__", json.dumps(data).replace("</", "<\\/"))
    )
