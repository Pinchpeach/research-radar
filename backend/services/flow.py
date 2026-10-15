"""Turn a set of papers into a research-flow map.

The map has three layers:
- citation edges between papers in the set (citing -> cited)
- topic clusters (TF-IDF + k-means), each labeled by its top terms
- per-cluster storyline: origin, hub, and frontier papers, plus the longest citation chain
"""

import math
from collections import Counter

import numpy as np
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer

from backend.services.ranking import paper_text

MAX_CLUSTERS = 6


def short_id(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def outside_references(papers: list[dict], min_count: int = 2, limit: int = 10) -> list[tuple[str, int]]:
    """Works cited by at least `min_count` papers in the set but not in the set themselves."""
    in_set = {short_id(paper["id"]) for paper in papers}
    counts = Counter(
        ref for paper in papers for ref in set(paper.get("referenced_works") or []) if ref not in in_set
    )
    return [(ref, count) for ref, count in counts.most_common() if count >= min_count][:limit]


def cluster_count(n: int) -> int:
    if n < 4:
        return 1
    return max(2, min(MAX_CLUSTERS, round(math.sqrt(n / 2))))


def cluster_papers(papers: list[dict]) -> tuple[list[int], list[str]]:
    """Return a cluster index per paper and a short label per cluster."""
    texts = [paper_text(paper) for paper in papers]
    k = cluster_count(len(papers))
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True, max_df=0.9, min_df=1)
    try:
        matrix = vectorizer.fit_transform(texts)
    except ValueError:  # empty vocabulary (no usable text)
        return [0] * len(papers), ["all papers"]

    terms = np.array(vectorizer.get_feature_names_out())
    k = min(k, matrix.shape[0], len(terms))
    if k <= 1:
        top = np.asarray(matrix.mean(axis=0)).ravel().argsort()[::-1][:3]
        return [0] * len(papers), [", ".join(terms[top])]

    model = KMeans(n_clusters=k, n_init=10, random_state=0).fit(matrix)
    labels = []
    for centroid in model.cluster_centers_:
        top = centroid.argsort()[::-1]
        picked: list[str] = []
        for index in top[:30]:
            term = terms[index]
            words = set(term.split())
            covered = [p for p in picked if set(p.split()) <= words]
            others = [p for p in picked if p not in covered]
            if any(words & set(p.split()) for p in others):
                continue  # shares a word with another picked term; adds little
            if covered:
                # prefer the phrase over the single words it contains, keeping their rank
                at = picked.index(covered[0])
                picked = [p for p in picked if p not in covered]
                picked.insert(at, term)
            else:
                picked.append(term)
        labels.append(", ".join(picked[:3]))
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


def build_flow(papers: list[dict], bookmarked: set[str] | None = None, foundations: list[dict] | None = None) -> dict:
    """Build the flow map. `foundations` are outside works (with a `cited_by_in_set` count)."""
    bookmarked = bookmarked or set()
    foundations = foundations or []

    unique: dict[str, dict] = {}
    for paper in papers:
        unique.setdefault(short_id(paper["id"]), {**paper, "role": "result"})
    for paper in foundations:
        unique.setdefault(short_id(paper["id"]), {**paper, "role": "foundation"})
    if not unique:
        return {"nodes": [], "edges": [], "clusters": [], "chain": []}

    ids = list(unique)
    all_papers = [unique[nid] for nid in ids]
    assignment, labels = cluster_papers(all_papers)

    edges = []
    for nid in ids:
        for ref in set(unique[nid].get("referenced_works") or []):
            if ref in unique and ref != nid:
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
