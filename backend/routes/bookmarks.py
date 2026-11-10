"""Bookmarks, and moving them in and out of Zotero (RIS / BibTeX)."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from requests import RequestException

from backend import library
from backend.deps import Store, asking_openalex
from backend.models import Bookmark, BookmarkIn, BookmarkUpdate, ImportRequest
from backend.services import openalex
from backend.storage import to_bibtex, to_ris

router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])

MAX_TITLE_LOOKUPS = 50  # entries without a DOI cost one OpenAlex request each


@router.get("", response_model=list[Bookmark])
def list_bookmarks(store: Store, tag: str | None = None):
    return store.all(tag)


@router.put("", response_model=Bookmark)
def save_bookmark(item: BookmarkIn, store: Store):
    return store.save(item.paper.model_dump(), item.note, item.tags, item.query)


@router.post("/import")
def import_bookmarks(request: ImportRequest, store: Store):
    """Bookmark the papers of a Zotero (or other) export: found on OpenAlex by DOI (50 a request), or,
    without one, by exact title (at most MAX_TITLE_LOOKUPS). Papers already bookmarked stay as
    they are; tags and notes come along. Reports what was added and what couldn't be found."""
    entries = request.entries
    dois = list(dict.fromkeys(e.doi.lower() for e in entries if e.doi and library.DOI.match(e.doi)))
    have, imported, existing, missing, lookups = store.ids(), 0, 0, [], 0
    with asking_openalex():
        by_doi = openalex.by_dois(dois)
        for entry in entries:
            paper = by_doi.get((entry.doi or "").lower())
            if not paper and entry.title and lookups < MAX_TITLE_LOOKUPS:
                lookups += 1
                try:
                    paper = openalex.by_title(entry.title, entry.year)
                except openalex.RateLimited:  # out of budget: the rest without a DOI aren't looked up
                    lookups = MAX_TITLE_LOOKUPS
                except RequestException:  # this one couldn't be looked up: counted as not found
                    pass
            if not paper:
                missing.append(entry.title or entry.doi)
            elif openalex.short_id(paper["id"]) in have:
                existing += 1
            else:
                store.save(paper, entry.note, entry.tags)
                have.add(openalex.short_id(paper["id"]))
                imported += 1
    return {"total": len(entries), "imported": imported, "existing": existing, "not_found": missing}


@router.get("/export.ris", response_class=PlainTextResponse)
def export_ris(store: Store, tag: str | None = None):
    return to_ris(store.all(tag))


@router.get("/export.bib", response_class=PlainTextResponse)
def export_bibtex(store: Store, tag: str | None = None):
    return to_bibtex(store.all(tag))


@router.patch("/{bookmark_id}", response_model=Bookmark)
def update_bookmark(bookmark_id: str, item: BookmarkUpdate, store: Store):
    updated = store.update(bookmark_id, item.note, item.tags, item.status)
    if not updated:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/{bookmark_id}", status_code=204)
def delete_bookmark(bookmark_id: str, store: Store):
    if not store.delete(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
