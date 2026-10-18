"""User settings (API keys, contact email and UI language) kept in a small JSON file.

The file lives in the app's data folder: RADAR_HOME when set (the desktop app points it at
the user's app-data directory), otherwise the repository's data/ folder. A saved value wins
over the matching environment variable, so the app works with either.
"""

import json
import os
import tempfile
from pathlib import Path

REPO_DATA = Path(__file__).resolve().parent.parent / "data"

# setting name -> environment variable used when the setting is not saved
FIELDS = {
    "openalex_api_key": "OPENALEX_API_KEY",
    "openalex_email": "OPENALEX_EMAIL",
    "language": "RADAR_LANG",
}
SECRETS = {"openalex_api_key"}


def data_dir() -> Path:
    path = Path(os.getenv("RADAR_HOME") or REPO_DATA)
    path.mkdir(parents=True, exist_ok=True)
    return path


def settings_path() -> Path:
    return data_dir() / "settings.json"


def load() -> dict:
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}
    return {k: v for k, v in data.items() if k in FIELDS and isinstance(v, str) and v}


def get(name: str) -> str | None:
    """Saved value, else the environment variable, else None."""
    return load().get(name) or os.getenv(FIELDS[name]) or None


def save(updates: dict) -> None:
    """Apply updates: a string sets a value, an empty string or None removes it."""
    current = load()
    for name, value in updates.items():
        if name not in FIELDS:
            raise KeyError(name)
        value = (value or "").strip()
        if value:
            current[name] = value
        else:
            current.pop(name, None)
    path = settings_path()
    # write atomically and readable only by the user: the file holds API keys
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(current, handle, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def mask(secret: str) -> str:
    return "•" * 6 + secret[-4:] if len(secret) > 8 else "•" * len(secret)


def public_view() -> dict:
    """What the UI may see: never a full key, only whether it is set and a short hint."""
    saved = load()
    view = {}
    for name, env in FIELDS.items():
        value = saved.get(name) or os.getenv(env) or ""
        source = "settings" if saved.get(name) else "environment" if value else None
        entry = {"set": bool(value), "source": source}
        if name in SECRETS:
            entry["hint"] = mask(value) if value else ""
        else:
            entry["value"] = value
        view[name] = entry
    view["data_dir"] = str(data_dir())
    return view
