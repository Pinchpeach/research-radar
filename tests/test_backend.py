import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.evaluation import ndcg_at_k, precision_at_k
from backend.services import openalex
from backend.services.context import citation_context
from backend.services.ranking import rank_papers, recency_score


def work(wid, title, abstract="", year=2020, cites=0, refs=()):
    words = abstract.split()
    return {
        "id": f"https://openalex.org/{wid}",
        "title": title,
        "abstract_inverted_index": {w: [i] for i, w in enumerate(words)} if words else None,
        "publication_year": year,
        "doi": f"https://doi.org/10.1/{wid}",
        "cited_by_count": cites,
        "authorships": [{"author": {"display_name": "A. Author"}}],
        "primary_location": {"landing_page_url": f"https://ex.org/{wid}", "source": {"display_name": "ApJ"}},
        "referenced_works": [f"https://openalex.org/{r}" for r in refs],
    }


def paper(wid, title, abstract="", year=2020, cites=0, refs=()):
    return openalex.normalize_work(work(wid, title, abstract, year, cites, refs))


# ---------- openalex ----------


def test_reconstruct_abstract_orders_words():
    assert openalex.reconstruct_abstract({"world": [1], "hello": [0, 2]}) == "hello world hello"


def test_normalize_work_extracts_fields():
    p = paper("W1", "Title", "some abstract", refs=["W9"])
    assert p["venue"] == "ApJ"
    assert p["url"] == "https://ex.org/W1"
    assert p["referenced_works"] == ["W9"]
    assert p["abstract"] == "some abstract"


@pytest.mark.parametrize(
    "identifier, expected",
    [
        ("W123", "W123"),
        ("https://openalex.org/W123", "W123"),
        ("10.1086/123456", "doi:10.1086/123456"),
        ("https://doi.org/10.1086/123456", "doi:10.1086/123456"),
        ("doi:10.1086/abc", "doi:10.1086/abc"),
        ("not an id", None),
    ],
)
def test_work_path(identifier, expected):
    assert openalex.work_path(identifier) == expected


def test_year_filter():
    assert openalex.year_filter(2010, 2020) == ["from_publication_date:2010-01-01", "to_publication_date:2020-12-31"]
    assert openalex.year_filter(None, None) == []


# ---------- ranking ----------

QUERY = "optical observations of isolated neutron stars"


def candidates():
    return [
        paper("W1", "Optical observations of isolated neutron stars", "VLT photometry of isolated neutron stars", 2015, 50),
        paper("W2", "Deep learning for images", "convolutional networks", 2023, 5000),
        paper("W3", "X-ray thermal emission of neutron stars", "isolated neutron stars blackbody", 2005, 300),
    ]


def test_relevance_dominates_by_default():
    ranked = rank_papers(QUERY, candidates(), current_year=2026)
    assert [p["id"].rsplit("/", 1)[-1] for p in ranked][0] == "W1"
    assert ranked[-1]["id"].endswith("W2")
    assert "referenced_works" in ranked[0]
    for p in ranked:
        assert 0 <= p["score"] <= 100
        assert all(0 <= v <= 1 for v in p["scores"].values())


def test_weights_change_order():
    ranked = rank_papers(QUERY, candidates(), weights={"relevance": 0, "recency": 0, "impact": 1}, current_year=2026)
    assert ranked[0]["id"].endswith("W2")


def test_seed_link_boosts_citing_paper():
    papers = candidates() + [paper("W4", "Unrelated title", "nothing shared", 2010, 1, refs=["W99"])]
    seed = paper("W99", "Seed paper", "seed text")
    ranked = rank_papers(QUERY, papers, seeds=[seed], weights={"relevance": 0, "seed": 1, "recency": 0, "impact": 0})
    assert ranked[0]["id"].endswith("W4")
    assert ranked[0]["seed_link"] is True
    assert ranked[0]["scores"]["seed"] == 1.0


def test_seed_weight_ignored_without_seeds():
    a = rank_papers(QUERY, candidates(), current_year=2026)
    b = rank_papers(QUERY, candidates(), weights={"seed": 100}, current_year=2026)
    assert [p["score"] for p in a] == [p["score"] for p in b]


def test_relevance_is_text_only_without_references():
    ranked = rank_papers(QUERY, candidates(), current_year=2026)
    top = max(p["relevance_score"] for p in ranked)
    assert [p["scores"]["relevance"] for p in ranked] == pytest.approx([p["relevance_score"] / top for p in ranked], abs=0.01)


