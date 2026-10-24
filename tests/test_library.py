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
        EZ + "https://doi.org/" + DOI: Answer(302, location=landing),
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
    # the address goes after the prefix as it is, like the libraries' guides show; encoded, Yonsei's
    # proxy showed a blank page (the user's screenshot of access.yonsei.ac.kr/link.n2s?url=http%3A%...)
    n2s = "https://access.yonsei.ac.kr/link.n2s?url="
    assert library.through(n2s, pdf) == n2s + pdf
    assert library.through(n2s, "http://www.dbpia.co.kr") == "https://access.yonsei.ac.kr/link.n2s?url=http://www.dbpia.co.kr"  # the guide's example
    assert library.unwrap(n2s, n2s + pdf) == pdf
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
    old = Session({"values": [{"type": "URL", "data": {"value": "http://ieeexplore.ieee.org/document/4700287/"}}]})
    assert publisher_url(DOI, old) == "https://ieeexplore.ieee.org/document/4700287/"  # proxies keep the scheme; Android blocks http
    assert found.asked == ("https://doi.org/api/handles/10.1000/xyz123", {"type": "URL"})
    assert publisher_url(DOI, Session({"responseCode": 100})) == "https://doi.org/10.1000/xyz123"  # unknown: doi.org itself
    assert publisher_url(DOI, Session({"values": [{"type": "URL", "data": {"value": "javascript:x"}}]})) == "https://doi.org/10.1000/xyz123"


def test_the_android_app_lets_every_listed_library_use_plain_http():
    """mobile/build.mjs writes network_security_config.xml from libraries.json; it must be current."""
    from pathlib import Path
    from urllib.parse import urlsplit

    from backend.paths import shared_json

    xml = (Path(__file__).resolve().parent.parent / "mobile/android/app/src/main/res/xml/network_security_config.xml").read_text()
    assert '<base-config cleartextTrafficPermitted="false" />' in xml
    for school in shared_json("libraries.json")["schools"]:
        for host in (school["domain"], urlsplit(school["proxy"]).hostname):
            assert f'<domain includeSubdomains="true">{host}</domain>' in xml, f"run node mobile/build.mjs ({host})"
    manifest = (Path(__file__).resolve().parent.parent / "mobile/android/app/src/main/AndroidManifest.xml").read_text()
    assert 'android:networkSecurityConfig="@xml/network_security_config"' in manifest


def test_the_android_app_fills_in_a_certificate_a_server_leaves_out():
    """Yonsei's library sends no intermediate certificate: the sign-in screen and the app's HTTP
    fetch it as Chrome does (AiaTrust), and only an untrusted chain is retried, never an expired,
    misnamed or not-yet-valid certificate."""
    from pathlib import Path

    java = Path(__file__).resolve().parent.parent / "mobile/android/app/src/main/java/io/github/pinchpeach/researchradar"
    main = (java / "MainActivity.java").read_text()
    assert "AiaTrust.install();" in main
    screen = (java / "LibraryWebActivity.java").read_text()
    assert "AiaTrust.trusted(error.getCertificate(), host)" in screen
    for refused in ("SSL_NOTYETVALID", "SSL_EXPIRED", "SSL_IDMISMATCH", "SSL_DATE_INVALID"):
        assert f"!error.hasError(SslError.{refused})" in screen
    trust = (java / "AiaTrust.java").read_text()
    assert "extensions.checkServerTrusted(completed, authType, host)" in trust  # the system's check, with the host
    xml = (java.parents[4] / "res/xml/network_security_config.xml").read_text()
    assert '<domain includeSubdomains="true">sectigo.com</domain>' in xml, "run node mobile/build.mjs"


