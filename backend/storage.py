"""Bookmarks stored in a local SQLite database."""

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "radar.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    paper TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    query TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


def short_id(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def clean_tags(tags: list[str]) -> list[str]:
    seen = []
    for tag in tags:
        tag = tag.strip().lower()
        if tag and tag not in seen:
            seen.append(tag)
    return seen


class BookmarkStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.getenv("RADAR_DB") or DEFAULT_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute(SCHEMA)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    @staticmethod
    def _row(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "paper": json.loads(row["paper"]),
            "note": row["note"],
            "tags": json.loads(row["tags"]),
            "query": row["query"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def all(self, tag: str | None = None) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM bookmarks ORDER BY created_at DESC").fetchall()
        items = [self._row(row) for row in rows]
        if tag:
            items = [item for item in items if tag.lower() in item["tags"]]
        return items

    def get(self, bookmark_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM bookmarks WHERE id = ?", (short_id(bookmark_id),)).fetchone()
        return self._row(row) if row else None

    def ids(self) -> set[str]:
        with self._connect() as db:
            return {row[0] for row in db.execute("SELECT id FROM bookmarks")}

    def save(self, paper: dict, note: str = "", tags: list[str] | None = None, query: str | None = None) -> dict:
        """Insert or replace the stored paper; keeps note/tags/created_at unless new ones are given."""
        bookmark_id = short_id(paper["id"])
        now = datetime.now(timezone.utc).isoformat()
        existing = self.get(bookmark_id)
        with self._connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO bookmarks (id, paper, note, tags, query, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    bookmark_id,
                    json.dumps(paper),
                    note or (existing["note"] if existing else ""),
                    json.dumps(clean_tags(tags) if tags is not None else (existing["tags"] if existing else [])),
                    query if query is not None else (existing["query"] if existing else None),
                    existing["created_at"] if existing else now,
                    now,
                ),
            )
        return self.get(bookmark_id)

    def update(self, bookmark_id: str, note: str | None = None, tags: list[str] | None = None) -> dict | None:
        existing = self.get(bookmark_id)
        if not existing:
            return None
        with self._connect() as db:
            db.execute(
                "UPDATE bookmarks SET note = ?, tags = ?, updated_at = ? WHERE id = ?",
                (
                    existing["note"] if note is None else note,
                    json.dumps(existing["tags"] if tags is None else clean_tags(tags)),
                    datetime.now(timezone.utc).isoformat(),
                    existing["id"],
                ),
            )
        return self.get(bookmark_id)

    def delete(self, bookmark_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute("DELETE FROM bookmarks WHERE id = ?", (short_id(bookmark_id),))
        return cursor.rowcount > 0


def to_bibtex(bookmarks: list[dict]) -> str:
    entries = []
    for bookmark in bookmarks:
        paper = bookmark["paper"]
        first_author = (paper.get("authors") or ["unknown"])[0].split()[-1].lower()
        key = "".join(ch for ch in f"{first_author}{paper.get('year') or ''}{bookmark['id']}" if ch.isalnum())
        fields = {
            "title": paper.get("title"),
            "author": " and ".join(paper.get("authors") or []),
            "year": paper.get("year"),
            "journal": paper.get("venue"),
            "doi": (paper.get("doi") or "").replace("https://doi.org/", "") or None,
            "url": paper.get("url"),
            "note": bookmark.get("note") or None,
            "keywords": ", ".join(bookmark.get("tags") or []) or None,
        }
        body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields.items() if value)
        entries.append(f"@article{{{key},\n{body}\n}}")
    return "\n\n".join(entries) + ("\n" if entries else "")
