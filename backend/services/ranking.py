from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity


def rank_papers(query: str, papers: list[dict]) -> list[dict]:
    if not papers:
        return []

    documents = [query]
    documents.extend(
        f"{paper['title']} {paper['abstract']}".strip() for paper in papers
    )

    vectorizer = TfidfVectorizer(stop_words="english")
    vectors = vectorizer.fit_transform(documents)
    similarities = cosine_similarity(vectors[0], vectors[1:])[0]

    for paper, score in zip(papers, similarities):
        paper["relevance_score"] = round(float(score) * 100, 1)

    return sorted(papers, key=lambda paper: paper["relevance_score"], reverse=True)
