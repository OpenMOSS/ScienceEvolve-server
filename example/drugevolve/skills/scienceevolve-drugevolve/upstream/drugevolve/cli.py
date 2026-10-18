"""Dependency-light CLI for reproducible evolution run operations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional

from .config import load_run_spec, save_run_spec, write_preflight_summary
from .cognition import CognitionStore
from .evaluators import SubprocessEvaluator
from .models import Algorithm, ExperimentNode, ScoreCard
from .state import RunWorkspace
from .storage import LocalExperimentStore


def _emit(payload: Dict[str, Any]) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _workspace(args: argparse.Namespace) -> RunWorkspace:
    return RunWorkspace(Path(args.run_dir)).initialize()


def _spec(workspace: RunWorkspace):
    return load_run_spec(workspace.run_dir / "run_spec.yaml")


def _store(workspace: RunWorkspace, spec) -> LocalExperimentStore:
    kwargs: Dict[str, Any] = {}
    if spec.sampling.algorithm == "ucb1":
        kwargs["c"] = spec.sampling.exploration_coefficient
    elif spec.sampling.algorithm == "island":
        kwargs.update(
            num_islands=spec.sampling.num_islands,
            exploration_ratio=spec.sampling.exploration_ratio,
            exploitation_ratio=spec.sampling.exploitation_ratio,
            feature_dimensions=spec.sampling.feature_dimensions,
            feature_bins=spec.sampling.feature_bins,
        )
    return LocalExperimentStore(
        workspace.database_dir,
        sampling_algorithm=spec.sampling.algorithm,
        sampling_kwargs=kwargs,
    )


def cmd_init(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    source = Path(args.spec).resolve()
    spec = load_run_spec(source)
    target = workspace.run_dir / "run_spec.yaml"
    save_run_spec(target, spec)
    summary = write_preflight_summary(
        workspace.run_dir / "preflight.md",
        spec,
        Path(args.workspace_root).resolve(),
    )
    return _emit(
        {
            "run_dir": str(workspace.run_dir),
            "run_spec": str(target),
            "preflight_summary": str(summary),
            "confirmed": spec.confirmed,
            "missing_fields": spec.missing_fields(Path(args.workspace_root).resolve()),
        }
    )


def cmd_preflight(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    path = workspace.run_dir / "run_spec.yaml"
    spec = load_run_spec(path)
    missing = spec.missing_fields(Path(args.workspace_root).resolve())
    if args.confirm:
        if missing:
            raise SystemExit("Cannot confirm incomplete preflight: " + ", ".join(missing))
        spec.confirmed = True
        save_run_spec(path, spec)
    write_preflight_summary(
        workspace.run_dir / "preflight.md",
        spec,
        Path(args.workspace_root).resolve(),
    )
    return _emit(
        {"confirmed": spec.confirmed, "missing_fields": missing, "ready": not missing and spec.confirmed}
    )


def cmd_evaluate(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    spec = _spec(workspace)
    root = Path(args.workspace_root).resolve()
    spec.require_ready(root)
    candidate = workspace.ensure_allowed(
        Path(args.candidate).resolve(), spec.mutation_scope.writable_paths, root
    )
    _, step_dir = workspace.allocate_step()
    evaluator = SubprocessEvaluator(
        spec.evaluation.command,
        spec.evaluation.timeout_secs,
    )
    result = evaluator.evaluate(candidate, step_dir, root)
    workspace.complete_step(success=result.success)
    return _emit({"step_dir": str(step_dir), "result": result.to_dict()})


def _candidate_text(path: Path) -> str:
    if path.is_file():
        return path.read_text(encoding="utf-8")
    sections = []
    for child in sorted(path.rglob("*")):
        if child.is_file() and child.suffix in {".py", ".sh", ".yaml", ".yml", ".json"}:
            sections.append(f"# FILE: {child.relative_to(path)}\n{child.read_text(encoding='utf-8')}")
    return "\n\n".join(sections)


def cmd_record(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    spec = _spec(workspace)
    root = Path(args.workspace_root).resolve()
    spec.require_ready(root)
    store = _store(workspace, spec)
    candidate = workspace.ensure_allowed(
        Path(args.candidate).resolve(), spec.mutation_scope.writable_paths, root
    )
    results_path = Path(args.results).resolve()
    if not results_path.is_relative_to(workspace.run_dir):
        results_path = workspace.ensure_allowed(
            results_path, spec.mutation_scope.writable_paths, root
        )
    results = json.loads(results_path.read_text(encoding="utf-8"))
    score = float(results.get("score", results.get("eval_score", 0.0)))
    node = ExperimentNode(
        name=args.name,
        parent=args.parent or [],
        algorithm=Algorithm(
            motivation=args.motivation or "",
            explain=args.explain or "",
            math=args.math or "",
        ),
        code=_candidate_text(candidate),
        results=results,
        analysis=(
            workspace.ensure_allowed(
                Path(args.analysis).resolve(),
                spec.mutation_scope.writable_paths,
                root,
            ).read_text(encoding="utf-8")
            if args.analysis
            else ""
        ),
        score=ScoreCard.combine(score, direction=spec.evaluation.direction),
    )
    node_id = store.add(node)
    step_dir = results_path.parent
    if step_dir.is_relative_to(workspace.steps_dir):
        (step_dir / "node.json").write_text(
            json.dumps(node.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        workspace.update_best(node, step_dir)
    return _emit({"node_id": node_id, "score": node.score.final})


def cmd_sample(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    spec = _spec(workspace)
    spec.require_ready(Path(args.workspace_root).resolve())
    nodes = _store(workspace, spec).sample(args.n or spec.sampling.sample_n)
    return _emit({"nodes": [node.to_dict() for node in nodes]})


def cmd_best(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    spec = _spec(workspace)
    spec.require_ready(Path(args.workspace_root).resolve())
    best = _store(workspace, spec).best()
    return _emit({"best": best.to_dict() if best else None})


def cmd_stats(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    spec = _spec(workspace)
    spec.require_ready(Path(args.workspace_root).resolve())
    return _emit({"run": workspace.load_state().__dict__, "database": _store(workspace, spec).stats()})


def cmd_cognition_add(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    item = CognitionStore(workspace.cognition_dir).add(
        args.content,
        source=args.source or "user",
        metadata={"kind": args.kind} if args.kind else {},
    )
    return _emit({"item": item.__dict__})


def cmd_cognition_search(args: argparse.Namespace) -> int:
    workspace = _workspace(args)
    matches = CognitionStore(workspace.cognition_dir).search(args.query, args.top_k)
    return _emit(
        {
            "matches": [
                {"item": item.__dict__, "score": score} for item, score in matches
            ]
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="drugevolve")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Initialize a run from a YAML run spec")
    init.add_argument("--run-dir", required=True)
    init.add_argument("--workspace-root", default=".")
    init.add_argument("--spec", required=True)
    init.set_defaults(func=cmd_init)

    preflight = sub.add_parser("preflight", help="Validate or explicitly confirm a run")
    preflight.add_argument("--run-dir", required=True)
    preflight.add_argument("--workspace-root", default=".")
    preflight.add_argument("--confirm", action="store_true")
    preflight.set_defaults(func=cmd_preflight)

    evaluate = sub.add_parser("evaluate", help="Materialize and evaluate a candidate")
    evaluate.add_argument("--run-dir", required=True)
    evaluate.add_argument("--workspace-root", default=".")
    evaluate.add_argument("--candidate", required=True)
    evaluate.set_defaults(func=cmd_evaluate)

    record = sub.add_parser("record", help="Record an evaluated candidate")
    record.add_argument("--run-dir", required=True)
    record.add_argument("--workspace-root", default=".")
    record.add_argument("--candidate", required=True)
    record.add_argument("--results", required=True)
    record.add_argument("--name", required=True)
    record.add_argument("--parent", type=int, action="append")
    record.add_argument("--motivation")
    record.add_argument("--explain")
    record.add_argument("--math")
    record.add_argument("--analysis")
    record.set_defaults(func=cmd_record)

    for name, function in (("sample", cmd_sample), ("best", cmd_best), ("stats", cmd_stats)):
        command = sub.add_parser(name)
        command.add_argument("--run-dir", required=True)
        command.add_argument("--workspace-root", default=".")
        if name == "sample":
            command.add_argument("-n", type=int)
        command.set_defaults(func=function)

    cognition_add = sub.add_parser("cognition-add", help="Store a reusable external insight")
    cognition_add.add_argument("--run-dir", required=True)
    cognition_add.add_argument("--content", required=True)
    cognition_add.add_argument("--source")
    cognition_add.add_argument("--kind")
    cognition_add.set_defaults(func=cmd_cognition_add)

    cognition_search = sub.add_parser("cognition-search", help="Search external insights")
    cognition_search.add_argument("--run-dir", required=True)
    cognition_search.add_argument("--query", required=True)
    cognition_search.add_argument("--top-k", type=int, default=5)
    cognition_search.set_defaults(func=cmd_cognition_search)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
