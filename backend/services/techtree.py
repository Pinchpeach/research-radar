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

# Poster text. Paper titles and topic names are never translated.
STRINGS = {
    "ko": {
        "page_title": "{title} 연구 흐름",
        "subtitle": "연구 흐름 · 논문 {papers}편 · 주제 {topics}개 · {first}–{last}",
        "lane_end": "{n}편 · {first}–{last}",
        "origins": "기원",
        "notes": [
            "읽는 법",
            "· 레일 하나가 연구 주제이고, 왼쪽에서 오른쪽으로 시간이 흐릅니다. 주제는 자신이 자라난 주제에서 갈라져 나옵니다.",
            "· 레일 사이의 부드러운 곡선은 주제 사이의 인용입니다. 두꺼울수록 많습니다.",
            "· 점은 논문입니다 (클수록 많이 인용됨, 빛 = 핵심 논문, ○ = 기초 논문, ★ = 북마크).",
            "· 점·레일·곡선에 마우스를 올리면 요약이, 클릭하면 고정 카드가 뜹니다 (× 또는 빈 곳을 누르면 닫힘).",
            "· 스크롤로 이동하고 Ctrl(⌘)+스크롤로 확대합니다. 확대할수록 더 많은 제목이 보입니다.",
        ],
        "no_papers": "연도가 있는 논문이 없습니다.",
        "js": {
            "titles": "제목", "titlesTip": "모든 논문 제목 보기 (겹치지 않는 만큼)",
            "lineage": "핵심 계보", "lineageTip": "가장 긴 인용 사슬 강조",
            "zoomIn": "확대", "zoomOut": "축소", "fit": "전체 보기", "fitTip": "화면에 맞추기",
            "details": "상세 정보", "close": "닫기 (Esc)",
            "foundational": " · ○ 기초 논문", "citations": "인용 {n}회", "bookmarked": " · ★ 북마크",
            "lineageCounts": "이 지도에서 {anc}편을 바탕으로 하고, {desc}편으로 이어짐",
            "papers": "논문 {n}편", "origin": "시작", "hub": "핵심", "latest": "최신",
            "bundle": "인용 {n}회", "branch": " · 이 주제가 갈라져 나온 곳", "cites": "→ 인용 →",
            "highlighted": "지도에 계보를 표시했습니다.", "open": "논문 열기 ↗",
            "hint": "스크롤: 이동 · Ctrl/⌘+스크롤: 확대",
        },
    },
    "en": {
        "page_title": "The Map of {title}",
        "subtitle": "Research flow · {papers} papers · {topics} topics · {first}–{last}",
        "lane_end": "{n} papers · {first}–{last}",
        "origins": "ORIGINS",
        "notes": [
            "How to read this map",
            "· Each rail is a research topic; time runs left to right. A topic branches off the topic it grew from.",
            "· Soft curves between rails are citations between topics — thicker means more.",
            "· Dots are papers (bigger = more cited, glow = key paper, ○ = foundational work, ★ = bookmarked).",
            "· Hover a dot, rail, or curve for a quick look; click to pin its card (× or empty space closes it).",
            "· Scroll to move, Ctrl(⌘) + scroll to zoom. Zooming in shows more titles.",
        ],
        "no_papers": "No dated papers.",
        "js": {
            "titles": "Titles", "titlesTip": "Show every title that fits without overlapping",
            "lineage": "Key lineage", "lineageTip": "Highlight the longest citation chain",
            "zoomIn": "Zoom in", "zoomOut": "Zoom out", "fit": "Fit", "fitTip": "Fit to screen",
            "details": "Details", "close": "Close (Esc)",
            "foundational": " · ○ foundational work", "citations": "{n} citations", "bookmarked": " · ★ bookmarked",
            "lineageCounts": "Builds on {anc} · led to {desc} papers in this map",
            "papers": "{n} papers", "origin": "Origin", "hub": "Key paper", "latest": "Latest",
            "bundle": "{n} citations", "branch": " · where this topic branched off", "cites": "cites",
            "highlighted": "Lineage highlighted on the map.", "open": "Open paper ↗",
            "hint": "Scroll: move · Ctrl/⌘ + scroll: zoom",
        },
    },
}


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


