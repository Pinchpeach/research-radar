import os
import re

import requests

OPENALEX_URL = "https://api.openalex.org/works"
MAX_PER_PAGE = 200
TIMEOUT = 20

_session = requests.Session()


def reconstruct_abstract(inverted_index: dict | None) -> str:
    if not inverted_index:
        return ""

    words: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        for position in positions:
            words.append((position, word))

    words.sort(key=lambda item: item[0])
    return " ".join(word for _, word in words)


def short_id(openalex_id: str) -> str:
    return openalex_id.rstrip("/").rsplit("/", 1)[-1]


def normalize_work(work: dict) -> dict:
    authors = [
        authorship.get("author", {}).get("display_name")
        for authorship in work.get("authorships", [])
        if authorship.get("author", {}).get("display_name")
    ]
    location = work.get("primary_location") or {}
    source = location.get("source") or {}

    return {
        "id": work.get("id") or "",
        "title": work.get("title") or work.get("display_name") or "",
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "year": work.get("publication_year"),
        "doi": work.get("doi"),
        "url": location.get("landing_page_url") or work.get("doi") or work.get("id"),
        "venue": source.get("display_name"),
        "authors": authors,
        "citations": work.get("cited_by_count", 0) or 0,
        "referenced_works": [short_id(ref) for ref in work.get("referenced_works") or []],
        # OpenAlex's own phrases for what the paper is about; used to name research topics
        "keywords": [k["display_name"] for k in work.get("keywords") or [] if k.get("display_name")],
        "topic": ((work.get("primary_topic") or {}).get("display_name")),
    }


class RateLimited(requests.HTTPError):
    """OpenAlex refused the request because the (key or shared-IP) budget is used up."""

    def __init__(self, message: str, retry_after: int | None, response: requests.Response):
        super().__init__(message, response=response)
        self.retry_after = retry_after


def _params(**params) -> dict:
    email = os.getenv("OPENALEX_EMAIL")
    if email:
        params["mailto"] = email
    return params


def _headers() -> dict:
    # Requests without a key share a small daily budget per IP address; a free key has its own.
    key = os.getenv("OPENALEX_API_KEY")
    return {"Authorization": f"Bearer {key}"} if key else {}


def _get(url: str, params: dict) -> dict:
    response = _session.get(url, params=params, headers=_headers(), timeout=TIMEOUT)
    if response.status_code == 429:
        try:
            message = response.json().get("message", "")
        except ValueError:
            message = ""
        retry = response.headers.get("retry-after")
        raise RateLimited(
            message or "OpenAlex rate limit reached.",
            int(retry) if retry and retry.isdigit() else None,
            response,
        )
    response.raise_for_status()
    return response.json()


def year_filter(year_from: int | None, year_to: int | None) -> list[str]:
    filters = []
    if year_from:
        filters.append(f"from_publication_date:{year_from}-01-01")
    if year_to:
        filters.append(f"to_publication_date:{year_to}-12-31")
    return filters


def _list(filters: list[str], limit: int, **extra) -> list[dict]:
    params = _params(**{"per-page": min(limit, MAX_PER_PAGE)}, **extra)
    if filters:
        params["filter"] = ",".join(filters)
    data = _get(OPENALEX_URL, params)
    return [normalize_work(work) for work in data.get("results", [])]


def search_papers(
    query: str,
    limit: int = 20,
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[dict]:
    return _list(year_filter(year_from, year_to), limit, search=query)


def citing_papers(
    work_id: str,
    limit: int = 25,
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[dict]:
    filters = [f"cites:{short_id(work_id)}", *year_filter(year_from, year_to)]
    return _list(filters, limit, sort="cited_by_count:desc")


def papers_by_ids(
    work_ids: list[str],
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[dict]:
    papers = []
    ids = [short_id(work_id) for work_id in work_ids]
    # OpenAlex accepts up to 100 OR-ed values per filter.
    for start in range(0, len(ids), 50):
        chunk = ids[start : start + 50]
        filters = [f"ids.openalex:{'|'.join(chunk)}", *year_filter(year_from, year_to)]
        papers.extend(_list(filters, len(chunk)))
    return papers


_DOI = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)?(10\.\d{4,9}/\S+)$", re.IGNORECASE)
_OPENALEX = re.compile(r"^(?:https?://openalex\.org/)?(W\d+)$", re.IGNORECASE)


def work_path(identifier: str) -> str | None:
    """Turn a DOI or OpenAlex work ID/URL into an OpenAlex /works path segment."""
    identifier = identifier.strip()
    if match := _OPENALEX.match(identifier):
        return match.group(1).upper()
    if match := _DOI.match(identifier):
        return f"doi:{match.group(1)}"
    return None


def get_work(identifier: str) -> dict | None:
    """Fetch one work by DOI or OpenAlex ID. Returns None if it is unknown or malformed."""
    path = work_path(identifier)
    if not path:
        return None
    try:
        return normalize_work(_get(f"{OPENALEX_URL}/{path}", _params()))
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return None
        raise
