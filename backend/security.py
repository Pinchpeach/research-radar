"""Keep the local API to the app itself.

The desktop app serves its API on 127.0.0.1. Any web page open in a browser on the same computer
can send requests there too, so:
- only Host headers naming this computer are answered: a site that re-points its own domain at
  127.0.0.1 (DNS rebinding) would otherwise read bookmarks and settings and use the API key;
- requests that change something must come from the app's own page: a different Origin is
  refused (plain cross-site form posts are already refused because bodies must be JSON).
"""

from urllib.parse import urlsplit

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"]
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class SameOriginWrites:
    """Refuse state-changing requests whose Origin is not the host they were sent to."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
            headers = dict(scope["headers"])
            origin = headers.get(b"origin", b"").decode("latin-1")
            host = headers.get(b"host", b"").decode("latin-1")
            # browsers send Origin on cross-site writes; "null" comes from sandboxed frames and files
            if origin and (origin == "null" or urlsplit(origin).netloc != host):
                await PlainTextResponse("Cross-origin request refused", status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def protect(app: FastAPI) -> None:
    app.add_middleware(SameOriginWrites)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOCAL_HOSTS)
