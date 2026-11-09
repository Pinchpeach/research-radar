"""PDFs through the person's university library, with the session they signed in to."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from requests import RequestException

from backend import library, pdf_proxy

router = APIRouter(prefix="/library", tags=["library"])


@router.get("/pdf")
def library_pdf(doi: str):
    """A paper's PDF through the person's library proxy."""
    try:
        data = library.fetch(doi)
    except library.NeedsLogin as exc:
        detail = {"message": "Sign in to your library", "login_url": exc.login_url, "library_login": exc.login_page}
        raise HTTPException(status_code=401, detail=detail) from exc
    except library.NoPdf as exc:
        detail = {"message": "No PDF link on the paper's page", "page_url": exc.page_url}
        raise HTTPException(status_code=404, detail=detail) from exc
    except pdf_proxy.Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not reach the library") from exc
    return Response(data, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@router.get("/school")
def library_school(email: str):
    """The school an e-mail address belongs to and its library's proxy, if the app knows it."""
    return library.school_for(email)


@router.delete("/session", status_code=204)
def library_sign_out():
    library.clear_session()
