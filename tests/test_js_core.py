"""The Android app runs a JavaScript port of the backend (frontend/web/core). These tests feed
both versions the same input, including a recorded real OpenAlex search, and check they agree.

Skipped when Node.js 22+ is not installed.
"""

import json
import os
import re
import shutil
import subprocess
from datetime import date
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.services import flow, openalex, ranking, techtree
from backend.services.dedupe import dedupe, title_key
from backend.evaluation import ndcg_at_k, precision_at_k
from backend.storage import BookmarkStore, to_bibtex
from backend.version import RELEASES_REPO, __version__

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "openalex_graph_neural_networks.json"
RUNNER = ROOT / "tests" / "js" / "parity_runner.mjs"
NODE = shutil.which("node")


def node_major() -> int:
    if not NODE:
        return 0
    out = subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout
    return int(re.match(r"v(\d+)", out).group(1))


# CI sets RADAR_REQUIRE_NODE so a missing Node.js fails the Android job instead of skipping
pytestmark = pytest.mark.skipif(node_major() < 22 and not os.getenv("RADAR_REQUIRE_NODE"), reason="needs Node.js 22+")

SEARCHES = [
    {"query": "graph neural networks", "limit": 20},
    # same OpenAlex requests as the recording (limit 20, recent share 0.3); different ranking
    {"query": "graph neural networks", "limit": 20, "recent_years": 3,
     "weights": {"relevance": 0.6, "influence": 0.2, "impact": 0.3, "recency": 0.2, "seed": 0}},
]


def run_js(payload: dict) -> dict:
    result = subprocess.run([NODE, str(RUNNER)], input=json.dumps(payload), capture_output=True, text=True,
                            encoding="utf-8", timeout=120)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ---------- replaying the recorded OpenAlex traffic in Python ----------


