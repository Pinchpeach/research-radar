# Research Radar

Discover papers for your research topic, bookmark the ones that matter, and map how the field developed.

The Streamlit UI has three tabs:

| Tab | What it does |
|---|---|
| 🔎 **Discover** | Ranked search over OpenAlex (below). ☆ Bookmark any result; optionally use your bookmarks as seed papers. |
| ★ **Bookmarks** | Saved papers with notes and tags, filter by tag, export BibTeX. Stored in `data/radar.db` (SQLite). |
| 🧭 **Research flow** | A map of the search results and/or bookmarks: topics as lanes, publication year left to right, citation links between papers, plus a written storyline. |

## How it works

1. **Retrieve.** Radar searches OpenAlex for the topic and pulls a candidate pool of 3× the requested results (at least 50, at most 200). With seed papers, it also adds papers that cite each seed and papers each seed cites.
2. **Score.** Each candidate gets four signals, each in 0–1:
   | Signal | Meaning |
   |---|---|
   | relevance | TF-IDF (unigrams and bigrams) cosine between the query and title + abstract, scaled so the best candidate is 1. When `OPENAI_API_KEY` is set, averaged with embedding similarity. |
   | seed | 1 if the paper cites or is cited by a seed; otherwise text similarity to the closest seed. |
   | recency | Halves every 5 years. |
   | impact | log(1 + citations per year), scaled to the best candidate. |
3. **Rank.** The final score is the weighted mean × 100. The default weights are relevance 0.6, seed 0.2, recency 0.1, and impact 0.1, and you can change them per search. The score ranks candidates; **it is not a probability**.
4. **Evaluate.** In the UI, mark results Relevant, Partial, or Not relevant to see Precision@10/20 and nDCG@20, then save the judgments to compare ranking settings over time.

## Research flow map

`POST /flow` turns a set of papers into:

- **Topics:** TF-IDF + k-means clusters (2–6, depending on how many papers), each labeled by its top phrases and ordered by when the topic emerged.
- **Citation links:** edges between papers in the set, plus cross-topic counts ("topic A → topic B: 3 citations").
- **Foundational works:** older papers that at least two papers in the set cite but the search did not return. These are fetched from OpenAlex, up to 10.
- **Storyline per topic:** *origin* (earliest paper), *hub* (most cited within the map), and *frontier* (newest papers).
- **Key lineage:** the longest chain of papers that each cite the previous one.

The **Tech tree** view (default) is an interactive map in the spirit of *The Map of Physics*, built to show the big picture first and details on demand:

- **At a glance:** each topic is a rail that starts where the topic emerges. A topic that grew out of an earlier one branches off that topic's rail; the others branch off a glowing **ORIGINS** node. Citations between topics are bundled into one soft curve per topic pair, thicker for more citations. Only topic names and one key paper per rail are labeled.
- **Dots on the lines:** every paper is a dot on its rail. Bigger means more cited, glow marks a key paper, ○ is a foundational work, and ★ is bookmarked.
- **Hover** a dot to see the paper and its own citation lines. Hover a rail for the topic's origin, key paper, and latest papers. Hover a curve to see how many citations link two topics, with examples.
- **Click** a dot, rail, or curve to pin its card. The card floats next to what you clicked and follows it while you pan and zoom. Click empty space, the **×**, or press **Esc** to close it. A pinned paper also traces what it builds on and what built on it. **핵심 계보** highlights the key lineage.
- **Zoom** with the scroll wheel; paper titles appear next to the dots (or turn them on with **제목**). **Download poster (HTML)** saves the map as one file.

The **Timeline chart** view is a compact Plotly version. There, a paper's role is shown by both color and shape: ● search result, ★ bookmarked, ◆ foundational. Marker size grows with total citations, and a table view lists every paper.

## Architecture

- **Backend:** FastAPI (`backend/`)
- **Paper source:** OpenAlex
- **Ranking:** TF-IDF baseline, plus optional OpenAI embeddings, seed-paper signals, recency, and citation impact
- **Prototype UI:** Streamlit (`frontend/app.py`)
- **Future clients:** web and mobile apps will share the same API-first backend.

