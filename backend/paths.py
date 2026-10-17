"""Where the app's bundled files live: next to the code, or unpacked by PyInstaller into sys._MEIPASS."""

import json
import sys
from functools import lru_cache
from pathlib import Path

APP_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
WEB_DIR = APP_DIR / "frontend" / "web"
# Files shared with the JavaScript port of the backend (the Android app), so both stay in step.
SHARED_DIR = WEB_DIR / "shared"


@lru_cache
def shared_text(name: str) -> str:
    return (SHARED_DIR / name).read_text(encoding="utf-8")


def shared_json(name: str):
    return json.loads(shared_text(name))
