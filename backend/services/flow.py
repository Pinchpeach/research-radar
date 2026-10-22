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

from backend.paths import shared_json
from backend.services.dedupe import dedupe
from backend.services.ranking import paper_text, plausible_citation  # noqa: F401 - re-exported

MAX_CLUSTERS = 6
WORDS = shared_json("words.json")  # shared with the Android app
# Words common in abstracts that say nothing about a topic.
GENERIC_WORDS = set(WORDS["generic_words"])
# Words that add nothing to a topic name on their own.
NAME_FILLER = set(WORDS["name_filler"])
TOPIC_WEIGHT = 0.8
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
    # ties broken by ID, so the same works are picked every run
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [(ref, count) for ref, count in ranked if count >= min_count][:limit]



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


def title_case(phrase: str) -> str:
    small = {"and", "or", "of", "in", "on", "for", "the", "a", "an", "to", "via", "with"}
    words = phrase.split()
    return " ".join(
        w if (w.isupper() and len(w) > 1) or any(c.isupper() for c in w[1:])  # keep GNN, X-ray, k-NN as written
        else (w if i and w.lower() in small else w[:1].upper() + w[1:])
        for i, w in enumerate(words)
    )


def _words(phrase: str) -> set[str]:
    return {_stem(w) for w in re.findall(r"[a-z0-9]+", phrase.lower())}


TRAILING_FILLER = re.compile(
    r"\s+(?:and\s+)?(?:research|studies|techniques|applications|methods|analysis)$", re.IGNORECASE
)
MAX_NAME_CHARS = 44


def tidy_phrase(phrase: str) -> str:
    """'Pulsars and Gravitational Waves Research' -> 'Pulsars and Gravitational Waves'."""
    phrase = " ".join(phrase.split())
    return TRAILING_FILLER.sub("", phrase) or phrase


def name_clusters(
    papers: list[dict], assignment: list[int], fallback: list[str], query: str | None = None
) -> list[str]:
    """Readable topic names from OpenAlex keywords and topics.

    1. Lift: phrases that papers in the cluster carry more often than papers in the whole map,
       covering at least two papers (or 15% of a large cluster). The best one names the
       cluster; a second keyword is added when it says something new and the name stays short,
       e.g. "Drug Discovery & Molecular Generation".
    2. Otherwise the cluster's most common phrase that no other cluster uses.
    3. Otherwise the word-statistics label.
    Phrases that only repeat the search query ("Advanced Graph Neural Networks" for "graph
    neural networks") are skipped, and each phrase names one cluster only.
    """
    query_set = _words(query or "")
    filler = {_stem(w) for w in NAME_FILLER}
    n_total = len(papers)
    k = max(assignment) + 1 if assignment else 0
    sizes = Counter(assignment)

    display: dict[str, str] = {}  # lowercase key -> phrase as OpenAlex writes it (keeps "CRISPR")
    topic_keys: set[str] = set()

    def phrases(paper: dict) -> set[str]:
        out = set()
        for raw, is_topic in [(kw, False) for kw in paper.get("keywords") or []] + [(paper.get("topic"), True)]:
            if not raw:
                continue
            shown = tidy_phrase(raw)
            key = shown.lower()
            if _words(key) <= query_set | filler:
                continue
            display.setdefault(key, shown)
            if is_topic:
                topic_keys.add(key)
            out.add(key)
        return out

    per_paper = [phrases(paper) for paper in papers]
    overall = Counter(ph for phs in per_paper for ph in phs)
    per_cluster = [Counter() for _ in range(k)]
    for phs, c in zip(per_paper, assignment):
        per_cluster[c].update(phs)

    def support(c: int) -> int:
        return min(sizes[c], max(2, math.ceil(0.15 * sizes[c])))

    candidates = []  # (score, cluster, phrase)
    for c in range(k):
        for ph, count in per_cluster[c].items():
            if count < support(c):
                continue
            lift = count / sizes[c] - overall[ph] / n_total
            if lift > 0:
                # OpenAlex topics are broad; on a tie a specific keyword names the cluster better
                weight = TOPIC_WEIGHT if ph in topic_keys else 1.0
                candidates.append((weight * lift * math.sqrt(count), c, ph))

    chosen: dict[int, list[str]] = {c: [] for c in range(k)}
    used: list[set[str]] = []

    def free(ph: str) -> bool:
        words = _words(ph)
        return not any(words <= u or u <= words for u in used)

    def take(c: int, ph: str) -> None:
        chosen[c].append(ph)
        used.append(_words(ph))

    ranked = sorted(candidates, key=lambda t: (-t[0], t[2]))
    for _, c, ph in ranked:  # first name for every cluster that has one
        if not chosen[c] and free(ph):
            take(c, ph)
    for _, c, ph in ranked:  # optional second keyword
        if len(chosen[c]) != 1 or ph in topic_keys or not free(ph):
            continue
        first = chosen[c][0]
        if _words(ph) & _words(first) or len(display[first]) + 3 + len(display[ph]) > MAX_NAME_CHARS:
            continue
        take(c, ph)
    for c in range(k):  # fallback: the cluster's most common phrase nobody else uses
        if chosen[c]:
            continue
        for ph, count in per_cluster[c].most_common():
            if count >= min(2, sizes[c]) and free(ph):
                take(c, ph)
                break

    names = []
    for c in range(k):
        if chosen[c]:
            names.append(" & ".join(title_case(display[ph]) for ph in chosen[c]))
        else:
            label = fallback[c] if c < len(fallback) else f"topic {c + 1}"
            names.append(title_case(label.replace(", ", " · ")))
    return names


def cluster_papers(papers: list[dict], query: str | None = None) -> tuple[list[int], list[str]]:
    """Return a cluster index per paper and a short label per cluster."""
    texts = [" ".join([paper_text(paper), *(paper.get("keywords") or [])]) for paper in papers]
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
        # by position, so ties go to the older paper whatever order the edges came in
        for cited in sorted(cites[nid], key=position.__getitem__):
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
    assignment, word_labels = cluster_papers(all_papers, query)
    labels = name_clusters(all_papers, assignment, word_labels, query)

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
            "open_access_url": paper.get("open_access_url"),
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