def test_citation_context_lifts_papers_that_share_references():
    refs = [f"R{i}" for i in range(6)]
    papers = [
        paper("W1", "Optical observations of isolated neutron stars", "isolated neutron stars photometry", 2010, refs=refs),
        paper("W2", "Isolated neutron stars in the optical", "deep imaging of isolated neutron stars", 2012, refs=refs[1:]),
        paper("W3", "Faint counterparts of thermally emitting X-ray sources", "VLT imaging of RX J1856", 2014, refs=refs[:5]),
        paper("W4", "Isolated neutron stars", "", 2019),  # stub: title only
        paper("W5", "Neutron star equation of state", "dense matter in neutron stars", 2020, refs=["Q1", "Q2", "Q3", "Q4", "Q5"]),
    ]
    context = citation_context(papers, np.array([1.0, 0.9, 0.0, 0.95, 0.3]))
    assert context[2] > context[4] and context[2] > context[3] == 0
    ranked = {p["id"][-2:]: p for p in rank_papers(QUERY, papers, current_year=2026)}
    assert ranked["W3"]["scores"]["relevance"] > ranked["W4"]["scores"]["relevance"]
    assert ranked["W3"]["relevance_score"] < ranked["W4"]["relevance_score"]  # by text alone the stub wins


def test_citation_context_is_zero_without_references():
    assert citation_context(candidates(), np.array([1.0, 0.2, 0.5])).tolist() == [0, 0, 0]


def test_recency_half_life():
    assert recency_score(2026, 2026) == 1
    assert recency_score(2021, 2026) == pytest.approx(0.5)
    assert recency_score(None, 2026) == 0


def test_empty():
    assert rank_papers(QUERY, []) == []


# ---------- evaluation ----------


def test_metrics():
    judgments = ["relevant", "not_relevant", "partial", None]
    assert precision_at_k(judgments, 4) == pytest.approx(2 / 3)
    assert precision_at_k([None, None], 2) is None
    assert ndcg_at_k(["relevant", "partial"], 2) == 1.0
    assert ndcg_at_k(["not_relevant", "relevant"], 2) < 1.0


# ---------- API ----------


class FakeOpenAlex:
    def __init__(self):
        self.calls = []

    def __call__(self, url, params):
        self.calls.append((url, params))
        if url.endswith("/W99"):
            return work("W99", "Seed about neutron stars", "isolated neutron stars optical", 2010, refs=["W7"])
        if url.endswith("/doi:10.1/missing"):
            raise _http_error(404)
        flt = params.get("filter", "")
        if "cites:W99" in flt:
            return {"results": [work("W6", "Follow-up optical study", "neutron stars", 2022, refs=["W99"])]}
        if "ids.openalex:W7" in flt:
            return {"results": [work("W7", "Earlier catalog", "neutron star catalog", 2001)]}
        return {
            "results": [
                work("W1", "Optical observations of isolated neutron stars", "VLT photometry", 2015, 50),
                work("W2", "Deep learning", "", 2023, 10),
                work("W99", "Seed about neutron stars", "dup of seed", 2010),
            ]
        }


def _http_error(status):
    import requests

    response = requests.Response()
    response.status_code = status
    return requests.HTTPError(response=response)


@pytest.fixture
def fake(monkeypatch):
    fake = FakeOpenAlex()
    monkeypatch.setattr(openalex, "_get", fake)
    return fake


api = TestClient(main.app, base_url="http://127.0.0.1")


def test_search_basic(fake):
    res = api.post("/search", json={"query": QUERY, "limit": 2, "year_from": 2000, "year_to": 2024})
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 2 and body["candidates"] == 3
    assert body["papers"][0]["id"].endswith("W1")
    params = fake.calls[0][1]
    assert params["per-page"] == 50
    assert "from_publication_date:2000-01-01" in params["filter"]


def test_searches_are_remembered_newest_first(fake):
    for query in ["neutron stars", "graph neural networks", "Neutron  Stars"]:
        assert api.post("/search", json={"query": query, "limit": 2}).status_code == 200
    assert [e["query"] for e in api.get("/history").json()] == ["Neutron Stars", "graph neural networks"]
    assert len(api.get("/history?limit=1").json()) == 1
    assert api.delete("/history").status_code == 204
    assert api.get("/history").json() == []


def test_history_keeps_the_latest_entries(tmp_path):
    from backend import history

    path = tmp_path / "history.json"
    for i in range(history.MAX_ENTRIES + 5):
        history.record(f"topic {i}", path)
    entries = history.load(path)
    assert len(entries) == history.MAX_ENTRIES and entries[0]["query"] == f"topic {history.MAX_ENTRIES + 4}"
    path.write_text("not json", encoding="utf-8")
    assert history.load(path) == []


def test_changelog_starts_with_this_version():
    from backend.version import __version__

    releases = api.get("/changelog").json()
    assert releases[0]["version"] == __version__
    assert all(r["ko"] and len(r["ko"]) == len(r["en"]) for r in releases)


