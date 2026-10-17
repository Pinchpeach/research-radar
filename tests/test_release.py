import re
import subprocess
import sys
from pathlib import Path

import pytest
import requests
from fastapi.testclient import TestClient

from backend import main, updates
from backend.version import __version__

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))
import release  # noqa: E402


# ---------- release helper used by the workflow ----------


def test_release_helper_reads_the_single_version_source():
    assert release.app_version() == __version__
    out = subprocess.run([sys.executable, "desktop/release.py", "version"], cwd=ROOT, capture_output=True, text=True)
    assert out.stdout.strip() == __version__


@pytest.mark.parametrize("suffix", ["", "-rc1", "-beta.2"])
def test_tag_matching_the_version_is_accepted(suffix):
    assert release.check_tag(f"v{__version__}{suffix}") is None


@pytest.mark.parametrize("tag", ["v0.0.1", "0.4.0", "v1.2", "release-1", "v1.2.3.4"])
def test_other_tags_are_rejected(tag):
    if tag == f"v{__version__}":
        pytest.skip("this is the current version's tag")
    assert release.check_tag(tag)


def test_check_tag_command_fails_the_build_on_mismatch():
    bad = subprocess.run([sys.executable, "desktop/release.py", "check-tag", "v0.0.1"], cwd=ROOT, capture_output=True, text=True)
    assert bad.returncode == 1 and "::error::" in bad.stdout
    good = subprocess.run([sys.executable, "desktop/release.py", "check-tag", f"v{__version__}"], cwd=ROOT,
                          capture_output=True, text=True)
    assert good.returncode == 0


def test_release_notes_name_the_versioned_files():
    notes = release.notes(f"v{__version__}")
    for name in ("windows.zip", "macos.zip", "linux.tar.gz"):
        assert f"ResearchRadar-{__version__}-{name}" in notes
    assert "시험판" in release.notes(f"v{__version__}-rc1") and "시험판" not in notes
    assert "android.apk" not in notes
    assert f"ResearchRadar-{__version__}-android.apk" in release.notes(f"v{__version__}", android=True)
    cli = subprocess.run([sys.executable, "desktop/release.py", "notes", "v1.2.3", "--android"], cwd=ROOT,
                         capture_output=True, text=True, encoding="utf-8")  # release.py writes UTF-8
    assert cli.returncode == 0 and "ResearchRadar-1.2.3-android.apk" in cli.stdout


# ---------- in-app update check ----------


class Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload or {}

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def fresh_cache():
    updates._cache.update(at=0.0, latest=None)


def test_parse_version():
    assert updates.parse_version("v0.10.2") == (0, 10, 2)
    assert updates.parse_version("0.5.0-rc1") is None and updates.parse_version("") is None


def test_newer_release_is_reported(monkeypatch):
    calls = []

    def fake_get(url, headers, timeout):
        calls.append(url)
        return Resp(200, {"tag_name": "v99.0.0", "html_url": "https://github.com/x/releases/v99.0.0", "published_at": "2027"})

    monkeypatch.setattr(updates.requests, "get", fake_get)
    info = TestClient(main.app).get("/version").json()
    assert info["version"] == __version__ and info["update_available"] is True
    assert info["latest"]["version"] == "99.0.0"
    TestClient(main.app).get("/version")
    assert len(calls) == 1  # cached


def test_same_or_older_release_is_not_an_update(monkeypatch):
    monkeypatch.setattr(updates.requests, "get", lambda *a, **k: Resp(200, {"tag_name": f"v{__version__}"}))
    assert updates.update_info()["update_available"] is False


def test_update_check_failures_are_silent(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr(updates.requests, "get", boom)
    assert updates.update_info() == {"version": __version__, "latest": None, "update_available": False}
    updates._cache.update(at=0.0)
    monkeypatch.setattr(updates.requests, "get", lambda *a, **k: Resp(404))  # no releases yet / private repo
    assert updates.update_info()["latest"] is None


def test_readme_download_links_point_at_this_version():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    links = re.findall(r"releases/download/(v[^/]+)/ResearchRadar-([^)]+?)-(windows\.zip|macos\.zip|linux\.tar\.gz)\)", readme)
    assert {kind for _, _, kind in links} == {"windows.zip", "macos.zip", "linux.tar.gz"}
    for tag, version, _ in links:
        assert tag == f"v{__version__}" and version == __version__, "update the README download links"
    assert f"**v{__version__}**" in readme
