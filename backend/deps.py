"""What the routes share: the bookmark store and turning OpenAlex failures into HTTP errors."""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException
from requests import RequestException

from backend import settings
from backend.services import openalex
from backend.storage import BookmarkStore


@lru_cache
def get_store() -> BookmarkStore:
    return BookmarkStore()


Store = Annotated[BookmarkStore, Depends(get_store)]


def rate_limit_detail(exc: openalex.RateLimited) -> str:
    hours = f" Try again in about {exc.retry_after // 3600 + 1} h." if exc.retry_after else ""
    if settings.get("openalex_api_key"):
        return f"OpenAlex rate limit reached for your API key.{hours}"
    return (
        "OpenAlex's shared free budget for this network is used up. Add your free OpenAlex API key "
        f"in Settings (or set OPENALEX_API_KEY) to use your own budget.{hours}"
    )


@contextmanager
def asking_openalex() -> Iterator[None]:
    """A rate limit becomes 429 with what to do about it; any other failure, 502."""
    try:
        yield
    except openalex.RateLimited as exc:
        raise HTTPException(status_code=429, detail=rate_limit_detail(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="OpenAlex request failed") from exc
