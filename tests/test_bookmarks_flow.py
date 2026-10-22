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


def label_parts(label: str) -> list[str]:
    """Topic names join phrases with " & " (keywords) or " · " (word-statistics fallback)."""
    import re

    return [part for part in re.split(r" · | & ", label) if part]


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
    labels = " ".join(c["label"] for c in result["clusters"]).lower()
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
    assert no_text["clusters"][0]["label"].lower() == "all papers"


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
    client = TestClient(main.app, base_url="http://127.0.0.1")
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
    labels = [c["label"].lower() for c in result["clusters"]]
    assert any("gravitational wave" in label for label in labels)
    for label in labels:
        parts = label_parts(label)
        words = [w for part in parts for w in part.split()]
        assert len(words) == len(set(words)), label


def test_cluster_label_phrase_found_past_first_three_words():
    foundations = [
        {**p("W91", "Interferometer noise budget", "interferometer noise", 1995, 1500), "cited_by_in_set": 2},
    ]
    labels = [c["label"].lower() for c in flow.build_flow(CORPUS, foundations=foundations)["clusters"]]
    assert any("gravitational wave" in label for label in labels), labels


# ---------- real-data issues: duplicates and labels ----------


def test_dedupe_merges_versions_and_redirects_citations():
    from backend.services.dedupe import dedupe

    preprint = p("W10", "Optical Observations of Isolated Neutron Stars", "", 1998, 0, ["W1"])
    journal = p("W11", "Optical observations of isolated neutron stars.", "abstract", 1999, 40, ["W2"])
    other = p("W12", "Optical Observations of Isolated Neutron Stars", "", 2015, 3)  # a later, different paper
    citer = p("W20", "Follow-up", "x", 2005, 1, ["W10"])
    unique, alias = dedupe([preprint, journal, other, citer])
    ids = [u["id"].rsplit("/", 1)[-1] for u in unique]
    assert ids == ["W11", "W12", "W20"]
    assert alias == {"W10": "W11"}
    kept = unique[0]
    assert set(kept["referenced_works"]) == {"W1", "W2"}
    assert unique[2]["referenced_works"] == ["W11"]
    assert preprint["referenced_works"] == ["W1"]  # inputs untouched


def test_build_flow_merges_duplicates_and_keeps_query_out_of_labels():
    dup = {**CORPUS[0], "id": "https://openalex.org/W1b", "citations": 0}
    result = flow.build_flow(CORPUS + [dup], query="neutron star optical observations")
    ids = {n["id"] for n in result["nodes"]}
    assert "W1b" not in ids and "W1" in ids
    for c in result["clusters"]:
        words = {w for part in label_parts(c["label"].lower()) for w in part.split()}
        assert not words & {"neutron", "star", "stars", "optical", "observations"}, c["label"]


def test_labels_skip_generic_and_short_tokens():
    papers = [
        p(f"W{i}", f"RX J{i} gives new results", "this paper gives results using rx data on magnetar bursts", 2000 + i)
        for i in range(4)
    ] + [
        p(f"W{i + 10}", f"Gravitational wave search {i}", "we present interferometer gravitational wave searches", 2000 + i)
        for i in range(4)
    ]
    labels = " ".join(c["label"] for c in flow.build_flow(papers)["clusters"]).lower()
    words = {w for part in label_parts(labels) for w in part.split()}
    assert not words & {"gives", "results", "using", "rx", "paper", "present", "new"}, labels
    assert "magnetar" in labels and "gravitational wave" in labels


def test_impossible_citations_are_ignored():
    old = p("W1", "Old paper about pulsars", "pulsars", 2000, 10, ["W9"])  # "cites" a 2025 paper
    new = p("W9", "New paper about pulsars", "pulsars", 2025, 1)
    preprint_lag = p("W3", "Journal version", "pulsars", 2010, 1, ["W4"])
    early = p("W4", "Cited preprint", "pulsars", 2011, 1)  # one year of slack is fine
    result = flow.build_flow([old, new, preprint_lag, early])
    edges = {(e["source"], e["target"]) for e in result["edges"]}
    assert ("W1", "W9") not in edges and ("W3", "W4") in edges


def test_credible_foundations_recounts_citers():
    citers = [p(f"W{i}", "t", "x", 2020, 1, ["W90", "W91"]) for i in range(3)]
    good = p("W90", "Classic", "x", 2010, 500)
    bogus = p("W91", "From the future", "x", 2025, 3)
    kept = flow.credible_foundations(citers, [good, bogus])
    assert [k["id"] for k in kept] == [good["id"]] and kept[0]["cited_by_in_set"] == 3


