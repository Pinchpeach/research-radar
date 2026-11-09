"""Every free copy of a paper: Unpaywall, OpenAlex's locations, Europe PMC, arXiv (freecopies.py)."""

import requests
from fastapi.testclient import TestClient

from backend import main, settings
from backend.services import freecopies, openalex, unpaywall

api = TestClient(main.app, base_url="http://127.0.0.1")
DOI = "10.1000/xyz123"


class Reply:
    def __init__(self, body, status=200):
        self.body, self.status_code = body, status

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


EUROPE_PMC = {"resultList": {"result": [{"pmcid": "PMC123", "isOpenAccess": "Y", "fullTextUrlList": {"fullTextUrl": [
    {"url": "https://europepmc.org/a.pdf", "documentStyle": "pdf", "availabilityCode": "OA"},
    {"url": "https://publisher.example/paywalled.pdf", "documentStyle": "pdf", "availabilityCode": "S"},
    {"url": "https://europepmc.org/a.html", "documentStyle": "html", "availabilityCode": "OA"},
]}}]}}
WORK = {"best_oa_location": {"pdf_url": "https://repo.example/a.pdf"}, "locations": [
    {"pdf_url": None, "landing_page_url": "https://arxiv.org/abs/2101.00001v2"},
    {"pdf_url": "https://repo.example/a.pdf"},
    {"pdf_url": "javascript:alert(1)"},
]}


def test_every_source_in_order_and_once(monkeypatch):
    monkeypatch.setattr(unpaywall, "pdf_links", lambda doi, email, session=None: ["https://oa.example/u.pdf", "https://repo.example/a.pdf"])
    monkeypatch.setattr(openalex, "_get", lambda url, params: WORK if url.endswith("/doi:" + DOI) else {})

    class Session:
        def get(self, url, params=None, timeout=None):
            assert url == freecopies.EUROPE_PMC_URL and params["query"] == f'DOI:"{DOI}"'
            return Reply(EUROPE_PMC)

    assert freecopies.pdf_links(DOI, "me@uni.example", Session()) == [
        "https://oa.example/u.pdf", "https://repo.example/a.pdf", "https://arxiv.org/pdf/2101.00001v2",
        "https://europepmc.org/a.pdf", "https://europepmc.org/articles/PMC123?pdf=render",
    ]
    # no e-mail: no Unpaywall, the rest as before
    assert freecopies.pdf_links(DOI, None, Session())[0] == "https://repo.example/a.pdf"


def test_a_failing_source_is_skipped_and_arxiv_dois_need_nothing(monkeypatch):
    def down(*args, **kwargs):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "_get", down)

    class Session:
        def get(self, *args, **kwargs):
            raise requests.ConnectionError("down")

    assert freecopies.pdf_links("10.48550/arXiv.1706.03762", None, Session()) == ["https://arxiv.org/pdf/1706.03762"]
    assert freecopies.pdf_links(DOI, None, Session()) == []


def test_route(monkeypatch):
    settings.save({"openalex_email": "me@uni.example"})
    monkeypatch.setattr(freecopies, "pdf_links", lambda doi, email: [f"https://x.example/{doi}?{email}"])
    assert api.get("/free-pdfs", params={"doi": DOI}).json() == {"pdf_urls": [f"https://x.example/{DOI}?me@uni.example"]}
    assert api.get("/free-pdfs", params={"doi": "nope"}).status_code == 422


def test_a_paper_by_doi_or_link_id(monkeypatch):
    work = {"id": "https://openalex.org/W1", "title": "GNN", "abstract": "", "year": 2009, "doi": "https://doi.org/10.1/x",
            "url": None, "open_access_url": None, "venue": None, "authors": [], "citations": 0,
            "referenced_works": [], "keywords": [], "topic": None}
    monkeypatch.setattr(openalex, "get_work", lambda identifier: work if identifier in ("10.1/x", "W1") else None)
    assert api.get("/works/lookup", params={"id": "10.1/x"}).json()["title"] == "GNN"
    assert api.get("/works/lookup", params={"id": "W404"}).status_code == 404

    def down(identifier):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(openalex, "get_work", down)
    assert api.get("/works/lookup", params={"id": "W1"}).status_code == 502
