"""The person's settings: OpenAlex key and e-mail, library proxy, ranking weights."""

from fastapi import APIRouter

from backend import library, settings
from backend.models import KeyTest, SettingsUpdate
from backend.services import openalex

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def read_settings():
    return settings.public_view()


@router.put("")
def update_settings(update: SettingsUpdate):
    values = update.model_dump(exclude_unset=True)
    if values.get("library_proxy"):
        values["library_proxy"] = library.normalize_proxy(values["library_proxy"])  # e.g. a pasted example address
    settings.save(values)
    return settings.public_view()


@router.post("/test-openalex")
def test_openalex_key(body: KeyTest):
    """Check a key before saving it (or the saved key when none is given)."""
    return openalex.check_key(body.api_key or None)