```text
research-radar/
├── backend/
│   ├── main.py              # API: /search, /bookmarks, /flow, /health
│   ├── models.py            # request / response schemas
│   ├── storage.py           # SQLite bookmarks, BibTeX export
│   ├── evaluation.py        # Precision@k, nDCG@k
│   ├── judgments.py         # save and summarize relevance judgments
│   └── services/
│       ├── openalex.py      # search, citing papers, references, DOI/ID lookup
│       ├── ranking.py       # hybrid scoring
│       ├── flow.py          # topics, citation graph, storyline, lineage
│       └── embeddings.py    # optional semantic similarity
├── frontend/
│   ├── app.py               # Streamlit UI
│   ├── techtree.py          # tech-tree poster (layout + interactive SVG)
│   └── flow_chart.py        # Plotly timeline chart
├── scripts/evaluate.py      # metrics per saved run
└── tests/
```

## Run locally

Python 3.10+ is recommended.

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Optional settings (shell or a `.env` file in the repository root):

```bash
OPENALEX_EMAIL=you@example.com      # OpenAlex polite pool
OPENAI_API_KEY=sk-...               # enables semantic ranking
RADAR_EMBEDDINGS=off                # disable embeddings even when a key is set
RADAR_EMBEDDING_MODEL=text-embedding-3-small
RADAR_API_URL=http://localhost:8000 # where the UI finds the API
RADAR_DB=data/radar.db              # bookmark database
```

Start the API:

```bash
uvicorn backend.main:app --reload
```

API docs are at `http://localhost:8000/docs`. In a second terminal, start the UI:

```bash
streamlit run frontend/app.py
```

## API

`POST /search`

```json
{
  "query": "Optical observations of isolated neutron stars",
  "limit": 20,
  "year_from": 2000,
  "year_to": 2025,
  "seed_ids": ["10.1086/345493", "W2058532123"],
  "require_abstract": false,
  "weights": {"relevance": 0.6, "seed": 0.2, "recency": 0.1, "impact": 0.1}
}
```

Only `query` is required. The response includes `papers` (with `score`, a `scores` breakdown, `seed_link`, venue, URL, and `referenced_works`), `candidates`, `semantic` (whether embeddings were used), and the resolved and unresolved seeds. OpenAlex failures return `502`.

Bookmarks (IDs are short OpenAlex IDs such as `W2058532123`):

| Endpoint | Purpose |
|---|---|
| `GET /bookmarks?tag=` | List, newest first |
| `PUT /bookmarks` `{paper, note?, tags?, query?}` | Add, or refresh the stored paper (keeps the existing note and tags) |
| `PATCH /bookmarks/{id}` `{note?, tags?}` | Edit note and tags |
| `DELETE /bookmarks/{id}` | Remove |
| `GET /bookmarks/export.bib?tag=` | BibTeX export |

Research flow: `POST /flow` `{papers: [...], include_bookmarks, include_foundations, max_foundations}` returns `nodes`, `edges`, `clusters`, `cluster_links`, and `chain`.

## Evaluating ranking quality

Judge results in the UI and click **Save judgments**. Judgments are appended to `data/judgments.jsonl` together with the query and settings used. Then compare runs:

```bash
python -m scripts.evaluate
```

First validation topic: *Optical observations of isolated neutron stars*. Judge the top 20 with the TF-IDF baseline, then repeat with embeddings, seeds, or other weights.

## Live check with real papers

Run the whole pipeline (search → seeds → ranking → research flow with foundational works → tech-tree poster) against live OpenAlex:

```bash
python -m scripts.live_check "optical observations of isolated neutron stars"
python -m scripts.live_check "graph neural networks" --limit 40 --seed 10.48550/arXiv.1609.02907
```

It prints the top results, topics, cross-topic links, key lineage, and foundational works, runs sanity checks (abstracts and reference lists present, citation links found, topics branching), and writes the poster to `data/live-map.html`.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest
```

## Next

- AI summaries of each topic's storyline.
- A Change Score for new papers in a bookmarked topic.
- Saved maps you can compare over time.
