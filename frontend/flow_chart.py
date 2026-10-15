"""Plotly figure for the research-flow map returned by POST /flow.

Layout: x = publication year, y = topic lane (one per cluster, ordered by when the topic
emerged). Position carries the topic, so color only marks a paper's role (3 validated slots).
"""

import math
from collections import defaultdict

import plotly.graph_objects as go

PALETTE = {
    # validated categorical slots 1-3 (blue, orange, aqua), stepped per mode
    "light": {"result": "#2a78d6", "bookmark": "#eb6834", "foundation": "#1baf7a",
              "surface": "#fcfcfb", "edge": "rgba(82,81,78,0.22)", "chain": "#52514e", "muted": "#52514e"},
    "dark": {"result": "#3987e5", "bookmark": "#d95926", "foundation": "#199e70",
             "surface": "#1a1a19", "edge": "rgba(195,194,183,0.22)", "chain": "#c3c2b7", "muted": "#c3c2b7"},
}
ROLES = [
    # (key, legend name, marker symbol) — shape is the secondary encoding for color
    ("result", "Search result", "circle"),
    ("bookmark", "Bookmarked", "star"),
    ("foundation", "Foundational (cited by your results)", "diamond"),
]
LANE_SPREAD = 0.32
ARC_POINTS = 16
STAR_SCALE = 1.35  # a star reads smaller than a circle of the same size


def role_of(node: dict) -> str:
    if node["bookmarked"]:
        return "bookmark"
    return node["role"]


def marker_size(node: dict) -> float:
    return min(28, 9 + 4 * math.log10(1 + (node["citations"] or 0)))


def wrap(text: str, width: int = 22) -> str:
    words, lines, line = text.split(), [], ""
    for word in words:
        if line and len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    lines.append(line)
    return "<br>".join(lines[:3])


def short(text: str, width: int = 34) -> str:
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def positions(nodes: list[dict]) -> dict[str, tuple[float, float]]:
    """Spread papers that share a lane and year vertically so they don't overlap."""
    groups = defaultdict(list)
    for node in nodes:
        groups[(node["lane"], node["year"])].append(node)
    pos = {}
    for (lane, year), members in groups.items():
        members.sort(key=lambda n: -(n["citations"] or 0))
        count = len(members)
        for i, node in enumerate(members):
            offset = 0 if count == 1 else -LANE_SPREAD + 2 * LANE_SPREAD * i / (count - 1)
            pos[node["id"]] = (year, lane + offset)
    return pos


def arc(x0: float, y0: float, x1: float, y1: float, x_span: float) -> tuple[list[float], list[float]]:
    """Quadratic curve bowing upward, so citations inside one lane don't hide each other."""
    bulge = 0.08 + 0.3 * abs(x1 - x0) / x_span
    cx, cy = (x0 + x1) / 2, min(y0, y1) - bulge
    xs, ys = [], []
    for i in range(ARC_POINTS + 1):
        t = i / ARC_POINTS
        xs.append((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t**2 * x1)
        ys.append((1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t**2 * y1)
    return xs, ys


def build_figure(flow: dict, mode: str = "light") -> go.Figure:
    colors = PALETTE["dark" if mode == "dark" else "light"]
    nodes = [n for n in flow["nodes"] if n["year"]]
    by_id = {n["id"]: n for n in nodes}
    pos = positions(nodes)
    clusters = sorted(flow["clusters"], key=lambda c: c["lane"])
    chain = flow.get("chain") or []
    chain_pairs = set(zip(chain[1:], chain[:-1]))  # (citing, cited)

    years = [n["year"] for n in nodes] or [2000]
    x_span = max(1, max(years) - min(years))
    fig = go.Figure()

    def edge_trace(pairs, color, width, name, showlegend):
        xs, ys = [], []
        for citing, cited in pairs:
            ax, ay = arc(*pos[cited], *pos[citing], x_span)
            xs += [*ax, None]
            ys += [*ay, None]
        fig.add_trace(go.Scatter(
            x=xs, y=ys, mode="lines", line={"color": color, "width": width},
            hoverinfo="skip", name=name, showlegend=showlegend,
        ))

    edges = [(e["source"], e["target"]) for e in flow["edges"] if e["source"] in pos and e["target"] in pos]
    edge_trace([e for e in edges if e not in chain_pairs], colors["edge"], 1, "Citation", True)
    if chain_pairs:
        edge_trace([e for e in edges if e in chain_pairs], colors["chain"], 2.5, "Key lineage", True)

    lane_label = {c["lane"]: c["label"] for c in clusters}
    for key, name, symbol in ROLES:
        members = [n for n in nodes if role_of(n) == key]
        if not members:
            continue
        fig.add_trace(go.Scatter(
            x=[pos[n["id"]][0] for n in members],
            y=[pos[n["id"]][1] for n in members],
            mode="markers",
            name=name,
            marker={
                "color": colors[key],
                "symbol": symbol,
                "size": [marker_size(n) * (STAR_SCALE if symbol == "star" else 1) for n in members],
                "line": {"color": colors["surface"], "width": 2},
            },
            customdata=[
                [
                    n["title"],
                    ", ".join(n["authors"]) or "—",
                    n["year"],
                    n["citations"],
                    n["cited_by_in_set"],
                    lane_label.get(n["lane"], ""),
                ]
                for n in members
            ],
            hovertemplate=(
                "<b>%{customdata[0]}</b><br>%{customdata[1]}<br>"
                "%{customdata[2]} · %{customdata[3]} citations<br>"
                "Cited by %{customdata[4]} papers in this map<br>"
                "Topic: %{customdata[5]}<extra></extra>"
            ),
        ))

    # Direct labels only for each topic's hub paper.
    for cluster in clusters:
        hub = by_id.get(cluster["hub"])
        if hub:
            x, y = pos[hub["id"]]
            # anchor labels near either edge inward so they stay inside the plot
            edge = (x - min(years)) / x_span
            anchor = "left" if edge < 0.2 else "right" if edge > 0.8 else "center"
            fig.add_annotation(
                x=x, y=y, text=short(hub["title"]), showarrow=False, yshift=-20, xanchor=anchor,
                font={"size": 11, "color": colors["muted"]},
            )

    pad = max(1.0, 0.07 * x_span)  # room for labels on papers at either end
    fig.update_layout(
        height=max(320, 140 * len(clusters) + 120),
        margin={"l": 10, "r": 10, "t": 40, "b": 40},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02, "x": 0},
        hoverlabel={"align": "left"},
        xaxis={"title": "Publication year", "range": [min(years) - pad, max(years) + pad],
               "showgrid": True, "gridwidth": 1, "zeroline": False, "dtick": 5 if max(years) - min(years) > 12 else 1},
        yaxis={"tickmode": "array", "tickvals": [c["lane"] for c in clusters],
               "ticktext": [wrap(c["label"]) for c in clusters], "range": [len(clusters) - 0.5, -0.5],
               "showgrid": False, "zeroline": False},
    )
    return fig


def lineage_rows(flow: dict) -> list[dict]:
    by_id = {n["id"]: n for n in flow["nodes"]}
    return [
        {"year": by_id[nid]["year"], "title": by_id[nid]["title"], "citations": by_id[nid]["citations"]}
        for nid in flow.get("chain") or []
        if nid in by_id
    ]
