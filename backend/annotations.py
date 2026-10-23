"""Handwriting on PDFs and note pages, one JSON file per document in the data folder.

A document is a paper (its OpenAlex id, e.g. W2116341502) or a PDF opened from a file
("file-" and the start of its SHA-256). Items are drawn by the reader (frontend/web/reader),
which only ever sets them as SVG attributes and text, never as HTML.
"""

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend import settings

DOC_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
MAX_BYTES = 8 * 1024 * 1024  # one document's handwriting


def folder() -> Path:
    path = settings.data_dir() / "annotations"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path(doc_id: str) -> Path:
    if not DOC_ID.match(doc_id) or doc_id.startswith("."):
        raise ValueError("invalid document id")
    return folder() / f"{doc_id}.json"


def load(doc_id: str) -> dict | None:
    path = _path(doc_id)  # an invalid id raises here, not as a missing file
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None


def save(doc_id: str, doc: dict) -> dict:
    doc = {**doc, "id": doc_id, "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise OverflowError("handwriting too large")
    path = _path(doc_id)
    # write to a temporary file first so a crash never leaves half a document
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(tmp, path)
    return summary(doc)


def delete(doc_id: str) -> bool:
    path = _path(doc_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def summary(doc: dict) -> dict:
    pages = doc.get("pages") or {}
    notes = doc.get("notes") or []
    return {
        "id": doc["id"],
        "title": doc.get("title", ""),
        "paper_id": doc.get("paper_id"),
        "source": doc.get("source"),
        "page_count": doc.get("page_count", 0),
        "last_page": doc.get("last_page", 1),
        "items": sum(len(items) for items in pages.values()) + sum(len(items) for items in notes),
        "note_pages": len(notes),
        "updated_at": doc.get("updated_at"),
    }


def all_summaries() -> list[dict]:
    docs = []
    for path in folder().glob("*.json"):
        try:
            docs.append(summary(json.loads(path.read_text(encoding="utf-8"))))
        except (ValueError, KeyError):
            continue
    return sorted(docs, key=lambda d: d.get("updated_at") or "", reverse=True)
