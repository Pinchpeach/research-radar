"""Papers through the person's university library: its off-campus proxy (EZproxy and the like).

The library's proxy address is a prefix put in front of a publisher's address
(https://libproxy.school.ac.kr/_Lib_Proxy_Url/https://doi.org/10.1/x, or EZproxy's
https://ezproxy.school.edu/login?url=...). The person signs in once in a window of the desktop app
(desktop/main.py); the proxy's session cookies are kept here, readable only by the user, and
sent only to the proxy's own host and its subdomains (EZproxy serves publishers as
www-nature-com.ezproxy.school.edu). A redirect away from the proxy means the session has run out
(the proxy sends people to the school's sign-in page) or the publisher isn't one the library
subscribes to: either way the person is asked to sign in, in that window, where they can also
download by hand.

Only what the person opens is fetched, one paper at a time: what a student does in a browser.
"""

import json
import os
import re
import tempfile
import time
from html import unescape
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests

from backend import pdf_proxy, settings
from backend.paths import shared_json

DOI = re.compile(r"^10\.\d{4,9}/\S{1,300}$")
PROXY = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d+)?(/\S*)?$")
_META_PDF = re.compile(r"""<meta\b[^>]*\bname\s*=\s*["']citation_pdf_url["'][^>]*>""", re.I)
_CONTENT = re.compile(r"""\bcontent\s*=\s*["']([^"']+)["']""", re.I)
_PASSWORD = re.compile(r"""<input\b[^>]*\btype\s*=\s*["']?password""", re.I)
_FRAME = re.compile(r"""<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']""", re.I)


class NeedsLogin(Exception):
    """Sign in to the library first (or again)."""

    def __init__(self, login_url: str):
        super().__init__("sign in to your library")
        self.login_url = login_url


class NoPdf(Exception):
    """The paper's page came through the library but has no PDF link the app can follow."""

    def __init__(self, page_url: str):
        super().__init__("no PDF link on the paper's page")
        self.page_url = page_url


def school_for(email: str | None) -> dict | None:
    """The school an e-mail belongs to, with its library's proxy (shared/libraries.json)."""
    domain = (email or "").rsplit("@", 1)[-1].strip().lower() if "@" in (email or "") else ""
    for school in shared_json("libraries.json")["schools"]:
        if domain == school["domain"] or domain.endswith("." + school["domain"]):
            return {k: school[k] for k in ("domain", "name_ko", "name_en", "proxy")}
    return None


def normalize_proxy(text: str | None) -> str:
    """The proxy prefix from what the person pasted: an example address from the library's guide
    (prefix + https://publisher/...) is cut back to the prefix, and the "/" or "=" that ends a
    prefix is added when it is missing."""
    text = (text or "").strip()
    found = re.search(r"https?(://|%3A%2F%2F)", text[8:], re.I)  # a second address inside the first
    if found:
        text = text[: 8 + found.start()]
    if re.search(r"_Lib_Proxy_Url$", text, re.I):
        text += "/"
    elif re.search(r"[?&](q?url)$", text, re.I):
        text += "="
    return text


def proxy() -> str:
    """The saved proxy prefix, normalized."""
    return normalize_proxy(settings.get("library_proxy"))


def valid_proxy(prefix: str) -> bool:
    return bool(PROXY.match(prefix or ""))


def proxy_host(prefix: str) -> str:
    return (urlsplit(prefix).hostname or "").lower()


def in_scope(url: str, prefix: str) -> bool:
    host, base = (urlsplit(url).hostname or "").lower(), proxy_host(prefix)
    return bool(base) and (host == base or host.endswith("." + base))


def through(prefix: str, url: str) -> str:
    """The address of url through the library: put after the prefix as it is, as the libraries'
    guides show (link.n2s?url=http://www.dbpia.co.kr). Their proxies read everything after "url="
    as the address, so an encoded one (http%3A%2F%2F...) leaves Yonsei's on a blank page."""
    return url if in_scope(url, prefix) else prefix + url


def unwrap(prefix: str, url: str) -> str:
    """The publisher's address inside a proxied one (the reverse of through), for resolving the
    page's relative links; a host-rewriting proxy's addresses are left as they are."""
    if not url.startswith(prefix):
        return url
    inner = url[len(prefix):]
    if prefix.endswith("=") and inner.lower().startswith(("http%3a", "https%3a")):
        inner = unquote(inner.split("&", 1)[0])
    return inner if re.match(r"https?://", inner, re.I) else url


