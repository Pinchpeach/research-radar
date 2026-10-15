import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "frontend"))

import techtree  # noqa: E402
from backend.services import flow  # noqa: E402
from tests.test_bookmarks_flow import CORPUS, p  # noqa: E402


def big_corpus():
    """Three topics over five decades, with citations inside and across topics."""
    topics = [
        ("optical photometry neutron star", 1975),
        ("gravitational wave interferometer", 1990),
        ("radio pulsar timing array", 1970),
    ]
    papers = []
    for t, (phrase, start) in enumerate(topics):
        for k in range(10):
            wid = f"W{t}{k:02d}"
            refs = [f"W{t}{k - 1:02d}"] if k else []
            if k > 3 and t:
                refs.append(f"W{t - 1}{k - 3:02d}")
            papers.append(p(wid, f"{phrase.title()} {k}", phrase, start + 4 * k, 10 * k + 1, refs))
    return papers


@pytest.fixture(scope="module")
def flow_data():
    foundation = {**p("W90", "Neutron star atmospheres", "neutron star atmosphere", 1968, 900), "cited_by_in_set": 3}
    return flow.build_flow(big_corpus(), bookmarked={"W105"}, foundations=[foundation])


def rects(lay):
    return [(n["x"] - techtree.CARD_W / 2, n["top"], n["x"] + techtree.CARD_W / 2, n["top"] + techtree.CARD_H)
            for n in lay["nodes"]]


@pytest.mark.parametrize("bin_size", techtree.BIN_SIZES)
def test_cards_never_overlap(flow_data, bin_size):
    boxes = rects(techtree.layout(flow_data, bin_size))
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            assert a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1], (a, b)


def test_every_dated_paper_is_placed_in_its_lane(flow_data):
    lay = techtree.layout(flow_data)
    assert len(lay["nodes"]) == len(flow_data["nodes"])
    lanes = {lane["lane"]: lane for lane in lay["lanes"]}
    for n in lay["nodes"]:
        lane = lanes[n["lane"]]
        assert lane["rail_y"] < n["top"] and n["top"] + techtree.CARD_H <= lane["top"] + lane["height"]


def test_columns_follow_time(flow_data):
    lay = techtree.layout(flow_data)
    ordered = sorted(lay["nodes"], key=lambda n: n["year"])
    xs = [n["x"] for n in ordered]
    assert xs == sorted(xs)


def test_cross_connectors_run_from_cited_card_to_citing_card(flow_data):
    lay = techtree.layout(flow_data)
    nodes = {n["id"]: n for n in lay["nodes"]}
    cross = [e for e in lay["edges"] if e["kind"] == "cross"]
    assert cross
    for e in cross:
        coords = [tuple(map(float, xy.split(","))) for xy in re.findall(r"-?[\d.]+,-?[\d.]+", e["path"])]
        start, end = coords[0], coords[-1]
        cited, citing = nodes[e["t"]], nodes[e["s"]]
        assert start == pytest.approx((cited["x"] + techtree.CARD_W / 2, cited["cy"]), abs=0.1)
        assert end == pytest.approx((citing["x"] - techtree.CARD_W / 2, citing["cy"]), abs=0.1)


def test_auto_era_size_is_closest_to_poster_shape(flow_data):
    import math

    best = techtree.layout(flow_data)
    target = techtree.TARGET_ASPECT
    for size in techtree.BIN_SIZES:
        other = techtree.layout(flow_data, size)
        assert abs(math.log(best["width"] / best["height"] / target)) <= abs(
            math.log(other["width"] / other["height"] / target)
        ) + 1e-9


def test_glow_marks_hubs_and_key_foundations(flow_data):
    lay = techtree.layout(flow_data)
    glowing = {n["id"] for n in lay["nodes"] if n["glow"]}
    assert {c["hub"] for c in flow_data["clusters"]} <= glowing
    assert "W90" in glowing


def test_render_html_is_self_contained(flow_data):
    page = techtree.render_html(flow_data, "Neutron <Stars>")
    assert page.startswith("<!doctype html>")
    assert "THE MAP OF NEUTRON &lt;STARS&gt;" in page
    assert "<script src" not in page
    data = json.loads(re.search(r"const DATA = (\{.*?\});\n", page).group(1))
    assert len(data["nodes"]) == len(flow_data["nodes"])
    assert page.count('class="node"') == len(flow_data["nodes"])


def test_render_html_escapes_script_breakout():
    nasty = [p("W1", "</script><img src=x onerror=alert(1)>", "text here", 2000)]
    page = techtree.render_html(flow.build_flow(nasty), "x")
    assert "</script><img" not in page


def test_small_and_empty_maps():
    assert techtree.layout(flow.build_flow([]))["nodes"] == []
    assert "No dated papers" in techtree.render_html(flow.build_flow([]), "x")
    lay = techtree.layout(flow.build_flow(CORPUS[:1]))
    assert len(lay["nodes"]) == 1 and lay["edges"] == []


def test_rounded_path_corners():
    path = techtree.rounded_path([(0, 0), (100, 0), (100, 100)], radius=10)
    assert path.startswith("M0.0,0.0") and "Q100.0,0.0" in path and path.endswith("L100.0,100.0")