def test_topic_names_come_from_distinctive_openalex_keywords():
    def kp(wid, kws, topic, year=2020):
        return {**p(wid, f"Graph neural networks paper {wid}", "graph neural networks", year), "keywords": kws, "topic": topic}

    drug = [kp(f"W{i}", ["graph neural networks", "drug discovery", "molecular generation"], "Advanced Graph Neural Networks")
            for i in range(4)]
    rec = [kp(f"W{i + 10}", ["graph neural networks", "social recommendation", "user-item interaction graph"],
              "Recommender Systems and Techniques") for i in range(4)]
    assignment = [0] * 4 + [1] * 4
    names = flow.name_clusters(drug + rec, assignment, ["fallback a", "fallback b"], query="graph neural networks")
    assert names[0] == "Drug Discovery & Molecular Generation"
    assert "Recommend" in names[1] or "Social Recommendation" in names[1]
    assert not any("Graph Neural Networks" == part for name in names for part in name.split(" & "))
    assert names[0] != names[1]


def test_topic_names_fall_back_without_keywords():
    names = flow.name_clusters([p("W1", "a", "x"), p("W2", "b", "y")], [0, 0], ["magnetar, x-ray timing"])
    assert names == ["Magnetar · X-ray Timing"]


def test_title_case_keeps_acronyms_and_small_words():
    assert flow.title_case("pulsars and gravitational waves") == "Pulsars and Gravitational Waves"
    assert flow.title_case("GNN for x-ray data") == "GNN for X-ray Data"


def test_topic_names_keep_acronyms_and_trim_filler():
    assert flow.tidy_phrase("Pulsars and Gravitational Waves Research") == "Pulsars and Gravitational Waves"
    assert flow.tidy_phrase("Recommender Systems and Techniques") == "Recommender Systems"
    papers = [{**p(f"W{i}", "t", "x"), "keywords": ["off-target effects"], "topic": "CRISPR and Genetic Engineering"}
              for i in range(3)]
    other = [{**p(f"W{i + 5}", "t", "x"), "keywords": ["tomato"], "topic": "Plant Breeding"} for i in range(3)]
    names = flow.name_clusters(papers + other, [0] * 3 + [1] * 3, ["a", "b"])
    assert names[0] == "Off-target Effects"  # keyword beats the broad topic; second phrase only if short
    assert names[1] == "Tomato"
    lone = flow.name_clusters(papers, [0, 0, 0], ["a"], query="off-target effects")
    assert lone == ["CRISPR and Genetic Engineering"]  # casing kept; query echo skipped


# ---------- reading status ----------


def test_reading_status_stamps_and_clears_read_at(tmp_path):
    store = BookmarkStore(tmp_path / "r.db")
    store.save({"id": "https://openalex.org/W1", "title": "A"})
    assert store.get("W1")["status"] == "to_read" and store.get("W1")["read_at"] is None
    read = store.update("W1", status="read")
    assert read["status"] == "read" and read["read_at"]
    again = store.update("W1", note="still read")
    assert again["read_at"] == read["read_at"]  # a note doesn't move the day it was read
    assert store.save({"id": "https://openalex.org/W1", "title": "A, refreshed"})["status"] == "read"
    back = store.update("W1", status="reading")
    assert back["status"] == "reading" and back["read_at"] is None
    with pytest.raises(ValueError):
        store.update("W1", status="finished")


def test_old_databases_get_the_reading_columns(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE bookmarks (id TEXT PRIMARY KEY, paper TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', "
                   "tags TEXT NOT NULL DEFAULT '[]', query TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        db.execute("INSERT INTO bookmarks VALUES ('W1', '{\"id\": \"W1\"}', '', '[]', NULL, 'x', 'x')")
    item = BookmarkStore(path).get("W1")
    assert item["status"] == "to_read" and item["read_at"] is None


def test_status_over_the_api(tmp_path):
    store = BookmarkStore(tmp_path / "api.db")
    main.app.dependency_overrides[main.get_store] = lambda: store
    try:
        client = TestClient(main.app, base_url="http://127.0.0.1")
        client.put("/bookmarks", json={"paper": {"id": "https://openalex.org/W7", "title": "T"}})
        assert client.patch("/bookmarks/W7", json={"status": "read"}).json()["read_at"]
        assert client.patch("/bookmarks/W7", json={"status": "done"}).status_code == 422
        assert client.get("/bookmarks").json()[0]["status"] == "read"
    finally:
        main.app.dependency_overrides.clear()
