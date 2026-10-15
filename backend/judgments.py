"""Store and summarize relevance judgments made in the prototype UI."""

import json
from collections import defaultdict
from pathlib import Path

from backend.evaluation import ndcg_at_k, precision_at_k

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "judgments.jsonl"


def save_run(run: dict, judgments: dict[str, str], path: Path = DEFAULT_PATH) -> int:
    """Append one line per judged paper. Returns the number of lines written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "run_id": run["run_id"],
            "query": run["query"],
            "settings": run["settings"],
            "rank": rank,
            "paper_id": paper["id"],
            "title": paper["title"],
            "score": paper["score"],
            "judgment": judgments[paper["id"]],
        }
        for rank, paper in enumerate(run["papers"], start=1)
        if judgments.get(paper["id"])
    ]
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return len(rows)


def load_rows(path: Path = DEFAULT_PATH) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def summarize(rows: list[dict]) -> list[dict]:
    """Metrics per run; a later judgment of the same paper in a run replaces an earlier one."""
    runs: dict[str, dict] = defaultdict(dict)
    meta: dict[str, dict] = {}
    for row in rows:
        runs[row["run_id"]][row["rank"]] = row["judgment"]
        meta[row["run_id"]] = {"query": row["query"], "settings": row.get("settings", {})}

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
    return summary
