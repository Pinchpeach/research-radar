import logging
import math
import time
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from requests import RequestException

from backend import annotations, history, judgments, library, pdf_proxy, security, settings, updates
from backend.paths import WEB_DIR, shared_json
from backend.version import __version__
from backend.models import (
    AnnotationDoc,
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
from backend.services import openalex, unpaywall
from backend.services.dedupe import dedupe
from backend.services.flow import build_flow, credible_foundations, outside_references
from backend.services.ranking import rank_papers, recent_since, select_results
from backend.services.techtree import render_html as render_poster
from backend.storage import BookmarkStore, to_bibtex

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

VERSION = __version__
CITING_PER_SEED = 25
CORE_REFERENCES = 25  # outside works cited by many candidates, added to the pool (some fail checks)
CORE_MIN_CITERS = 3
RECENT_FETCH_MIN = 20  # recent-only candidates fetched per search (more for larger result lists)
FRESH_YEARS = 2  # the recent-only search covers this many latest years
CORE_MIN_SHARE = 0.05
REFERENCES_PER_SEED = 50

app = FastAPI(title="Research Radar API", version=VERSION)
security.protect(app)


@lru_cache
def get_store() -> BookmarkStore:
    return BookmarkStore()


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
def health():
    return {"status": "ok", "version": VERSION}


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


def core_references(candidates: list[dict], years: dict) -> list[dict]:
    """Classic papers the candidates keep citing, even when their text doesn't match the query
    (e.g. "Semi-supervised classification with graph convolutional networks" for "graph neural
    networks"). They join the pool and compete on relevance and influence like any other."""
    min_count = max(CORE_MIN_CITERS, math.ceil(CORE_MIN_SHARE * len(candidates)))
    wanted = outside_references(candidates, min_count=min_count, limit=CORE_REFERENCES)
    if not wanted:
        return []
    try:
        fetched = openalex.papers_by_ids([ref for ref, _ in wanted], **years)
    except RequestException:
        logger.warning("Could not fetch core references", exc_info=True)
        return []
    known = {paper["id"] for paper in candidates}
    found = credible_foundations(candidates, fetched, min_count=min_count)
    return [{**paper, "core_reference": True} for paper in found if paper["id"] not in known]


def recent_candidates(request: SearchRequest) -> list[dict]:
    """A second, recent-only search, so new work is in the pool even when the relevance search
    returns mostly older papers."""
    if not request.recent_share:
        return []
    # the newest work is the most likely to be buried, so aim this search at the last two years
    since = max(request.year_from or 0, recent_since(date.today().year, min(request.recent_years, FRESH_YEARS)))
    if request.year_to and request.year_to < since:
        return []
    size = max(RECENT_FETCH_MIN, math.ceil(request.limit * request.recent_share * 3))
    return openalex.search_papers(request.query, min(size, openalex.MAX_PER_PAGE), year_from=since, year_to=request.year_to)


def merge_candidates(papers: list[dict], exclude: set[str]) -> list[dict]:
    """Unique by OpenAlex ID, then preprint / conference / journal versions merged."""
    unique: dict[str, dict] = {}
    for paper in papers:
        if paper["id"] and paper["id"] not in exclude and paper["id"] not in unique:
            unique[paper["id"]] = paper
    merged, _ = dedupe(list(unique.values()))
    return merged


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
    papers = merge_candidates(candidates, seed_ids)
    # core references come from the main search alone, so fetching recent work doesn't change
    # what counts as core
    papers += core_references(papers, years)
    papers = merge_candidates(papers + recent_candidates(request), seed_ids)
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

    ranked = rank_papers(
        request.query,
        candidates,
        seeds,
        request.weights.model_dump(),
        recent_years=request.recent_years,
    )
    since = recent_since(date.today().year, request.recent_years)
    papers = select_results(ranked, request.limit, request.recent_share, since)
    try:
        history.record(request.query)
    except OSError:
        logger.warning("Could not save the search history.", exc_info=True)
    return {
        "query": request.query,
        "count": len(papers),
        "candidates": len(candidates),
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
    updated = store.update(bookmark_id, item.note, item.tags, item.status)
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
    values = update.model_dump(exclude_unset=True)
    if values.get("library_proxy"):
        values["library_proxy"] = library.normalize_proxy(values["library_proxy"])  # e.g. a pasted example address
    settings.save(values)
    return settings.public_view()


@app.post("/settings/test-openalex")
def test_openalex_key(body: KeyTest):
    """Check a key before saving it (or the saved key when none is given)."""
    return openalex.check_key(body.api_key or None)


@app.post("/poster", response_class=HTMLResponse)
def poster(request: PosterRequest):
    """The interactive tech-tree page for a map returned by /flow."""
    return render_poster(request.flow, request.title, request.lang)


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


# ---------- PDF reader ----------


@app.get("/pdf")
def open_access_pdf(url: str):
    """An open-access PDF, fetched for the reader (publishers don't let the page fetch it)."""
    try:
        data = pdf_proxy.fetch_pdf(url)
    except pdf_proxy.Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not download the PDF") from exc
    return Response(data, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@app.get("/unpaywall")
def free_copies(doi: str):
    """Free PDF addresses Unpaywall knows for a DOI (it asks for the person's e-mail)."""
    if not library.DOI.match(doi):
        raise HTTPException(status_code=422, detail="not a DOI")
    email = settings.get("openalex_email")
    if not email:
        raise HTTPException(status_code=409, detail="Add your e-mail in Settings to look for free copies")
    try:
        return {"pdf_urls": unpaywall.pdf_links(doi, email)}
    except (RequestException, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Unpaywall did not answer") from exc


@app.get("/library/pdf")
def library_pdf(doi: str):
    """A paper's PDF through the person's library proxy, with the session they signed in to."""
    try:
        data = library.fetch(doi)
    except library.NeedsLogin as exc:
        raise HTTPException(status_code=401, detail={"message": "Sign in to your library", "login_url": exc.login_url}) from exc
    except library.NoPdf as exc:
        raise HTTPException(status_code=404, detail={"message": "No PDF link on the paper's page", "page_url": exc.page_url}) from exc
    except pdf_proxy.Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not reach the library") from exc
    return Response(data, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@app.get("/library/school")
def library_school(email: str):
    """The school an e-mail address belongs to and its library's proxy, if the app knows it."""
    return library.school_for(email)


@app.delete("/library/session", status_code=204)
def library_sign_out():
    library.clear_session()


@app.get("/annotations")
def list_annotations():
    """Documents with handwriting, most recently changed first."""
    return annotations.all_summaries()


@app.get("/annotations/{doc_id}")
def get_annotations(doc_id: str):
    try:
        doc = annotations.load(doc_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if doc is None:
        raise HTTPException(status_code=404, detail="No handwriting for this document")
    return doc


@app.put("/annotations/{doc_id}")
def put_annotations(doc_id: str, doc: AnnotationDoc):
    try:
        return annotations.save(doc_id, doc.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OverflowError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


@app.delete("/annotations/{doc_id}", status_code=204)
def delete_annotations(doc_id: str):
    try:
        found = annotations.delete(doc_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not found:
        raise HTTPException(status_code=404, detail="No handwriting for this document")


# ---------- home screen and news ----------


@app.get("/history")
def search_history(limit: int = 5):
    """Recently searched topics, newest first."""
    return history.load()[: max(0, limit)]


NEW_PAPERS_TTL = 3600  # seconds a count of new papers is reused (the home screen asks on every visit)
_new_papers_cache: dict[tuple[str, str], tuple[float, int]] = {}


@app.get("/history/new")
def new_papers(limit: int = 3):
    """For the most recent topics: papers published since the day after each was last searched.
    `new_papers` is None when OpenAlex could not be asked."""
    today = date.today()
    out = []
    for entry in history.load()[: max(0, limit)]:
        since = date.fromisoformat(entry["searched_at"][:10]) + timedelta(days=1)
        count: int | None = 0
        if since <= today:
            key = (entry["query"], since.isoformat())
            cached = _new_papers_cache.get(key)
            if cached and time.monotonic() - cached[0] < NEW_PAPERS_TTL:
                count = cached[1]
            else:
                try:
                    count = openalex.count_since(entry["query"], since.isoformat())
                    _new_papers_cache[key] = (time.monotonic(), count)
                except RequestException:  # includes rate limits: the home screen just shows no count
                    count = None
        out.append({**entry, "since": since.isoformat(), "new_papers": count})
    return out


@app.delete("/history", status_code=204)
def clear_history():
    history.clear()


@app.get("/changelog")
def changelog():
    """What changed in each version, newest first (shared/changelog.json)."""
    return shared_json("changelog.json")


@app.get("/version")
def version():
    """This app's version and, when GitHub can be reached, whether a newer release exists."""
    return updates.update_info()
