"""Generic helpers for parsing experiment outputs and computing scores.

DrugEvolve is task-agnostic. The functions in this module provide the
default "objective score" pipeline that the Engineer stage invokes. Replace
:func:`evaluate_algorithm`, :func:`compute_test_score` and
:func:`get_baseline_content` with task-specific logic for your drug-
discovery application.

The remaining helpers (CSV parsing, log cleaning, header keeping, …) are
fully generic and can be reused as-is.
"""

from __future__ import annotations

import csv
import io
import math
import os
import re
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

def extract_original_name(timestamped_name: str) -> str:
    """Strip the ``YYYYMMDD-HH:MM:SS-`` timestamp prefix added by the pipeline."""
    timestamp_pattern = r"^\d{8}-\d{2}:\d{2}:\d{2}-"
    return re.sub(timestamp_pattern, "", timestamped_name)


def read_py_files_in_dir(directory: str) -> Dict[str, str]:
    """Return a mapping ``{filename: file_contents}`` for every ``*.py`` file."""
    result: Dict[str, str] = {}
    if not os.path.isdir(directory):
        return result
    for fname in os.listdir(directory):
        if not fname.endswith(".py"):
            continue
        fpath = os.path.join(directory, fname)
        if not os.path.isfile(fpath):
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            result[fname] = f.read()
    return result


def keep_header_and_final(csv_text: str, max_tail_rows: int = 1) -> str:
    """Keep the CSV header plus the last ``max_tail_rows`` rows.

    Useful when the training script produces a long CSV that you want to
    compress before feeding it back into an LLM prompt.
    """
    if not csv_text:
        return csv_text
    lines = [ln for ln in csv_text.splitlines() if ln.strip()]
    if len(lines) <= max_tail_rows + 1:
        return csv_text
    return "\n".join([lines[0]] + lines[-max_tail_rows:])


def clean_log_line(line: str) -> str:
    """Strip ANSI colour codes and common timestamp prefixes from a log line."""
    line = re.sub(r"\x1b\[\d+m", "", line)
    line = re.sub(r"^\s*\(.+?pid=\d+\)\s*", "", line)
    line = re.sub(
        r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\|\s+\w+\s+\|[^>]+>>\s*",
        "",
        line,
    )
    return line.strip()


# ---------------------------------------------------------------------------
# CSV parsing / metric aggregation
# ---------------------------------------------------------------------------

def read_rows_from_csv_text(csv_text: str) -> List[Dict[str, str]]:
    if not csv_text:
        return []
    f = io.StringIO(csv_text)
    reader = csv.DictReader(f)
    return list(reader)


def last_float(row: Dict[str, str], key: str) -> Optional[float]:
    if key not in row or row[key] in (None, ""):
        return None
    try:
        return float(row[key])
    except Exception:
        return None


def series_last(rows: List[Dict[str, str]], key: str) -> Optional[float]:
    for r in reversed(rows):
        v = last_float(r, key)
        if v is not None:
            return v
    return None


def _clip010(x: float) -> float:
    return max(0.0, min(10.0, x))


def compute_test_score(test_csv_text: str) -> Optional[float]:
    """Average the last non-NaN row's numeric columns, scaled to ``[0, 10]``."""
    test_csv_text = test_csv_text.replace("\r\n", "\n").replace("\r", "\n")
    rows = read_rows_from_csv_text(test_csv_text)
    if not rows:
        return None

    raw_headers = list(rows[0].keys())
    cleaned_headers: List[str] = []
    for h in raw_headers:
        if h is None:
            cleaned_headers.append("")
            continue
        hh = h.strip().lstrip("\ufeff")
        cleaned_headers.append(hh)

    header_map = {clean: orig for clean, orig in zip(cleaned_headers, raw_headers)}
    benchmark_headers = [
        h for h in cleaned_headers if h and h.lower() not in ("step", "run")
    ]
    if not benchmark_headers:
        return None

    for row in reversed(rows):
        vals: List[float] = []
        for bench in benchmark_headers:
            orig_key = header_map.get(bench, bench)
            v = last_float(row, orig_key)
            if v is not None and not (isinstance(v, float) and math.isnan(v)):
                vals.append(v)
        if vals:
            return (sum(vals) / len(vals)) * 10.0
    return None


