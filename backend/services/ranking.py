import math
from datetime import date

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

RECENCY_HALF_LIFE_YEARS = 5
DEFAULT_WEIGHTS = {"relevance": 0.35, "influence": 0.45, "seed": 0.2, "recency": 0.05, "impact": 0.15}


def paper_text(paper: dict) -> str:
    return f"{paper.get('title', '')} {paper.get('abstract', '')}".strip()


def scale_to_max(values: np.ndarray) -> np.ndarray:
    """Scale non-negative scores so the best candidate gets 1.0."""
    values = np.clip(np.asarray(values, dtype=float), 0, None)
    top = values.max() if values.size else 0
    return values / top if top > 0 else values


def recency_score(year: int | None, current_year: int) -> float:
    if not year:
        return 0.0
    age = max(0, current_year - year)
    return 0.5 ** (age / RECENCY_HALF_LIFE_YEARS)


def impact_values(papers: list[dict], current_year: int) -> np.ndarray:
    """Citations per year since publication, log-damped."""
    values = []
    for paper in papers:
        age = max(1, current_year - (paper.get("year") or current_year) + 1)
        values.append(math.log1p((paper.get("citations") or 0) / age))
    return np.array(values)


def plausible_citation(citing_year: int | None, cited_year: int | None) -> bool:
    """A paper can't cite one published later. Allow a year of slack for preprints vs. journals;
    anything beyond that is an error in the citation data."""
    return not citing_year or not cited_year or cited_year <= citing_year + 1


