"""Optional semantic similarity using OpenAI embeddings.

Enabled when an OpenAI key is configured (settings or OPENAI_API_KEY) and RADAR_EMBEDDINGS is
not "off". Any failure
returns None so ranking falls back to the TF-IDF baseline.
"""

import logging
import os

import numpy as np

from backend import settings

logger = logging.getLogger(__name__)

MAX_CHARS = 8000


def enabled() -> bool:
    return bool(settings.get("openai_api_key")) and os.getenv("RADAR_EMBEDDINGS", "on").lower() != "off"


def _embed(texts: list[str]) -> np.ndarray:
    from openai import OpenAI

    client = OpenAI(api_key=settings.get("openai_api_key"))
    model = os.getenv("RADAR_EMBEDDING_MODEL", "text-embedding-3-small")
    response = client.embeddings.create(model=model, input=[text[:MAX_CHARS] or " " for text in texts])
    vectors = np.array([item.embedding for item in response.data], dtype=float)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.where(norms == 0, 1, norms)


def similarities(query: str, documents: list[str]) -> np.ndarray | None:
    """Cosine similarity of each document to the query, or None when unavailable."""
    if not enabled() or not documents:
        return None
    try:
        vectors = _embed([query, *documents])
    except Exception:  # network, auth, quota, missing package
        logger.warning("Embedding request failed; using TF-IDF only.", exc_info=True)
        return None
    return vectors[1:] @ vectors[0]
