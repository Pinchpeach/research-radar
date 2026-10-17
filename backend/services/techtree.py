"""Tech-tree map of a research flow, in the spirit of "The Map of Physics".

Overview first, details on demand:
- Each topic is a rail that starts where the topic emerges. A topic that grew out of an
  earlier one branches off that topic's rail; the others branch off a glowing ORIGINS node.
- Citations between topics are drawn as one soft bundle per topic pair (width = count).
- Every paper is a dot on its rail (size = citations, glow = key paper). Hovering a dot shows
  the paper and its individual citation lines; hovering a rail or a bundle summarizes it.
- Clicking a dot pins it and traces what it builds on and what built on it.
- Paper titles are placed in screen space at a fixed size, so zooming in spreads the dots and
  lets more titles in; a title that would overlap another title, a dot or a topic name is left
  out (most important papers first). Scrolling pans, Ctrl/⌘ + scroll zooms, and a timeline bar
  and year ruler stay at the bottom while moving around.
- UI text comes in Korean and English (`lang`); paper titles and topic names stay as they are.

`layout()` does the geometry (so it can be tested); `render_html()` turns it into a
self-contained interactive page.
"""

import html
import json
import math
import random
import re
import statistics
from collections import Counter, defaultdict

from backend.paths import shared_json, shared_text

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

# Poster text (shared with the Android app). Paper titles and topic names are never translated.
STRINGS = shared_json("poster-strings.json")


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
        "axis": {"x0": X0, "ppy": ppy, "first": first_year},
    }


# ---------------------------------------------------------------- rendering


def _t(value) -> str:
    return html.escape(str(value), quote=True)


def _svg(lay: dict, title: str, text: dict) -> str:
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
    letters = sum(2 if "\uac00" <= ch <= "\ud7a3" else 1 for ch in title)
    title_size = max(26, min(52, (W - 160) / max(1, letters) / 0.75))
    out.append(
        f'<text x="{W / 2:.0f}" y="92" text-anchor="middle" fill="{TEXT}" font-size="{title_size:.0f}" font-weight="300" '
        f'letter-spacing="6">{_t(title.upper())}</text>'
        f'<text x="{W / 2:.0f}" y="128" text-anchor="middle" fill="{TEXT_2}" font-size="17" letter-spacing="2">'
        + _t(text["subtitle"].format(papers=len(lay["nodes"]), topics=len(lay["lanes"]), first=first, last=last))
        + "</text>"
    )

    # era grid; the year numbers live in the screen-space ruler so they stay readable
    axis_y = TOP - 80
    out.append('<g pointer-events="none">')
    for year, x in lay["ticks"]:
        out.append(
            f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{axis_y + 12}" y2="{H - 150:.0f}" stroke="#fff" '
            f'stroke-opacity=".05" stroke-dasharray="2 6"/>'
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
            f'<circle class="hit" cx="{x:.1f}" cy="{y:.1f}" r="{r + 6:.1f}" fill="transparent"/></g>'
        )
    out.append("</g>")

    # topic name at the rail start and a summary at the rail end (paper titles are placed by the script)
    out.append(f'<g pointer-events="none" stroke="{SURFACE}" stroke-width="5" paint-order="stroke" stroke-linejoin="round">')
    for lane in lay["lanes"]:
        y = lane["rail_y"]
        # a topic that starts late would push its label past the arrow; right-align it instead
        label_w = len(lane["label"]) * 17 * 0.72
        anchor = ' text-anchor="end"' if lane["x_start"] + label_w > lane["x_end"] else ""
        label_x = lane["x_end"] if anchor else lane["x_start"]
        out.append(
            f'<text class="lane-label" data-ax="{label_x:.1f}" data-ay="{y:.1f}" x="{label_x:.1f}" y="{y - 22:.1f}"{anchor} '
            f'font-size="17" font-weight="700" letter-spacing="1.5" fill="{lane["color"]}">{_t(lane["label"].upper())}</text>'
            f'<text class="lane-label" data-ax="{lane["x_end"]:.1f}" data-ay="{y:.1f}" x="{lane["x_end"] + 18:.1f}" '
            f'y="{y + 5:.1f}" font-size="14" fill="{TEXT_2}">'
            + _t(text["lane_end"].format(n=lane["size"], first=lane["years"][0], last=lane["years"][1]))
            + "</text>"
        )
    out.append("</g>")

    out.append(
        f'<circle cx="{rx:.0f}" cy="{ry:.1f}" r="80" fill="url(#glow)" pointer-events="none"/>'
        f'<text x="{rx:.0f}" y="{ry + 4:.1f}" text-anchor="middle" fill="#0b0b0b" font-size="11" font-weight="700" '
        f'pointer-events="none">{_t(text["origins"])}</text>'
    )

    # how to read
    ly = H - 135
    for i, line in enumerate(text["notes"]):
        out.append(
            f'<text x="{ROOT_X - 40}" y="{ly + i * 21}" fill="{TEXT if i == 0 else TEXT_3}" '
            f'font-size="{14 if i == 0 else 12.5}" font-weight="{700 if i == 0 else 400}" pointer-events="none" '
            f'class="lane-label">{_t(line)}</text>'
        )

    # screen-space layer: paper titles and the year ruler, drawn by the script at a fixed size
    out.append(
        f'</g><g id="titles" pointer-events="none" font-size="11" stroke="{SURFACE}" stroke-width="4" '
        f'paint-order="stroke" stroke-linejoin="round"></g></svg>'
    )
    return "".join(out)


# The interactive page around the SVG, shared with the Android app.
TEMPLATE = shared_text("poster.html")


def render_html(flow: dict, title: str, lang: str = "ko") -> str:
    text = STRINGS.get(lang, STRINGS["en"])
    lay = layout(flow)
    data = {
        "width": lay["width"],
        "height": lay["height"],
        "axis": lay.get("axis", {"x0": X0, "ppy": PX_PER_YEAR_RANGE[0], "first": 0}),
        "years": lay.get("years", (0, 0)),
        "chain": lay.get("chain", []),
        "edges": [{"s": e["s"], "t": e["t"]} for e in lay["edges"]],
        "nodes": [
            {key: n.get(key) for key in ("id", "title", "authors", "year", "citations", "url", "role", "bookmarked",
                                          "cited_by_in_set", "lane_label", "color", "x", "y", "r", "glow")}
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
    page_title = text["page_title"].format(title=title)
    empty = f"<p style='color:#fff'>{_t(text['no_papers'])}</p>"
    values = {
        "__LANG__": lang if lang in STRINGS else "en",
        "__TITLE__": _t(page_title),
        "__SURFACE__": SURFACE,
        "__SVG__": _svg(lay, page_title, text) if lay["nodes"] else empty,
        "__TEXT__": json.dumps(text["js"], ensure_ascii=False).replace("</", "<\\/"),
        "__DATA__": json.dumps(data).replace("</", "<\\/"),
    }
    # one pass, so text inside one value (a paper title, say) is never mistaken for a placeholder
    return re.sub("|".join(values), lambda m: values[m.group(0)], TEMPLATE)
