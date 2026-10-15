import os
import sys
from datetime import datetime
from pathlib import Path

import requests
import streamlit as st
import streamlit.components.v1 as components

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
sys.path.insert(0, str(ROOT))

from backend.evaluation import ndcg_at_k, precision_at_k  # noqa: E402
from backend.judgments import save_run  # noqa: E402
from flow_chart import build_figure, lineage_rows  # noqa: E402
from techtree import layout as tech_tree_layout  # noqa: E402
from techtree import render_html as render_tech_tree  # noqa: E402

API_URL = os.getenv("RADAR_API_URL", "http://localhost:8000")
JUDGMENTS = {"—": None, "Relevant": "relevant", "Partial": "partial", "Not relevant": "not_relevant"}
PAPER_FIELDS = ("id", "title", "abstract", "year", "doi", "url", "venue", "authors", "citations", "referenced_works")
MAX_SEEDS = 10

st.set_page_config(page_title="Research Radar", page_icon="📡", layout="wide")
state = st.session_state
state.setdefault("run", None)
state.setdefault("flow", None)


# ---------- API helpers ----------


class ApiError(Exception):
    pass


def api(method: str, path: str, **kwargs):
    try:
        response = requests.request(method, f"{API_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = exc
        if exc.response is not None:
            try:
                detail = exc.response.json().get("detail", exc)
            except ValueError:
                pass
        raise ApiError(str(detail)) from exc
    if response.status_code == 204:
        return None
    return response.json() if "json" in response.headers.get("content-type", "") else response.text


def short_id(paper_id: str) -> str:
    return paper_id.rstrip("/").rsplit("/", 1)[-1]


def load_bookmarks() -> list[dict]:
    try:
        return api("GET", "/bookmarks")
    except ApiError as exc:
        st.error(f"Could not load bookmarks: {exc}")
        return []


def toggle_bookmark(paper: dict, query: str | None, bookmarked: bool) -> None:
    try:
        if bookmarked:
            api("DELETE", f"/bookmarks/{short_id(paper['id'])}")
        else:
            data = {key: paper.get(key) for key in PAPER_FIELDS}
            api("PUT", "/bookmarks", json={"paper": data, "query": query})
    except ApiError as exc:
        st.toast(f"Bookmark failed: {exc}")


def author_line(authors: list[str]) -> str:
    return (", ".join(authors[:5]) + (" et al." if len(authors) > 5 else "")) or "Authors unavailable"


def meta_line(paper: dict) -> str:
    parts = [str(paper.get("year") or "—"), paper.get("venue") or "", f"{paper.get('citations', 0)} citations"]
    return " · ".join(part for part in parts if part)


def title_md(paper: dict, level: str = "###") -> str:
    link = paper.get("url") or paper.get("doi")
    return f"{level} [{paper['title']}]({link})" if link else f"{level} {paper['title']}"


bookmarks = load_bookmarks()
bookmarked_ids = {b["id"] for b in bookmarks}

st.title("Research Radar")
st.caption("Discover papers for your research topic, keep the ones that matter, and see how the field developed.")

# ---------- sidebar: search settings ----------

with st.sidebar:
    st.header("Search settings")
    limit = st.slider("Results", 5, 100, 20, step=5)

    use_years = st.checkbox("Filter by publication year")
    year_from = year_to = None
    if use_years:
        this_year = datetime.now().year
        year_from, year_to = st.slider("Years", 1950, this_year, (this_year - 15, this_year))

    seeds_text = st.text_area(
        "Seed papers (optional)",
        placeholder="One DOI or OpenAlex ID per line\n10.1086/345493\nW2058532123",
        help="Papers you already know are relevant. Radar adds papers that cite them or that "
        "they cite, and boosts results similar to them.",
    )
    use_bookmark_seeds = st.checkbox(
        f"Use my bookmarks as seeds (latest {MAX_SEEDS})",
        disabled=not bookmarks,
        help="Find papers connected to the ones you saved.",
    )
    require_abstract = st.checkbox("Only papers with an abstract")

    with st.expander("Ranking weights"):
        weights = {
            "relevance": st.slider("Topic relevance", 0.0, 1.0, 0.6, 0.05),
            "seed": st.slider("Seed similarity / links", 0.0, 1.0, 0.2, 0.05),
            "recency": st.slider("Recency", 0.0, 1.0, 0.1, 0.05),
            "impact": st.slider("Citation impact", 0.0, 1.0, 0.1, 0.05),
        }

discover_tab, bookmarks_tab, flow_tab = st.tabs(
    ["🔎 Discover", f"★ Bookmarks ({len(bookmarks)})", "🧭 Research flow"]
)

# ---------- 1. discover ----------

with discover_tab:
    query = st.text_input(
        "What are you researching?",
        value="Optical observations of isolated neutron stars",
    )

    if st.button("Scan Research", type="primary"):
        if not query.strip():
            st.warning("Enter a research topic first.")
        else:
            seed_ids = [line.strip() for line in seeds_text.splitlines() if line.strip()]
            if use_bookmark_seeds:
                seed_ids += [b["id"] for b in bookmarks if b["id"] not in seed_ids]
            payload = {
                "query": query.strip(),
                "limit": limit,
                "year_from": year_from,
                "year_to": year_to,
                "seed_ids": seed_ids[:MAX_SEEDS],
                "require_abstract": require_abstract,
                "weights": weights,
            }
            try:
                with st.spinner("Scanning papers..."):
                    body = api("POST", "/search", json=payload, timeout=90)
            except ApiError as exc:
                st.error(f"Search failed: {exc}")
            else:
                settings = {k: v for k, v in payload.items() if k != "query"}
                state.run = {
                    "run_id": datetime.now().strftime("%Y%m%d-%H%M%S"),
                    "settings": settings,
                    **body,
                }

    run = state.run
    if run:
        papers = run["papers"]
        info = f"{run['count']} papers shown from {run['candidates']} candidates"
        info += " · semantic ranking on" if run["semantic"] else " · TF-IDF ranking"
        st.success(info)
        if run["seeds"]:
            st.caption("Seeds: " + "; ".join(f"{s['title']} ({s['year'] or '—'})" for s in run["seeds"]))
        if run["unresolved_seeds"]:
            st.warning("Could not resolve seeds: " + ", ".join(run["unresolved_seeds"]))

        def judge_key(paper: dict) -> str:
            return f"judge-{run['run_id']}-{paper['id']}"

        # Radio values are already updated in session state when the script reruns.
        judgments = {paper["id"]: JUDGMENTS[state.get(judge_key(paper), "—")] for paper in papers}
        judged = list(judgments.values())

        with st.expander("Evaluate this ranking", expanded=any(judged)):
            st.caption("Mark results below as Relevant / Partial / Not relevant to measure ranking quality.")
            cols = st.columns(4)
            cols[0].metric("Judged", f"{sum(j is not None for j in judged)} / {len(papers)}")
            for col, (label, value) in zip(
                cols[1:],
                [
                    ("Precision@10", precision_at_k(judged, 10)),
                    ("Precision@20", precision_at_k(judged, 20)),
                    ("nDCG@20", ndcg_at_k(judged, 20)),
                ],
            ):
                col.metric(label, "—" if value is None else f"{value:.2f}")
            if st.button("Save judgments", disabled=not any(judged)):
                written = save_run(run, judgments)
                st.toast(f"Saved {written} judgments to data/judgments.jsonl")

        for index, paper in enumerate(papers, start=1):
            st.divider()
            is_bookmarked = short_id(paper["id"]) in bookmarked_ids
            left, right = st.columns([5, 2])
            with left:
                badge = " · 🔗 linked to seed" if paper["seed_link"] else ""
                st.markdown(f"**#{index} · score {paper['score']}**{badge}")
                st.markdown(title_md(paper))
                st.write(author_line(paper["authors"]))
                st.caption(meta_line(paper))
                if paper["abstract"]:
                    with st.expander("Abstract"):
                        st.write(paper["abstract"])
            with right:
                st.button(
                    "★ Bookmarked" if is_bookmarked else "☆ Bookmark",
                    key=f"bm-{run['run_id']}-{paper['id']}",
                    type="primary" if is_bookmarked else "secondary",
                    on_click=toggle_bookmark,
                    args=(paper, run["query"], is_bookmarked),
                    use_container_width=True,
                )
                s = paper["scores"]
                st.caption(
                    f"relevance {s['relevance']:.2f} · seed {s['seed']:.2f}  \n"
                    f"recency {s['recency']:.2f} · impact {s['impact']:.2f}"
                )
                st.radio(
                    "Judgment",
                    list(JUDGMENTS),
                    key=judge_key(paper),
                    horizontal=True,
                    label_visibility="collapsed",
                )

# ---------- 2. bookmarks ----------

with bookmarks_tab:
    if not bookmarks:
        st.info("No bookmarks yet. Use ☆ Bookmark on a search result to save it here.")
    else:
        all_tags = sorted({tag for b in bookmarks for tag in b["tags"]})
        top = st.columns([3, 1])
        tag_filter = top[0].selectbox("Filter by tag", ["All", *all_tags])
        shown = bookmarks if tag_filter == "All" else [b for b in bookmarks if tag_filter in b["tags"]]
        try:
            bib = api("GET", "/bookmarks/export.bib", params={} if tag_filter == "All" else {"tag": tag_filter})
            top[1].download_button("Export BibTeX", bib, file_name="research-radar.bib", use_container_width=True)
        except ApiError as exc:
            top[1].caption(f"Export unavailable: {exc}")

        for bookmark in shown:
            paper = bookmark["paper"]
            st.divider()
            st.markdown(title_md(paper, "####"))
            st.write(author_line(paper["authors"]))
            caption = meta_line(paper)
            if bookmark.get("query"):
                caption += f" · found via “{bookmark['query']}”"
            st.caption(caption)
            with st.form(f"bm-form-{bookmark['id']}", border=False):
                note = st.text_area("Note", bookmark["note"], key=f"note-{bookmark['id']}", height=80)
                tags = st.text_input("Tags (comma separated)", ", ".join(bookmark["tags"]), key=f"tags-{bookmark['id']}")
                save_col, remove_col = st.columns([1, 1])
                save = save_col.form_submit_button("Save", use_container_width=True)
                remove = remove_col.form_submit_button("Remove bookmark", use_container_width=True)
            if save:
                try:
                    api("PATCH", f"/bookmarks/{bookmark['id']}",
                        json={"note": note, "tags": [t for t in tags.split(",") if t.strip()]})
                    st.rerun()
                except ApiError as exc:
                    st.error(f"Save failed: {exc}")
            if remove:
                try:
                    api("DELETE", f"/bookmarks/{bookmark['id']}")
                    st.rerun()
                except ApiError as exc:
                    st.error(f"Remove failed: {exc}")

# ---------- 3. research flow ----------

with flow_tab:
    st.caption(
        "Maps how the papers you found connect: topics as lanes, publication year left to right, "
        "and citation links between papers."
    )
    sources = []
    if state.run:
        sources.append("Search results + bookmarks")
        sources.append("Search results only")
    if bookmarks:
        sources.append("Bookmarks only")

    if not sources:
        st.info("Run a search or bookmark some papers first.")
    else:
        controls = st.columns([2, 2, 1])
        source = controls[0].radio("Papers to map", sources, horizontal=False)
        include_foundations = controls[1].checkbox(
            "Add foundational works",
            value=True,
            help="Older papers that at least two of your papers cite, even if the search did not return them.",
        )
        if controls[2].button("Build map", type="primary", use_container_width=True):
            papers = [] if source == "Bookmarks only" else [
                {key: p.get(key) for key in PAPER_FIELDS} for p in state.run["papers"]
            ]
            payload = {
                "papers": papers,
                "include_bookmarks": source != "Search results only",
                "include_foundations": include_foundations,
            }
            try:
                with st.spinner("Mapping the research flow..."):
                    state.flow = api("POST", "/flow", json=payload, timeout=60)
                    state.flow_title = (
                        state.run["query"] if state.run and source != "Bookmarks only" else "My Bookmarks"
                    )
            except ApiError as exc:
                st.error(f"Could not build the map: {exc}")

    flow = state.flow
    if flow and flow["nodes"]:
        nodes = {n["id"]: n for n in flow["nodes"]}
        view = st.radio("View", ["Tech tree", "Timeline chart"], horizontal=True, label_visibility="collapsed")
        if view == "Tech tree":
            poster = render_tech_tree(flow, state.get("flow_title", "My Research"))
            st.caption("Drag to pan, scroll to zoom, click a paper to trace what it builds on and what built on it.")
            shape = tech_tree_layout(flow)
            # the main column is ~1000px wide; size the frame to the poster's shape
            frame_height = int(min(900, max(480, 1000 * shape["height"] / shape["width"])))
            components.html(poster, height=frame_height)
            st.download_button(
                "Download poster (HTML)",
                poster,
                file_name="research-map.html",
                mime="text/html",
            )
        else:
            mode = "dark" if (st.context.theme.type or "light") == "dark" else "light"
            st.plotly_chart(build_figure(flow, mode), use_container_width=True, theme="streamlit")
        undated = sum(1 for n in flow["nodes"] if not n["year"])
        st.caption(
            f"{len(nodes)} papers · {len(flow['edges'])} citation links · {len(flow['clusters'])} topics. "
            "Marker size grows with total citations; the labeled paper in each lane is its hub "
            "(most cited within this map)."
            + (f" {undated} papers without a year are not plotted." if undated else "")
        )

        st.subheader("Storyline by topic")
        for cluster in sorted(flow["clusters"], key=lambda c: c["lane"]):
            span = f"{cluster['year_min']}–{cluster['year_max']}" if cluster["year_min"] else "years unknown"
            origin, hub = nodes[cluster["origin"]], nodes[cluster["hub"]]
            frontier = [nodes[nid] for nid in cluster["frontier"]]
            st.markdown(
                f"**{cluster['label']}** · {cluster['size']} papers · {span}\n"
                f"- **Origin:** {origin['title']} ({origin['year'] or '—'})\n"
                f"- **Hub:** {hub['title']} ({hub['year'] or '—'}), cited by {hub['cited_in_set']} papers here\n"
                f"- **Frontier:** " + "; ".join(f"{n['title']} ({n['year'] or '—'})" for n in frontier)
            )

        lane_label = {c["lane"]: c["label"] for c in flow["clusters"]}
        if flow["cluster_links"]:
            st.subheader("How topics feed each other")
            for link in flow["cluster_links"][:6]:
                st.markdown(
                    f"- **{lane_label[link['from_lane']]}** → **{lane_label[link['to_lane']]}**: "
                    f"{link['count']} citation{'s' if link['count'] != 1 else ''}"
                )

        lineage = lineage_rows(flow)
        if lineage:
            st.subheader("Key lineage")
            st.caption("The longest chain of papers where each one cites the previous one.")
            st.markdown("\n".join(f"{i}. **{row['year']}** · {row['title']}" for i, row in enumerate(lineage, 1)))

        with st.expander("Table view"):
            st.dataframe(
                [
                    {
                        "Year": n["year"],
                        "Title": n["title"],
                        "Topic": lane_label.get(n["lane"], ""),
                        "Role": "Bookmarked" if n["bookmarked"] else n["role"].capitalize(),
                        "Citations": n["citations"],
                        "Cited in map": n["cited_by_in_set"],
                    }
                    for n in sorted(flow["nodes"], key=lambda n: (n["lane"], n["year"] or 0))
                ],
                use_container_width=True,
                hide_index=True,
            )
