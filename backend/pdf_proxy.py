"""Fetch an open-access PDF for the desktop reader.

The page can't fetch publishers' files itself (they don't allow other sites to read them), so
the local server does. It only follows public http(s) addresses: never this computer or the
local network (a link from a paper's metadata must not reach a router or another local service),
checking again after every redirect, and only returns files that are PDFs, up to MAX_BYTES.
"""

import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import requests

MAX_BYTES = 80 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT = 30
HEADERS = {"User-Agent": "ResearchRadar (+https://github.com/Pinchpeach/research-radar)", "Accept": "application/pdf,*/*"}


class Refused(Exception):
    """The address or the answer is not something the reader may fetch."""


def public_address(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Refused("only http(s) links")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise Refused(f"unknown host {parts.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise Refused("not a public address")


def fetch_pdf(url: str, session: requests.Session | None = None) -> bytes:
    session = session or requests.Session()
    for _ in range(MAX_REDIRECTS + 1):
        public_address(url)
        with session.get(url, headers=HEADERS, timeout=TIMEOUT, stream=True, allow_redirects=False) as response:
            if response.is_redirect or response.status_code in (301, 302, 303, 307, 308):
                url = urljoin(url, response.headers.get("location", ""))
                continue
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_content(64 * 1024):
                data += chunk
                if len(data) > MAX_BYTES:
                    raise Refused("file too large")
            if not bytes(data[:1024]).lstrip().startswith(b"%PDF"):
                raise Refused("not a PDF (the site may want you to open it in a browser)")
            return bytes(data)
    raise Refused("too many redirects")
