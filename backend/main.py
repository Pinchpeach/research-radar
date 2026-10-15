import logging
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from requests import RequestException

from backend.models import (
    Bookmark,
    BookmarkIn,
    BookmarkUpdate,
    FlowRequest,
    SearchRequest,
    SearchResponse,
)
from backend.services import embeddings, openalex
from backend.services.flow import build_flow, outside_references, short_id
from backend.services.ranking import paper_text, rank_papers
from backend.storage import BookmarkStore, to_bibtex

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

VERSION = "0.3.0"
CITING_PER_SEED = 25
REFERENCES_PER_SEED = 50

app = FastAPI(title="Research Radar API", version=VERSION)


@lru_cache
def get_store() -> BookmarkStore:
    return BookmarkStore()


@app.get("/")
def root():
    return {"service": "Research Radar", "version": VERSION}


@app.get("/health")
def health():
    return {"status": "ok", "version": VERSION, "semantic": embeddings.enabled()}


def rate_limit_detail(exc: "openalex.RateLimited") -> str:
    hours = f" Try again in about {exc.retry_after // 3600 + 1} h." if exc.retry_after else ""
    if os.getenv("OPENALEX_API_KEY"):
        return f"OpenAlex rate limit reached for your API key.{hours}"
    return (
        "OpenAlex's shared free budget for this network is used up. Set OPENALEX_API_KEY "
        f"(free at https://openalex.org) to use your own budget.{hours}"
    )


def candidate_pool_size(limit: int) -> int:
    return min(openalex.MAX_PER_PAGE, max(50, limit * 3))


def gather_candidates(request: SearchRequest, seeds: list[dict]) -> list[dict]:
    years = {"year_from": request.year_from, "year_to": request.year_to}
    candidates = openalex.search_papers(request.query, candidate_pool_size(request.limit), **years)

    for seed in seeds:
        try:
            candidates.extend(openalex.citing_papers(seed["id"], CITING_PER_SEED, **years))
            refs = seed.get("referenced_works", [])[:REFERENCES_PER_SEED]
            if refs:
                candidates.extend(openalex.papers_by_ids(refs, **years))
        except RequestException:
            logger.warning("Could not expand seed %s", seed["id"], exc_info=True)

    seed_ids = {seed["id"] for seed in seeds}
    unique: dict[str, dict] = {}
    for paper in candidates:
        if paper["id"] and paper["id"] not in seed_ids and paper["id"] not in unique:
            unique[paper["id"]] = paper

    papers = list(unique.values())
    if request.require_abstract:
        papers = [paper for paper in papers if paper["abstract"]]
    return papers


@app.post("/search", response_model=SearchResponse)
def search(request: SearchRequest):
    try:
        seeds, unresolved = [], []
        for identifier in request.seed_ids:
            seed = openalex.get_work(identifier)
            if seed:
                seeds.append(seed)
            else:
                unresolved.append(identifier)
        candidates = gather_candidates(request, seeds)
    except openalex.RateLimited as exc:
        raise HTTPException(status_code=429, detail=rate_limit_detail(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="OpenAlex request failed") from exc

    semantic = embeddings.similarities(request.query, [paper_text(p) for p in candidates])
    ranked = rank_papers(
        request.query, candidates, seeds, request.weights.model_dump(), semantic=semantic
    )
    papers = ranked[: request.limit]
    return {
        "query": request.query,
        "count": len(papers),
        "candidates": len(candidates),
        "semantic": semantic is not None,
        "seeds": [{"id": s["id"], "title": s["title"], "year": s["year"]} for s in seeds],
        "unresolved_seeds": unresolved,
        "papers": papers,
    }


# ---------- bookmarks ----------


@app.get("/bookmarks", response_model=list[Bookmark])
def list_bookmarks(tag: str | None = None, store: BookmarkStore = Depends(get_store)):
    return store.all(tag)


@app.put("/bookmarks", response_model=Bookmark)
def save_bookmark(item: BookmarkIn, store: BookmarkStore = Depends(get_store)):
    return store.save(item.paper.model_dump(), item.note, item.tags, item.query)


@app.get("/bookmarks/export.bib", response_class=PlainTextResponse)
def export_bibtex(tag: str | None = None, store: BookmarkStore = Depends(get_store)):
    return to_bibtex(store.all(tag))


@app.patch("/bookmarks/{bookmark_id}", response_model=Bookmark)
def update_bookmark(bookmark_id: str, item: BookmarkUpdate, store: BookmarkStore = Depends(get_store)):
    updated = store.update(bookmark_id, item.note, item.tags)
    if not updated:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@app.delete("/bookmarks/{bookmark_id}", status_code=204)
def delete_bookmark(bookmark_id: str, store: BookmarkStore = Depends(get_store)):
    if not store.delete(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")


# ---------- research flow ----------


@app.post("/flow")
def research_flow(request: FlowRequest, store: BookmarkStore = Depends(get_store)):
    papers = [paper.model_dump() for paper in request.papers]
    if request.include_bookmarks:
        papers.extend(bookmark["paper"] for bookmark in store.all())
    if not papers:
        raise HTTPException(status_code=400, detail="No papers to map. Search or bookmark papers first.")

    foundations = []
    if request.include_foundations and request.max_foundations:
        wanted = outside_references(papers, limit=request.max_foundations)
        if wanted:
            counts = dict(wanted)
            try:
                foundations = openalex.papers_by_ids([ref for ref, _ in wanted])
            except RequestException:
                logger.warning("Could not fetch foundational works", exc_info=True)
            for paper in foundations:
                paper["cited_by_in_set"] = counts.get(short_id(paper["id"]), 0)

    return build_flow(papers, bookmarked=store.ids(), foundations=foundations)
