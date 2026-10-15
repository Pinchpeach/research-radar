"""Turn a set of papers into a research-flow map.

The map has three layers:
- citation edges between papers in the set (citing -> cited)
- topic clusters (TF-IDF + k-means), each labeled by its top terms
- per-cluster storyline: origin, hub, and frontier papers, plus the longest citation chain
"""

import math
from collections import Counter

import re

import numpy as np
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer

from backend.services.dedupe import dedupe
from backend.services.ranking import paper_text

MAX_CLUSTERS = 6
# Words common in abstracts that say nothing about a topic.
GENERIC_WORDS = {
    "able", "achieve", "achieves", "albeit", "also", "analysis", "approach", "approaches", "based",
    "demonstrate", "demonstrated", "effective", "identified", "identify", "introduce", "introduced",
    "novel", "reviewed", "reviews", "different", "discuss", "discussed", "find", "findings",
    "found", "give", "given", "gives", "however", "method", "methods", "new", "number", "obtain",
    "obtained", "paper", "possible", "present", "presented", "presents", "propose", "proposed",
    "recent", "recently", "report", "reported", "result", "results", "review", "show", "shown",
    "shows", "studied", "studies", "study", "use", "used", "using", "various", "work",
}
# At least 3 characters, starting with a letter; hyphenated terms such as "x-ray" stay whole.
TOKEN_PATTERN = r"(?u)\b[^\W\d_][\w-]+[^\W_]\b"


