"""Searching, opening a paper from a link, and the research flow map."""

import logging
from datetime import date

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from requests import RequestException

from backend import history
from backend.deps import Store, asking_openalex
from backend.models import FlowRequest, PaperData, PosterRequest, SearchRequest, SearchResponse
from backend.services import candidates, openalex
from backend.services.flow import build_flow, credible_foundations, outside_references
from backend.services.ranking import rank_papers, recent_since, select_results
from backend.services.techtree import render_html as render_poster

logger = logging.getLogger(__name__)
router = APIRouter(tags=["search"])

PROFILE_SIZE = 100  # bookmarks that count toward the personal score


@router.get("/works/lookup", response_model=PaperData)
def lookup_work(id: str):
    """One paper by DOI or OpenAlex ID: a paper opened from a link (a DOI pasted or shared)."""
    with asking_openalex():
        work = openalex.get_work(id)
    if not work:
        raise HTTPException(status_code=404, detail="OpenAlex doesn't know this paper")
    return work


@router.post("/search", response_model=SearchResponse)
def search(request: SearchRequest, store: Store):
    with asking_openalex():
        seeds, unresolved = [], []
        for identifier in request.seed_ids:
            seed = openalex.get_work(identifier)
            if seed:
                seeds.append(seed)
            else:
                unresolved.append(identifier)
        pool = candidates.gather(request, seeds)

    ranked = rank_papers(
        request.query,
        pool,
        seeds,
        request.weights.model_dump(),
        recent_years=request.recent_years,
        # the person's bookmarks, newest first: what they keep says what they're after
        profile=[bookmark["paper"] for bookmark in store.all()[:PROFILE_SIZE]],
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
        "candidates": len(pool),
        "seeds": [{"id": s["id"], "title": s["title"], "year": s["year"]} for s in seeds],
        "unresolved_seeds": unresolved,
        "papers": papers,
    }


@router.post("/flow")
def research_flow(request: FlowRequest, store: Store):
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


@router.post("/poster", response_class=HTMLResponse)
def poster(request: PosterRequest):
    """The interactive tech-tree page for a map returned by /flow."""
    return render_poster(request.flow, request.title, request.lang)
