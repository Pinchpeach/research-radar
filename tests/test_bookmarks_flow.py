import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.services import flow, openalex
from backend.storage import BookmarkStore, to_bibtex


def p(wid, title, abstract="", year=2020, cites=0, refs=()):
    return {
        "id": f"https://openalex.org/{wid}",
        "title": title,
        "abstract": abstract,
        "year": year,
        "doi": f"https://doi.org/10.1/{wid}",
        "url": f"https://ex.org/{wid}",
        "venue": "ApJ",
        "authors": ["Ada Lovelace", "Alan Turing"],
        "citations": cites,
        "referenced_works": list(refs),
    }


# Two topics: neutron-star optics (W1-W4) and gravitational-wave detection (W5-W8).
CORPUS = [
    p("W1", "Optical counterpart of isolated neutron star", "optical photometry isolated neutron star faint counterpart", 1998, 300),
    p("W2", "Deep optical imaging of neutron stars", "optical imaging isolated neutron star spectrum", 2005, 120, ["W1", "W90"]),
    p("W3", "Optical excess in neutron star spectra", "optical excess isolated neutron star spectrum blackbody", 2012, 80, ["W2", "W1", "W90"]),
    p("W4", "New optical neutron star survey", "optical survey isolated neutron star photometry", 2022, 5, ["W3", "W91"]),
    p("W5", "Gravitational wave detector design", "gravitational wave interferometer detector noise", 2000, 500),
    p("W6", "Gravitational wave burst search", "gravitational wave burst search interferometer", 2010, 200, ["W5", "W91"]),
    p("W7", "Gravitational waves from binary mergers", "gravitational wave binary merger detection interferometer", 2017, 900, ["W6", "W5", "W90"]),
    p("W8", "Neutron star merger optical follow-up", "gravitational wave neutron star merger optical counterpart", 2018, 400, ["W7", "W3"]),
]


# ---------- storage ----------


@pytest.fixture
def store(tmp_path):
    return BookmarkStore(tmp_path / "radar.db")


def test_store_save_update_delete(store):
    saved = store.save(CORPUS[0], note="classic", tags=["Optics", "optics", " key "], query="q")
    assert saved["id"] == "W1"
    assert saved["tags"] == ["optics", "key"]
    assert store.ids() == {"W1"}

    resaved = store.save({**CORPUS[0], "citations": 301})  # refresh paper, keep note/tags
    assert resaved["note"] == "classic" and resaved["tags"] == ["optics", "key"]
    assert resaved["paper"]["citations"] == 301
    assert resaved["created_at"] == saved["created_at"]

    updated = store.update("https://openalex.org/W1", note="", tags=["x"])
    assert updated["note"] == "" and updated["tags"] == ["x"]
    assert store.all("x")[0]["id"] == "W1"
    assert store.all("optics") == []

    assert store.delete("W1") is True
    assert store.delete("W1") is False
    assert store.update("W1", note="n") is None


def test_bibtex(store):
    store.save(CORPUS[1], note="read", tags=["optics"])
    bib = to_bibtex(store.all())
    assert bib.startswith("@article{lovelace2005W2,")
    assert "doi = {10.1/W2}" in bib and "keywords = {optics}" in bib


# ---------- flow ----------


def test_outside_references_needs_two_citers():
    assert flow.outside_references(CORPUS) == [("W90", 3), ("W91", 2)]


def test_build_flow_clusters_edges_and_chain():
    result = flow.build_flow(CORPUS, bookmarked={"W3"})
    nodes = {n["id"]: n for n in result["nodes"]}
    assert len(nodes) == 8
    assert nodes["W3"]["bookmarked"] is True

    # the two topics land in different lanes
    assert nodes["W1"]["lane"] == nodes["W2"]["lane"] == nodes["W3"]["lane"]
    assert nodes["W5"]["lane"] == nodes["W6"]["lane"] == nodes["W7"]["lane"]
    assert nodes["W1"]["lane"] != nodes["W5"]["lane"]
    labels = " ".join(c["label"] for c in result["clusters"])
    assert "optical" in labels and "gravitational" in labels

    # only edges inside the set; W90/W91 are not nodes
    edges = {(e["source"], e["target"]) for e in result["edges"]}
    assert ("W2", "W1") in edges and ("W8", "W3") in edges
    assert all(s in nodes and t in nodes for s, t in edges)

    optics = next(c for c in result["clusters"] if c["lane"] == nodes["W1"]["lane"])
    assert optics["origin"] == "W1"
    assert optics["hub"] in {"W1", "W3"}  # most cited inside the set
    assert result["chain"][0] in {"W1", "W5"} and len(result["chain"]) >= 4
    # W8 (GW topic) cites W3 (optics topic): a cross-topic link exists
    assert result["cluster_links"]


