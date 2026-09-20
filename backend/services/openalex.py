import os

import requests


OPENALEX_URL = "https://api.openalex.org/works"


def reconstruct_abstract(inverted_index: dict | None) -> str:
    if not inverted_index:
        return ""

    words: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        for position in positions:
            words.append((position, word))

    words.sort(key=lambda item: item[0])
    return " ".join(word for _, word in words)


def search_papers(query: str, limit: int = 20) -> list[dict]:
    params = {"search": query, "per-page": limit}
    email = os.getenv("OPENALEX_EMAIL")
    if email:
        params["mailto"] = email

    response = requests.get(OPENALEX_URL, params=params, timeout=20)
    response.raise_for_status()
    data = response.json()

    papers = []
    for work in data.get("results", []):
        authors = [
            authorship.get("author", {}).get("display_name")
            for authorship in work.get("authorships", [])
            if authorship.get("author", {}).get("display_name")
        ]

        papers.append(
            {
                "id": work.get("id") or "",
                "title": work.get("title") or "",
                "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
                "year": work.get("publication_year"),
                "doi": work.get("doi"),
                "authors": authors,
                "citations": work.get("cited_by_count", 0),
            }
        )

    return papers
