import os
import stat

import pytest
import requests
from fastapi.testclient import TestClient

from backend import main, settings
from backend.services import openalex

api = TestClient(main.app)


def test_saved_value_wins_over_environment_and_can_be_cleared(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", "from-env")
    assert settings.get("openalex_api_key") == "from-env"
    settings.save({"openalex_api_key": "  saved-key-1234  "})
    assert settings.get("openalex_api_key") == "saved-key-1234"
    settings.save({"openalex_api_key": ""})
    assert settings.get("openalex_api_key") == "from-env"


def test_settings_file_is_private():
    if os.name == "nt":
        pytest.skip("POSIX permission bits; Windows protects the per-user app-data folder instead")
    settings.save({"openalex_api_key": "abc"})
    mode = stat.S_IMODE(os.stat(settings.settings_path()).st_mode)
    assert mode == 0o600


def test_api_never_returns_full_key():
    res = api.put("/settings", json={"openalex_api_key": "0123456789abcdefWXYZ", "openalex_email": "me@uni.edu"})
    body = res.json()
    assert "0123456789abcdefWXYZ" not in res.text
    assert body["openalex_api_key"] == {"set": True, "source": "settings", "hint": "••••••WXYZ"}
    assert body["openalex_email"]["value"] == "me@uni.edu"
    assert body["openai_api_key"]["set"] is False
    # leaving a field out keeps it; an empty string clears it
    api.put("/settings", json={"openalex_email": ""})
    body = api.get("/settings").json()
    assert body["openalex_api_key"]["set"] and not body["openalex_email"]["set"]


def test_saved_key_is_used_for_openalex_requests(monkeypatch):
    seen = {}

    class Resp:
        status_code = 200
        headers = {"x-ratelimit-remaining-usd": "0.75", "x-ratelimit-limit-usd": "1"}

        def raise_for_status(self):
            pass

        def json(self):
            return {"results": []}

    def fake_get(url, params, headers, timeout):
        seen["headers"] = headers
        return Resp()

    monkeypatch.setattr(openalex._session, "get", fake_get)
    api.put("/settings", json={"openalex_api_key": "saved-key"})
    openalex.search_papers("q", 1)
    assert seen["headers"] == {"Authorization": "Bearer saved-key"}

    # testing a key before saving it uses that key, not the saved one
    res = api.post("/settings/test-openalex", json={"api_key": "candidate"}).json()
    assert seen["headers"] == {"Authorization": "Bearer candidate"}
    assert res == {"ok": True, "code": "ok", "message": res["message"], "remaining_usd": 0.75, "limit_usd": 1.0}


def test_key_test_reports_rejection_and_network_errors(monkeypatch):
    class Resp:
        status_code = 401
        headers = {}

    monkeypatch.setattr(openalex._session, "get", lambda *a, **k: Resp())
    assert api.post("/settings/test-openalex", json={"api_key": "bad"}).json()["ok"] is False

    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex._session, "get", boom)
    res = api.post("/settings/test-openalex", json={}).json()
    assert res["ok"] is False and "연결" in res["message"]


def test_bookmarks_live_in_the_data_folder(tmp_path, monkeypatch):
    from backend.storage import BookmarkStore

    monkeypatch.setenv("RADAR_HOME", str(tmp_path / "elsewhere"))
    assert BookmarkStore().path == tmp_path / "elsewhere" / "radar.db"


def test_evaluation_runs_roundtrip():
    run = {
        "run_id": "2026-10-15T05:00:00Z",
        "query": "graph neural networks",
        "settings": {"weights": {"relevance": 0.6}},
        "papers": [{"id": f"W{i}", "title": f"t{i}", "score": 90 - i} for i in range(4)],
        "judgments": {"W0": "relevant", "W1": "not_relevant", "W3": "partial"},
    }
    assert api.post("/evaluations", json=run).json() == {"written": 3}
    assert (settings.data_dir() / "judgments.jsonl").exists()  # in the app's data folder

    [saved] = api.get("/evaluations").json()
    assert saved["query"] == "graph neural networks" and saved["judged"] == 3
    assert saved["p@10"] == 2 / 3 and saved["settings"]["weights"]["relevance"] == 0.6

    assert api.post("/evaluations", json={**run, "judgments": {}}).status_code == 400
    assert api.post("/evaluations", json={**run, "judgments": {"W0": "maybe"}}).status_code == 422
    assert api.delete(f"/evaluations/{run['run_id']}").status_code == 204
    assert api.get("/evaluations").json() == []
    assert api.delete(f"/evaluations/{run['run_id']}").status_code == 404


def test_language_is_saved_and_validated():
    assert api.get("/settings").json()["language"]["set"] is False
    body = api.put("/settings", json={"language": "en"}).json()
    assert body["language"] == {"set": True, "source": "settings", "value": "en"}
    assert api.put("/settings", json={"language": "fr"}).status_code == 422
    assert api.get("/settings").json()["language"]["value"] == "en"


def test_poster_follows_the_requested_language():
    flow = {"nodes": [], "edges": [], "clusters": []}
    assert "연도가 있는 논문이 없습니다" in api.post("/poster", json={"flow": flow, "title": "x", "lang": "ko"}).text
    assert "No dated papers" in api.post("/poster", json={"flow": flow, "title": "x", "lang": "en"}).text
    assert api.post("/poster", json={"flow": flow, "title": "x", "lang": "de"}).status_code == 422
