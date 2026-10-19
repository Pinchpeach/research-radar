"""Attacks on the app, replayed: each test is a way in that must stay closed (docs/security.md)."""

from fastapi.testclient import TestClient

from backend import main
from backend.services import openalex

api = TestClient(main.app, base_url="http://127.0.0.1:8123")


def test_dns_rebinding_is_refused():
    # a site that points its own name at 127.0.0.1 arrives with its name in the Host header
    stolen = TestClient(main.app, base_url="http://attacker.example:8123")
    assert stolen.get("/settings").status_code == 400
    assert stolen.get("/bookmarks").status_code == 400
    assert api.get("/settings").status_code == 200
    assert TestClient(main.app, base_url="http://localhost:8123").get("/health").status_code == 200


def test_writes_from_another_origin_are_refused():
    body = {"openalex_email": "attacker@example.org"}
    for origin in ["https://attacker.example", "null", "http://127.0.0.1:9999"]:
        res = api.put("/settings", json=body, headers={"Origin": origin})
        assert res.status_code == 403, origin
    assert api.delete("/history", headers={"Origin": "https://attacker.example"}).status_code == 403
    assert api.get("/settings").json()["openalex_email"]["value"] in (None, "")
    # the app's own page (and clients that send no Origin) still work
    assert api.put("/settings", json=body, headers={"Origin": "http://127.0.0.1:8123"}).status_code == 200
    assert api.put("/settings", json={"openalex_email": ""}).status_code == 200


def test_plain_cross_site_posts_are_not_json():
    # what a form on another site can send without a CORS preflight
    res = api.put("/settings", content='{"openalex_email": "a@b.c"}', headers={"Content-Type": "text/plain"})
    assert res.status_code == 422


def test_only_web_links_survive_from_openalex():
    work = {
        "id": "https://openalex.org/W1",
        "doi": "javascript:alert(1)",
        "primary_location": {"landing_page_url": " JavaScript:fetch('//evil')"},
    }
    paper = openalex.normalize_work(work)
    assert paper["doi"] is None
    assert paper["url"] == "https://openalex.org/W1"
    assert openalex.web_url("data:text/html,<script>1</script>") is None
    assert openalex.web_url("HTTPS://doi.org/10.1/x") == "HTTPS://doi.org/10.1/x"
