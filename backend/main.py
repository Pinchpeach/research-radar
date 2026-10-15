import logging
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from requests import RequestException

from backend.models import SearchRequest, SearchResponse
from backend.services import embeddings, openalex
from backend.services.ranking import paper_text, rank_papers

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

VERSION = "0.2.0"
CITING_PER_SEED = 25
REFERENCES_PER_SEED = 50

app = FastAPI(title="Research Radar API", version=VERSION)


@app.get("/")
def root():
    return {"service": "Research Radar", "version": VERSION}


@app.get("/health")
def health():
    return {"status": "ok", "version": VERSION, "semantic": embeddings.enabled()}


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
