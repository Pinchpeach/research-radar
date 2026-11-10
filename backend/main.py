"""The Research Radar API: the app the desktop window and the browser talk to.

Each area of the app has its own router in backend/routes/; this file puts them together.
"""

import mimetypes
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import security, updates
from backend.paths import WEB_DIR, shared_json
from backend.routes import bookmarks, evaluations, library, news, reader, search, settings
from backend.version import __version__

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
# The screens are JavaScript modules, which browsers run only when served as JavaScript. Windows
# can map .js to text/plain in its registry, which Python's mimetypes reads: say it here.
mimetypes.add_type("text/javascript", ".js")

app = FastAPI(title="Research Radar API", version=__version__)
security.protect(app)
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

for module in (search, bookmarks, reader, library, news, settings, evaluations):
    app.include_router(module.router)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__}


@app.get("/changelog")
def changelog():
    """What changed in each version, newest first (shared/changelog.json)."""
    return shared_json("changelog.json")


@app.get("/version")
def version():
    """This app's version and, when GitHub can be reached, whether a newer release exists."""
    return updates.update_info()
