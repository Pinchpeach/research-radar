"""Papers through a university library proxy (backend/library.py) and Unpaywall's free copies."""

import json
import os
import socket
import stat

import pytest
from fastapi.testclient import TestClient

from backend import library, main, settings
from backend.services import unpaywall

api = TestClient(main.app, base_url="http://127.0.0.1")
EZ = "https://ezproxy.uni.example/login?url="
KR = "https://libproxy.uni.example/_Lib_Proxy_Url/"
DOI = "10.1000/xyz123"
PDF = b"%PDF-1.7 the paper"
publisher_url = library.publisher_url  # the real one (the fixture below stands in for it)


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("RADAR_HOME", str(tmp_path))
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, *a, **k: [(socket.AF_INET, 1, 6, "", ("93.184.216.34", port))])
    library._recent.clear()
    # doi.org is asked where a DOI points (publisher_url); here it doesn't know, so doi.org itself
    monkeypatch.setattr(library, "publisher_url", lambda doi, session=None: library.doi_url(doi))


class Answer:
    def __init__(self, status=200, body=b"", location=None):
        self.status_code, self.body = status, body
        self.is_redirect = status in (301, 302, 303, 307, 308)
        self.headers = {"location": location} if location else {}

    def raise_for_status(self):
        pass

    def iter_content(self, size):
        yield self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Site:
    """A fake web: url -> Answer, remembering what was asked for and with which cookies."""

    def __init__(self, pages):
        self.pages, self.asked = pages, []
        import requests

        self.cookies = requests.cookies.RequestsCookieJar()

    def get(self, url, **kwargs):
        self.asked.append(url)
        return self.pages[url]


def test_landing_page_then_its_pdf_link_through_an_ezproxy():
    landing = "https://www-publisher-com.ezproxy.uni.example/article/xyz"
    site = Site({
        EZ + "https%3A%2F%2Fdoi.org%2F10.1000%2Fxyz123": Answer(302, location=landing),
        landing: Answer(body=b'<html><meta name="citation_pdf_url" content="/article/xyz.pdf"></html>'),
        "https://www-publisher-com.ezproxy.uni.example/article/xyz.pdf": Answer(body=PDF),
    })
    assert library.fetch(DOI, EZ, site) == PDF


def test_a_pdf_link_outside_the_proxy_goes_through_it():
    site = Site({
        KR + "https://doi.org/" + DOI: Answer(body=b"<meta content='https://publisher.example/x.pdf' name='citation_pdf_url'>"),
        KR + "https://publisher.example/x.pdf": Answer(body=PDF),
    })
    assert library.fetch(DOI, KR, site) == PDF


@pytest.mark.parametrize("answer", [
    Answer(302, location="https://sso.uni.example/login"),  # off to the school's sign-in page
    Answer(body=b'<form><input name="pw" type="password"></form>'),  # EZproxy's own sign-in page
])
def test_signing_in_is_asked_for(answer):
    with pytest.raises(library.NeedsLogin) as caught:
        library.fetch(DOI, KR, Site({KR + "https://doi.org/" + DOI: answer}))
    assert caught.value.login_url == KR + "https://doi.org/" + DOI


def test_a_page_without_a_pdf_link():
    with pytest.raises(library.NoPdf):
        library.fetch(DOI, KR, Site({KR + "https://doi.org/" + DOI: Answer(body=b"<html>Read online</html>")}))


def test_cookies_are_kept_only_for_the_proxy_and_only_for_the_user():
    kept = library.save_cookies(EZ, [
        {"name": "ezproxy", "value": "s3cret", "domain": ".ezproxy.uni.example", "path": "/"},
        {"name": "tracker", "value": "x", "domain": ".ads.example", "path": "/"},
        {"name": "evil", "value": "x", "domain": "ezproxy.uni.example.attacker.example", "path": "/"},
    ])
    assert kept == 1
    saved = json.loads(library.session_path().read_text())
    assert [c["name"] for c in saved["cookies"]] == ["ezproxy"]
    if os.name == "posix":
        assert stat.S_IMODE(library.session_path().stat().st_mode) == 0o600
    session = library._session(EZ)
    assert session.cookies.get("ezproxy", domain=".ezproxy.uni.example") == "s3cret"
    assert library.signed_in(EZ) and not library.signed_in(KR)
    assert len(library._session(KR).cookies) == 0  # another library's session isn't used


