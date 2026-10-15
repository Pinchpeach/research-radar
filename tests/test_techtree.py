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
    """Three topics that emerge one after another; later topics cite earlier ones."""
    topics = [
        ("radio pulsar timing array", 1970),
        ("optical photometry neutron star", 1980),
        ("gravitational wave interferometer", 1995),
    ]
    papers = []
    for t, (phrase, start) in enumerate(topics):
        for k in range(10):
            refs = [f"W{t}{k - 1:02d}"] if k else []
            if t and k % 2 == 0:
                refs.append(f"W{t - 1}{min(9, k + 2):02d}")
            # two papers per year in places, to exercise dot spreading
            papers.append(p(f"W{t}{k:02d}", f"{phrase.title()} {k}", phrase, start + 2 * (k // 2) + k % 2 * 0, 10 * k + 1, refs))
    return papers


@pytest.fixture(scope="module")
def flow_data():
    foundation = {**p("W90", "Neutron star atmospheres", "neutron star atmosphere", 1965, 900), "cited_by_in_set": 3}
    return flow.build_flow(big_corpus(), bookmarked={"W105"}, foundations=[foundation])


@pytest.fixture(scope="module")
def lay(flow_data):
    return techtree.layout(flow_data)


def test_every_paper_is_a_dot_on_its_rail(flow_data, lay):
    assert len(lay["nodes"]) == len(flow_data["nodes"])
    rails = {lane["lane"]: lane for lane in lay["lanes"]}
    for n in lay["nodes"]:
        lane = rails[n["lane"]]
        assert n["y"] == lane["rail_y"]
        assert lane["x_start"] < n["x"] < lane["x_end"]


def test_dots_on_a_rail_never_overlap_and_follow_time(lay):
    for lane in lay["lanes"]:
        dots = sorted((n for n in lay["nodes"] if n["lane"] == lane["lane"]), key=lambda n: n["x"])
        for a, b in zip(dots, dots[1:]):
            assert b["x"] - a["x"] >= a["r"] + b["r"]
            assert a["year"] <= b["year"]


def test_topics_branch_from_an_earlier_topic(lay):
    lanes = {lane["lane"]: lane for lane in lay["lanes"]}
    parents = [lane for lane in lay["lanes"] if lane["parent"] is not None]
    assert parents, "later topics cite earlier ones, so some must branch"
    for lane in parents:
        assert lanes[lane["parent"]]["x_start"] < lane["x_start"]
    assert any(lane["parent"] is None for lane in lay["lanes"])  # at least one starts at ORIGINS


def test_bundles_cover_every_cross_topic_citation(flow_data, lay):
    by_id = {n["id"]: n for n in lay["nodes"]}
    cross = [e for e in flow_data["edges"] if by_id[e["source"]]["lane"] != by_id[e["target"]]["lane"]]
    assert sum(b["count"] for b in lay["bundles"]) == len(cross)
    branches = [b for b in lay["bundles"] if b["branch"]]
    assert len(branches) == sum(1 for lane in lay["lanes"] if lane["parent"] is not None)
    for b in lay["bundles"]:
        assert 1 <= len(b["examples"]) <= 4
        assert b["width"] > 2


def test_individual_edges_connect_their_dots(lay):
    by_id = {n["id"]: n for n in lay["nodes"]}
    assert len(lay["edges"]) > 0
    for e in lay["edges"]:
        nums = [float(v) for v in re.findall(r"-?\d+\.\d", e["path"])]
        cited, citing = by_id[e["t"]], by_id[e["s"]]
        assert nums[:2] == pytest.approx([cited["x"], cited["y"]], abs=0.1)
        assert nums[-2:] == pytest.approx([citing["x"], citing["y"]], abs=0.1)


def test_glow_marks_hubs_and_key_foundations(flow_data, lay):
    glowing = {n["id"] for n in lay["nodes"] if n["glow"]}
    assert {c["hub"] for c in flow_data["clusters"]} <= glowing
    assert "W90" in glowing


def test_render_html_is_self_contained_and_interactive(flow_data):
    page = techtree.render_html(flow_data, "Neutron <Stars>")
    assert page.startswith("<!doctype html>")
    assert "THE MAP OF NEUTRON &lt;STARS&gt;" in page
    assert "<script src" not in page
    data = json.loads(re.search(r"const DATA = (\{.*?\});\n", page).group(1))
    assert len(data["nodes"]) == len(flow_data["nodes"])
    assert len(data["lanes"]) == len(flow_data["clusters"])
    assert page.count('class="dot"') == len(flow_data["nodes"])
    assert page.count('class="hit rail-hit"') == len(data["lanes"])
    assert page.count('class="hit bundle-hit"') == len(data["bundles"])


def test_render_html_escapes_script_breakout():
    nasty = [p("W1", "</script><img src=x onerror=alert(1)>", "text here", 2000)]
    page = techtree.render_html(flow.build_flow(nasty), "x")
    assert "</script><img" not in page


def test_small_and_empty_maps():
    assert techtree.layout(flow.build_flow([]))["nodes"] == []
    assert "No dated papers" in techtree.render_html(flow.build_flow([]), "x")
    lay = techtree.layout(flow.build_flow(CORPUS[:1]))
    assert len(lay["nodes"]) == 1 and lay["edges"] == [] and lay["bundles"] == []
    techtree.render_html(flow.build_flow(CORPUS), "x")  # renders without error


def test_pinned_card_markup_and_anchor_data(flow_data):
    page = techtree.render_html(flow_data, "x")
    assert 'id="pin"' in page and 'id="close"' in page
    data = json.loads(re.search(r"const DATA = (\{.*?\});\n", page).group(1))
    # cards anchor to the dot, so every paper carries its map position
    assert all(isinstance(n["x"], float) and isinstance(n["y"], (int, float)) for n in data["nodes"])
