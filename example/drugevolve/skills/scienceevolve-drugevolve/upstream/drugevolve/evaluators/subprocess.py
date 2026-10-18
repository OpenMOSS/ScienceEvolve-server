"""Structured subprocess evaluator with process-group timeout handling."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

from .base import EvaluationResult, Evaluator


class SubprocessEvaluator(Evaluator):
    def __init__(self, command: str, timeout_secs: int):
        if not command.strip():
            raise ValueError("Evaluator command must not be empty")
        if timeout_secs <= 0:
            raise ValueError("Evaluator timeout must be positive")
        self.command = command
        self.timeout_secs = int(timeout_secs)

    def evaluate(
        self,
        candidate_path: Path,
        step_dir: Path,
        workspace_root: Path,
    ) -> EvaluationResult:
        source = Path(candidate_path).resolve()
        step_dir = Path(step_dir).resolve()
        workspace_root = Path(workspace_root).resolve()
        step_dir.mkdir(parents=True, exist_ok=True)
        materialized_root = step_dir / "candidate"
        if source.is_dir():
            if materialized_root.exists():
                shutil.rmtree(materialized_root)
            shutil.copytree(source, materialized_root)
            materialized = materialized_root
        else:
            materialized_root.mkdir(parents=True, exist_ok=True)
            materialized = materialized_root / source.name
            shutil.copy2(source, materialized)

        results_path = step_dir / "results.json"
        command = self.command.format(
            candidate_path=str(materialized),
            results_path=str(results_path),
            step_dir=str(step_dir),
            workspace_root=str(workspace_root),
            timeout_secs=self.timeout_secs,
        )
        (step_dir / "evaluation.command").write_text(command, encoding="utf-8")

        started = time.monotonic()
        process = subprocess.Popen(
            command,
            shell=True,
            cwd=workspace_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=self.timeout_secs)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
        runtime = time.monotonic() - started
        (step_dir / "evaluation.stdout").write_text(stdout or "", encoding="utf-8")
        (step_dir / "evaluation.stderr").write_text(stderr or "", encoding="utf-8")

        payload = {}
        if results_path.exists():
            try:
                payload = json.loads(results_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                payload = {"success": False, "score": 0.0, "error": str(exc)}

        if timed_out:
            payload.update(
                success=False,
                score=0.0,
                error=f"Evaluator timed out after {self.timeout_secs} seconds",
            )
            return_code = 124
        else:
            return_code = process.returncode
            if return_code != 0:
                payload.setdefault("success", False)
                payload.setdefault("score", 0.0)
                payload.setdefault("error", stderr or f"Evaluator exited with {return_code}")
            elif not results_path.exists():
                payload = {
                    "success": False,
                    "score": 0.0,
                    "error": "Evaluator did not produce results.json",
                }

        payload["return_code"] = return_code
        payload["runtime_secs"] = runtime
        result = EvaluationResult.from_dict(payload)
        results_path.write_text(
            json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return result
