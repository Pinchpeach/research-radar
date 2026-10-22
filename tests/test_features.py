"""0.9.0: free full text links, new papers on recent topics, the monthly reading goal."""

import json
from datetime import date

import requests
from fastapi.testclient import TestClient

from backend import history, main
from backend.services import openalex

api = TestClient(main.app, base_url="http://127.0.0.1")


def test_free_full_text_prefers_the_pdf():
    work = {"id": "https://openalex.org/W1", "best_oa_location": {"pdf_url": "https://r.example/p.pdf"},
            "open_access": {"oa_url": "https://r.example/landing"}}
    assert openalex.normalize_work(work)["open_access_url"] == "https://r.example/p.pdf"
    assert openalex.normalize_work({**work, "best_oa_location": None})["open_access_url"] == "https://r.example/landing"
    assert openalex.normalize_work({"id": "W2", "open_access": {"oa_url": "javascript:alert(1)"}})["open_access_url"] is None


def test_new_papers_since_the_day_after_each_search(monkeypatch):
    asked = []

    def count(query, since):
        asked.append((query, since))
        return {"graph neural networks": 12}.get(query, 0)

    class Today(date):
        @classmethod
        def today(cls):
            return date(2026, 10, 20)

    monkeypatch.setattr(main, "date", Today)
    monkeypatch.setattr(openalex, "count_since", count)
    main._new_papers_cache.clear()
    history.record("protein folding")
    history.record("graph neural networks")
    entries = history.load()
    entries[0]["searched_at"] = "2026-10-01T09:00:00+00:00"  # graph neural networks, weeks ago
    entries[1]["searched_at"] = "2026-10-20T08:00:00+00:00"  # protein folding, today
    history.default_path().write_text(json.dumps(entries), encoding="utf-8")

    body = api.get("/history/new").json()
    assert [(e["query"], e["since"], e["new_papers"]) for e in body] == [
        ("graph neural networks", "2026-10-02", 12),
        ("protein folding", "2026-10-21", 0),  # searched today: nothing to ask yet
    ]
    api.get("/history/new")
    assert asked == [("graph neural networks", "2026-10-02")], "asked once, then reused"


def test_new_papers_survive_openalex_being_down(monkeypatch):
    def down(query, since):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr(openalex, "count_since", down)
    main._new_papers_cache.clear()
    history.record("x-ray binaries")
    entries = history.load()
    entries[0]["searched_at"] = "2020-01-01T00:00:00+00:00"
    history.default_path().write_text(json.dumps(entries), encoding="utf-8")
    assert api.get("/history/new").json()[0]["new_papers"] is None


def test_reading_goal_setting():
    assert api.put("/settings", json={"reading_goal": "15"}).json()["reading_goal"]["value"] == "15"
    for bad in ["0", "1000", "abc", "-3"]:
        assert api.put("/settings", json={"reading_goal": bad}).status_code == 422, bad
    assert api.put("/settings", json={"reading_goal": ""}).json()["reading_goal"]["value"] == ""