def short_id(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def outside_references(papers: list[dict], min_count: int = 2, limit: int = 10) -> list[tuple[str, int]]:
    """Works cited by at least `min_count` papers in the set but not in the set themselves."""
    in_set = {short_id(paper["id"]) for paper in papers}
    counts = Counter(
        ref for paper in papers for ref in set(paper.get("referenced_works") or []) if ref not in in_set
    )
    return [(ref, count) for ref, count in counts.most_common() if count >= min_count][:limit]


def plausible_citation(citing_year: int | None, cited_year: int | None) -> bool:
    """A paper can't cite one published later. Allow a year of slack for preprints vs. journals;
    anything beyond that is an error in the citation data."""
    return not citing_year or not cited_year or cited_year <= citing_year + 1


def credible_foundations(papers: list[dict], foundations: list[dict], min_count: int = 2) -> list[dict]:
    """Recount who cites each foundational work, ignoring impossible citations, and keep the
    ones still cited by at least `min_count` papers. Sets `cited_by_in_set`."""
    kept = []
    for work in foundations:
        wid = short_id(work["id"])
        citers = [
            p for p in papers
            if wid in (p.get("referenced_works") or []) and plausible_citation(p.get("year"), work.get("year"))
        ]
        if len(citers) >= min_count:
            kept.append({**work, "cited_by_in_set": len(citers)})
    return kept


def cluster_count(n: int) -> int:
    if n < 4:
        return 1
    return max(2, min(MAX_CLUSTERS, round(math.sqrt(n / 2))))


def query_words(query: str | None) -> set[str]:
    """Words of the search query, singular and plural: every topic shares them, so they can't label one."""
    words = set()
    for word in re.findall(r"[a-z][a-z-]+", (query or "").lower()):
        words |= {word, word.rstrip("s"), word.rstrip("s") + "s"}
    return words - {""}


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def label_terms(scores: np.ndarray, terms: np.ndarray, size: int = 3) -> list[str]:
    """Top distinct terms; a phrase replaces the single words it contains."""
    picked: list[str] = []
    for index in scores.argsort()[::-1][:40]:
        if scores[index] <= 0:
            break
        term = terms[index]
        words = {_stem(w) for w in term.split()}
        covered = [p for p in picked if {_stem(w) for w in p.split()} <= words]
        others = [p for p in picked if p not in covered]
        if any(words & {_stem(w) for w in p.split()} for p in others):
            continue  # shares a word with another picked term; adds little
        if covered:
            at = picked.index(covered[0])
            picked = [p for p in picked if p not in covered]
            picked.insert(at, term)
        else:
            picked.append(term)
    return picked[:size]


def cluster_papers(papers: list[dict], query: str | None = None) -> tuple[list[int], list[str]]:
    """Return a cluster index per paper and a short label per cluster."""
    texts = [paper_text(paper) for paper in papers]
    k = cluster_count(len(papers))
    vectorizer = TfidfVectorizer(
        stop_words=list(ENGLISH_STOP_WORDS | GENERIC_WORDS | query_words(query)),
        ngram_range=(1, 2),
        sublinear_tf=True,
        max_df=0.9,
        token_pattern=TOKEN_PATTERN,
    )
    try:
        matrix = vectorizer.fit_transform(texts)
    except ValueError:  # empty vocabulary (no usable text)
        return [0] * len(papers), ["all papers"]

    terms = np.array(vectorizer.get_feature_names_out())
    k = min(k, matrix.shape[0], len(terms))
    overall = np.asarray(matrix.mean(axis=0)).ravel()
    if k <= 1:
        return [0] * len(papers), [", ".join(label_terms(overall, terms)) or "all papers"]

    model = KMeans(n_clusters=k, n_init=10, random_state=0).fit(matrix)
    # label by what sets a topic apart from the whole map, not just what is frequent in it
    labels = [", ".join(label_terms(centroid - overall, terms)) or f"topic {i + 1}"
              for i, centroid in enumerate(model.cluster_centers_)]
    return [int(label) for label in model.labels_], labels


def longest_chain(nodes: dict[str, dict], edges: list[tuple[str, str]]) -> list[str]:
    """Longest citation chain, oldest paper first. Edges go citing -> cited."""
    order = sorted(nodes, key=lambda nid: (nodes[nid]["year"] or 0, nid))
    position = {nid: i for i, nid in enumerate(order)}
    cites: dict[str, list[str]] = {nid: [] for nid in nodes}
    for citing, cited in edges:
        # keep edges pointing back in time so the graph is acyclic
        if position[cited] < position[citing]:
            cites[citing].append(cited)

    best: dict[str, int] = {}
    prev: dict[str, str | None] = {}
    for nid in order:
        best[nid], prev[nid] = 1, None
        for cited in cites[nid]:
            if best[cited] + 1 > best[nid]:
                best[nid], prev[nid] = best[cited] + 1, cited
    if not best:
        return []
    end = max(order, key=lambda nid: (best[nid], nodes[nid]["citations"]))
    chain = []
    while end:
        chain.append(end)
        end = prev[end]
    return chain[::-1] if len(chain) > 1 else []


def build_flow(
    papers: list[dict],
    bookmarked: set[str] | None = None,
    foundations: list[dict] | None = None,
    query: str | None = None,
) -> dict:
    """Build the flow map. `foundations` are outside works (with a `cited_by_in_set` count).

    Duplicate records of one paper are merged first; `query` keeps the search words out of
    topic labels.
    """
    bookmarked = bookmarked or set()
    tagged = [{**p, "role": "result"} for p in papers] + [{**p, "role": "foundation"} for p in foundations or []]
    merged, alias = dedupe(tagged)
    bookmarked = {alias.get(b, b) for b in bookmarked}

    unique: dict[str, dict] = {}
    for paper in merged:
        unique.setdefault(short_id(paper["id"]), paper)
    if not unique:
        return {"nodes": [], "edges": [], "clusters": [], "chain": []}

    ids = list(unique)
    all_papers = [unique[nid] for nid in ids]
    assignment, labels = cluster_papers(all_papers, query)

    edges = []
    for nid in ids:
        for ref in set(unique[nid].get("referenced_works") or []):
            if ref in unique and ref != nid and plausible_citation(unique[nid].get("year"), unique[ref].get("year")):
                edges.append((nid, ref))
    cited_in_set = Counter(cited for _, cited in edges)

    nodes = {}
    for nid, cluster in zip(ids, assignment):
        paper = unique[nid]
        nodes[nid] = {
            "id": nid,
            "title": paper.get("title") or "",
            "year": paper.get("year"),
            "citations": paper.get("citations") or 0,
            "authors": (paper.get("authors") or [])[:3],
            "url": paper.get("url") or paper.get("doi"),
            "cluster": cluster,
            "role": paper["role"],
            "bookmarked": nid in bookmarked,
            "cited_in_set": cited_in_set[nid],
            "cited_by_in_set": paper.get("cited_by_in_set", cited_in_set[nid]),
        }

    clusters = []
    for index, label in enumerate(labels):
        members = [nodes[nid] for nid in ids if nodes[nid]["cluster"] == index]
        if not members:
            continue
        dated = [m for m in members if m["year"]] or members
        origin = min(dated, key=lambda m: (m["year"] or 9999, -m["citations"]))
        hub = max(members, key=lambda m: (m["cited_in_set"], m["citations"]))
        frontier = sorted(dated, key=lambda m: (m["year"] or 0, m["citations"]), reverse=True)[:3]
        years = [m["year"] for m in members if m["year"]]
        clusters.append(
            {
                "index": index,
                "label": label,
                "size": len(members),
                "year_min": min(years) if years else None,
                "year_max": max(years) if years else None,
                "year_median": int(np.median(years)) if years else None,
                "origin": origin["id"],
                "hub": hub["id"],
                "frontier": [m["id"] for m in frontier],
            }
        )
    # lanes ordered by when each topic emerged
    clusters.sort(key=lambda c: (c["year_median"] or 9999, c["index"]))
    lane = {c["index"]: position for position, c in enumerate(clusters)}
    for node in nodes.values():
        node["lane"] = lane[node["cluster"]]
    for c in clusters:
        c["lane"] = lane[c["index"]]

    cross = Counter(
        (nodes[citing]["lane"], nodes[cited]["lane"])
        for citing, cited in edges
        if nodes[citing]["lane"] != nodes[cited]["lane"]
    )

    return {
        "nodes": list(nodes.values()),
        "edges": [{"source": citing, "target": cited} for citing, cited in edges],
        "clusters": clusters,
        "cluster_links": [
            {"from_lane": cited_lane, "to_lane": citing_lane, "count": count}
            for (citing_lane, cited_lane), count in cross.most_common()
        ],
        "chain": longest_chain(nodes, edges),
    }
