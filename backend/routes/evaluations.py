"""Relevance judgments the person saves, to measure how well the ranking does."""

from fastapi import APIRouter, HTTPException

from backend import judgments
from backend.models import EvaluationRun

router = APIRouter(prefix="/evaluations", tags=["evaluations"])


@router.post("")
def save_evaluation(run: EvaluationRun):
    """Save relevance judgments for one search run."""
    if not run.judgments:
        raise HTTPException(status_code=400, detail="No judgments to save.")
    written = judgments.save_run(run.model_dump(), run.judgments)
    return {"written": written}


@router.get("")
def list_evaluations():
    """Precision@10/20 and nDCG@20 per saved run, newest first."""
    return judgments.summarize(judgments.load_rows())


@router.delete("/{run_id}", status_code=204)
def delete_evaluation(run_id: str):
    if not judgments.delete_run(run_id):
        raise HTTPException(status_code=404, detail="Evaluation run not found")
