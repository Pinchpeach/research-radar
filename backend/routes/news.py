"""The home screen's news: recent searches and followed authors and journals, with how many
papers came out since the person last looked."""

import time
from datetime import date, timedelta
from functools import partial

from fastapi import APIRouter, HTTPException
from requests import RequestException

from backend import follows, history
from backend.models import FollowIn
from backend.services import openalex

router = APIRouter(tags=["news"])

NEW_PAPERS_TTL = 3600  # seconds an answer is reused (the home screen asks on every visit)
_cache: dict[tuple, tuple[float, object]] = {}


def cached(key: tuple, ask):
    """ask(), or its answer from the last hour."""
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < NEW_PAPERS_TTL:
        return hit[1]
    value = ask()
    _cache[key] = (time.monotonic(), value)
    return value


@router.get("/history")
def search_history(limit: int = 5):
    """Recently searched topics, newest first."""
    return history.load()[: max(0, limit)]


@router.delete("/history", status_code=204)
def clear_history():
    history.clear()


@router.get("/history/new")
def new_papers(limit: int = 3):
    """For the most recent topics: papers published since the day after each was last searched.
    `new_papers` is None when OpenAlex could not be asked."""
    today = date.today()
    out = []
    for entry in history.load()[: max(0, limit)]:
        since = (date.fromisoformat(entry["searched_at"][:10]) + timedelta(days=1)).isoformat()
        count: int | None = 0
        if since <= today.isoformat():
            try:
                count = cached((entry["query"], since), partial(openalex.count_since, entry["query"], since))
            except RequestException:  # includes rate limits: the home screen just shows no count
                count = None
        out.append({**entry, "since": since, "new_papers": count})
    return out


@router.get("/follows")
def list_follows():
    return follows.load()


@router.put("/follows")
def add_follow(item: FollowIn):
    try:
        return follows.add(item.kind, item.id, item.name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OverflowError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/follows/{kind}/{follow_id}", status_code=204)
def remove_follow(kind: str, follow_id: str):
    if not follows.remove(kind, follow_id):
        raise HTTPException(status_code=404, detail="Not followed")


@router.post("/follows/{kind}/{follow_id}/seen")
def follow_seen(kind: str, follow_id: str):
    item = follows.seen(kind, follow_id)
    if not item:
        raise HTTPException(status_code=404, detail="Not followed")
    return item


@router.get("/follows/new")
def followed_new_papers():
    """For each followed author or journal: papers published since the person last looked
    (`count` None when OpenAlex could not be asked). Cached like /history/new."""
    today, out = date.today().isoformat(), []
    for item in follows.load():
        count, papers = 0, []
        if item["since"] <= today:
            # `since` is in the key, so marking a follow as seen asks again
            key = ("follow", item["kind"], item["id"], item["since"])
            try:
                count, papers = cached(key, partial(openalex.published_by, item["kind"], item["id"], item["since"]))
            except RequestException:
                count = None
        out.append({**item, "count": count, "papers": papers})
    return out
