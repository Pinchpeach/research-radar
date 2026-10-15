# Research Radar

Discover and rank academic papers by how relevant they are to your research topic.

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

## Architecture

- **Backend:** FastAPI (`backend/`)
- **Paper source:** OpenAlex
- **Ranking:** TF-IDF baseline, plus optional OpenAI embeddings, seed-paper signals, recency, and citation impact
- **Prototype UI:** Streamlit (`frontend/app.py`)
- **Future clients:** web and mobile apps will share the same API-first backend.

```text
research-radar/
├── backend/
│   ├── main.py              # API: /search, /health
│   ├── models.py            # request / response schemas
│   ├── evaluation.py        # Precision@k, nDCG@k
│   ├── judgments.py         # save and summarize relevance judgments
│   └── services/
│       ├── openalex.py      # search, citing papers, references, DOI/ID lookup
│       ├── ranking.py       # hybrid scoring
│       └── embeddings.py    # optional semantic similarity
├── frontend/app.py
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

Only `query` is required. The response includes `papers` (with `score`, a `scores` breakdown, `seed_link`, venue, and URL), `candidates`, `semantic` (whether embeddings were used), and the resolved and unresolved seeds. OpenAlex failures return `502`.

## Evaluating ranking quality

Judge results in the UI and click **Save judgments**. Judgments are appended to `data/judgments.jsonl` together with the query and settings used. Then compare runs:

```bash
python -m scripts.evaluate
```

First validation topic: *Optical observations of isolated neutron stars*. Judge the top 20 with the TF-IDF baseline, then repeat with embeddings, seeds, or other weights.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest
```

## Next

AI summaries and a Change Score, once evaluation shows the ranking is good enough.
