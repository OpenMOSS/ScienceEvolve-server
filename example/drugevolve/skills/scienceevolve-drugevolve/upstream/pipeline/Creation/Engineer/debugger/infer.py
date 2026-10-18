"""Debugger agent invocation."""

from __future__ import annotations

import os

from config import Config
from utils.agent import run
from utils.algorithm import Algorithm
from .model import debugger
from .prompt import debugger_input


async def debug(name: str, algorithm: Algorithm, log_file: str):
    """Inspect the training log and emit a fix for the candidate algorithm.

    Args:
        name: Algorithm directory name.
        algorithm: ``Algorithm`` instance with motivation/explain/math.
        log_file: Path to the live training log file (currently unused; the
            debugger pulls its context from the per-dataset files written
            by the launch script).
    """
    # After ``Engineer.evaluation`` rewrites the launch script, the actual
    # algorithm directory is:
    #     {Config.CODE_DIR}/algorithm/<name>/
    # Inside it, the convention established by the launch script template
    # is to write:
    #     <algorithm_dir>/log/<dataset>.txt           ← stdout/stderr of training
    #     <algorithm_dir>/log/<dataset>_metric.txt    ← metrics-step stdout
    # The two are read here and stitched into the prompt sent to the
    # Debugger agent.
    dataset = os.getenv("DRUGEVOLVE_DATASET", "default")
    algo_dir = os.path.join(Config.CODE_DIR, "algorithm", name)
    log_path = os.path.join(algo_dir, "log", f"{dataset}.txt")
    metric_path = os.path.join(algo_dir, "log", f"{dataset}_metric.txt")

    debug_content = ""
    if os.path.exists(log_path):
        with open(log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        tail = lines[-100:] if len(lines) > 100 else lines
        debug_content = "".join(tail)

    if os.path.exists(metric_path):
        with open(metric_path, "r", encoding="utf-8") as f:
            metric_lines = f.readlines()
        tail = metric_lines[-50:] if len(metric_lines) > 50 else metric_lines
        debug_content += "\n\nMetrics Error:\n" + "".join(tail)

    previous_error = f"Previous Error:\n{debug_content}"
    return await run(
        "debugger",
        debugger,
        debugger_input(name, algorithm, previous_error),
    )


__all__ = ["debug"]