def test_endpoints(monkeypatch):
    assert api.get("/library/pdf", params={"doi": DOI}).status_code == 422  # no proxy yet
    assert api.put("/settings", json={"library_proxy": "javascript:alert(1)"}).status_code == 422
    assert api.put("/settings", json={"library_proxy": KR}).json()["library_proxy"]["value"] == KR
    assert api.get("/library/pdf", params={"doi": "not-a-doi"}).status_code == 422

    def needs_login(doi, prefix=None, session=None):
        raise library.NeedsLogin(KR + "https://doi.org/" + doi)

    monkeypatch.setattr(library, "fetch", needs_login)
    answer = api.get("/library/pdf", params={"doi": DOI})
    assert answer.status_code == 401 and answer.json()["detail"]["login_url"].startswith(KR)
    monkeypatch.setattr(library, "fetch", lambda doi, prefix=None, session=None: PDF)
    answer = api.get("/library/pdf", params={"doi": DOI})
    assert answer.content == PDF and answer.headers["content-type"] == "application/pdf"
    library.save_cookies(KR, [{"name": "s", "value": "1", "domain": "libproxy.uni.example"}])
    assert api.get("/settings").json()["library_signed_in"] is True
    assert api.delete("/library/session").status_code == 204
    assert api.get("/settings").json()["library_signed_in"] is False


def test_unpaywall_lists_free_pdfs_best_first(monkeypatch):
    record = {"best_oa_location": {"url_for_pdf": "https://repo.example/a.pdf"},
              "oa_locations": [{"url_for_pdf": "https://repo.example/a.pdf"}, {"url_for_pdf": "javascript:x"}, {"url_for_pdf": "https://arxiv.org/pdf/1"}]}

    class Reply:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return record

    asked = {}

    class Session:
        def get(self, url, params, timeout):
            asked.update(url=url, **params)
            return Reply()

    assert unpaywall.pdf_links(DOI, "me@uni.example", Session()) == ["https://repo.example/a.pdf", "https://arxiv.org/pdf/1"]
    assert asked == {"url": "https://api.unpaywall.org/v2/10.1000/xyz123", "email": "me@uni.example"}

    assert api.get("/unpaywall", params={"doi": DOI}).status_code == 409  # no e-mail yet
    settings.save({"openalex_email": "me@uni.example"})
    monkeypatch.setattr(unpaywall, "pdf_links", lambda doi, email: ["https://repo.example/a.pdf"])
    assert api.get("/unpaywall", params={"doi": DOI}).json() == {"pdf_urls": ["https://repo.example/a.pdf"]}


def test_schools_are_known_by_their_email_domain():
    assert library.school_for("kim@snu.ac.kr")["proxy"].startswith("https://libproxy.snu.ac.kr/")
    assert library.school_for("lee@mail.yonsei.ac.kr")["name_en"] == "Yonsei University"
    assert library.school_for("x@notsnu.ac.kr") is None and library.school_for("") is None
    assert api.get("/library/school", params={"email": "park@korea.ac.kr"}).json()["name_ko"] == "고려대학교"
    for school in __import__("backend.paths", fromlist=["x"]).shared_json("libraries.json")["schools"]:
        assert library.valid_proxy(school["proxy"]) and school["proxy"].startswith("https://"), school


def test_the_desktop_sign_in_window_keeps_the_cookies_and_closes_on_the_pdf(monkeypatch):
    """desktop/main.py's library_login, with a stand-in for pywebview's window."""
    import sys
    import threading
    import time
    import types
    from http.cookies import SimpleCookie

    from desktop.main import DesktopApi

    settings.save({"library_proxy": KR})

    class Hook:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, handler):
            self.handlers.append(handler)
            return self

        def fire(self):
            for handler in self.handlers:
                handler()

    class Window:
        def __init__(self, title, url, **kwargs):
            self.url, self.destroyed = url, False
            self.events = types.SimpleNamespace(loaded=Hook(), closed=Hook())
            opened.append(self)

        def get_cookies(self):
            jar = SimpleCookie()
            jar["session"] = "abc"
            jar["session"]["domain"], jar["session"]["path"] = ".libproxy.uni.example", "/"
            return [jar]

        def destroy(self):
            self.destroyed = True
            self.events.closed.fire()

    opened = []
    monkeypatch.setitem(sys.modules, "webview", types.SimpleNamespace(create_window=Window))
    tries = []

    def fetch(doi, prefix=None, session=None):
        tries.append(json.loads(library.session_path().read_text())["cookies"][0]["value"])
        if len(tries) == 1:
            raise library.NeedsLogin("")  # the first page is the sign-in form
        return PDF

    monkeypatch.setattr(library, "fetch", fetch)
    result = {}
    thread = threading.Thread(target=lambda: result.update(ok=DesktopApi().library_login(DOI)))
    thread.start()
    while not opened:
        time.sleep(0.01)
    window = opened[0]
    assert window.url == KR + "https://doi.org/" + DOI
    window.events.loaded.fire()  # the sign-in page
    assert not window.destroyed
    window.events.loaded.fire()  # signed in: the paper
    thread.join(5)
    assert result == {"ok": True} and window.destroyed and tries == ["abc", "abc"]


