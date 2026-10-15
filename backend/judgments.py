"""Store and summarize relevance judgments made in the app's evaluation mode.

Each saved judgment is one JSON line in judgments.jsonl in the app's data folder.
"""

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from backend import settings
from backend.evaluation import ndcg_at_k, precision_at_k


def default_path() -> Path:
    return settings.data_dir() / "judgments.jsonl"


def save_run(run: dict, judgments: dict[str, str], path: Path | None = None) -> int:
    """Append one line per judged paper. Returns the number of lines written."""
    path = path or default_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    saved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = [
        {
            "run_id": run["run_id"],
            "query": run["query"],
            "settings": run.get("settings", {}),
            "saved_at": saved_at,
            "rank": rank,
            "paper_id": paper["id"],
            "title": paper["title"],
            "score": paper.get("score"),
            "judgment": judgments[paper["id"]],
        }
        for rank, paper in enumerate(run["papers"], start=1)
        if judgments.get(paper["id"])
    ]
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def load_rows(path: Path | None = None) -> list[dict]:
    path = path or default_path()
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def delete_run(run_id: str, path: Path | None = None) -> bool:
    """Remove every saved judgment of one run. Returns whether anything was removed."""
    path = path or default_path()
    rows = load_rows(path)
    kept = [row for row in rows if row["run_id"] != run_id]
    if len(kept) == len(rows):
        return False
    with path.open("w", encoding="utf-8") as handle:
        for row in kept:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return True


def summarize(rows: list[dict]) -> list[dict]:
    """Metrics per run, newest first; a later judgment of the same paper in a run replaces an earlier one."""
    runs: dict[str, dict] = defaultdict(dict)
    meta: dict[str, dict] = {}
    for row in rows:
        runs[row["run_id"]][row["rank"]] = row["judgment"]
        meta[row["run_id"]] = {
            "query": row["query"],
            "settings": row.get("settings", {}),
            "saved_at": row.get("saved_at"),
        }

    summary = []
    for run_id, by_rank in runs.items():
        judgments = [by_rank.get(rank) for rank in range(1, max(by_rank) + 1)]
        summary.append(
            {
                "run_id": run_id,
                **meta[run_id],
                "judged": len(by_rank),
                "p@10": precision_at_k(judgments, 10),
                "p@20": precision_at_k(judgments, 20),
                "ndcg@20": ndcg_at_k(judgments, 20),
            }
        )
    return sorted(summary, key=lambda run: run["saved_at"] or "", reverse=True)
