"""The pool of papers a search ranks: the relevance search, the seeds' citing and cited works,
classics the pool keeps citing, and a recent-only search so new work isn't buried."""

import logging
import math
from datetime import date

from requests import RequestException

from backend.models import SearchRequest
from backend.services import openalex
from backend.services.dedupe import dedupe
from backend.services.flow import credible_foundations, outside_references
from backend.services.ranking import recent_since

logger = logging.getLogger(__name__)

CITING_PER_SEED = 25
CORE_REFERENCES = 25  # outside works cited by many candidates, added to the pool (some fail checks)
CORE_MIN_CITERS = 3
RECENT_FETCH_MIN = 20  # recent-only candidates fetched per search (more for larger result lists)
FRESH_YEARS = 2  # the recent-only search covers this many latest years
CORE_MIN_SHARE = 0.05
REFERENCES_PER_SEED = 50


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


def gather(request: SearchRequest, seeds: list[dict]) -> list[dict]:
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
