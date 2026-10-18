"""Recently searched topics, newest first, for the home screen.

Kept in history.json in the app's data folder (the desktop app's window gets a new local port
each run, so the browser's own storage would forget them).
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from backend import settings

MAX_ENTRIES = 20


def default_path() -> Path:
    return settings.data_dir() / "history.json"


def load(path: Path | None = None) -> list[dict]:
    try:
        data = json.loads((path or default_path()).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict) and isinstance(e.get("query"), str)] if isinstance(data, list) else []


def record(query: str, path: Path | None = None) -> None:
    """Put `query` first; an earlier search for the same topic (ignoring case and spacing) moves up."""
    query = " ".join(query.split())
    if not query:
        return
    path = path or default_path()
    entries = [e for e in load(path) if e["query"].casefold() != query.casefold()]
    entry = {"query": query, "searched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([entry, *entries][:MAX_ENTRIES], ensure_ascii=False), encoding="utf-8")


def clear(path: Path | None = None) -> None:
    (path or default_path()).unlink(missing_ok=True)
