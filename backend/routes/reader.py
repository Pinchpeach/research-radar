"""The PDF reader: free PDFs, handwriting, and PDFs kept with their notes."""

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from requests import RequestException

from backend import annotations, library, pdf_proxy, settings
from backend.models import AnnotationDoc
from backend.services import freecopies

router = APIRouter(tags=["reader"])

NO_NOTE = "No handwriting for this document"


@contextmanager
def checked_document() -> Iterator[None]:
    """A bad document ID becomes 422; a document over the size limit, 413."""
    try:
        yield
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OverflowError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


@router.get("/pdf")
def open_access_pdf(url: str):
    """An open-access PDF, fetched for the reader (publishers don't let the page fetch it)."""
    try:
        data = pdf_proxy.fetch_pdf(url)
    except pdf_proxy.Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not download the PDF") from exc
    return Response(data, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@router.get("/free-pdfs")
def free_pdfs(doi: str):
    """Free PDF addresses for a DOI from every source the app knows (backend/services/freecopies.py)."""
    if not library.DOI.match(doi):
        raise HTTPException(status_code=422, detail="not a DOI")
    return {"pdf_urls": freecopies.pdf_links(doi, settings.get("openalex_email"))}


@router.get("/annotations")
def list_annotations():
    """Documents with handwriting, most recently changed first."""
    return annotations.all_summaries()


@router.get("/annotations/{doc_id}")
def get_annotations(doc_id: str):
    with checked_document():
        doc = annotations.load(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=NO_NOTE)
    return doc


@router.put("/annotations/{doc_id}")
def put_annotations(doc_id: str, doc: AnnotationDoc):
    with checked_document():
        return annotations.save(doc_id, doc.model_dump())


@router.delete("/annotations/{doc_id}", status_code=204)
def delete_annotations(doc_id: str):
    with checked_document():
        found = annotations.delete(doc_id)
    if not found:
        raise HTTPException(status_code=404, detail=NO_NOTE)


@router.get("/annotations/{doc_id}/pdf")
def get_kept_pdf(doc_id: str):
    """The PDF the person opened for this document, kept so it opens again without fetching."""
    with checked_document():
        data = annotations.load_pdf(doc_id)
    if data is None:
        raise HTTPException(status_code=404, detail="No PDF kept for this document")
    return Response(content=data, media_type="application/pdf")


@router.put("/annotations/{doc_id}/pdf", status_code=204)
async def put_kept_pdf(doc_id: str, request: Request):
    if int(request.headers.get("content-length") or 0) > annotations.MAX_PDF:
        raise HTTPException(status_code=413, detail="PDF too large")
    with checked_document():
        annotations.save_pdf(doc_id, await request.body())
