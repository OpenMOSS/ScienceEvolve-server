"""Engineer stage entry point.

Runs the candidate algorithm on the configured task and aggregates:

- the textual program files written under ``Config.CODE_DIR/algorithm/<name>``
- a CSV / metric dictionary parsed from the training log
- an LLM-driven quality score (see :mod:`judger`)
- an algorithmic objective score (see :func:`utils.experiment.evaluate_algorithm`)
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from typing import Dict, Tuple

from config import Config
from utils.algorithm import Algorithm
from utils.experiment import (
    collect_algorithm_results,
    collect_score_detail,
    evaluate_algorithm,
    extract_original_name,
    get_case,
    read_py_files_in_dir,
)
from utils.copy_launch_script import generate_training_script

from .debugger.infer import debug
from .judger.infer import judge
from .trainer import train

# ---------------------------------------------------------------------------
# Background training-log monitor (for entropy / loss explosion detection)
# ---------------------------------------------------------------------------
_monitor_threads = {}
_CRASH_MESSAGE = "Training crashed before producing test results."
_ENTROPY_ABORT_MSG = (
    "Training stopped because entropy exceeded the threshold: "
    f"{Config.ENTROPY_THRESHOLD}"
)


async def evaluation(name: str, algorithm: Algorithm):
    """Train + judge a single candidate algorithm.

    Returns a tuple of
    ``(name, program, result, score, score_detail, llm_score, complexity, case)``.
    """
    original_name = extract_original_name(name)
    train_script = generate_training_script(original_name, name, Config.SOURCE_FILE)
    log_file = f"{Config.LOGS_DIR}/{name}.log"

    success, error_msg = await run_training(original_name, train_script, algorithm, log_file)
    forced_abort = error_msg == _ENTROPY_ABORT_MSG
    if not success and not forced_abort:
        raise Exception(f"[FAILED] Training failed: {error_msg}")

    code_dir = getattr(Config, "CODE_DIR", None)
    if code_dir is not None:
        src_dir = os.path.join(code_dir, "algorithm", original_name)
        dst_dir = os.path.join(code_dir, "algorithm", name)
        if os.path.exists(src_dir):
            if os.path.exists(dst_dir):
                shutil.rmtree(dst_dir)
            shutil.move(src_dir, dst_dir)

    program = read_py_files_in_dir(os.path.join(code_dir, "algorithm", name))
    result_dict = collect_algorithm_results(os.path.join(code_dir, "algorithm", name))
    score_detail = collect_score_detail(os.path.join(code_dir, "algorithm", name))
    case_study = get_case(os.path.join(code_dir, "algorithm", name))

    if forced_abort:
        result_dict["test"] = _CRASH_MESSAGE

    llm_score, complexity = await judge(algorithm, result_dict)

    algorithm_path = os.path.join(code_dir, "algorithm", name)
    if not forced_abort:
        objective = evaluate_algorithm(algorithm_path, verbose=True) or 0.0
    else:
        objective = 0.0

    total_weight = Config.OBJECTIVE_SCORE_WEIGHT + Config.LLM_SCORE_WEIGHT
    if total_weight <= 0:
        raise ValueError("At least one score weight must be positive")
    score = (
        Config.OBJECTIVE_SCORE_WEIGHT * objective
        + Config.LLM_SCORE_WEIGHT * llm_score
    ) / total_weight
    return (
        original_name,
        program,
        result_dict,
        score,
        score_detail,
        llm_score,
        complexity,
        case_study,
    )


def _monitor_training_log(name: str, log_file: str, kill_event: threading.Event) -> None:
    """Background thread: watch the training log for entropy spikes."""
    from utils.experiment import parse_train_log

    entropy_threshold = Config.ENTROPY_THRESHOLD

    while not os.path.exists(log_file):
        if kill_event.is_set():
            return
        time.sleep(2)

    while not kill_event.is_set():
        try:
            with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                log_content = f.read()

            if not log_content:
                time.sleep(2)
                continue

            parsed = parse_train_log(log_content, k=1)
            train_csv = parsed.get("train") or ""
            if not train_csv:
                continue

            import csv as _csv
            import io as _io

            reader = _csv.DictReader(_io.StringIO(train_csv))
            for row in reader:
                entropy_val = row.get("entropy")
                if entropy_val in (None, ""):
                    continue
                try:
                    entropy_float = float(entropy_val)
                except ValueError:
                    continue
                if entropy_float > entropy_threshold:
                    kill_event.set()
                    return
        except Exception:
            time.sleep(5)


def _start_monitor_thread(name: str, log_file: str, kill_event: threading.Event) -> None:
    thread = threading.Thread(
        target=_monitor_training_log,
        args=(name, log_file, kill_event),
        daemon=True,
    )
    _monitor_threads[name] = (thread, kill_event)
    thread.start()


def _stop_monitor_thread(name: str) -> None:
    thread_data = _monitor_threads.pop(name, None)
    if not thread_data:
        return
    thread, kill_event = thread_data
    kill_event.set()
    thread.join(timeout=5)


async def run_training(name: str, bash_path: str, algorithm: Algorithm, log_file: str) -> Tuple[bool, str]:
    """Run the training script with up to ``MAX_DEBUG_ATTEMPT`` retries."""
    debug_flag = False
    kill_event = threading.Event()
    _start_monitor_thread(name, log_file, kill_event)

    try:
        for attempt in range(Config.MAX_DEBUG_ATTEMPT):
            if debug_flag:
                debug_result = await debug(name, algorithm, log_file)
                _ = debug_result.changes_made  # consumed for logging only

            success, error_msg = await train(bash_path, cancel_event=kill_event)
            if success:
                return True, ""

            debug_flag = True

            if kill_event.is_set():
                return True, _ENTROPY_ABORT_MSG

            if attempt == Config.MAX_DEBUG_ATTEMPT - 1:
                return False, (
                    f"Training failed after {Config.MAX_DEBUG_ATTEMPT} attempts: "
                    f"{error_msg}"
                )

        return False, "Training retry loop ended unexpectedly"
    finally:
        _stop_monitor_thread(name)


__all__ = ["evaluation", "run_training"]
