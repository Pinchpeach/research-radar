import pytest


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    """Each test gets an empty data folder and no API keys from the real environment."""
    monkeypatch.setenv("RADAR_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("RADAR_DB", raising=False)
    for name in ("OPENALEX_API_KEY", "OPENALEX_EMAIL", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
