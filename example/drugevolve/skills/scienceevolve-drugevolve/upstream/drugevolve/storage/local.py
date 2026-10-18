"""Atomic, process-safe JSON experiment storage."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from difflib import SequenceMatcher
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

from .base import ExperimentStore
from ..models import ExperimentNode
from ..samplers import BaseSampler, create_sampler


class LocalExperimentStore(ExperimentStore):
    SCHEMA_VERSION = 1

    def __init__(
        self,
        storage_dir: Path | str,
        *,
        sampling_algorithm: str = "ucb1",
        sampling_kwargs: Optional[Dict[str, Any]] = None,
        max_size: Optional[int] = None,
    ):
        self.storage_dir = Path(storage_dir).resolve()
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.data_path = self.storage_dir / "nodes.json"
        self.lock_path = self.storage_dir / ".lock"
        self.thread_lock = threading.RLock()
        self.sampling_algorithm = sampling_algorithm
        self.sampling_kwargs = dict(sampling_kwargs or {})
        self.max_size = max_size
        self.nodes: dict[int, ExperimentNode] = {}
        self.next_id = 1
        self.sampler: BaseSampler
        self._load()

    @contextmanager
    def _file_lock(self) -> Iterator[None]:
        import fcntl

        with self.lock_path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _load(self) -> None:
        payload: Dict[str, Any] = {}
        if self.data_path.exists():
            payload = json.loads(self.data_path.read_text(encoding="utf-8"))
            stored_algorithm = payload.get("sampling_algorithm", self.sampling_algorithm)
            stored_kwargs = payload.get("sampling_kwargs", self.sampling_kwargs)
            if payload.get("nodes") and (
                stored_algorithm != self.sampling_algorithm
                or stored_kwargs != self.sampling_kwargs
            ):
                raise ValueError(
                    "Sampling configuration cannot change after nodes have been recorded"
                )
            self.next_id = int(payload.get("next_id", 1))
            self.nodes = {
                int(key): ExperimentNode.from_dict(value)
                for key, value in payload.get("nodes", {}).items()
            }
        self.sampler = create_sampler(
            self.sampling_algorithm,
            state=payload.get("sampler_state", {}),
            **self.sampling_kwargs,
        )

    def _reload_locked(self) -> None:
        if self.data_path.exists():
            self._load()

    def _save_locked(self) -> None:
        payload = {
            "schema_version": self.SCHEMA_VERSION,
            "sampling_algorithm": self.sampling_algorithm,
            "sampling_kwargs": self.sampling_kwargs,
            "next_id": self.next_id,
            "sampler_state": self.sampler.get_state(),
            "nodes": {str(key): node.to_dict() for key, node in self.nodes.items()},
        }
        descriptor, temporary = tempfile.mkstemp(
            prefix="nodes.", suffix=".tmp", dir=self.storage_dir
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.replace(temporary, self.data_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def add(self, node: ExperimentNode) -> int:
        with self.thread_lock, self._file_lock():
            self._reload_locked()
            if self.max_size is not None and len(self.nodes) >= self.max_size:
                worst_id = min(
                    self.nodes,
                    key=lambda key: (self.nodes[key].score.selection_value, key),
                )
                del self.nodes[worst_id]
            node.id = self.next_id
            self.next_id += 1
            if self.sampling_algorithm == "island":
                diversity = 1.0
                existing_codes = [item.code for item in self.nodes.values() if item.code]
                if node.code and existing_codes:
                    diversity = sum(
                        1.0 - SequenceMatcher(None, node.code, code).ratio()
                        for code in existing_codes
                    ) / len(existing_codes)
                features: Dict[str, float] = {
                    "complexity": float(len(node.code)),
                    "diversity": float(diversity),
                }
                metrics = node.results.get("metrics", {})
                if isinstance(metrics, dict):
                    for key, value in metrics.items():
                        if isinstance(value, (int, float)):
                            features[str(key)] = float(value)
                for key, value in node.results.items():
                    if isinstance(value, (int, float)):
                        features.setdefault(str(key), float(value))
                node.metadata.setdefault("features", features)
            self.sampler.on_node_added(node)
            self.nodes[node.id] = node
            self._save_locked()
            return node.id

    def get(self, node_id: int) -> ExperimentNode | None:
        with self.thread_lock, self._file_lock():
            self._reload_locked()
            return self.nodes.get(int(node_id))

    def all(self) -> list[ExperimentNode]:
        with self.thread_lock, self._file_lock():
            self._reload_locked()
            return list(self.nodes.values())

    def sample(self, n: int) -> list[ExperimentNode]:
        with self.thread_lock, self._file_lock():
            self._reload_locked()
            selected = self.sampler.sample(list(self.nodes.values()), n)
            self._save_locked()
            return selected

    def search(self, query: str, top_k: int = 5) -> list[ExperimentNode]:
        query_terms = set(re.findall(r"[A-Za-z0-9_]+", query.lower()))
        if not query_terms:
            return []
        ranked: list[tuple[float, ExperimentNode]] = []
        for node in self.all():
            terms = set(re.findall(r"[A-Za-z0-9_]+", node.context_text().lower()))
            union = query_terms | terms
            similarity = len(query_terms & terms) / len(union) if union else 0.0
            if similarity > 0:
                ranked.append((similarity, node))
        ranked.sort(key=lambda item: item[0], reverse=True)
        return [node for _, node in ranked[:top_k]]

    def stats(self) -> Dict[str, Any]:
        nodes = self.all()
        best = max(nodes, key=lambda item: item.score.selection_value) if nodes else None
        return {
            "total_nodes": len(nodes),
            "best_node_id": best.id if best else None,
            "best_score": best.score.final if best else None,
            "sampling_algorithm": self.sampling_algorithm,
        }
