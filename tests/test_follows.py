"""Following authors and journals (backend/follows.py) and their new papers."""

from datetime import date

import requests
from fastapi.testclient import TestClient

from backend import follows, main
from backend.services import openalex

api = TestClient(main.app, base_url="http://127.0.0.1")


def test_follow_list_seen_and_unfollow():
    assert api.get("/follows").json() == []
    first = api.put("/follows", json={"kind": "author", "id": "A123", "name": "Ada Lovelace"}).json()
    assert first["since"] == date.today().isoformat() and first["name"] == "Ada Lovelace"
    assert api.put("/follows", json={"kind": "author", "id": "A123", "name": "again"}).json()["name"] == "Ada Lovelace"
    api.put("/follows", json={"kind": "source", "id": "S9", "name": "Nature"})
    assert [(f["kind"], f["id"]) for f in api.get("/follows").json()] == [("source", "S9"), ("author", "A123")]
    assert api.put("/follows", json={"kind": "author", "id": "S9"}).status_code == 422  # an author id starts with A
    assert api.put("/follows", json={"kind": "topic", "id": "T1"}).status_code == 422
    assert api.post("/follows/author/A123/seen").json()["since"] > date.today().isoformat()
    assert api.delete("/follows/author/A123").status_code == 204
    assert api.delete("/follows/author/A123").status_code == 404
    assert api.post("/follows/author/A123/seen").status_code == 404


def test_at_most_thirty(monkeypatch):
    monkeypatch.setattr(follows, "MAX_FOLLOWS", 2)
    api.put("/follows", json={"kind": "author", "id": "A1"})
    api.put("/follows", json={"kind": "author", "id": "A2"})
    assert api.put("/follows", json={"kind": "author", "id": "A3"}).status_code == 409


def test_new_papers_since_last_look(monkeypatch):
    asked = []
    paper = {"id": "https://openalex.org/W5", "title": "New result"}

    def published_by(kind, follow_id, since, limit=10):
        asked.append((kind, follow_id, since))
        return 7, [paper]

    monkeypatch.setattr(openalex, "published_by", published_by)
    main._new_papers_cache.clear()
    api.put("/follows", json={"kind": "author", "id": "A123", "name": "Ada"})
    new = api.get("/follows/new").json()
    assert new[0]["count"] == 7 and new[0]["papers"][0]["title"] == "New result"
    assert asked == [("author", "A123", date.today().isoformat())]
    api.get("/follows/new")
    assert len(asked) == 1  # cached
    api.post("/follows/author/A123/seen")
    assert api.get("/follows/new").json()[0]["count"] == 0  # nothing can be new before tomorrow

    def down(*args, **kwargs):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "published_by", down)
    main._new_papers_cache.clear()
    follows.remove("author", "A123")
    api.put("/follows", json={"kind": "source", "id": "S1", "name": "Nature"})
    assert api.get("/follows/new").json()[0]["count"] is None


def test_openalex_filter_for_follows(monkeypatch):
    seen = {}

    def get(url, params):
        seen.update(params)
        return {"meta": {"count": 3}, "results": [{"id": "https://openalex.org/W1", "title": "x",
                 "authorships": [{"author": {"id": "https://openalex.org/A9", "display_name": "Ada"}}],
                 "primary_location": {"source": {"id": "https://openalex.org/S4", "display_name": "Nature"}}}]}

    monkeypatch.setattr(openalex, "_get", get)
    count, papers = openalex.published_by("source", "S4", "2026-01-01")
    assert seen["filter"] == "primary_location.source.id:S4,from_publication_date:2026-01-01"
    assert seen["sort"] == "publication_date:desc"
    assert count == 3 and papers[0]["author_ids"] == ["A9"] and papers[0]["venue_id"] == "S4"
