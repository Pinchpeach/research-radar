"""Legal free copies of a paper from Unpaywall (https://unpaywall.org/products/api).

Unpaywall asks every request to carry the person's e-mail. It often knows of copies OpenAlex
doesn't link to (an author's repository version, a preprint), so the reader tries these before
asking for the library.
"""

from urllib.parse import quote

import requests

from backend.services.openalex import web_url

UNPAYWALL_URL = "https://api.unpaywall.org/v2/"
TIMEOUT = 20


def pdf_links(doi: str, email: str, session: requests.Session | None = None) -> list[str]:
    """PDF addresses for a DOI, best first; [] when Unpaywall knows no free copy."""
    response = (session or requests).get(UNPAYWALL_URL + quote(doi, safe="/"), params={"email": email}, timeout=TIMEOUT)
    if response.status_code == 404:
        return []
    response.raise_for_status()
    record = response.json()
    links = []
    for location in [record.get("best_oa_location")] + list(record.get("oa_locations") or []):
        url = web_url((location or {}).get("url_for_pdf"))
        if url and url not in links:
            links.append(url)
    return links
