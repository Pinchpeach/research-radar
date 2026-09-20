import requests
import streamlit as st


API_URL = "http://localhost:8000"

st.set_page_config(page_title="Research Radar", page_icon="📡", layout="wide")
st.title("Research Radar")
st.caption("Discover papers relevant to your research.")

query = st.text_input(
    "What are you researching?",
    value="Optical observations of isolated neutron stars",
)

if st.button("Scan Research", type="primary"):
    if not query.strip():
        st.warning("Enter a research topic first.")
    else:
        try:
            with st.spinner("Scanning papers..."):
                response = requests.post(
                    f"{API_URL}/search",
                    json={"query": query.strip(), "limit": 20},
                    timeout=30,
                )
                response.raise_for_status()
        except requests.RequestException as exc:
            st.error(f"Search failed: {exc}")
        else:
            papers = response.json()["papers"]
            st.success(f"{len(papers)} papers found")

            for index, paper in enumerate(papers, start=1):
                st.divider()
                st.subheader(f"#{index} · {paper['relevance_score']} relevance score")
                st.markdown(f"### {paper['title']}")
                st.write(", ".join(paper["authors"][:5]) or "Authors unavailable")

                col1, col2 = st.columns(2)
                col1.metric("Year", paper["year"] or "—")
                col2.metric("Citations", paper["citations"])

                if paper["abstract"]:
                    with st.expander("Abstract"):
                        st.write(paper["abstract"])

                if paper["doi"]:
                    st.write(paper["doi"])