def compute_objective_score(train_csv_text: str, test_csv_text: str) -> Optional[float]:
    """Default objective score = clipped ``compute_test_score``."""
    test_score = compute_test_score(test_csv_text)
    if test_score is None:
        return None
    return _clip010(test_score)


def compute_objective_score_test(test_csv_text: str) -> Optional[float]:
    """Variant that ignores the training CSV entirely."""
    return compute_objective_score("", test_csv_text)


def combine_with_llm(
    objective_score: float,
    llm_score: float,
    w_obj: float = 0.7,
    w_llm: float = 0.3,
) -> float:
    """Weighted aggregation of the objective and LLM-judge scores."""
    return _clip010(w_obj * objective_score + w_llm * float(llm_score or 0.0))


# ---------------------------------------------------------------------------
# Result collection from the algorithm workspace
# ---------------------------------------------------------------------------

def collect_algorithm_results(algorithm_dir: str) -> Dict[str, str]:
    """Collect the standard result files written by a candidate algorithm.

    Looks for ``<dataset>_test.csv`` and ``<dataset>_metric.csv`` in the
    ``algorithm_dir`` itself or in the immediate ``<dataset>`` subdirectory.
    Returns a dict with keys ``test`` and ``train`` (train may be empty).
    """
    result: Dict[str, str] = {"test": "", "train": ""}

    candidate_paths = [algorithm_dir, os.path.join(algorithm_dir, "default")]
    for path in candidate_paths:
        if not os.path.isdir(path):
            continue
        for fname in os.listdir(path):
            if not fname.endswith(".csv"):
                continue
            full = os.path.join(path, fname)
            with open(full, "r", encoding="utf-8") as f:
                content = f.read()
            if fname.endswith("_test.csv"):
                result["test"] = content
            elif fname.endswith("_metric.csv"):
                result["train"] = content
    return result


def collect_score_detail(algorithm_dir: str) -> Dict[str, Any]:
    """Extract per-metric score detail if it is persisted as JSON."""
    import json

    detail_path = os.path.join(algorithm_dir, "score_detail.json")
    if not os.path.exists(detail_path):
        return {}
    try:
        with open(detail_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def get_case(algorithm_dir: str) -> str:
    """Return the qualitative case-study text for an algorithm, if any."""
    case_path = os.path.join(algorithm_dir, "case_study.txt")
    if not os.path.exists(case_path):
        return ""
    with open(case_path, "r", encoding="utf-8") as f:
        return f.read()


def evaluate_algorithm(algorithm_dir: str, verbose: bool = False) -> Optional[float]:
    """Compute the objective score for a finished algorithm.

    Override this in your task-specific adapter if your scoring logic is
    more sophisticated than averaging the last CSV row.
    """
    results = collect_algorithm_results(algorithm_dir)
    if verbose:
        print(f"[evaluate] collected {list(results.keys())} from {algorithm_dir}")
    return compute_objective_score(results.get("train", ""), results.get("test", ""))


# ---------------------------------------------------------------------------
# Baseline content for the judger prompt
# ---------------------------------------------------------------------------

def get_baseline_content(default: str = "") -> str:
    """Return the textual description of the baseline.

    Override via the ``DRUGEVOLVE_BASELINE_CONTENT`` environment variable
    so that deployments can inject their own task-specific baseline without
    editing the source.
    """
    return os.getenv("DRUGEVOLVE_BASELINE_CONTENT", default)


# ---------------------------------------------------------------------------
# Generic training-log parser hook
# ---------------------------------------------------------------------------

def parse_train_log(log_content: str, k: int = 1) -> Dict[str, str]:
    """Best-effort parser for ``step:``-prefixed training logs.

    The default implementation returns empty CSVs. Override it in a task
    adapter when the entropy monitor should parse task-specific log output.
    """
    return {"train": "", "test": ""}


__all__ = [
    "extract_original_name",
    "read_py_files_in_dir",
    "keep_header_and_final",
    "clean_log_line",
    "read_rows_from_csv_text",
    "last_float",
    "series_last",
    "compute_test_score",
    "compute_objective_score",
    "compute_objective_score_test",
    "combine_with_llm",
    "collect_algorithm_results",
    "collect_score_detail",
    "get_case",
    "evaluate_algorithm",
    "get_baseline_content",
    "parse_train_log",
]