def test_addresses_through_each_kind_of_proxy():
    """How the publisher's address goes into the library's (the user's report: links didn't go through)."""
    pdf = "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=4700287"
    # a query-style prefix takes the address encoded, or its "&arnumber=" would be the proxy's own
    assert library.through("https://libproxy.snu.ac.kr/link.n2s?url=", pdf) == (
        "https://libproxy.snu.ac.kr/link.n2s?url=https%3A%2F%2Fieeexplore.ieee.org%2Fstamp%2Fstamp.jsp%3Ftp%3D%26arnumber%3D4700287")
    assert library.through(KR, pdf) == KR + pdf  # a path-style prefix takes it as it is
    # a relative link on a proxied page is the publisher's, then goes through the proxy again
    page = KR + "https://ieeexplore.ieee.org/document/4700287/"
    site = Site({
        KR + "https://doi.org/" + DOI: Answer(302, location=page),
        page: Answer(body=b'<meta name="citation_pdf_url" content="/stamp/stamp.jsp?tp=&amp;arnumber=4700287">'),
        KR + pdf: Answer(body=b'<iframe src="https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?arnumber=4700287"></iframe>'),
        KR + "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?arnumber=4700287": Answer(body=PDF),  # IEEE's frame around the PDF
    })
    assert library.fetch(DOI, KR, site) == PDF
    # what people paste: no closing "/", or a whole example address from the library's guide
    assert library.normalize_proxy("https://libproxy.knu.ac.kr/_Lib_Proxy_Url") == "https://libproxy.knu.ac.kr/_Lib_Proxy_Url/"
    assert library.normalize_proxy(" https://libproxy.knu.ac.kr/_Lib_Proxy_Url/https://www.sciencedirect.com/ ") == "https://libproxy.knu.ac.kr/_Lib_Proxy_Url/"
    assert library.normalize_proxy("https://ezproxy.uni.edu/login?url=https%3A%2F%2Fwww.nature.com") == "https://ezproxy.uni.edu/login?url="
    assert library.normalize_proxy("https://ezproxy.uni.edu/login?url") == "https://ezproxy.uni.edu/login?url="
    assert api.put("/settings", json={"library_proxy": "https://libproxy.knu.ac.kr/_Lib_Proxy_Url"}).json()["library_proxy"]["value"] == (
        "https://libproxy.knu.ac.kr/_Lib_Proxy_Url/")
    # a DOI's own "#", "?" or spaces don't cut it short
    assert library.doi_url("10.1002/(SICI)1097-4636#3 x?y") == "https://doi.org/10.1002/(SICI)1097-4636%233%20x%3Fy"


def test_the_doi_is_followed_to_the_publisher_first():

    class Reply:
        def __init__(self, record):
            self.record = record

        def json(self):
            return self.record

    class Session:
        def __init__(self, record):
            self.record, self.asked = record, None

        def get(self, url, params=None, timeout=None):
            self.asked = (url, params)
            return Reply(self.record)

    found = Session({"values": [{"type": "HS_ADMIN", "data": {}}, {"type": "URL", "data": {"value": "https://ieeexplore.ieee.org/document/4700287/"}}]})
    assert publisher_url(DOI, found) == "https://ieeexplore.ieee.org/document/4700287/"
    assert found.asked == ("https://doi.org/api/handles/10.1000/xyz123", {"type": "URL"})
    assert publisher_url(DOI, Session({"responseCode": 100})) == "https://doi.org/10.1000/xyz123"  # unknown: doi.org itself
    assert publisher_url(DOI, Session({"values": [{"type": "URL", "data": {"value": "javascript:x"}}]})) == "https://doi.org/10.1000/xyz123"
