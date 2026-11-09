"""Every free copy of a paper the app can find, best first (the reader tries them in turn).

1. Unpaywall (when the person gave an e-mail; see unpaywall.py)
2. OpenAlex's own list of where the work is: every location with a PDF (repositories, PMC, preprints)
3. Europe PMC: open-access full texts of life-science papers, and PubMed Central's PDFs
4. arXiv: a DOI arXiv gave out (10.48550/arXiv.<id>), or an arXiv location OpenAlex knows

All free and keyless, so no paid service is involved; CORE needs a key and is left out.
"""

import re
from urllib.parse import quote

import requests

from backend.services import openalex, unpaywall
from backend.services.openalex import web_url

EUROPE_PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
TIMEOUT = 20
ARXIV_DOI = re.compile(r"^10\.48550/arxiv\.(.+)$", re.I)
ARXIV_PAGE = re.compile(r"^https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/([^?#]+?)(?:\.pdf)?$", re.I)


def arxiv_pdf(arxiv_id: str) -> str:
    return f"https://arxiv.org/pdf/{arxiv_id}"


def openalex_links(work: dict) -> list[str]:
    """PDFs among a raw OpenAlex work's locations, and arXiv's PDF for an arXiv landing page."""
    links = []
    for location in [work.get("best_oa_location"), *(work.get("locations") or [])]:
        location = location or {}
        url = web_url(location.get("pdf_url"))
        page = ARXIV_PAGE.match(location.get("landing_page_url") or "")
        if not url and page:
            url = arxiv_pdf(page.group(1))
        if url and url not in links:
            links.append(url)
    return links


def europe_pmc_links(doi: str, session=None) -> list[str]:
    response = (session or requests).get(
        EUROPE_PMC_URL,
        params={"query": f'DOI:"{doi}"', "resultType": "core", "format": "json", "pageSize": 1},
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    results = ((response.json().get("resultList") or {}).get("result")) or []
    if not results:
        return []
    record, links = results[0], []
    for entry in ((record.get("fullTextUrlList") or {}).get("fullTextUrl")) or []:
        url = web_url(entry.get("url"))
        if url and entry.get("documentStyle") == "pdf" and entry.get("availabilityCode") in ("OA", "F") and url not in links:
            links.append(url)
    pmcid = record.get("pmcid")
    if pmcid and record.get("isOpenAccess") == "Y":
        links.append(f"https://europepmc.org/articles/{quote(pmcid)}?pdf=render")
    return links


def pdf_links(doi: str, email: str | None = None, session=None) -> list[str]:
    """Free PDF addresses for a DOI from every source, best first; a source that fails is skipped."""
    found: list[str] = []

    def add(links):
        found.extend(link for link in links if link not in found)

    if email:
        try:
            add(unpaywall.pdf_links(doi, email, session))
        except (requests.RequestException, ValueError):
            pass
    try:
        add(openalex_links(openalex._get(f"{openalex.OPENALEX_URL}/doi:{quote(doi, safe='/')}", openalex._params())))
    except (requests.RequestException, ValueError):
        pass
    try:
        add(europe_pmc_links(doi, session))
    except (requests.RequestException, ValueError, AttributeError):
        pass
    if match := ARXIV_DOI.match(doi):
        add([arxiv_pdf(match.group(1))])
    return found
