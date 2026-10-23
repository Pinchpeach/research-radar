"""The PDF reader's server side: handwriting storage and fetching open-access PDFs."""

import socket

import pytest
import requests
from fastapi.testclient import TestClient

from backend import annotations, main, pdf_proxy

api = TestClient(main.app, base_url="http://127.0.0.1")
INK = {"id": "a1", "type": "ink", "color": "#1b1b1a", "outline": [[10, 10], [20, 12], [12, 20]]}


def test_handwriting_round_trip_and_list():
    doc = {"title": "GNN", "paper_id": "W1", "page_count": 3, "last_page": 2, "pages": {"1": [INK]}, "notes": [[INK, INK]]}
    saved = api.put("/annotations/W1", json=doc).json()
    assert saved["items"] == 3 and saved["note_pages"] == 1 and saved["last_page"] == 2
    assert api.get("/annotations/W1").json()["pages"]["1"][0]["outline"] == INK["outline"]
    assert [d["id"] for d in api.get("/annotations").json()] == ["W1"]
    assert api.delete("/annotations/W1").status_code == 204
    assert api.get("/annotations/W1").status_code == 404


def test_document_ids_stay_inside_the_folder():
    for bad in ["..", ".hidden", "a b", "x" * 81, "%2e%2e%2fsettings"]:
        assert api.put(f"/annotations/{bad}", json={}).status_code in (404, 405, 422), bad  # 405: ".." collapses the path
    with pytest.raises(ValueError):
        annotations.load("../settings")


def test_handwriting_size_is_capped(monkeypatch):
    monkeypatch.setattr(annotations, "MAX_BYTES", 200)
    assert api.put("/annotations/W2", json={"pages": {"1": [INK] * 20}}).status_code == 413


def _resolve(ip):
    return lambda host, port, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1"])
def test_local_addresses_are_never_fetched(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", _resolve(ip))
    with pytest.raises(pdf_proxy.Refused):
        pdf_proxy.fetch_pdf("https://looks-public.example/paper.pdf")
    assert api.get("/pdf", params={"url": "https://looks-public.example/paper.pdf"}).status_code == 422


def test_only_web_links_and_only_pdfs(monkeypatch):
    with pytest.raises(pdf_proxy.Refused):
        pdf_proxy.fetch_pdf("file:///etc/passwd")
    monkeypatch.setattr(socket, "getaddrinfo", _resolve("93.184.216.34"))

    class Page:
        status_code, is_redirect, headers = 200, False, {}

        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def iter_content(self, size):
            yield self.body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Session:
        def __init__(self, body):
            self.body = body

        def get(self, url, **kwargs):
            return Page(self.body)

    assert pdf_proxy.fetch_pdf("https://publisher.example/a.pdf", Session(b"%PDF-1.7 ...")) == b"%PDF-1.7 ..."
    with pytest.raises(pdf_proxy.Refused):
        pdf_proxy.fetch_pdf("https://publisher.example/a.pdf", Session(b"<html>Accept cookies</html>"))


def test_a_redirect_to_the_local_network_is_refused(monkeypatch):
    addresses = {"publisher.example": "93.184.216.34", "router.local": "192.168.0.1"}
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, *a, **k: [(socket.AF_INET, 1, 6, "", (addresses[host], port))])

    class Redirect:
        status_code, is_redirect, headers = 302, True, {"location": "http://router.local/admin"}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Session:
        def get(self, url, **kwargs):
            return Redirect()

    with pytest.raises(pdf_proxy.Refused):
        pdf_proxy.fetch_pdf("https://publisher.example/a.pdf", Session())


def test_unreachable_publisher_is_502(monkeypatch):
    def fail(url, session=None):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(pdf_proxy, "fetch_pdf", fail)
    assert api.get("/pdf", params={"url": "https://publisher.example/a.pdf"}).status_code == 502
