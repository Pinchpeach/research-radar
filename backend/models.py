from typing import Optional

from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    query: str = Field(min_length=2)
    limit: int = Field(default=20, ge=1, le=100)


class Paper(BaseModel):
    id: str
    title: str
    abstract: str
    year: Optional[int] = None
    doi: Optional[str] = None
    authors: list[str]
    citations: int
    relevance_score: float
