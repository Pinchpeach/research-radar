"""Record the OpenAlex traffic of one real search for the Python/JS parity test.

    OPENALEX_API_KEY=... python tests/fixtures/record_openalex.py "graph neural networks"

Writes tests/fixtures/openalex_<query>.json: each request (path + parameters, without the key
or e-mail) with a trimmed copy of OpenAlex's answer (only the fields the app reads).
"""

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi.testclient import TestClient  # noqa: E402

from backend import main  # noqa: E402
from backend.services import openalex  # noqa: E402

TODAY = date(2026, 10, 17)
KEEP = ("id", "title", "display_name", "abstract_inverted_index", "publication_year", "doi", "cited_by_count",
        "referenced_works", "primary_topic")


def request_key(url: str, params: dict) -> str:
    kept = {k: str(v) for k, v in params.items() if k not in ("api_key", "mailto")}
    return url + "?" + "&".join(f"{k}={kept[k]}" for k in sorted(kept))


def trim(work: dict) -> dict:
    out = {k: work.get(k) for k in KEEP}
    location = work.get("primary_location") or {}
    out["primary_location"] = {"landing_page_url": location.get("landing_page_url"),
                               "source": {"display_name": (location.get("source") or {}).get("display_name")}}
    out["authorships"] = [{"author": {"display_name": a.get("author", {}).get("display_name")}} for a in work.get("authorships", [])]
    out["keywords"] = [{"display_name": k.get("display_name")} for k in work.get("keywords") or []]
    if out["primary_topic"]:
        out["primary_topic"] = {"display_name": out["primary_topic"].get("display_name")}
    return out


def shrink_references(recorded: dict) -> None:
    """Drop references that can't matter: works cited only once and not in the recorded set
    (core references need several citers), which is most of the file."""
    works = [w for r in recorded.values() for w in (r["body"].get("results") or [r["body"]]) if w.get("id")]
    ids = {openalex.short_id(w["id"]) for w in works}
    counts: dict[str, int] = {}
    for w in works:
        for ref in set(w.get("referenced_works") or []):
            counts[ref] = counts.get(ref, 0) + 1
    for w in works:
        w["referenced_works"] = [r for r in w.get("referenced_works") or []
                                 if openalex.short_id(r) in ids or counts.get(r, 0) >= 2]


def main_(query: str) -> None:
    recorded = {}
    real_get = openalex._session.get

    def get(url, params=None, headers=None, timeout=None):
        response = real_get(url, params=params, headers=headers, timeout=timeout)
        body = response.json()
        if "results" in body:
            body = {"results": [trim(w) for w in body["results"]]}
        elif "id" in body:
            body = trim(body)
        recorded[request_key(url, params or {})] = {"status": response.status_code, "body": body}
        return response

    openalex._session.get = get
    main.date = type("FixedDate", (date,), {"today": classmethod(lambda cls: TODAY)})
    response = TestClient(main.app, base_url="http://127.0.0.1").post("/search", json={"query": query, "limit": 20})
    response.raise_for_status()
    shrink_references(recorded)
    out = Path(__file__).with_name(f"openalex_{query.replace(' ', '_')}.json")
    out.write_text(json.dumps({"query": query, "today": TODAY.isoformat(), "responses": recorded}, ensure_ascii=False))
    print(f"{len(recorded)} requests, {out.stat().st_size // 1024} KB -> {out}")


if __name__ == "__main__":
    main_(sys.argv[1] if len(sys.argv) > 1 else "graph neural networks")