class Reply:
    def __init__(self, status: int, body: dict):
        self.status_code, self._body, self.headers = status, body, {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise openalex.requests.HTTPError(response=self)


@pytest.fixture(scope="module")
def recorded():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def python_api(recorded, monkeypatch, tmp_path):
    from tests.fixtures.record_openalex import request_key

    works = {}
    for r in recorded["responses"].values():
        for w in r["body"].get("results") or [r["body"]]:
            works[openalex.short_id(w["id"])] = w

    def get(url, params=None, headers=None, timeout=None):
        ids = re.search(r"ids\.openalex:([^,]+)", (params or {}).get("filter", ""))
        if ids:
            return Reply(200, {"results": [works[i] for i in ids.group(1).split("|") if i in works]})
        hit = recorded["responses"].get(request_key(url, params or {}))
        return Reply(hit["status"], hit["body"]) if hit else Reply(404, {"message": "not recorded"})

    today = date.fromisoformat(recorded["today"])
    fixed = type("FixedDate", (date,), {"today": classmethod(lambda cls: today)})
    monkeypatch.setattr(openalex._session, "get", get)
    monkeypatch.setattr(main, "date", fixed)
    monkeypatch.setattr(ranking, "date", fixed)
    store = BookmarkStore(tmp_path / "parity.db")
    main.app.dependency_overrides[main.get_store] = lambda: store
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def approx_tree(value):
    """`value` with every float wrapped in pytest.approx, for comparing nested JSON."""
    if isinstance(value, dict):
        return {k: approx_tree(v) for k, v in value.items()}
    if isinstance(value, list):
        return [approx_tree(v) for v in value]
    return pytest.approx(value, rel=1e-12) if isinstance(value, float) else value


def assert_same_ranking(py: list[dict], js: list[dict]):
    assert [p["id"] for p in py] == [p["id"] for p in js]
    for a, b in zip(py, js):
        assert abs(a["score"] - b["score"]) <= 0.11, (a["title"], a["score"], b["score"])
        assert abs(a["relevance_score"] - b["relevance_score"]) <= 0.11
        for name, value in a["scores"].items():
            assert abs(value - b["scores"][name]) <= 0.0011, (a["title"], name, value, b["scores"][name])
        for name in ("group", "seed_link", "core_reference", "cited_by_results", "builds_on_key_papers", "title", "year"):
            assert a[name] == b[name], (a["title"], name)


def test_whole_search_and_flow_match_on_real_data(python_api, recorded):
    py_searches = [python_api.post("/search", json=body).json() for body in SEARCHES]
    flow_request = {"papers": [{k: p[k] for k in openalex_fields()} for p in py_searches[0]["papers"]],
                    "query": "graph neural networks", "include_foundations": True}
    py_flow = python_api.post("/flow", json=flow_request).json()

    js = run_js({"fixture": str(FIXTURE), "today": recorded["today"], "searches": SEARCHES, "flow_request": flow_request})

    for py, js_search in zip(py_searches, js["searches"]):
        assert py["candidates"] == js_search["candidates"] > 60
        assert py["count"] == js_search["count"]
        assert_same_ranking(py["papers"], js_search["papers"])
    assert any(p["group"] == "recent" for p in py_searches[1]["papers"])
    assert any(p["core_reference"] for p in py_searches[0]["papers"])

    # topics come from k-means, seeded differently in the two versions; everything else matches
    jf = js["flow"]
    assert {n["id"] for n in py_flow["nodes"]} == {n["id"] for n in jf["nodes"]}
    assert {(e["source"], e["target"]) for e in py_flow["edges"]} == {(e["source"], e["target"]) for e in jf["edges"]}
    assert py_flow["chain"] == jf["chain"]
    assert len(py_flow["clusters"]) == len(jf["clusters"])
    by_id = {n["id"]: n for n in jf["nodes"]}
    for node in py_flow["nodes"]:
        other = by_id[node["id"]]
        for name in ("title", "year", "citations", "role", "bookmarked", "cited_in_set", "cited_by_in_set", "url", "authors"):
            assert node[name] == other[name], (node["id"], name)


def openalex_fields():
    return ["id", "title", "abstract", "year", "doi", "url", "venue", "authors", "citations", "referenced_works",
            "keywords", "topic"]


@pytest.fixture(scope="module")
def real_flow(recorded):
    """A research flow built by the Python backend from the recorded search."""
    results = recorded["responses"]
    works = next(r["body"]["results"] for k, r in results.items() if "per-page=60" in k)
    papers = [openalex.normalize_work(w) for w in works][:40]
    return papers, flow.build_flow(papers, bookmarked={openalex.short_id(papers[0]["id"])}, query="graph neural networks")


def test_ranking_matches_with_seeds_and_semantic_scores(real_flow):
    papers, _ = real_flow
    rng = np.random.default_rng(3)
    cases = [
        {"query": "graph neural networks", "papers": papers, "seeds": [], "weights": {}, "current_year": 2026, "semantic": None},
        {"query": "message passing on molecules", "papers": papers, "seeds": papers[:2], "weights": {"seed": 0.5},
         "current_year": 2024, "semantic": rng.random(len(papers)).round(4).tolist()},
    ]
    js = run_js({"rank": cases})["rank"]
    for case, js_ranked in zip(cases, js):
        semantic = np.array(case["semantic"]) if case["semantic"] else None
        py = ranking.rank_papers(case["query"], case["papers"], case["seeds"], case["weights"], case["current_year"], semantic)
        for p in py:
            p.setdefault("group", None)
            p.setdefault("core_reference", None)
        for p in js_ranked:
            p.setdefault("group", None)
            p.setdefault("core_reference", None)
        assert_same_ranking(py, js_ranked)


def test_topic_names_labels_and_chain_match(real_flow):
    papers, built = real_flow
    unique = list({openalex.short_id(p["id"]): p for p in dedupe(papers)[0]}.values())
    assignment, fallback = flow.cluster_papers(unique, "graph neural networks")
    terms = np.array(["graph learning", "graph", "learning", "neural", "networks", "neural networks", "x-ray"])
    scores = [np.array([0.3, 0.5, 0.2, 0.4, 0.1, 0.45, 0.0]), np.array([0.1, 0.1, 0.1, 0, 0, 0, 0.2])]
    nodes = {n["id"]: n for n in built["nodes"]}
    edges = [(e["source"], e["target"]) for e in built["edges"]]
    js = run_js({
        "names": {"papers": unique, "assignment": assignment, "fallback": fallback, "query": "graph neural networks"},
        "labels": [{"scores": s.tolist(), "terms": terms.tolist()} for s in scores],
        "chain": {"nodes": nodes, "edges": edges},
    })
    assert js["names"] == flow.name_clusters(unique, assignment, fallback, "graph neural networks")
    assert js["labels"] == [flow.label_terms(s, terms) for s in scores]
    assert js["chain"] == flow.longest_chain(nodes, edges)


def test_poster_layout_and_page_match(real_flow):
    _, built = real_flow
    js = run_js({"layout": built, "poster": {"flow": built, "title": "Graph Neural Networks", "lang": "ko"}})
    py = techtree.layout(built)
    lay = js["layout"]
    assert (lay["width"], lay["height"]) == (py["width"], py["height"])
    assert lay["ticks"] == [list(t) for t in py["ticks"]]
    assert lay["root"] == list(py["root"]) and lay["bus"] == list(py["bus"]) and lay["axis"] == py["axis"]
    py_nodes = {n["id"]: n for n in py["nodes"]}
    for n in lay["nodes"]:
        m = py_nodes[n["id"]]
        assert (n["x"], n["y"], n["r"], n["color"], n["glow"], n["lane_label"]) == pytest.approx(
            (m["x"], m["y"], m["r"], m["color"], m["glow"], m["lane_label"]))
    keys = ("lane", "label", "color", "rail_y", "x_start", "x_end", "size", "parent", "origin", "hub", "frontier")
    assert [[lane[k] for k in keys] for lane in lay["lanes"]] == [[list(v) if isinstance(v, tuple) else v for v in (lane[k] for k in keys)] for lane in py["lanes"]]
    bkeys = ("from_lane", "to_lane", "count", "branch", "color", "path", "examples")
    assert [[b[k] for k in bkeys] for b in lay["bundles"]] == [[b[k] for k in bkeys] for b in py["bundles"]]
    assert [e["path"] for e in lay["edges"]] == [e["path"] for e in py["edges"]]

    # the page: identical apart from the decorative starfield (different random generators)
    stars = re.compile(r'<g fill="#fff" pointer-events="none">.*?</g>')
    data = re.compile(r"const (?:DATA|T) = (\{.*?\});\n")
    py_page = techtree.render_html(built, "Graph Neural Networks", "ko")
    js_page = js["poster"]
    # floats may differ in the last digit (each platform's log10), so compare them approximately
    assert approx_tree([json.loads(m) for m in data.findall(py_page)]) == [json.loads(m) for m in data.findall(js_page)]
    assert stars.sub("", data.sub("", py_page)) == stars.sub("", data.sub("", js_page))


def test_small_helpers_match():
    titles = ["Graph Neural Networks: A Review", "Über Naïve Résumés — 2nd ed.", "  X-ray  ", ""]
    phrases = ["graph neural networks research", "CRISPR and gene editing", "x-ray of the GNN", "k-NN methods",
               "Pulsars and Gravitational Waves Research", "deep learning analysis"]
    queries = ["Graph neural networks", "isolated neutron-stars", ""]
    identifiers = ["W123", "https://openalex.org/w42", "10.1000/abc.def", "doi:10.1/x", "https://doi.org/10.555/Q", "nope"]
    years = [[None, None], [2001, None], [None, 2010], [1999, 2005]]
    works = [{"id": "https://openalex.org/W1", "title": None, "display_name": "Shown", "abstract_inverted_index": {"b": [1], "a": [0, 2]},
              "publication_year": 2001, "authorships": [{"author": {"display_name": "Ada"}}, {"author": {}}],
              "primary_location": None, "doi": "https://doi.org/10.1/x", "cited_by_count": None,
              "referenced_works": ["https://openalex.org/W9"], "keywords": [{"display_name": "k1"}, {}],
              "primary_topic": {"display_name": "T"}}]
    bookmarks = [{"id": "W2", "note": "read", "tags": ["optics", "key"], "paper": {
        "id": "https://openalex.org/W2", "title": "Deep imaging", "year": 2005, "authors": ["Ada Lovelace", "Alan Turing"],
        "venue": "ApJ", "doi": "https://doi.org/10.1/W2", "url": "https://ex.org/W2"}},
        {"id": "W3", "note": "", "tags": [], "paper": {"id": "W3", "title": "No authors", "authors": []}}]
    judgments = [["relevant", None, "partial", "not_relevant"] * 6, [None] * 5, ["not_relevant"] * 3]
    dupes = [
        {"id": "https://openalex.org/W1", "title": "Graph attention networks", "year": 2017, "citations": 10, "referenced_works": ["W9"], "abstract": ""},
        {"id": "https://openalex.org/W2", "title": "Graph Attention Networks.", "year": 2018, "citations": 900, "referenced_works": ["W8", "W1"], "abstract": "x"},
        {"id": "https://openalex.org/W3", "title": "Graph attention networks", "year": 2025, "citations": 1, "referenced_works": []},
        {"id": "https://openalex.org/W4", "title": "Erratum", "year": 2018, "referenced_works": ["W1"]},
    ]
    outside = {"papers": [{"id": "W1", "referenced_works": ["W7", "W8", "W9"]}, {"id": "W2", "referenced_works": ["W9", "W8", "W7", "W7"]},
                          {"id": "W3", "referenced_works": ["W5", "W6"]}, {"id": "W4", "referenced_works": ["W6", "W5"]}],
               "min_count": 2, "limit": 3}
    js = run_js({"strings": {"titles": titles, "phrases": phrases, "queries": queries, "identifiers": identifiers,
                             "years": years, "works": works, "bookmarks": bookmarks, "judgments": judgments},
                 "dedupe": dupes, "outside": outside})
    s = js["strings"]
    assert s["title_key"] == [title_key(t) for t in titles]
    assert s["title_case"] == [flow.title_case(p) for p in phrases]
    assert s["tidy"] == [flow.tidy_phrase(p) for p in phrases]
    assert s["query_words"] == [sorted(flow.query_words(q)) for q in queries]
    assert s["work_path"] == [openalex.work_path(i) for i in identifiers]
    assert s["year_filter"] == [openalex.year_filter(a, b) for a, b in years]
    assert s["normalize"] == [openalex.normalize_work(w) for w in works]
    assert s["bibtex"] == to_bibtex(bookmarks)
    assert s["metrics"] == [pytest.approx([precision_at_k(j, 10), precision_at_k(j, 20), ndcg_at_k(j, 20)]) for j in judgments]
    assert js["dedupe"] == [list(x) if isinstance(x, list) else x for x in dedupe(dupes)]
    assert [tuple(x) for x in js["outside"]] == flow.outside_references(outside["papers"], 2, 3)


def test_shared_words_and_version_stay_in_step():
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    words = json.loads((ROOT / "frontend" / "web" / "shared" / "words.json").read_text(encoding="utf-8"))
    assert set(words["english_stop_words"]) == set(ENGLISH_STOP_WORDS)
    js = run_js({})
    assert js["version"] == __version__, "update frontend/web/core/version.js"
    core = (ROOT / "frontend" / "web" / "core" / "version.js").read_text(encoding="utf-8")
    assert f'"{RELEASES_REPO}"' in core
