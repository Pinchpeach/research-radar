"""Citation context: how closely each candidate is tied, through references, to the papers
that best match the query. Runs locally on the candidate set; no language model.

1. Take the TOP_K substantive candidates with the highest text relevance as the
   pseudo-relevant set (the papers most likely on topic).
2. Score every candidate by
   - bibliographic coupling: references it shares with that set, each shared reference
     counted once per set paper citing it, divided by sqrt(own reference count) so long
     reference lists don't win on size alone
   - direct links: set papers it cites, plus set papers that cite it
   and take log1p of the sum.
3. Repeat once with the set re-chosen by text and context together, so a set seeded by
   title-only stubs or near-duplicates moves to the papers the field actually cites.

Papers on the topic but worded differently from the query share references with the
matching ones, and papers that only repeat the query words (index entries, chapter
headings, news items) share none.
"""

import math
from collections import Counter

import numpy as np

TOP_K = 20
ROUNDS = 2


def _short(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def _scale(values: np.ndarray) -> np.ndarray:
    top = values.max() if values.size else 0
    return values / top if top > 0 else values


def _substantive(paper: dict) -> bool:
    return bool(paper.get("abstract")) or len(paper.get("referenced_works") or []) >= 5


def _round(papers: list[dict], ids: list[str], refs: list[set], scores: np.ndarray) -> np.ndarray:
    # rounded so near-ties order the same in the JavaScript port; ties go to the earlier paper
    keyed = [round(float(s), 9) for s in scores]
    order = sorted(range(len(papers)), key=lambda i: (-keyed[i], i))
    top = [i for i in order if keyed[i] > 0 and _substantive(papers[i])][:TOP_K]
    top_ids = {ids[i] for i in top}
    shared = Counter(ref for i in top for ref in refs[i])
    out = np.zeros(len(papers))
    for i in range(len(papers)):
        own = refs[i]
        # a set paper's own references are not shared with anyone
        coupling = sum(shared[ref] - (i in top) for ref in own) / math.sqrt(len(own)) if own else 0.0
        links = len(own & top_ids) + sum(ids[i] in refs[j] for j in top if j != i)
        out[i] = math.log1p(coupling + links)
    return out


def citation_context(papers: list[dict], relevance: np.ndarray) -> np.ndarray:
    """Context score per paper (>= 0; 0 when no candidate has references)."""
    ids = [_short(p["id"]) for p in papers]
    refs = [set(p.get("referenced_works") or []) - {ids[i]} for i, p in enumerate(papers)]
    text = _scale(np.clip(np.asarray(relevance, dtype=float), 0, None))
    scores = text
    context = np.zeros(len(papers))
    for _ in range(ROUNDS):
        context = _round(papers, ids, refs, scores)
        scores = 0.5 * text + 0.5 * _scale(context)
    return context