def test_search_with_seeds_expands_and_excludes_seed(fake):
    res = api.post(
        "/search",
        json={"query": QUERY, "seed_ids": ["W99", "10.1/missing", "garbage"], "require_abstract": True},
    )
    body = res.json()
    ids = {p["id"].rsplit("/", 1)[-1] for p in body["papers"]}
    assert ids == {"W1", "W6", "W7"}  # W2 has no abstract, W99 is the seed itself
    assert body["seeds"][0]["title"].startswith("Seed")
    assert body["unresolved_seeds"] == ["10.1/missing", "garbage"]
    assert all(p["seed_link"] for p in body["papers"] if not p["id"].endswith("W1"))


def test_search_openalex_failure_is_502(monkeypatch):
    import requests

    def boom(*_):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "_get", boom)
    assert api.post("/search", json={"query": QUERY}).status_code == 502


def test_search_rejects_inverted_years():
    assert api.post("/search", json={"query": QUERY, "year_from": 2020, "year_to": 2010}).status_code == 422


def test_judgments_roundtrip(tmp_path):
    from backend.judgments import load_rows, save_run, summarize

    path = tmp_path / "j.jsonl"
    run = {
        "run_id": "r1",
        "query": "q",
        "settings": {"limit": 3},
        "papers": [{"id": f"W{i}", "title": "t", "score": 1.0} for i in range(3)],
    }
    assert save_run(run, {"W0": "relevant", "W2": "not_relevant"}, path) == 2
    save_run(run, {"W2": "partial"}, path)  # re-judged later
    [summary] = summarize(load_rows(path))
    assert summary["judged"] == 2
    assert summary["p@10"] == 1.0


def test_api_key_is_sent_as_bearer(monkeypatch):
    seen = {}

    class Resp:
        status_code = 200
        headers = {}

        def raise_for_status(self):
            pass

        def json(self):
            return {"results": []}

    def fake_get(url, params, headers, timeout):
        seen["headers"] = headers
        return Resp()

    monkeypatch.setattr(openalex._session, "get", fake_get)
    monkeypatch.setenv("OPENALEX_API_KEY", "k123")
    openalex.search_papers("q", 1)
    assert seen["headers"] == {"Authorization": "Bearer k123"}
    monkeypatch.delenv("OPENALEX_API_KEY")
    openalex.search_papers("q", 1)
    assert seen["headers"] == {}


def test_rate_limit_becomes_429_with_guidance(monkeypatch):
    import requests

    response = requests.Response()
    response.status_code = 429
    response.headers["retry-after"] = "7200"
    response._content = b'{"message": "Insufficient budget."}'
    monkeypatch.setattr(openalex._session, "get", lambda *a, **k: response)
    monkeypatch.delenv("OPENALEX_API_KEY", raising=False)

    with pytest.raises(openalex.RateLimited) as err:
        openalex.search_papers("q", 1)
    assert err.value.retry_after == 7200 and "Insufficient budget" in str(err.value)

    res = api.post("/search", json={"query": QUERY})
    assert res.status_code == 429
    assert "OPENALEX_API_KEY" in res.json()["detail"] and "3 h" in res.json()["detail"]


# ---------- flow importance (influence) ----------


def test_influence_rewards_papers_the_relevant_literature_builds_on():
    from backend.services.ranking import citation_influence

    core = paper("W1", "Graph convolutional networks", "graph convolution", 2016, 5000)
    followers = [paper(f"W{i}", f"Graph network variant {i}", "graph network", 2020, 10, refs=["W1"]) for i in range(2, 6)]
    loner = paper("W9", "Graph networks again", "graph network", 2021, 10)
    papers = [core, *followers, loner]
    received = citation_influence(papers, np.ones(len(papers)))
    assert received.argmax() == 0  # everyone builds on W1
    assert received[-1] == pytest.approx(0, abs=1e-9)  # nobody cites the loner


def test_key_paper_outranks_relevant_but_uncited_paper():
    core = paper("W1", "Semi-supervised classification with graph convolutional networks", "graph convolution layer", 2016, 7000)
    followers = [paper(f"W{i}", f"Graph neural networks for task {i}", "graph neural networks", 2022, 20, refs=["W1"]) for i in range(2, 7)]
    ranked = rank_papers("graph neural networks", [core, *followers], current_year=2026)
    assert ranked[0]["id"].endswith("W1")
    assert ranked[0]["scores"]["influence"] == 1.0 and ranked[0]["cited_by_results"] == 5
    # with the flow-importance weight off, plain relevance puts the title matches first
    plain = rank_papers("graph neural networks", [core, *followers], weights={"influence": 0}, current_year=2026)
    assert not plain[0]["id"].endswith("W1")


