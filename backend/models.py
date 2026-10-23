from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class Weights(BaseModel):
    relevance: float = Field(default=0.35, ge=0)
    influence: float = Field(default=0.45, ge=0)  # how much the relevant literature builds on a paper
    seed: float = Field(default=0.2, ge=0)
    recency: float = Field(default=0.05, ge=0)
    impact: float = Field(default=0.15, ge=0)


class SearchRequest(BaseModel):
    query: str = Field(min_length=2)
    limit: int = Field(default=20, ge=1, le=100)
    year_from: Optional[int] = Field(default=None, ge=1800, le=2100)
    year_to: Optional[int] = Field(default=None, ge=1800, le=2100)
    seed_ids: list[str] = Field(default_factory=list, max_length=10)
    require_abstract: bool = False
    weights: Weights = Field(default_factory=Weights)
    # share of the results kept for recent research, picked by frontier score (0 = off)
    recent_share: float = Field(default=0.3, ge=0, le=0.8)
    recent_years: int = Field(default=5, ge=1, le=30)

    @model_validator(mode="after")
    def check_years(self):
        if self.year_from and self.year_to and self.year_from > self.year_to:
            raise ValueError("year_from must not be after year_to")
        return self


class Scores(BaseModel):
    relevance: float
    influence: float
    frontier: float = 0.0
    seed: float
    recency: float
    impact: float


class PaperData(BaseModel):
    """Bibliographic fields shared by search results, bookmarks and flow input."""

    id: str
    title: str = ""
    abstract: str = ""
    year: Optional[int] = None
    doi: Optional[str] = None
    url: Optional[str] = None
    open_access_url: Optional[str] = None
    venue: Optional[str] = None
    authors: list[str] = Field(default_factory=list)
    citations: int = 0
    referenced_works: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    topic: Optional[str] = None


class Paper(PaperData):
    seed_link: bool = False
    core_reference: bool = False  # found because many results cite it, not by the text search
    cited_by_results: int = 0
    builds_on_key_papers: int = 0
    group: Literal["core", "recent"] = "core"
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
    seeds: list[Seed]
    unresolved_seeds: list[str]
    papers: list[Paper]


class BookmarkIn(BaseModel):
    paper: PaperData
    note: str = ""
    tags: Optional[list[str]] = None
    query: Optional[str] = None


ReadingStatus = Literal["to_read", "reading", "read"]


class BookmarkUpdate(BaseModel):
    note: Optional[str] = None
    tags: Optional[list[str]] = None
    status: Optional[ReadingStatus] = None


class Bookmark(BaseModel):
    id: str
    paper: PaperData
    note: str
    tags: list[str]
    query: Optional[str] = None
    created_at: str
    updated_at: str
    status: ReadingStatus = "to_read"
    read_at: Optional[str] = None  # when it was marked read


class FlowRequest(BaseModel):
    papers: list[PaperData] = Field(default_factory=list, max_length=300)
    query: Optional[str] = None  # kept out of topic labels
    include_bookmarks: bool = False
    include_foundations: bool = True
    max_foundations: int = Field(default=10, ge=0, le=30)


class SettingsUpdate(BaseModel):
    """Fields left out stay as they are; an empty string removes the saved value."""

    openalex_api_key: Optional[str] = Field(default=None, max_length=200)
    openalex_email: Optional[str] = Field(default=None, max_length=200)
    language: Optional[Literal["ko", "en", ""]] = None
    reading_goal: Optional[str] = Field(default=None, pattern=r"^([1-9][0-9]{0,2})?$")  # 1-999, "" resets
    # a library proxy prefix (backend/library.py), "" removes it
    library_proxy: Optional[str] = Field(default=None, max_length=300, pattern=r"^(https?://[A-Za-z0-9.-]+(:\d+)?(/\S*)?)?$")


class KeyTest(BaseModel):
    api_key: Optional[str] = Field(default=None, max_length=200)


class AnnotationDoc(BaseModel):
    """One document's handwriting (see backend/annotations.py). Items stay free-form dicts: the
    reader owns their shape, and draws them only as SVG attributes and text."""

    title: str = Field(default="", max_length=500)
    paper_id: Optional[str] = Field(default=None, max_length=100)
    source: Optional[str] = Field(default=None, max_length=2000)  # where the PDF came from
    page_count: int = Field(default=0, ge=0, le=10000)
    last_page: int = Field(default=1, ge=1, le=10000)
    pages: dict[str, list[dict]] = Field(default_factory=dict)  # PDF page number -> items
    notes: list[list[dict]] = Field(default_factory=list, max_length=500)  # blank note pages


class PosterRequest(BaseModel):
    flow: dict
    title: str = Field(default="My Research", max_length=300)
    lang: Literal["ko", "en"] = "ko"


Judgment = Literal["relevant", "partial", "not_relevant"]


class JudgedPaper(BaseModel):
    id: str
    title: str = ""
    score: Optional[float] = None


class EvaluationRun(BaseModel):
    """Relevance judgments for one search, in the order the results were shown."""

    run_id: str = Field(min_length=1, max_length=100)
    query: str = Field(min_length=1, max_length=500)
    settings: dict = Field(default_factory=dict)
    papers: list[JudgedPaper] = Field(max_length=200)
    judgments: dict[str, Judgment]
