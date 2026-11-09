"""Zotero round trip: bookmarks out as RIS (and BibTeX), a RIS/BibTeX export in as bookmarks."""

import requests
from fastapi.testclient import TestClient

from backend import main
from backend.services import openalex
from backend.storage import to_ris

api = TestClient(main.app, base_url="http://127.0.0.1")


def work(wid, title, doi=None, year=2020):
    return {"id": f"https://openalex.org/{wid}", "title": title, "abstract": "", "year": year,
            "doi": f"https://doi.org/{doi}" if doi else None, "url": None, "open_access_url": None, "venue": "Nature",
            "authors": ["Ada Lovelace"], "citations": 0, "referenced_works": [], "keywords": [], "topic": None}


def test_ris_has_one_line_per_field_and_ends_each_entry():
    ris = to_ris([{"id": "W1", "paper": {**work("W1", "A\ntitle", "10.1000/x"), "abstract": "line one\nline two"},
                   "note": "read\nthis", "tags": ["gnn", "key"]}])
    assert ris.splitlines() == ["TY  - JOUR", "TI  - A title", "AU  - Ada Lovelace", "PY  - 2020", "JO  - Nature",
                                "DO  - 10.1000/x", "AB  - line one line two", "KW  - gnn", "KW  - key", "N1  - read this",
                                "ID  - W1", "ER  - "]
    assert to_ris([]) == ""


def test_import_by_doi_then_title_keeping_tags_and_notes(monkeypatch):
    asked = {}

    def by_dois(dois):
        asked["dois"] = dois
        return {"10.1000/x": work("W1", "Paper one", "10.1000/x")}

    def by_title(title, year=None):
        asked.setdefault("titles", []).append((title, year))
        return work("W2", "Paper two") if title == "Paper two" else None

    monkeypatch.setattr(openalex, "by_dois", by_dois)
    monkeypatch.setattr(openalex, "by_title", by_title)
    entries = [{"doi": "10.1000/X", "title": "Paper one", "tags": ["GNN"], "note": "from zotero"},
               {"title": "Paper two", "year": 2019}, {"title": "Unknown paper"}, {"doi": "not a doi", "title": ""}]
    done = api.post("/bookmarks/import", json={"entries": entries}).json()
    assert done == {"total": 4, "imported": 2, "existing": 0, "not_found": ["Unknown paper", "not a doi"]}
    assert asked["dois"] == ["10.1000/x"] and asked["titles"] == [("Paper two", 2019), ("Unknown paper", None)]
    saved = {b["id"]: b for b in api.get("/bookmarks").json()}
    assert saved["W1"]["tags"] == ["gnn"] and saved["W1"]["note"] == "from zotero"
    again = api.post("/bookmarks/import", json={"entries": entries[:1]}).json()
    assert (again["imported"], again["existing"]) == (0, 1)
    assert "ER  - " in api.get("/bookmarks/export.ris").text


def test_import_limits_and_failures(monkeypatch):
    assert api.post("/bookmarks/import", json={"entries": [{"title": "x"}] * 301}).status_code == 422

    def down(dois):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "by_dois", down)
    assert api.post("/bookmarks/import", json={"entries": [{"doi": "10.1000/x"}]}).status_code == 502


def test_openalex_lookups(monkeypatch):
    calls = []

    def get(url, params):
        calls.append(params["filter"])
        if params["filter"].startswith("doi:"):
            return {"results": [{"id": "https://openalex.org/W1", "title": "One", "doi": "https://doi.org/10.1000/X"}]}
        return {"results": [{"id": "https://openalex.org/W8", "title": "Graph attention networks?", "publication_year": 2017},
                            {"id": "https://openalex.org/W9", "title": "Graph Attention Networks", "publication_year": 2018},
                            {"id": "https://openalex.org/W7", "title": "Graph attention networks for X", "publication_year": 2018}]}

    monkeypatch.setattr(openalex, "_get", get)
    assert list(openalex.by_dois(["10.1000/x"])) == ["10.1000/x"]
    assert openalex.by_title("Graph attention networks", 2018)["id"].endswith("W9")
    assert calls[-1] == "title.search:Graph attention networks"
    assert openalex.by_title("Nothing like it") is None
