import os
import sys
from datetime import datetime
from pathlib import Path

import requests
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.evaluation import ndcg_at_k, precision_at_k  # noqa: E402
from backend.judgments import save_run  # noqa: E402

API_URL = os.getenv("RADAR_API_URL", "http://localhost:8000")
JUDGMENTS = {"—": None, "Relevant": "relevant", "Partial": "partial", "Not relevant": "not_relevant"}

st.set_page_config(page_title="Research Radar", page_icon="📡", layout="wide")
st.title("Research Radar")
st.caption("Discover papers relevant to your research.")

state = st.session_state
state.setdefault("run", None)

# ---------- search settings ----------

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
    require_abstract = st.checkbox("Only papers with an abstract")

    with st.expander("Ranking weights"):
        weights = {
            "relevance": st.slider("Topic relevance", 0.0, 1.0, 0.6, 0.05),
            "seed": st.slider("Seed similarity / links", 0.0, 1.0, 0.2, 0.05),
            "recency": st.slider("Recency", 0.0, 1.0, 0.1, 0.05),
            "impact": st.slider("Citation impact", 0.0, 1.0, 0.1, 0.05),
        }

query = st.text_input(
    "What are you researching?",
    value="Optical observations of isolated neutron stars",
)

if st.button("Scan Research", type="primary"):
    if not query.strip():
        st.warning("Enter a research topic first.")
    else:
        payload = {
            "query": query.strip(),
            "limit": limit,
            "year_from": year_from,
            "year_to": year_to,
            "seed_ids": [line.strip() for line in seeds_text.splitlines() if line.strip()],
            "require_abstract": require_abstract,
            "weights": weights,
        }
        try:
            with st.spinner("Scanning papers..."):
                response = requests.post(f"{API_URL}/search", json=payload, timeout=90)
                response.raise_for_status()
        except requests.RequestException as exc:
            detail = exc
            if exc.response is not None:
                try:
                    detail = exc.response.json().get("detail", exc)
                except ValueError:
                    pass
            st.error(f"Search failed: {detail}")
        else:
            body = response.json()
            settings = {k: v for k, v in payload.items() if k != "query"}
            state.run = {
                "run_id": datetime.now().strftime("%Y%m%d-%H%M%S"),
                "query": body["query"],
                "settings": settings,
                **body,
            }

# ---------- results ----------

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
        left, right = st.columns([5, 2])
        with left:
            badge = " · 🔗 linked to seed" if paper["seed_link"] else ""
            st.markdown(f"**#{index} · score {paper['score']}**{badge}")
            link = paper["url"] or paper["doi"]
            st.markdown(f"### [{paper['title']}]({link})" if link else f"### {paper['title']}")
            authors = paper["authors"]
            st.write(", ".join(authors[:5]) + (" et al." if len(authors) > 5 else "") or "Authors unavailable")
            meta = [str(paper["year"] or "—"), paper["venue"] or "", f"{paper['citations']} citations"]
            st.caption(" · ".join(part for part in meta if part))
            if paper["abstract"]:
                with st.expander("Abstract"):
                    st.write(paper["abstract"])
        with right:
            s = paper["scores"]
            st.caption(
                f"relevance {s['relevance']:.2f} · seed {s['seed']:.2f}  \n"
                f"recency {s['recency']:.2f} · impact {s['impact']:.2f}  \n"
                f"TF-IDF {paper['relevance_score']}"
            )
            st.radio(
                "Judgment",
                list(JUDGMENTS),
                key=judge_key(paper),
                horizontal=True,
                label_visibility="collapsed",
            )
