import math
from datetime import date

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

RECENCY_HALF_LIFE_YEARS = 5
DEFAULT_WEIGHTS = {"relevance": 0.6, "seed": 0.2, "recency": 0.1, "impact": 0.1}


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


def rank_papers(
    query: str,
    papers: list[dict],
    seeds: list[dict] | None = None,
    weights: dict | None = None,
    current_year: int | None = None,
    semantic: np.ndarray | None = None,
) -> list[dict]:
    """Score and sort candidates.

    Every component is in [0, 1]:
    - relevance: TF-IDF cosine to the query, scaled so the best candidate is 1; averaged with
      `semantic` (embedding similarity per paper) when it is given
    - seed: 1 for papers that cite or are cited by a seed, otherwise text similarity to the
      closest seed, scaled to the best candidate
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

    total_weight = sum(weights.values()) or 1.0
    combined = (
        weights["relevance"] * relevance
        + weights["seed"] * seed_scores
        + weights["recency"] * recency
        + weights["impact"] * impact
    ) / total_weight

    ranked = []
    for index, paper in enumerate(papers):
        item = {key: value for key, value in paper.items() if key != "referenced_works"}
        item.update(
            score=round(float(combined[index]) * 100, 1),
            relevance_score=round(float(tfidf[index]) * 100, 1),
            seed_link=links[index],
            scores={
                "relevance": round(float(relevance[index]), 3),
                "seed": round(float(seed_scores[index]), 3),
                "recency": round(float(recency[index]), 3),
                "impact": round(float(impact[index]), 3),
            },
        )
        ranked.append(item)

    return sorted(ranked, key=lambda paper: (paper["score"], paper["relevance_score"]), reverse=True)
