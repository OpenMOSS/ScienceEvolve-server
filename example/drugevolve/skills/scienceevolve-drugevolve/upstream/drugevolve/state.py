"""Resumable run layout, state, event log, and best snapshots."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .models import ExperimentNode


def _atomic_json_write(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@dataclass
class RunState:
    next_step: int = 1
    attempts: int = 0
    successes: int = 0
    failures: int = 0
    consecutive_failures: int = 0
    rounds_without_improvement: int = 0
    best_node_id: Optional[int] = None
    best_score: Optional[float] = None
    best_utility: Optional[float] = None
    last_updated: str = ""

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "RunState":
        allowed = cls.__dataclass_fields__.keys()
        return cls(**{key: value[key] for key in allowed if key in value})


class RunWorkspace:
    """Own all durable artifacts for one named evolution run."""

    def __init__(self, run_dir: Path | str):
        self.run_dir = Path(run_dir).resolve()
        self.steps_dir = self.run_dir / "steps"
        self.best_dir = self.run_dir / "best"
        self.database_dir = self.run_dir / "database"
        self.cognition_dir = self.run_dir / "cognition"
        self.state_path = self.run_dir / "state.json"
        self.events_path = self.run_dir / "events.jsonl"

    def initialize(self) -> "RunWorkspace":
        for path in (
            self.run_dir,
            self.steps_dir,
            self.best_dir,
            self.database_dir,
            self.cognition_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        if not self.events_path.exists():
            self.events_path.write_text("", encoding="utf-8")
        if not self.state_path.exists():
            self.save_state(RunState())
        return self

    def load_state(self) -> RunState:
        self.initialize()
        return RunState.from_dict(json.loads(self.state_path.read_text(encoding="utf-8")))

    def save_state(self, state: RunState) -> None:
        state.last_updated = datetime.now(timezone.utc).isoformat()
        _atomic_json_write(self.state_path, asdict(state))

    def allocate_step(self) -> tuple[int, Path]:
        state = self.load_state()
        step = state.next_step
        state.next_step += 1
        state.attempts += 1
        self.save_state(state)
        step_dir = self.steps_dir / f"step_{step:04d}"
        step_dir.mkdir(parents=True, exist_ok=False)
        self.append_event("step_started", {"step": step})
        return step, step_dir

    def complete_step(self, *, success: bool, node: Optional[ExperimentNode] = None) -> None:
        state = self.load_state()
        if success:
            state.successes += 1
            state.consecutive_failures = 0
        else:
            state.failures += 1
            state.consecutive_failures += 1
        if node is not None and (
            state.best_utility is None or node.score.selection_value > state.best_utility
        ):
            state.best_score = node.score.final
            state.best_utility = node.score.selection_value
            state.best_node_id = node.id
        self.save_state(state)
        self.append_event(
            "step_completed",
            {"success": success, "node_id": node.id if node else None},
        )

    def update_best(self, node: ExperimentNode, step_dir: Path) -> bool:
        state = self.load_state()
        if (
            state.best_utility is not None
            and node.score.selection_value <= state.best_utility
        ):
            state.rounds_without_improvement += 1
            self.save_state(state)
            return False
        target = self.best_dir / f"node_{node.id}"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(step_dir, target)
        (self.best_dir / "best.json").write_text(
            json.dumps(node.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        state.best_score = node.score.final
        state.best_utility = node.score.selection_value
        state.best_node_id = node.id
        state.rounds_without_improvement = 0
        self.save_state(state)
        return True

    def append_event(self, event: str, payload: Dict[str, Any]) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **payload,
        }
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def ensure_allowed(
        self,
        target: Path | str,
        writable_paths: list[str],
        workspace_root: Path | str | None = None,
    ) -> Path:
        target_path = Path(target).resolve()
        if target_path.is_relative_to(self.run_dir):
            return target_path
        workspace_root = (
            Path(workspace_root).resolve()
            if workspace_root is not None
            else self.run_dir.parent.parent.parent
        )
        for raw in writable_paths:
            path = Path(raw)
            allowed = path.resolve() if path.is_absolute() else (workspace_root / path).resolve()
            if target_path.is_relative_to(allowed):
                return target_path
        raise PermissionError(f"Path is outside the approved mutation scope: {target_path}")