def test_build_flow_with_foundations_and_tiny_sets():
    foundation = {**p("W90", "Neutron star atmospheres", "neutron star atmosphere model", 1990, 1000), "cited_by_in_set": 3}
    result = flow.build_flow(CORPUS, foundations=[foundation])
    w90 = next(n for n in result["nodes"] if n["id"] == "W90")
    assert w90["role"] == "foundation" and w90["cited_by_in_set"] == 3

    single = flow.build_flow([CORPUS[0]])
    assert len(single["clusters"]) == 1 and single["chain"] == []
    assert flow.build_flow([])["nodes"] == []
    no_text = flow.build_flow([p("W1", "", ""), p("W2", "", "")])
    assert no_text["clusters"][0]["label"] == "all papers"


def test_longest_chain_ignores_cycles():
    nodes = {
        "A": {"year": 2000, "citations": 0},
        "B": {"year": 2000, "citations": 0},
    }
    assert flow.longest_chain(nodes, [("A", "B"), ("B", "A")]) == ["A", "B"]


# ---------- API ----------


@pytest.fixture
def api(store, monkeypatch):
    main.app.dependency_overrides[main.get_store] = lambda: store
    fetched = []

    def fake_by_ids(ids, **_):
        fetched.extend(ids)
        return [{**p(i, f"Foundation {i}", "neutron star atmosphere", 1990, 1000)} for i in ids]

    monkeypatch.setattr(openalex, "papers_by_ids", fake_by_ids)
    client = TestClient(main.app)
    client.fetched = fetched
    yield client
    main.app.dependency_overrides.clear()


def test_bookmark_api_roundtrip(api):
    assert api.get("/bookmarks").json() == []
    res = api.put("/bookmarks", json={"paper": CORPUS[0], "tags": ["optics"], "query": "neutron"})
    assert res.status_code == 200 and res.json()["id"] == "W1"
    assert api.patch("/bookmarks/W1", json={"note": "must read"}).json()["note"] == "must read"
    assert [b["id"] for b in api.get("/bookmarks", params={"tag": "optics"}).json()] == ["W1"]
    assert "@article{" in api.get("/bookmarks/export.bib").text
    assert api.delete("/bookmarks/W1").status_code == 204
    assert api.delete("/bookmarks/W1").status_code == 404
    assert api.patch("/bookmarks/W1", json={"note": "x"}).status_code == 404


def test_flow_api_merges_bookmarks_and_foundations(api):
    api.put("/bookmarks", json={"paper": CORPUS[7]})
    res = api.post("/flow", json={"papers": CORPUS[:7], "include_bookmarks": True})
    assert res.status_code == 200
    nodes = {n["id"]: n for n in res.json()["nodes"]}
    assert nodes["W8"]["bookmarked"] is True
    assert api.fetched == ["W90", "W91"]
    assert nodes["W90"]["role"] == "foundation" and nodes["W90"]["cited_by_in_set"] == 3


def test_flow_api_without_papers_is_400(api):
    assert api.post("/flow", json={"papers": []}).status_code == 400


def test_flow_api_survives_openalex_failure(api, monkeypatch):
    import requests

    def boom(*_, **__):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "papers_by_ids", boom)
    res = api.post("/flow", json={"papers": CORPUS})
    assert res.status_code == 200
    assert all(n["role"] == "result" for n in res.json()["nodes"])


def test_cluster_label_prefers_phrases():
    result = flow.build_flow(CORPUS)
    labels = [c["label"] for c in result["clusters"]]
    assert any("gravitational wave" in label for label in labels)
    for label in labels:
        parts = label.split(", ")
        words = [w for part in parts for w in part.split()]
        assert len(words) == len(set(words)), label


def test_flow_figure_builds():
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "frontend"))
    from flow_chart import build_figure, lineage_rows

    data = flow.build_flow(CORPUS, bookmarked={"W3"})
    for mode in ("light", "dark"):
        fig = build_figure(data, mode)
        names = [trace.name for trace in fig.data]
        assert names[:2] == ["Citation", "Key lineage"]
        assert {"Search result", "Bookmarked"} <= set(names)
        assert len(fig.layout.yaxis.tickvals) == len(data["clusters"])
    assert [row["year"] for row in lineage_rows(data)] == sorted(row["year"] for row in lineage_rows(data))


def test_cluster_label_phrase_found_past_first_three_words():
    foundations = [
        {**p("W91", "Interferometer noise budget", "interferometer noise", 1995, 1500), "cited_by_in_set": 2},
    ]
    labels = [c["label"] for c in flow.build_flow(CORPUS, foundations=foundations)["clusters"]]
    assert any("gravitational wave" in label for label in labels), labels
