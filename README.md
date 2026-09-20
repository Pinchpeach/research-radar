# Research Radar

Prototype v0.1 for discovering and ranking academic papers by research-topic relevance.

## Architecture

- **Backend:** FastAPI
- **Paper source:** OpenAlex
- **Ranking:** TF-IDF + cosine similarity baseline
- **Prototype UI:** Streamlit
- **Future clients:** Web and mobile apps will share the same API-first backend.

## Project structure

```text
research-radar/
├── backend/
│   ├── main.py
│   ├── models.py
│   └── services/
│       ├── openalex.py
│       └── ranking.py
├── frontend/
│   └── app.py
├── requirements.txt
└── README.md
```

## Run locally

Python 3.10+ is recommended.

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
```

Optionally set an email for OpenAlex polite identification:

```bash
export OPENALEX_EMAIL="you@example.com"
```

Start the API:

```bash
uvicorn backend.main:app --reload
```

API docs are available at `http://localhost:8000/docs`.

In a second terminal, start the prototype UI:

```bash
streamlit run frontend/app.py
```

## First validation topic

```text
Optical observations of isolated neutron stars
```

The v0.1 relevance score is a ranking baseline, **not a probability**. It uses TF-IDF cosine similarity between the research query and each paper's title + abstract.

## Next milestone

Evaluate the top 20 results, then improve retrieval/ranking with query expansion, semantic embeddings, recency, and seed-paper signals before adding AI summaries or Change Score.
