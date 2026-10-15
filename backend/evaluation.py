"""Offline metrics for relevance judgments collected in the prototype UI."""

import math

GAIN = {"relevant": 2, "partial": 1, "not_relevant": 0}


def precision_at_k(judgments: list[str | None], k: int) -> float | None:
    """Share of the top-k judged results that are relevant or partially relevant."""
    judged = [j for j in judgments[:k] if j]
    if not judged:
        return None
    return sum(GAIN[j] > 0 for j in judged) / len(judged)


def ndcg_at_k(judgments: list[str | None], k: int) -> float | None:
    """nDCG over the top-k, using graded gains; unjudged results count as 0."""
    gains = [GAIN.get(j, 0) if j else 0 for j in judgments[:k]]
    if not any(j for j in judgments[:k]):
        return None
    dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted((GAIN[j] for j in judgments if j), reverse=True)[:k]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0
