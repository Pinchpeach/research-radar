import logging
import sys
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from requests import RequestException

from backend import judgments, settings
from backend.models import (
    Bookmark,
    BookmarkIn,
    BookmarkUpdate,
    EvaluationRun,
    FlowRequest,
    KeyTest,
    PosterRequest,
    SearchRequest,
    SearchResponse,
    SettingsUpdate,
)
from backend.services import embeddings, openalex
from backend.services.dedupe import dedupe
from backend.services.flow import build_flow, credible_foundations, outside_references
from backend.services.ranking import paper_text, rank_papers
from backend.services.techtree import render_html as render_poster
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


# Files bundled with the app: next to the code, or unpacked by PyInstaller into sys._MEIPASS.
APP_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB_DIR = APP_DIR / "frontend" / "web"
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
def health():
    return {"status": "ok", "version": VERSION, "semantic": embeddings.enabled()}


def rate_limit_detail(exc: "openalex.RateLimited") -> str:
    hours = f" Try again in about {exc.retry_after // 3600 + 1} h." if exc.retry_after else ""
    if settings.get("openalex_api_key"):
        return f"OpenAlex rate limit reached for your API key.{hours}"
    return (
        "OpenAlex's shared free budget for this network is used up. Add your free OpenAlex API key "
        f"in Settings (or set OPENALEX_API_KEY) to use your own budget.{hours}"
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

    papers, _ = dedupe(list(unique.values()))  # preprint + journal versions count once
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
            try:
                fetched = openalex.papers_by_ids([ref for ref, _ in wanted])
            except RequestException:
                logger.warning("Could not fetch foundational works", exc_info=True)
            else:
                # drops works "cited" by papers older than themselves (bad citation data)
                foundations = credible_foundations(papers, fetched)

    return build_flow(papers, bookmarked=store.ids(), foundations=foundations, query=request.query)


# ---------- settings ----------


@app.get("/settings")
def read_settings():
    return settings.public_view()


@app.put("/settings")
def update_settings(update: SettingsUpdate):
    settings.save(update.model_dump(exclude_unset=True))
    return settings.public_view()


@app.post("/settings/test-openalex")
def test_openalex_key(body: KeyTest):
    """Check a key before saving it (or the saved key when none is given)."""
    return openalex.check_key(body.api_key or None)


@app.post("/poster", response_class=HTMLResponse)
def poster(request: PosterRequest):
    """The interactive tech-tree page for a map returned by /flow."""
    return render_poster(request.flow, request.title)


# ---------- ranking evaluation ----------


@app.post("/evaluations")
def save_evaluation(run: EvaluationRun):
    """Save relevance judgments for one search run."""
    if not run.judgments:
        raise HTTPException(status_code=400, detail="No judgments to save.")
    written = judgments.save_run(run.model_dump(), run.judgments)
    return {"written": written}


@app.get("/evaluations")
def list_evaluations():
    """Precision@10/20 and nDCG@20 per saved run, newest first."""
    return judgments.summarize(judgments.load_rows())


@app.delete("/evaluations/{run_id}", status_code=204)
def delete_evaluation(run_id: str):
    if not judgments.delete_run(run_id):
        raise HTTPException(status_code=404, detail="Evaluation run not found")
