"""Run specification loading and preflight validation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional


@dataclass
class EvaluationSpec:
    command: str = ""
    core_score: str = "score"
    direction: str = "maximize"
    secondary_metrics: list[str] = field(default_factory=list)
    timeout_secs: int = 0
    success_criteria: list[str] = field(default_factory=list)


@dataclass
class BudgetSpec:
    max_rounds: int = 0
    patience: int = 0
    max_consecutive_failures: int = 3


@dataclass
class MutationScope:
    writable_paths: list[str] = field(default_factory=list)
    primary_targets: list[str] = field(default_factory=list)


@dataclass
class SamplingSpec:
    algorithm: str = "ucb1"
    sample_n: int = 3
    exploration_coefficient: float = 1.414
    num_islands: int = 4
    exploration_ratio: float = 0.2
    exploitation_ratio: float = 0.3
    feature_dimensions: list[str] = field(
        default_factory=lambda: ["complexity", "diversity"]
    )
    feature_bins: int = 10


@dataclass
class CognitionSpec:
    source_mode: str = "none"
    seed_files: list[str] = field(default_factory=list)


@dataclass
class RunSpec:
    """The reproducibility and safety contract for one evolution run."""

    objective: str = ""
    evaluation: EvaluationSpec = field(default_factory=EvaluationSpec)
    budget: BudgetSpec = field(default_factory=BudgetSpec)
    stop_conditions: list[str] = field(default_factory=list)
    mutation_scope: MutationScope = field(default_factory=MutationScope)
    sampling: SamplingSpec = field(default_factory=SamplingSpec)
    cognition: CognitionSpec = field(default_factory=CognitionSpec)
    confirmed: bool = False

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RunSpec":
        return cls(
            objective=str(value.get("objective", "")),
            evaluation=EvaluationSpec(**dict(value.get("evaluation", {}))),
            budget=BudgetSpec(**dict(value.get("budget", {}))),
            stop_conditions=list(value.get("stop_conditions", [])),
            mutation_scope=MutationScope(**dict(value.get("mutation_scope", {}))),
            sampling=SamplingSpec(**dict(value.get("sampling", {}))),
            cognition=CognitionSpec(**dict(value.get("cognition", {}))),
            confirmed=bool(
                value.get("confirmed", value.get("approval", {}).get("confirmed", False))
            ),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def missing_fields(self, workspace_root: Optional[Path] = None) -> list[str]:
        missing: list[str] = []
        if not self.objective.strip():
            missing.append("objective")
        if not self.evaluation.command.strip():
            missing.append("evaluation.command")
        if not self.evaluation.core_score.strip():
            missing.append("evaluation.core_score")
        if self.evaluation.direction not in {"maximize", "minimize"}:
            missing.append("evaluation.direction")
        if self.evaluation.timeout_secs <= 0:
            missing.append("evaluation.timeout_secs")
        if not self.evaluation.success_criteria:
            missing.append("evaluation.success_criteria")
        if self.budget.max_rounds <= 0:
            missing.append("budget.max_rounds")
        if self.budget.patience < 0:
            missing.append("budget.patience")
        if self.budget.max_consecutive_failures <= 0:
            missing.append("budget.max_consecutive_failures")
        if not self.stop_conditions:
            missing.append("stop_conditions")
        if not self.mutation_scope.writable_paths:
            missing.append("mutation_scope.writable_paths")
        if not self.mutation_scope.primary_targets:
            missing.append("mutation_scope.primary_targets")
        if self.sampling.algorithm not in {"random", "greedy", "ucb1", "island"}:
            missing.append("sampling.algorithm")
        if self.sampling.sample_n <= 0:
            missing.append("sampling.sample_n")
        if not self.cognition.source_mode.strip():
            missing.append("cognition.source_mode")

        if workspace_root is not None:
            root = Path(workspace_root).resolve()
            for raw in self.mutation_scope.primary_targets:
                path = Path(raw)
                target = path.resolve() if path.is_absolute() else (root / path).resolve()
                if not any(
                    target.is_relative_to(
                        Path(allowed).resolve()
                        if Path(allowed).is_absolute()
                        else (root / allowed).resolve()
                    )
                    for allowed in self.mutation_scope.writable_paths
                ):
                    missing.append(f"mutation_scope.primary_target_allowed:{raw}")
        return missing

    def require_ready(self, workspace_root: Optional[Path] = None) -> None:
        missing = self.missing_fields(workspace_root)
        if missing:
            raise ValueError("Preflight is incomplete: " + ", ".join(missing))
        if not self.confirmed:
            raise PermissionError("Preflight has not been explicitly confirmed")


def load_run_spec(path: Path | str) -> RunSpec:
    import yaml

    spec_path = Path(path)
    payload = yaml.safe_load(spec_path.read_text(encoding="utf-8")) or {}
    return RunSpec.from_dict(payload)


def save_run_spec(path: Path | str, spec: RunSpec) -> Path:
    import yaml

    spec_path = Path(path)
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(
        yaml.safe_dump(spec.to_dict(), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return spec_path


def write_preflight_summary(
    path: Path | str,
    spec: RunSpec,
    workspace_root: Optional[Path] = None,
) -> Path:
    missing = spec.missing_fields(workspace_root)
    status = "READY" if spec.confirmed and not missing else "PENDING"
    lines = [
        "# DrugEvolve Preflight",
        "",
        f"- Status: `{status}`",
        f"- Objective: {spec.objective or '(missing)'}",
        f"- Core score: {spec.evaluation.core_score or '(missing)'} ({spec.evaluation.direction})",
        f"- Evaluator: `{spec.evaluation.command or '(missing)'}`",
        f"- Timeout: {spec.evaluation.timeout_secs} seconds",
        f"- Budget: {spec.budget.max_rounds} rounds, patience={spec.budget.patience}",
        f"- Sampler: {spec.sampling.algorithm}, sample_n={spec.sampling.sample_n}",
        f"- Writable paths: {', '.join(spec.mutation_scope.writable_paths) or '(missing)'}",
        f"- Primary targets: {', '.join(spec.mutation_scope.primary_targets) or '(missing)'}",
        f"- Cognition source: {spec.cognition.source_mode or '(missing)'}",
        f"- Confirmed: {spec.confirmed}",
        "",
        "## Missing fields",
    ]
    lines.extend(f"- {item}" for item in missing)
    if not missing:
        lines.append("- none")
    summary_path = Path(path)
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return summary_path
