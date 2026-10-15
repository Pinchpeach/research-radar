"""Print relevance metrics for saved judgment runs.

Usage: python -m scripts.evaluate [path/to/judgments.jsonl]
"""

import sys
from pathlib import Path

from backend.judgments import DEFAULT_PATH, load_rows, summarize


def fmt(value):
    return "  –  " if value is None else f"{value:.3f}"


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH
    summary = summarize(load_rows(path))
    if not summary:
        print(f"No judgments found in {path}")
        return
    print(f"{'run':<20} {'judged':>6} {'P@10':>6} {'P@20':>6} {'nDCG@20':>8}  query / settings")
    for run in summary:
        print(
            f"{run['run_id']:<20} {run['judged']:>6} {fmt(run['p@10']):>6} {fmt(run['p@20']):>6} "
            f"{fmt(run['ndcg@20']):>8}  {run['query']} {run['settings']}"
        )


if __name__ == "__main__":
    main()