def test_influence_is_damped_for_off_topic_hubs():
    on_topic = paper("W1", "Graph attention networks", "graph attention networks neural", 2017, 8000)
    generic = paper("W2", "Adam: a method for stochastic optimization", "stochastic optimization gradient", 2014, 90000)
    followers = [paper(f"W{i}", f"Graph neural network model {i}", "graph neural network attention", 2021, 5, refs=["W1", "W2"])
                 for i in range(3, 8)]
    ranked = {p["id"].rsplit("/", 1)[-1]: p for p in rank_papers("graph neural networks", [on_topic, generic, *followers])}
    assert ranked["W1"]["scores"]["influence"] > ranked["W2"]["scores"]["influence"]
    assert ranked["W1"]["score"] > ranked["W2"]["score"]


def test_influence_ignores_impossible_citations():
    from backend.services.ranking import citation_counts_within

    old = paper("W1", "Old", "x", 2000, 1, refs=["W2"])
    future = paper("W2", "From the future", "x", 2025, 1)
    assert citation_counts_within([old, future]).tolist() == [0, 0]


def test_search_adds_core_references(monkeypatch):

    def fake_get(url, params):
        flt = params.get("filter", "")
        if "ids.openalex" in flt:
            return {"results": [work("W500", "Semi-supervised classification with graph convolutional networks",
                                     "graph convolution", 2016, 7000)]}
        return {"results": [work(f"W{i}", f"Graph neural networks study {i}", "graph neural networks", 2022, 10, refs=["W500"])
                            for i in range(1, 6)]}

    monkeypatch.setattr(openalex, "_get", fake_get)
    body = api.post("/search", json={"query": "graph neural networks", "limit": 10}).json()
    core = [p for p in body["papers"] if p["id"].endswith("W500")]
    assert core and core[0]["core_reference"] is True and core[0]["cited_by_results"] == 5
    assert body["papers"][0]["id"].endswith("W500")  # the paper every result builds on comes first


# ---------- recent work (frontier) ----------


def test_recent_group_is_added_on_top_and_skips_shown_and_stub_papers():
    from backend.services.ranking import select_results

    def item(wid, year, score, frontier=0.0, abstract="text"):
        return {"id": wid, "year": year, "score": score, "abstract": abstract, "referenced_works": [],
                "scores": {"frontier": frontier}}

    ranked = [item("A", 2010, 90), item("B", 2024, 80, 0.9), item("C", 2012, 70),
              item("D", 2025, 10, 0.8), item("E", 2026, 9, 0.95, abstract=""), item("F", 2023, 8, 0.5)]
    out = select_results(ranked, limit=3, recent_share=0.67, since=2022)
    assert [p["id"] for p in out] == ["A", "B", "C", "D", "F"]  # E is a stub; B is already shown
    assert [p["group"] for p in out] == ["core"] * 3 + ["recent"] * 2
    assert [p["id"] for p in select_results(ranked, 3, 0, 2022)] == ["A", "B", "C"]


def test_frontier_prefers_fresh_relevant_work_building_on_key_papers():
    from backend.services.ranking import frontier_scores

    key = paper("W1", "Graph convolutional networks", "graph", 2016, 9000)
    builder = paper("W2", "New graph model", "graph", 2025, 3, refs=["W1"])
    loner = paper("W3", "New graph model", "graph", 2025, 3)
    older_recent = paper("W4", "New graph model", "graph", 2022, 3, refs=["W1"])
    papers = [key, builder, loner, older_recent]
    frontier, key_cited = frontier_scores(papers, np.ones(4), np.array([1.0, 0, 0, 0]), 2026, since=2022)
    assert frontier[0] == 0  # not recent
    assert frontier[1] > frontier[2]  # builds on a key paper
    assert frontier[1] > frontier[3]  # fresher
    assert key_cited.tolist() == [0, 1, 0, 1]


def test_search_fetches_recent_candidates_and_returns_groups(monkeypatch):
    calls = []

    def fake_get(url, params):
        calls.append(params)
        flt = params.get("filter", "")
        if "from_publication_date" in flt:  # the recent-only search
            return {"results": [work(f"W9{i}", f"New graph neural networks method {i}", "graph neural networks", 2026, 1)
                                for i in range(3)]}
        return {"results": [work(f"W{i}", f"Graph neural networks {i}", "graph neural networks", 2010 + i, 100) for i in range(5)]}

    monkeypatch.setattr(openalex, "_get", fake_get)
    body = api.post("/search", json={"query": "graph neural networks", "limit": 4, "recent_share": 0.5}).json()
    assert any("from_publication_date" in c.get("filter", "") for c in calls)
    groups = [p["group"] for p in body["papers"]]
    assert groups.count("core") == 4 and groups.count("recent") == 2
    assert all(p["year"] == 2026 for p in body["papers"] if p["group"] == "recent")

    calls.clear()
    api.post("/search", json={"query": "graph neural networks", "limit": 4, "recent_share": 0})
    assert not any("from_publication_date" in c.get("filter", "") for c in calls)
