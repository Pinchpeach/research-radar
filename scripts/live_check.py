"""Run the whole pipeline against live OpenAlex and report what comes back.

Search → seeds → ranking → research flow (with foundational works) → tech-tree poster.
Nothing is mocked: this is the end-to-end check with real papers.

Usage:
    python -m scripts.live_check "optical observations of isolated neutron stars"
    python -m scripts.live_check "graph neural networks" --limit 40 --seed 10.48550/arXiv.1609.02907
Writes the poster to data/live-map.html (or --out).
"""

import argparse
import time
from collections import Counter
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

from backend import main
from backend.services import openalex
from backend.services.techtree import layout, render_html


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  [{'ok' if ok else '!!'}] {label}" + (f" — {detail}" if detail else ""))
    return ok


def main_cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("query")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--seed", action="append", default=[], help="DOI or OpenAlex ID (repeatable)")
    parser.add_argument("--year-from", type=int)
    parser.add_argument("--year-to", type=int)
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "live-map.html")
    args = parser.parse_args()

    client = TestClient(main.app)
    print(f"Query: {args.query!r}  limit={args.limit}  seeds={args.seed or '—'}")

    started = time.time()
    try:
        openalex.search_papers(args.query, 1)
    except openalex.RateLimited as exc:
        print(f"OpenAlex rate limit: {exc}")
        print("Set OPENALEX_API_KEY (free at https://openalex.org) and run this again.")
        return 2
    except Exception as exc:  # noqa: BLE001 - report any connectivity problem plainly
        print(f"Cannot reach OpenAlex ({exc.__class__.__name__}: {exc}).")
        print("Allow api.openalex.org in the network settings, then run this again.")
        return 2

    res = client.post(
        "/search",
        json={
            "query": args.query,
            "limit": args.limit,
            "seed_ids": args.seed,
            "year_from": args.year_from,
            "year_to": args.year_to,
        },
    )
    if res.status_code != 200:
        print(f"/search failed: {res.status_code} {res.text[:300]}")
        return 1
    body = res.json()
    papers = body["papers"]
    search_s = time.time() - started

    print(f"\nSearch ({search_s:.1f}s): {body['count']} shown of {body['candidates']} candidates, "
          f"semantic={body['semantic']}")
    for i, p in enumerate(papers[:10], 1):
        print(f"  {i:>2}. {p['score']:5.1f}  {p['year'] or '----'}  {p['citations']:>6} cites  {p['title'][:90]}")
    if body["seeds"] or body["unresolved_seeds"]:
        print(f"  seeds resolved: {[s['title'][:50] for s in body['seeds']]}  unresolved: {body['unresolved_seeds']}")

    started = time.time()
    flow_res = client.post("/flow", json={"papers": papers, "query": args.query, "include_foundations": True})
    if flow_res.status_code != 200:
        print(f"/flow failed: {flow_res.status_code} {flow_res.text[:300]}")
        return 1
    flow = flow_res.json()
    flow_s = time.time() - started

    nodes = {n["id"]: n for n in flow["nodes"]}
    roles = Counter(n["role"] for n in flow["nodes"])
    lanes = {c["lane"]: c for c in flow["clusters"]}
    print(f"\nFlow ({flow_s:.1f}s): {len(nodes)} papers ({dict(roles)}), {len(flow['edges'])} citation links, "
          f"{len(flow['clusters'])} topics")
    for c in sorted(flow["clusters"], key=lambda c: c["lane"]):
        hub = nodes[c["hub"]]
        print(f"  lane {c['lane']}: {c['label']!r}  {c['size']} papers {c['year_min']}–{c['year_max']}  "
              f"hub: {hub['title'][:60]} ({hub['year']})")
    for link in flow["cluster_links"][:6]:
        print(f"  {lanes[link['from_lane']]['label']!r} → {lanes[link['to_lane']]['label']!r}: {link['count']}")
    chain = [nodes[i] for i in flow["chain"]]
    if chain:
        print("  key lineage: " + " → ".join(f"{n['year']} {n['title'][:35]}" for n in chain))
    for n in sorted((n for n in flow["nodes"] if n["role"] == "foundation"), key=lambda n: -n["cited_by_in_set"])[:5]:
        print(f"  foundation: {n['title'][:70]} ({n['year']}), cited by {n['cited_by_in_set']} results")

    lay = layout(flow)
    parents = {lane["lane"]: lane["parent"] for lane in lay["lanes"]}
    page = render_html(flow, args.query)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(page, encoding="utf-8")

    print("\nChecks")
    with_refs = sum(1 for p in papers if p["referenced_works"])
    with_abs = sum(1 for p in papers if p["abstract"])
    results = [
        check("search returned papers", bool(papers), f"{len(papers)}"),
        check("abstracts available for ranking", with_abs >= len(papers) // 2, f"{with_abs}/{len(papers)}"),
        check("reference lists present", with_refs >= len(papers) // 2, f"{with_refs}/{len(papers)}"),
        check("citation links found inside the map", len(flow["edges"]) > 0, f"{len(flow['edges'])}"),
        check("foundational works added", roles.get("foundation", 0) > 0, f"{roles.get('foundation', 0)}"),
        check("more than one topic", len(flow["clusters"]) > 1, f"{len(flow['clusters'])}"),
        check("every dated paper drawn", len(lay["nodes"]) == sum(1 for n in flow["nodes"] if n["year"])),
        check("topic branching found", any(p is not None for p in parents.values()),
              ", ".join(f"{k}←{v}" for k, v in parents.items() if v is not None) or "none"),
    ]
    print(f"\nPoster: {args.out}  ({len(page) // 1024} KB, {lay['width']:.0f}×{lay['height']:.0f})")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main_cli())
