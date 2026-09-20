from fastapi import FastAPI, HTTPException
from requests import RequestException

from backend.models import SearchRequest
from backend.services.openalex import search_papers
from backend.services.ranking import rank_papers


app = FastAPI(title="Research Radar API", version="0.1.0")


@app.get("/")
def root():
    return {"service": "Research Radar", "version": "0.1.0"}


@app.post("/search")
def search(request: SearchRequest):
    try:
        papers = search_papers(request.query, request.limit)
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="OpenAlex request failed") from exc

    ranked = rank_papers(request.query, papers)
    return {"query": request.query, "count": len(ranked), "papers": ranked}
