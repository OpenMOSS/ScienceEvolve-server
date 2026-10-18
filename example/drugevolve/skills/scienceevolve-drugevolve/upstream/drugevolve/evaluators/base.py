"""Evaluator contract."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class EvaluationResult:
    success: bool
    score: float
    metrics: Dict[str, float] = field(default_factory=dict)
    artifacts: Dict[str, str] = field(default_factory=dict)
    error: Optional[str] = None
    return_code: int = 0
    runtime_secs: float = 0.0

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "EvaluationResult":
        metrics = value.get("metrics", {})
        return cls(
            success=bool(value.get("success", False)),
            score=float(value.get("score", value.get("eval_score", 0.0))),
            metrics={str(k): float(v) for k, v in dict(metrics).items()},
            artifacts={str(k): str(v) for k, v in dict(value.get("artifacts", {})).items()},
            error=str(value["error"]) if value.get("error") is not None else None,
            return_code=int(value.get("return_code", 0)),
            runtime_secs=float(value.get("runtime_secs", value.get("runtime", 0.0))),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class Evaluator(ABC):
    @abstractmethod
    def evaluate(
        self,
        candidate_path: Path,
        step_dir: Path,
        workspace_root: Path,
    ) -> EvaluationResult:
        raise NotImplementedError