def _short(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def citation_counts_within(papers: list[dict]) -> np.ndarray:
    """How many papers in the set cite each paper (ignoring impossible citations)."""
    index = {_short(p["id"]): i for i, p in enumerate(papers)}
    counts = np.zeros(len(papers))
    for paper in papers:
        own = _short(paper["id"])
        for ref in set(paper.get("referenced_works") or []):
            j = index.get(ref)
            if j is not None and ref != own and plausible_citation(paper.get("year"), papers[j].get("year")):
                counts[j] += 1
    return counts


def citation_influence(papers: list[dict], start: np.ndarray, damping: float = 0.85, iterations: int = 60) -> np.ndarray:
    """Personalized PageRank over the citation graph of the candidates.

    A reader starts at papers in proportion to `start` (their relevance) and keeps following
    references. Papers the relevant literature keeps building on collect the most weight:
    the core papers for understanding how the field developed.
    """
    n = len(papers)
    if n == 0:
        return np.zeros(0)
    index = {_short(p["id"]): i for i, p in enumerate(papers)}
    out: list[list[int]] = []
    for i, paper in enumerate(papers):
        refs = {index[r] for r in paper.get("referenced_works") or [] if r in index}
        out.append([j for j in refs if j != i and plausible_citation(paper.get("year"), papers[j].get("year"))])
    teleport = np.clip(np.asarray(start, dtype=float), 0, None) + 1e-9
    teleport /= teleport.sum()
    rank = teleport.copy()
    via_citations = np.zeros(n)
    for _ in range(iterations):
        via_citations = np.zeros(n)
        dangling = 0.0
        for i, targets in enumerate(out):
            if targets:
                via_citations[targets] += damping * rank[i] / len(targets)
            else:
                dangling += damping * rank[i]
        rank = via_citations + ((1 - damping) + dangling) * teleport
    # Return only what arrives along citation links: the restart share (and the share returned
    # by papers citing nothing in the set) is spread by relevance and would just repeat it.
    return via_citations


def recent_since(current_year: int, recent_years: int) -> int:
    """First publication year that counts as recent: the last `recent_years` years, inclusive."""
    return current_year - recent_years + 1


def frontier_scores(
    papers: list[dict], relevance: np.ndarray, influence: np.ndarray, current_year: int, since: int
) -> tuple[np.ndarray, np.ndarray]:
    """How promising each *recent* paper is as the current front of the field (0 for older ones).

    Recent work has not had time to be cited, so it can't show influence. Instead:
    - relevance to the query (0.4)
    - building on the field's key papers: the influence of the papers it cites (0.25)
    - freshness within the recent window, so this year's work isn't buried under papers that
      merely had longer to collect citations (0.2)
    - citation momentum: citations per year, compared among recent papers only (0.15)
    Also returns how many key papers (influence >= 0.5) each paper cites.
    """
    n = len(papers)
    index = {_short(p["id"]): i for i, p in enumerate(papers)}
    builds_on = np.zeros(n)
    key_cited = np.zeros(n, dtype=int)
    for i, paper in enumerate(papers):
        for ref in set(paper.get("referenced_works") or []):
            j = index.get(ref)
            if j is None or j == i or not plausible_citation(paper.get("year"), papers[j].get("year")):
                continue
            builds_on[i] += influence[j]
            key_cited[i] += influence[j] >= 0.5
    recent = np.array([(p.get("year") or 0) >= since for p in papers])
    if not recent.any():
        return np.zeros(n), key_cited
    momentum = np.zeros(n)
    momentum[recent] = scale_to_max(impact_values([p for p, r in zip(papers, recent) if r], current_year))
    builds = np.zeros(n)
    builds[recent] = scale_to_max(np.sqrt(builds_on[recent]))
    window = max(1, current_year - since + 1)
    freshness = np.array([((p.get("year") or since) - since + 1) / window for p in papers]).clip(0, 1)
    frontier = 0.4 * relevance + 0.25 * builds + 0.2 * freshness + 0.15 * momentum
    return np.where(recent, frontier, 0.0), key_cited


def substantive(paper: dict) -> bool:
    """Skip stub records (index entries, chapter headings) that have neither an abstract nor
    a real reference list; recent ones have no citations yet to vouch for them."""
    return bool(paper.get("abstract")) or len(paper.get("referenced_works") or []) >= 5


def select_results(ranked: list[dict], limit: int, recent_share: float, since: int) -> list[dict]:
    """The best `limit` results by score (group "core"), followed by a "recent" group of
    `recent_share` × `limit` more: the best recent papers by frontier score that are not
    already in the core group.

    The recent group comes on top of the core results, so key papers are never pushed out,
    and it always shows new work: recent papers that already rank in the core group (often
    well-cited surveys) do not use up its slots.
    """
    core = ranked[:limit]
    taken = {p["id"] for p in core}
    needed = round(limit * recent_share)
    recent_pool = sorted(
        (p for p in ranked if (p.get("year") or 0) >= since and p["id"] not in taken and substantive(p)),
        key=lambda p: (p["scores"]["frontier"], p["score"]),
        reverse=True,
    )
    return [{**p, "group": "core"} for p in core] + [{**p, "group": "recent"} for p in recent_pool[:needed]]


def rank_papers(
    query: str,
    papers: list[dict],
    seeds: list[dict] | None = None,
    weights: dict | None = None,
    current_year: int | None = None,
    semantic: np.ndarray | None = None,
    recent_years: int = 5,
) -> list[dict]:
    """Score and sort candidates.

    Every component is in [0, 1]:
    - relevance: TF-IDF cosine to the query, scaled so the best candidate is 1; averaged with
      `semantic` (embedding similarity per paper) when it is given
    - seed: 1 for papers that cite or are cited by a seed, otherwise text similarity to the
      closest seed, scaled to the best candidate
    - influence: how much the relevant candidates build on the paper (personalized PageRank
      over their citations), damped for papers whose topic is unrelated; scaled to the best
    - recency: halves every RECENCY_HALF_LIFE_YEARS
    - impact: log citations per year, scaled to the best candidate
    The final score is the weighted mean × 100. It ranks candidates; it is not a probability.
    """
    if not papers:
        return []

    seeds = seeds or []
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    if not seeds:
        weights["seed"] = 0
    current_year = current_year or date.today().year

    texts = [paper_text(paper) for paper in papers]
    seed_texts = [paper_text(seed) for seed in seeds]

    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True)
    vectors = vectorizer.fit_transform([query, *texts, *seed_texts])
    query_vec = vectors[0]
    paper_vecs = vectors[1 : 1 + len(papers)]
    seed_vecs = vectors[1 + len(papers) :]

    tfidf = cosine_similarity(query_vec, paper_vecs)[0]
    relevance = scale_to_max(tfidf)
    if semantic is not None:
        relevance = 0.5 * relevance + 0.5 * scale_to_max(semantic)

    seed_scores = np.zeros(len(papers))
    links = [False] * len(papers)
    if seeds:
        seed_ids = {seed["id"].rsplit("/", 1)[-1] for seed in seeds}
        cited_by_seeds = {ref for seed in seeds for ref in seed.get("referenced_works", [])}
        seed_scores = scale_to_max(cosine_similarity(paper_vecs, seed_vecs).max(axis=1))
        for index, paper in enumerate(papers):
            pid = paper["id"].rsplit("/", 1)[-1]
            if pid in cited_by_seeds or seed_ids & set(paper.get("referenced_works", [])):
                links[index] = True
                seed_scores[index] = 1.0

    recency = np.array([recency_score(paper.get("year"), current_year) for paper in papers])
    impact = scale_to_max(impact_values(papers, current_year))
    # sqrt spreads PageRank's long tail; the relevance gate keeps generic method papers
    # (cited by everyone, about something else) from taking over
    influence = np.sqrt(scale_to_max(citation_influence(papers, relevance))) * (0.3 + 0.7 * relevance)
    influence = scale_to_max(influence)
    cited_within = citation_counts_within(papers)
    frontier, key_cited = frontier_scores(
        papers, relevance, influence, current_year, recent_since(current_year, recent_years)
    )

    total_weight = sum(weights.values()) or 1.0
    combined = (
        weights["relevance"] * relevance
        + weights["seed"] * seed_scores
        + weights["influence"] * influence
        + weights["recency"] * recency
        + weights["impact"] * impact
    ) / total_weight

    ranked = []
    for index, paper in enumerate(papers):
        item = dict(paper)
        item.update(
            score=round(float(combined[index]) * 100, 1),
            relevance_score=round(float(tfidf[index]) * 100, 1),
            seed_link=links[index],
            cited_by_results=int(cited_within[index]),
            builds_on_key_papers=int(key_cited[index]),
            scores={
                "relevance": round(float(relevance[index]), 3),
                "influence": round(float(influence[index]), 3),
                "seed": round(float(seed_scores[index]), 3),
                "recency": round(float(recency[index]), 3),
                "impact": round(float(impact[index]), 3),
                "frontier": round(float(frontier[index]), 3),
            },
        )
        ranked.append(item)

    return sorted(ranked, key=lambda paper: (paper["score"], paper["relevance_score"]), reverse=True)