TEMPLATE = """<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
  html,body{margin:0;height:100%;background:__SURFACE__;overflow:hidden;font-family:Inter,system-ui,sans-serif}
  #wrap{position:relative;width:100%;height:100%;cursor:grab;outline:none}
  #wrap.drag{cursor:grabbing}
  svg{width:100%;height:100%;display:block}
  .dot{cursor:pointer;outline:none}
  .dot circle:first-child{transition:r .12s}
  .dot:hover circle:first-child,.dot:focus circle:first-child{stroke:#fff;stroke-width:3}
  #titles text{fill:#c3c2b7}
  #titles text.key{fill:#f0efec;font-weight:600;font-size:12px}
  .edge{opacity:0;transition:opacity .12s}
  .edge.peek,.edge.on{opacity:.95}
  .bundle,.rail,.dot,.halo{transition:opacity .15s}
  .bundle-hit,.rail-hit{cursor:help}
  .bundle.hover{stroke-opacity:.9}
  .focus .bundle,.focus .halo{opacity:.12}
  .focus .rail{opacity:.35}
  .focus .dot{opacity:.18}
  .focus .dot.on,.focus .halo.on{opacity:1}
  #bar{position:absolute;top:12px;right:12px;display:flex;gap:6px}
  #bar button{background:#1f232c;color:#f0efec;border:1px solid #3a3f4b;border-radius:8px;padding:6px 10px;
    font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  #bar button.active{background:#f0efec;color:#0e1015}
  #hint{position:absolute;top:12px;left:12px;color:#8a8984;font:12px Inter,system-ui,sans-serif;pointer-events:none;
    background:rgba(14,16,21,.75);border-radius:6px;padding:5px 9px;transition:opacity .6s}
  #ruler{position:absolute;left:0;right:0;bottom:16px;height:16px;pointer-events:none;overflow:hidden;
    font:11px Inter,system-ui,sans-serif;color:#8a8984;text-shadow:0 0 4px #0e1015,0 0 4px #0e1015}
  #ruler span{position:absolute;top:0;transform:translateX(-50%)}
  #track{position:absolute;left:12px;right:12px;bottom:5px;height:8px;border-radius:4px;background:rgba(255,255,255,.07);
    display:none;cursor:pointer}
  #thumb{position:absolute;top:0;height:100%;min-width:24px;border-radius:4px;background:rgba(240,239,236,.35);cursor:grab}
  #thumb:hover,#thumb.drag{background:rgba(240,239,236,.65)}
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
<body><div id="wrap" tabindex="0">
__SVG__
<div id="hint"></div>
<div id="ruler"></div>
<div id="track"><div id="thumb"></div></div>
<div id="bar">
  <button id="labels"></button><button id="lineage"></button>
  <button id="zin">+</button><button id="zout">−</button><button id="fit"></button>
</div>
<div id="tip" role="tooltip"></div>
<div id="pinmark"></div>
<div id="pin" role="dialog"><button id="close">×</button><div id="pinbody"></div></div>
</div>
<script>
const DATA = __DATA__;
const T = __TEXT__;
const $ = id => document.getElementById(id);
const fmt = (key, v = {}) => T[key].replace(/\\{(\\w+)\\}/g, (m, k) => (k in v ? v[k] : m));
const svg = $("map"), vp = $("viewport"), wrap = $("wrap"), tip = $("tip");
const W = DATA.width, H = DATA.height, LABEL_ZOOM = 1.6, RULER_H = 36, GROW_UNTIL = 1.5;
let s = 1, tx = 0, ty = 0, fitScale = 1, labelsOn = false, frame = 0, k = 1;

// ---------- button text ----------
const button = (id, text, title) => { $(id).textContent = text; $(id).title = title || text; };
button("labels", T.titles, T.titlesTip); button("lineage", T.lineage, T.lineageTip);
$("zin").title = T.zoomIn; $("zout").title = T.zoomOut; button("fit", T.fit, T.fitTip);
$("close").title = T.close; $("close").setAttribute("aria-label", T.close); $("pin").setAttribute("aria-label", T.details);
$("hint").textContent = T.hint;

// ---------- pan & zoom: scroll moves, Ctrl/⌘ + scroll (or a pinch) zooms ----------
function clampPan() {
  // keep at least half of the map (or of the frame) in view
  const w = wrap.clientWidth, h = wrap.clientHeight, mx = Math.min(W * s, w) / 2, my = Math.min(H * s, h) / 2;
  tx = Math.min(w - mx, Math.max(mx - W * s, tx));
  ty = Math.min(h - my, Math.max(my - H * s, ty));
}
function apply() {
  if (!s) return;
  clampPan();
  vp.setAttribute("transform", `translate(${tx},${ty}) scale(${s})`);
  placePin();
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; resizeMarks(); placeLabels(); drawRuler(); });
}

// ---------- marks stop growing past GROW_UNTIL × the overview zoom ----------
// Zooming in then spreads dots, rails and topic names apart instead of blowing them up,
// which leaves room for the titles.
const sized = [];
const keep = (el, attr) => { const base = parseFloat(el.getAttribute(attr)); if (!isNaN(base)) sized.push([el, attr, base]); };
document.querySelectorAll(".dot circle").forEach(el => { keep(el, "r"); keep(el, "stroke-width"); });
document.querySelectorAll(".halo").forEach(el => keep(el, "r"));
document.querySelectorAll(".rail,.rail-hit,.bundle,.bundle-hit,.edge").forEach(el => keep(el, "stroke-width"));
document.querySelectorAll(".lane-label").forEach(el => keep(el, "font-size"));
const anchored = [...document.querySelectorAll("[data-ax]")].map(el => [el, +el.dataset.ax, +el.dataset.ay,
  +el.getAttribute("x"), +el.getAttribute("y")]);
const stars = [...document.querySelectorAll(".dot text")].map(el => [el, +el.closest(".dot").querySelector("circle").getAttribute("cy"),
  +el.getAttribute("y")]);
function resizeMarks() {
  const nk = Math.min(1, fitScale * GROW_UNTIL / s);
  if (Math.abs(nk - k) < 1e-3) return;
  k = nk;
  for (const [el, attr, base] of sized) el.setAttribute(attr, (base * k).toFixed(2));
  for (const [el, ax, ay, x, y] of anchored) { el.setAttribute("x", (ax + (x - ax) * k).toFixed(1)); el.setAttribute("y", (ay + (y - ay) * k).toFixed(1)); }
  for (const [el, cy, y] of stars) { el.setAttribute("y", (cy + (y - cy) * k).toFixed(1)); el.setAttribute("font-size", (11 * k).toFixed(1)); }
}
function fit() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return; // drawn in a hidden tab: wait for the resize when it is shown
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s = fitScale = Math.min(w / W, h / H); tx = (w - W * s) / 2; ty = (h - H * s) / 2; apply();
}
function zoom(f, cx, cy) {
  cx ??= wrap.clientWidth / 2; cy ??= wrap.clientHeight / 2;
  const ns = Math.max(fitScale * 0.5, Math.min(fitScale * 10, s * f));
  tx = cx - (cx - tx) * ns / s; ty = cy - (cy - ty) * ns / s; s = ns; apply();
}
const quiet = () => { $("hint").style.opacity = 0; };
wrap.addEventListener("wheel", e => {
  e.preventDefault(); quiet(); hideTip();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? wrap.clientHeight : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit, r = wrap.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) return zoom(Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.008), e.clientX - r.left, e.clientY - r.top);
  if (e.shiftKey && !dx) tx -= dy; else { tx -= dx; ty -= dy; }
  apply();
}, { passive: false });
wrap.addEventListener("dblclick", e => { if (e.target.closest("#bar,#pin,#track")) return;
  const r = wrap.getBoundingClientRect(); zoom(1.8, e.clientX - r.left, e.clientY - r.top); });
wrap.addEventListener("keydown", e => {
  const step = 80, moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key]) { e.preventDefault(); tx += moves[e.key][0]; ty += moves[e.key][1]; apply(); }
  else if (e.key === "+" || e.key === "=") zoom(1.4);
  else if (e.key === "-") zoom(1 / 1.4);
  else if (e.key === "0") fit();
});
let drag = null, moved = false;
wrap.addEventListener("pointerdown", e => { if (e.target.closest("#bar,#pin,#track")) return;
  drag = { x: e.clientX, y: e.clientY, tx, ty }; moved = false; wrap.classList.add("drag"); });
window.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; hideTip(); quiet(); } tx = drag.tx + dx; ty = drag.ty + dy; apply(); });
window.addEventListener("pointerup", () => { drag = null; wrap.classList.remove("drag"); });
$("zin").onclick = () => zoom(1.4); $("zout").onclick = () => zoom(1 / 1.4); $("fit").onclick = fit;
$("labels").onclick = e => { labelsOn = !labelsOn; e.currentTarget.classList.toggle("active", labelsOn); apply(); };
window.addEventListener("resize", fit);

// ---------- timeline bar: the visible stretch of the map, draggable ----------
const track = $("track"), thumb = $("thumb");
let thumbDrag = null;
thumb.addEventListener("pointerdown", e => { e.stopPropagation(); thumb.setPointerCapture(e.pointerId);
  thumbDrag = { x: e.clientX, tx }; thumb.classList.add("drag"); });
thumb.addEventListener("pointermove", e => { if (!thumbDrag) return;
  tx = thumbDrag.tx - (e.clientX - thumbDrag.x) / track.clientWidth * W * s; quiet(); apply(); });
thumb.addEventListener("pointerup", () => { thumbDrag = null; thumb.classList.remove("drag"); });
track.addEventListener("click", e => { if (e.target !== track) return; e.stopPropagation();
  const r = track.getBoundingClientRect(); tx = wrap.clientWidth / 2 - (e.clientX - r.left) / r.width * W * s; apply(); });

// ---------- year ruler: stays at the bottom, spacing adapts to the zoom ----------
const A = DATA.axis, ruler = $("ruler");
function drawRuler() {
  const w = wrap.clientWidth, perYear = A.ppy * s;
  const step = [1, 2, 5, 10, 20, 50].find(k => k * perYear >= 56) || 100;
  const yearAt = sx => A.first + ((sx - tx) / s - A.x0) / A.ppy;
  const [first, last] = DATA.years;
  let marks = "";
  for (let y = Math.ceil(Math.max(first, yearAt(0)) / step) * step; y <= Math.min(last + step / 2, yearAt(w)); y += step) {
    marks += `<span style="left:${((A.x0 + (y - A.first) * A.ppy) * s + tx).toFixed(0)}px">${y}</span>`;
  }
  ruler.innerHTML = marks;
  const mapW = W * s;
  track.style.display = mapW > w + 2 ? "block" : "none";
  if (mapW > w + 2) {
    const tw = track.clientWidth;
    thumb.style.width = Math.max(24, w / mapW * tw) + "px";
    thumb.style.left = Math.min(tw - thumb.offsetWidth, Math.max(0, -tx / mapW * tw)) + "px";
  }
}

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

// ---------- paper titles: fixed size on screen, never overlapping ----------
// The most important papers claim space first; a title that would cover another title, a dot,
// a topic name or the controls is left out. Zooming in spreads the dots, so more titles fit.
const hubs = new Set(DATA.lanes.map(l => l.hub));
const importance = n => (hubs.has(n.id) ? 4e6 : 0) + (n.glow ? 2e6 : 0) + (n.bookmarked ? 1e6 : 0) + (n.citations || 0);
const byImportance = [...DATA.nodes].sort((a, b) => importance(b) - importance(a));
const measure = document.createElement("canvas").getContext("2d");
const labelEls = {}, NS = "http://www.w3.org/2000/svg";
for (const n of byImportance) {
  const lead = document.createElementNS(NS, "line"), el = document.createElementNS(NS, "text");
  if (hubs.has(n.id) || n.glow) el.classList.add("key");
  lead.setAttribute("stroke", n.color); lead.setAttribute("stroke-width", "1"); lead.setAttribute("stroke-opacity", ".7");
  el.style.display = lead.style.display = "none";
  $("titles").append(lead, el);
  labelEls[n.id] = { el, lead, sizes: {} };
}
function titleSize(n, L, chars) {
  // [text, width] of a title cut to `chars` letters, measured once
  if (!L.sizes[chars]) {
    const text = `${n.year} · ${shorten(n.title, chars)}`;
    measure.font = L.el.classList.contains("key") ? "600 12px Inter, system-ui, sans-serif" : "11px Inter, system-ui, sans-serif";
    L.sizes[chars] = [text, measure.measureText(text).width + 4];
  }
  return L.sizes[chars];
}
const shorten = (text, k) => { text = String(text || "").replace(/\\s+/g, " ").trim();
  return text.length <= k ? text : text.slice(0, k - 1).trimEnd() + "…"; };
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function placeLabels() {
  const w = wrap.clientWidth, h = wrap.clientHeight, wr = wrap.getBoundingClientRect();
  const zoomed = s >= fitScale * LABEL_ZOOM, focused = svg.classList.contains("focus");
  const chars = s >= fitScale * 3.5 ? 70 : zoomed ? 46 : 34;
  const taken = [];
  const takeRect = el => { const r = el.getBoundingClientRect();
    if (r.width) taken.push([r.left - wr.left - 3, r.top - wr.top - 2, r.right - wr.left + 3, r.bottom - wr.top + 2]); };
  document.querySelectorAll(".lane-label").forEach(takeRect);
  takeRect($("bar"));
  if (pinned) takeRect($("pin"));
  const visible = [];
  for (const n of DATA.nodes) {
    const x = n.x * s + tx, y = n.y * s + ty, r = Math.max(2, n.r * k * s);
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    visible.push(n.id);
    taken.push([x - r - 1, y - r - 1, x + r + 1, y + r + 1]);
  }
  const shown = new Set(visible);
  const selected = pinned && pinned.key.startsWith("dot:") ? pinned.key.slice(4) : null;
  const order = selected ? [nodes[selected], ...byImportance.filter(n => n.id !== selected)] : byImportance;
  const onLineage = new Set(dotEls.filter(d => d.classList.contains("on")).map(d => d.dataset.id));
  const free = box => box[0] >= 4 && box[1] >= 4 && box[2] <= w - 4 && box[3] <= h - RULER_H && !taken.some(t => overlaps(box, t));
  for (const n of order) {
    const L = labelEls[n.id];
    L.el.style.display = L.lead.style.display = "none";
    const eligible = shown.has(n.id) && (focused ? onLineage.has(n.id) : labelsOn || zoomed || hubs.has(n.id) || n.glow || n.bookmarked);
    if (!eligible) continue;
    const x = n.x * s + tx, y = n.y * s + ty, r = Math.max(2, n.r * k * s), th = 14, g = 3;
    // the full title in the six spots around the dot, then a short one, then lifted a row or two
    // above or below with a thin leader line (only where the line itself crosses nothing)
    let placed = null;
    for (const c of [chars, 18]) {
      const [text, tw] = titleSize(n, L, c);
      const spots = [
        [x - tw / 2, y - r - g - th], [x - tw / 2, y + r + g],
        [x + r + g, y - r - th + 3], [x - r - g - tw, y - r - th + 3],
        [x + r + g, y + r - 3], [x - r - g - tw, y + r - 3],
      ];
      for (const [lx, ly] of spots) if (free([lx, ly, lx + tw, ly + th])) { placed = { text, lx, ly, tw }; break; }
      if (placed) break;
    }
    if (!placed) {
      const [text, tw] = titleSize(n, L, 18);
      for (const row of [1, 2]) for (const side of [-1, 1]) {
        if (placed) break;
        const ly = side < 0 ? y - r - g - th - row * (th + 2) : y + r + g + row * (th + 2), lx = x - tw / 2;
        const lead = side < 0 ? [x - 1, ly + th, x + 1, y - r] : [x - 1, y + r, x + 1, ly];
        if (free([lx, ly, lx + tw, ly + th]) && free(lead)) placed = { text, lx, ly, tw, lead };
      }
    }
    if (!placed) continue;
    const { text, lx, ly, tw, lead } = placed;
    taken.push([lx, ly, lx + tw, ly + th]);
    L.el.textContent = text;
    L.el.setAttribute("x", (lx + 2).toFixed(1));
    L.el.setAttribute("y", (ly + th - 3).toFixed(1));
    L.el.style.display = "";
    if (lead) {
      taken.push(lead);
      L.lead.setAttribute("x1", x); L.lead.setAttribute("x2", x);
      L.lead.setAttribute("y1", lead[1]); L.lead.setAttribute("y2", lead[3]);
      L.lead.style.display = "";
    }
  }
}

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
  return chip(n.lane_label, n.color) + `<b>${esc(n.title)}</b>` +
    `<span class="k">${esc((n.authors || []).join(", ") || "—")}</span><br>` +
    `${n.year} · ${fmt("citations", { n: (n.citations || 0).toLocaleString() })}` +
    `${n.bookmarked ? T.bookmarked : ""}${n.role === "foundation" ? T.foundational : ""}<br>` +
    `<span class="k">${fmt("lineageCounts", { anc, desc })}</span>`;
}
function laneTip(l) {
  const t = id => nodes[id] ? `${esc(nodes[id].title)} (${nodes[id].year})` : "—";
  return chip(l.label, l.color) + `<b>${fmt("papers", { n: l.size })} · ${l.years[0]}–${l.years[1]}</b>` +
    `<span class="k">${T.origin}</span> ${t(l.origin)}<br><span class="k">${T.hub}</span> ${t(l.hub)}<br>` +
    `<span class="k">${T.latest}</span><ul>${l.frontier.map(id => `<li>${t(id)}</li>`).join("")}</ul>`;
}
function bundleTip(b) {
  const a = lanes[b.from_lane], c = lanes[b.to_lane];
  return `${chip(a.label, a.color)} → ${chip(c.label, c.color)}` +
    `<b>${fmt("bundle", { n: b.count })}${b.branch ? T.branch : ""}</b>` +
    `<ul>${b.examples.map(x => `<li>${esc(x.citing)} (${x.citing_year}) <span class="k">${T.cites}</span> ${esc(x.cited)} (${x.cited_year})</li>`).join("")}</ul>`;
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
  apply();
  $("close").focus({ preventScroll: true });
}
function placePin() {
  if (!pinned) return;
  // follow the anchor as the map pans and zooms; keep the side the card opened on and flip
  // only when it would leave the frame
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
function unpin() { pinned = null; pinEl.style.display = pinMark.style.display = "none"; apply(); }

// ---------- focus: selected paper's lineage, or the key lineage ----------
function focus(ids, edgeOk) {
  svg.classList.add("focus");
  edgeEls.forEach(el => { el.classList.remove("peek"); el.classList.toggle("on", edgeOk(el.dataset.s, el.dataset.t)); });
  dotEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
  haloEls.forEach(el => el.classList.toggle("on", ids.has(el.dataset.id)));
  apply();
}
function clearFocus() {
  svg.classList.remove("focus");
  [...dotEls, ...edgeEls, ...haloEls].forEach(el => el.classList.remove("on", "peek"));
  $("lineage").classList.remove("active");
  apply();
}
function dismiss() { clearFocus(); unpin(); }
function select(id) {
  const anc = reach(id, cites), desc = reach(id, citedBy), ids = new Set([id, ...anc, ...desc]);
  // s cites t: keep edges that run among the ancestors or among the descendants
  focus(ids, (s, t) => ((s === id || anc.has(s)) && anc.has(t)) || (desc.has(s) && (t === id || desc.has(t))));
  const n = nodes[id];
  $("lineage").classList.remove("active");
  pin(paperTip(n) + `<div class="actions"><span class="k">${T.highlighted}</span>` +
      (n.url ? ` <a href="${esc(n.url)}" target="_blank" rel="noopener">${T.open}</a>` : "") + `</div>`,
      { x: n.x, y: n.y }, n.color, "dot:" + id);
}
// a click on empty map (not a drag) closes the card
wrap.addEventListener("click", e => { if (!moved && !e.target.closest(".dot,.rail-hit,.bundle-hit,#bar,#pin,#track")) dismiss(); });
$("close").onclick = e => { e.stopPropagation(); dismiss(); };
window.addEventListener("keydown", e => { if (e.key === "Escape") dismiss(); });
$("lineage").onclick = e => { e.stopPropagation();
  if (e.currentTarget.classList.contains("active")) return clearFocus();
  const c = DATA.chain, pairs = new Set(c.slice(1).map((id, i) => id + ">" + c[i]));
  unpin(); focus(new Set(c), (s, t) => pairs.has(s + ">" + t));
  e.currentTarget.classList.add("active"); };
fit();
setTimeout(quiet, 8000);
</script></body></html>"""


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