def doi_url(doi: str) -> str:
    return "https://doi.org/" + quote(doi, safe="/()<>;:-._")  # "#", "?" and spaces would cut the DOI short


def publisher_url(doi: str, session=None) -> str:
    """Where the DOI points (the publisher's page), asked of doi.org without the library: a proxy
    serves the publishers its library subscribes to, which doi.org itself may not be among."""
    try:
        record = (session or requests).get(f"https://doi.org/api/handles/{quote(doi, safe='/')}", params={"type": "URL"}, timeout=15).json()
        url = next(v["data"]["value"] for v in record.get("values", []) if v.get("type") == "URL")
        if re.match(r"https?://", url, re.I):
            return url
    except (requests.RequestException, ValueError, KeyError, StopIteration, TypeError, AttributeError):
        pass
    return doi_url(doi)


def login_url(prefix: str, doi: str, session=None) -> str:
    return through(prefix, publisher_url(doi, session))


# ---------- the signed-in session ----------


def session_path() -> Path:
    return settings.data_dir() / "library-session.json"


def save_cookies(prefix: str, cookies: list[dict]) -> int:
    """Keep the proxy's cookies (name, value, domain, path); others are dropped. Returns how many."""
    kept = []
    for c in cookies:
        domain = str(c.get("domain") or "").lstrip(".").lower()
        if c.get("name") and domain and in_scope(f"https://{domain}/", prefix):
            kept.append({"name": str(c["name"]), "value": str(c.get("value") or ""), "domain": domain, "path": str(c.get("path") or "/")})
    path = session_path()
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".library-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"proxy": prefix, "cookies": kept}, handle)
        os.chmod(tmp, 0o600)  # the cookies are a signed-in session
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return len(kept)


def clear_session() -> None:
    session_path().unlink(missing_ok=True)


def signed_in(prefix: str | None) -> bool:
    try:
        saved = json.loads(session_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return False
    return bool(prefix) and saved.get("proxy") == prefix and bool(saved.get("cookies"))


def _session(prefix: str) -> requests.Session:
    session = requests.Session()
    try:
        saved = json.loads(session_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return session
    if saved.get("proxy") != prefix:  # signed in to another library: start over
        return session
    for c in saved.get("cookies", []):
        # a domain cookie, so requests sends it to the proxy host and its subdomains only
        session.cookies.set(c["name"], c["value"], domain="." + c["domain"], path=c.get("path") or "/")
    return session


# ---------- fetching ----------

_recent: dict = {}  # the last PDF fetched: the sign-in window fetches it, then the page asks again


def pdf_link(html: str, page_url: str) -> str | None:
    """The publisher's PDF address from the page's citation_pdf_url tag (Google Scholar's), else a
    PDF shown in a frame (IEEE's stamp page)."""
    for tag in _META_PDF.findall(html):
        found = _CONTENT.search(tag)
        if found:
            return urljoin(page_url, unescape(found.group(1)).strip())
    for src in _FRAME.findall(html):
        if "pdf" in src.lower():
            return urljoin(page_url, unescape(src).strip())
    return None


def fetch(doi: str, prefix: str | None = None, session: requests.Session | None = None) -> bytes:
    prefix = normalize_proxy(prefix) if prefix else proxy()
    if not valid_proxy(prefix or ""):
        raise pdf_proxy.Refused("set your library's proxy address in Settings first")
    if not DOI.match(doi or ""):
        raise pdf_proxy.Refused("not a DOI")
    if _recent.get("key") == (prefix, doi) and time.monotonic() - _recent["at"] < 120:
        return _recent["data"]
    session = session or _session(prefix)
    start = login_url(prefix, doi, session)

    def stay(url: str) -> None:
        if not in_scope(url, prefix):
            raise NeedsLogin(start)

    url = start
    for _ in range(3):  # the paper's page, its PDF link, and a frame around the PDF
        final, data = pdf_proxy.fetch(url, session, stay)
        if pdf_proxy.is_pdf(data):
            _recent.update(key=(prefix, doi), at=time.monotonic(), data=data)
            return data
        html = data[:2_000_000].decode("utf-8", "replace")
        if _PASSWORD.search(html):
            raise NeedsLogin(start)
        link = pdf_link(html, unwrap(prefix, final))  # relative links are the publisher's
        if not link:
            raise NoPdf(final)
        url = through(prefix, link)
    raise NoPdf(url)