def test_a_library_that_needs_its_own_sign_in_first(monkeypatch):
    """Yonsei's link.n2s shows a blank page until the person has signed in on the library's site."""
    import sys
    import threading
    import time
    import types

    from desktop.main import DesktopApi

    yonsei = "https://access.yonsei.ac.kr/link.n2s?url="
    assert library.login_page(yonsei) == "https://library.yonsei.ac.kr/login"
    assert library.login_page(KR) is None
    with pytest.raises(library.NeedsLogin) as caught:
        library.fetch(DOI, yonsei, Site({yonsei + "https://doi.org/" + DOI: Answer(body=b"<html></html>")}))
    assert caught.value.login_page == "https://library.yonsei.ac.kr/login"

    settings.save({"library_proxy": yonsei})
    monkeypatch.setattr(library, "fetch", lambda doi, prefix=None, session=None: (_ for _ in ()).throw(library.NeedsLogin("")))

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
            self.url, self.loaded_urls = url, []
            self.events = types.SimpleNamespace(loaded=Hook(), closed=Hook())
            opened.append(self)

        def get_current_url(self):
            return self.url

        def load_url(self, url):
            self.loaded_urls.append(url)

        def get_cookies(self):
            return []

        def destroy(self):
            self.events.closed.fire()

    opened = []
    monkeypatch.setitem(sys.modules, "webview", types.SimpleNamespace(create_window=Window))
    thread = threading.Thread(target=lambda: DesktopApi().library_login(DOI))
    thread.start()
    while not opened:
        time.sleep(0.01)
    window = opened[0]
    assert window.url == "https://library.yonsei.ac.kr/login"  # the library's sign-in page first
    window.events.loaded.fire()
    assert window.loaded_urls == []  # still signing in
    window.url = "https://library.yonsei.ac.kr/"  # signed in: back on the library's homepage
    window.events.loaded.fire()
    assert window.loaded_urls == [yonsei + "https://doi.org/" + DOI]  # on to the paper through the proxy
    window.destroy()
    thread.join(5)


def test_signing_in_once_from_settings(monkeypatch):
    """Settings › Library › Sign in: the library's sign-in page, then a publisher's page through
    the proxy, whose cookies are kept for the papers opened later."""
    import sys
    import threading
    import time
    import types

    from desktop.main import DesktopApi

    yonsei = "https://access.yonsei.ac.kr/link.n2s?url="
    assert library.sign_in_url(yonsei) == "https://library.yonsei.ac.kr/login"
    assert library.sign_in_url(KR) == KR + "https://www.nature.com/"
    assert library.sign_in_url("") is None
    assert library.on_publisher("https://www-nature-com-ssl.access.yonsei.ac.kr/articles/168356a0", yonsei)
    assert not library.on_publisher(yonsei + "https://www.nature.com/", yonsei)  # the proxy's own link page
    assert library.on_publisher(KR + "https://www.nature.com/", KR) and not library.on_publisher("https://sso.uni.example/", KR)

    settings.save({"library_proxy": yonsei})
    assert api.get("/settings").json()["library_sign_in_url"] == "https://library.yonsei.ac.kr/login"

    class Hook:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, handler):
            self.handlers.append(handler)
            return self

        def fire(self):
            for handler in self.handlers:
                handler()

    from http.cookies import SimpleCookie

    class Window:
        def __init__(self, title, url, **kwargs):
            self.url, self.loaded_urls = url, []
            self.events = types.SimpleNamespace(loaded=Hook(), closed=Hook())
            opened.append(self)

        def get_current_url(self):
            return self.url

        def load_url(self, url):
            self.loaded_urls.append(url)

        def get_cookies(self):
            jar = SimpleCookie()
            jar["ezsession"] = "s1"
            jar["ezsession"]["domain"], jar["ezsession"]["path"] = ".access.yonsei.ac.kr", "/"
            return [jar]

        def destroy(self):
            self.events.closed.fire()

    opened, result = [], {}
    monkeypatch.setitem(sys.modules, "webview", types.SimpleNamespace(create_window=Window))
    thread = threading.Thread(target=lambda: result.update(ok=DesktopApi().library_sign_in()))
    thread.start()
    while not opened:
        time.sleep(0.01)
    window = opened[0]
    assert window.url == "https://library.yonsei.ac.kr/login"
    window.url = "https://library.yonsei.ac.kr/"  # signed in
    window.events.loaded.fire()
    assert window.loaded_urls == [yonsei + "https://www.nature.com/"]
    window.url = "https://www-nature-com-ssl.access.yonsei.ac.kr/"  # through the proxy now
    window.events.loaded.fire()
    thread.join(5)
    assert result == {"ok": True} and library.signed_in(yonsei)
