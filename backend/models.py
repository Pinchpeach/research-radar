from typing import Optional

from pydantic import BaseModel, Field, model_validator


class Weights(BaseModel):
    relevance: float = Field(default=0.6, ge=0)
    seed: float = Field(default=0.2, ge=0)
    recency: float = Field(default=0.1, ge=0)
    impact: float = Field(default=0.1, ge=0)


class SearchRequest(BaseModel):
    query: str = Field(min_length=2)
    limit: int = Field(default=20, ge=1, le=100)
    year_from: Optional[int] = Field(default=None, ge=1800, le=2100)
    year_to: Optional[int] = Field(default=None, ge=1800, le=2100)
    seed_ids: list[str] = Field(default_factory=list, max_length=10)
    require_abstract: bool = False
    weights: Weights = Field(default_factory=Weights)

    @model_validator(mode="after")
    def check_years(self):
        if self.year_from and self.year_to and self.year_from > self.year_to:
            raise ValueError("year_from must not be after year_to")
        return self


class Scores(BaseModel):
    relevance: float
    seed: float
    recency: float
    impact: float


class Paper(BaseModel):
    id: str
    title: str
    abstract: str
    year: Optional[int] = None
    doi: Optional[str] = None
    url: Optional[str] = None
    venue: Optional[str] = None
    authors: list[str]
    citations: int
    seed_link: bool = False
    score: float
    relevance_score: float
    scores: Scores


class Seed(BaseModel):
    id: str
    title: str
    year: Optional[int] = None


class SearchResponse(BaseModel):
    query: str
    count: int
    candidates: int
    semantic: bool
    seeds: list[Seed]
    unresolved_seeds: list[str]
    papers: list[Paper]
