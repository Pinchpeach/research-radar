"""Authors and journals the person follows, and the papers they've published since last looked at.

Kept in follows.json in the app's data folder: [{kind, id, name, since, added_at}], where kind
is "author" (an OpenAlex author, A...) or "source" (a journal or other venue, S...), and
`since` is the first publication day that still counts as new (set to the next day when the
person has looked; see seen()).
"""

import json
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from backend import settings

KINDS = {"author": re.compile(r"^A\d{1,15}$"), "source": re.compile(r"^S\d{1,15}$")}
MAX_FOLLOWS = 30  # one OpenAlex request each when checking for new papers


def path() -> Path:
    return settings.data_dir() / "follows.json"


def valid(kind: str, follow_id: str) -> bool:
    return kind in KINDS and bool(KINDS[kind].match(follow_id or ""))


def load() -> list[dict]:
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    return (
        [f for f in data if isinstance(f, dict) and valid(f.get("kind", ""), f.get("id", ""))]
        if isinstance(data, list)
        else []
    )


def _save(items: list[dict]) -> None:
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")


def add(kind: str, follow_id: str, name: str, today: date | None = None) -> dict:
    if not valid(kind, follow_id):
        raise ValueError("not an OpenAlex author or source id")
    items = load()
    for item in items:
        if item["kind"] == kind and item["id"] == follow_id:
            return item
    if len(items) >= MAX_FOLLOWS:
        raise OverflowError(f"follow at most {MAX_FOLLOWS}")
    today = today or date.today()
    item = {
        "kind": kind,
        "id": follow_id,
        "name": (name or follow_id).strip()[:200],
        "since": today.isoformat(),
        "added_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    _save([item, *items])
    return item


def remove(kind: str, follow_id: str) -> bool:
    items = load()
    kept = [f for f in items if not (f["kind"] == kind and f["id"] == follow_id)]
    if len(kept) == len(items):
        return False
    _save(kept)
    return True


def seen(kind: str, follow_id: str, today: date | None = None) -> dict | None:
    """The person has looked: only papers from tomorrow on count as new."""
    items = load()
    for item in items:
        if item["kind"] == kind and item["id"] == follow_id:
            item["since"] = ((today or date.today()) + timedelta(days=1)).isoformat()
            _save(items)
            return item
    return None
