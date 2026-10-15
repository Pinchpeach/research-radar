"""Merge records that are the same paper.

OpenAlex often keeps a preprint, a conference version and the journal article as separate
works. They share a title, so they would show up twice in results and split the citation
links between them. We treat works with the same normalized title published within
YEAR_WINDOW years of each other as one paper.
"""

import re
import unicodedata

YEAR_WINDOW = 2


def short_id(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def title_key(title: str) -> str:
    text = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _strength(paper: dict) -> tuple:
    """Which record of a duplicate group to keep: most cited, then most complete."""
    return (
        paper.get("citations") or 0,
        len(paper.get("referenced_works") or []),
        len(paper.get("abstract") or ""),
        bool(paper.get("doi")),
    )


def dedupe(papers: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Return (unique papers in original order, {duplicate short id: kept short id}).

    The kept record gains the union of the group's reference lists and any missing
    abstract, DOI, venue or year.
    """
    groups: list[list[dict]] = []
    by_key: dict[str, list[list[dict]]] = {}
    for paper in papers:
        key = title_key(paper.get("title", ""))
        if len(key) < 12:  # too short to identify a paper ("Introduction", "Erratum")
            groups.append([paper])
            continue
        for group in by_key.setdefault(key, []):
            years = [p.get("year") for p in group if p.get("year")]
            year = paper.get("year")
            if not year or not years or min(abs(year - y) for y in years) <= YEAR_WINDOW:
                group.append(paper)
                break
        else:
            group = [paper]
            by_key[key].append(group)
            groups.append(group)

    unique, alias = [], {}
    for group in groups:
        keep = max(group, key=_strength)
        if len(group) > 1:
            keep = dict(keep)
            refs = list(dict.fromkeys(ref for p in group for ref in p.get("referenced_works") or []))
            keep["referenced_works"] = refs
            for field in ("abstract", "doi", "venue", "url"):
                if not keep.get(field):
                    keep[field] = next((p[field] for p in group if p.get(field)), keep.get(field))
            if not keep.get("year"):
                keep["year"] = min((p["year"] for p in group if p.get("year")), default=None)
            for p in group:
                if p is not keep and p["id"] != keep["id"]:
                    alias[short_id(p["id"])] = short_id(keep["id"])
        unique.append(keep)

    if alias:
        # citations of a duplicate now point at the kept record
        remapped = []
        for paper in unique:
            own = short_id(paper["id"])
            refs = (alias.get(ref, ref) for ref in paper.get("referenced_works") or [])
            remapped.append({**paper, "referenced_works": list(dict.fromkeys(r for r in refs if r != own))})
        unique = remapped
    return unique, alias
