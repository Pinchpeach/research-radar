"""Check GitHub Releases for a newer version of the app.

Best effort: any failure (offline, rate limit, private repository) just means no update
notice. The answer is cached so the app asks GitHub at most every few hours.
"""

import logging
import re
import time

import requests

from backend.version import RELEASES_REPO, __version__

logger = logging.getLogger(__name__)

CACHE_SECONDS = 6 * 3600
TIMEOUT = 4

_cache: dict = {"at": 0.0, "latest": None}


def parse_version(text: str) -> tuple[int, ...] | None:
    """'v0.10.2' -> (0, 10, 2). Pre-releases ('0.5.0-rc1') and anything else -> None."""
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (text or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None


def latest_release() -> dict | None:
    """{'version', 'url', 'published_at'} of the latest published release, or None."""
    now = time.time()
    if now - _cache["at"] < CACHE_SECONDS:
        return _cache["latest"]
    latest = None
    try:
        response = requests.get(
            f"https://api.github.com/repos/{RELEASES_REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json"},
            timeout=TIMEOUT,
        )
        if response.status_code == 200:
            data = response.json()
            latest = {
                "version": data.get("tag_name", "").lstrip("v"),
                "url": data.get("html_url"),
                "published_at": data.get("published_at"),
            }
    except (requests.RequestException, ValueError):
        logger.info("Update check failed", exc_info=True)
    _cache.update(at=now, latest=latest)
    return latest


def update_info() -> dict:
    latest = latest_release()
    current = parse_version(__version__)
    newer = bool(latest and current and (parse_version(latest["version"]) or (0,)) > current)
    return {"version": __version__, "latest": latest, "update_available": newer}
