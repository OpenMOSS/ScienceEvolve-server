"""Serializable domain models shared by storage, evaluators, and the CLI."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Sequence


@dataclass(frozen=True)
class Algorithm:
    """A task-independent algorithm proposal."""

    motivation: str = ""
    explain: str = ""
    math: str = ""

    @classmethod
    def from_value(cls, value: Any) -> "Algorithm":
        if isinstance(value, cls):
            return value
        if isinstance(value, Mapping):
            return cls(
                motivation=str(value.get("motivation", "")),
                explain=str(value.get("explain", "")),
                math=str(value.get("math", "")),
            )
        if all(hasattr(value, field) for field in ("motivation", "explain", "math")):
            return cls(
                motivation=str(value.motivation),
                explain=str(value.explain),
                math=str(value.math),
            )
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            if len(value) != 3:
                raise ValueError("Algorithm sequences must contain exactly three values")
            return cls(*(str(item) for item in value))
        raise TypeError(f"Unsupported Algorithm value: {type(value).__name__}")

    def to_dict(self) -> Dict[str, str]:
        return asdict(self)

    def to_tuple(self) -> tuple[str, str, str]:
        return (self.motivation, self.explain, self.math)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Algorithm":
        return cls.from_value(value)

    @classmethod
    def from_tuple(cls, value: Sequence[Any]) -> "Algorithm":
        return cls.from_value(value)


@dataclass
class ScoreCard:
    """Explicit scoring channels used by evolution and reporting."""

    primary: float = 0.0
    secondary: Dict[str, float] = field(default_factory=dict)
    judge: Optional[float] = None
    complexity: Optional[float] = None
    final: float = 0.0
    direction: str = "maximize"

    @classmethod
    def combine(
        cls,
        primary: float,
        *,
        judge: Optional[float] = None,
        primary_weight: float = 1.0,
        judge_weight: float = 0.0,
        secondary: Optional[Dict[str, float]] = None,
        complexity: Optional[float] = None,
        direction: str = "maximize",
    ) -> "ScoreCard":
        if primary_weight < 0 or judge_weight < 0:
            raise ValueError("Score weights must be non-negative")
        effective_judge_weight = judge_weight if judge is not None else 0.0
        total = primary_weight + effective_judge_weight
        if total <= 0:
            raise ValueError("At least one available score channel must have positive weight")
        if direction not in {"maximize", "minimize"}:
            raise ValueError("Score direction must be 'maximize' or 'minimize'")
        final = (primary_weight * float(primary)) / total
        if judge is not None:
            final += effective_judge_weight * float(judge) / total
        return cls(
            primary=float(primary),
            secondary={k: float(v) for k, v in (secondary or {}).items()},
            judge=float(judge) if judge is not None else None,
            complexity=float(complexity) if complexity is not None else None,
            final=final,
            direction=direction,
        )

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ScoreCard":
        return cls(
            primary=float(value.get("primary", value.get("final", 0.0))),
            secondary={
                str(k): float(v) for k, v in dict(value.get("secondary", {})).items()
            },
            judge=float(value["judge"]) if value.get("judge") is not None else None,
            complexity=(
                float(value["complexity"])
                if value.get("complexity") is not None
                else None
            ),
            final=float(value.get("final", value.get("primary", 0.0))),
            direction=str(value.get("direction", "maximize")),
        )

    @property
    def selection_value(self) -> float:
        """Utility used internally by samplers; larger is always better."""
        return self.final if self.direction == "maximize" else -self.final

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ExperimentNode:
    """One immutable-in-history experiment branch in the evolution graph."""

    name: str
    algorithm: Algorithm = field(default_factory=Algorithm)
    parent: list[int] = field(default_factory=list)
    code: str = ""
    results: Dict[str, Any] = field(default_factory=dict)
    analysis: str = ""
    experience: str = ""
    score: ScoreCard = field(default_factory=ScoreCard)
    metadata: Dict[str, Any] = field(default_factory=dict)
    id: Optional[int] = None
    visit_count: int = 0
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ExperimentNode":
        return cls(
            id=int(value["id"]) if value.get("id") is not None else None,
            name=str(value.get("name", "")),
            algorithm=Algorithm.from_value(value.get("algorithm", {})),
            parent=[int(item) for item in value.get("parent", [])],
            code=str(value.get("code", "")),
            results=dict(value.get("results", {})),
            analysis=str(value.get("analysis", "")),
            experience=str(value.get("experience", "")),
            score=ScoreCard.from_dict(value.get("score", {})),
            metadata=dict(value.get("metadata", {})),
            visit_count=int(value.get("visit_count", 0)),
            created_at=str(value.get("created_at", ""))
            or datetime.now(timezone.utc).isoformat(),
        )

    def context_text(self) -> str:
        return " ".join(
            part
            for part in (
                self.name,
                self.algorithm.motivation,
                self.algorithm.explain,
                self.analysis,
                self.experience,
            )
            if part
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "algorithm": self.algorithm.to_dict(),
            "parent": self.parent,
            "code": self.code,
            "results": self.results,
            "analysis": self.analysis,
            "experience": self.experience,
            "score": self.score.to_dict(),
            "metadata": self.metadata,
            "visit_count": self.visit_count,
            "created_at": self.created_at,
        }
