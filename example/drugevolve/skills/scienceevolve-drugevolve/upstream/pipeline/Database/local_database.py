"""Compatibility adapter from the legacy pipeline to the local core store."""

from __future__ import annotations

import random
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import Config
from drugevolve.models import Algorithm as CoreAlgorithm
from drugevolve.models import ExperimentNode, ScoreCard
from drugevolve.storage import LocalExperimentStore
from drugevolve.state import RunWorkspace
from utils.algorithm import Algorithm

from .element import DataElement


@dataclass
class ApiResponse:
    success: bool
    message: str
    data: Optional[Any] = None


class LocalDatabaseClient:
    """Expose the compatibility database API over local JSON storage."""

    def __init__(self, storage_dir: str | Path | None = None):
        sampling_kwargs: Dict[str, Any] = {}
        if Config.SAMPLER_TYPE == "ucb1":
            sampling_kwargs = {
                "c": Config.SAMPLER_EXPLORATION_COEFFICIENT,
            }
        elif Config.SAMPLER_TYPE == "island":
            sampling_kwargs = {
                "num_islands": Config.SAMPLER_NUM_ISLANDS,
                "exploration_ratio": Config.SAMPLER_EXPLORATION_RATIO,
                "exploitation_ratio": Config.SAMPLER_EXPLOITATION_RATIO,
                "feature_dimensions": Config.SAMPLER_FEATURE_DIMENSIONS,
                "feature_bins": Config.SAMPLER_FEATURE_BINS,
            }
        self.store = LocalExperimentStore(
            storage_dir or Path(Config.RUN_DIR) / "database",
            sampling_algorithm=Config.SAMPLER_TYPE,
            sampling_kwargs=sampling_kwargs,
        )

    @staticmethod
    def _to_node(element: DataElement) -> ExperimentNode:
        payload = element.to_dict()
        return ExperimentNode(
            name=element.name,
            algorithm=CoreAlgorithm.from_value(element.algorithm.to_dict()),
            parent=[element.parent] if element.parent and element.parent > 0 else [],
            code="\n\n".join(
                f"# FILE: {name}\n{content}"
                for name, content in sorted(element.program.items())
            ),
            results=element.result,
            analysis=element.analysis,
            experience=element.experience,
            score=ScoreCard(
                primary=float(element.score),
                secondary={},
                judge=float(element.llm_score),
                complexity=float(element.complexity),
                final=float(element.score),
            ),
            metadata={"legacy": payload, "island": element.island},
        )

    @staticmethod
    def _to_element(node: ExperimentNode) -> DataElement:
        payload = dict(node.metadata.get("legacy", {}))
        payload.update(
            index=node.id or 0,
            parent=node.parent[0] if node.parent else 0,
            name=node.name,
            algorithm=node.algorithm.to_dict(),
            analysis=node.analysis,
            experience=node.experience,
            result=node.results,
            score=node.score.final,
            llm_score=node.score.judge or 0.0,
            complexity=int(node.score.complexity or 0),
            island=int(node.metadata.get("island", -1)),
        )
        payload.setdefault("mode", "creation")
        payload.setdefault("program", {})
        payload.setdefault("cognition", "")
        payload.setdefault("ablation", None)
        payload.setdefault("enhancement", None)
        payload.setdefault("score_detail", {})
        return DataElement.from_dict(payload)

    def add_element(self, element_data: Dict[str, Any]) -> ApiResponse:
        element = DataElement.from_dict(element_data)
        node = self._to_node(element)
        node_id = self.store.add(node)
        workspace = RunWorkspace(Config.RUN_DIR).initialize()
        step_dir = workspace.steps_dir / f"step_{node_id:04d}"
        step_dir.mkdir(parents=True, exist_ok=True)
        (step_dir / "node.json").write_text(
            json.dumps(node.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (step_dir / "results.json").write_text(
            json.dumps(element.result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (step_dir / "program.json").write_text(
            json.dumps(element.program, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (step_dir / "analysis.md").write_text(element.analysis, encoding="utf-8")
        workspace.update_best(node, step_dir)
        return ApiResponse(True, "Element added", {"index": node_id})

    def get_elements_by_index(self, index: int) -> Optional[DataElement]:
        node = self.store.get(index)
        return self._to_element(node) if node else None

    def get_multi_elements_by_index(self, indexes: List[int]) -> List[DataElement]:
        return [item for index in indexes if (item := self.get_elements_by_index(index))]

    def get_elements_by_name(self, name: str) -> List[DataElement]:
        return [self._to_element(node) for node in self.store.all() if node.name == name]

    def sample_element(self) -> Optional[DataElement]:
        nodes = self.store.all()
        return self._to_element(random.choice(nodes)) if nodes else None

    def get_ucb1_elements(self, num: int, score_source: str = "all") -> List[DataElement]:
        del score_source
        return [self._to_element(node) for node in self.store.sample(num)]

    def get_island_elements(
        self,
        num: int = 1,
        exploration_ratio: float | None = None,
        exploitation_ratio: float | None = None,
    ) -> List[DataElement]:
        del exploration_ratio, exploitation_ratio
        return [self._to_element(node) for node in self.store.sample(num)]

    def get_island_elements_from_island(
        self,
        island_id: int,
        num: int = 1,
        exploration_ratio: float | None = None,
        exploitation_ratio: float | None = None,
    ) -> List[DataElement]:
        del exploration_ratio, exploitation_ratio
        candidates = [
            node
            for node in self.store.all()
            if int(node.metadata.get("island", -1)) == int(island_id)
        ]
        candidates.sort(key=lambda node: node.score.selection_value, reverse=True)
        return [self._to_element(node) for node in candidates[:num]]

    def search_similar_motivations(
        self, algorithm: Algorithm, top_k: int = 5
    ) -> List[DataElement]:
        query = " ".join((algorithm.motivation, algorithm.explain, algorithm.math))
        return [self._to_element(node) for node in self.store.search(query, top_k)]

    def get_contextual_elements(self, parent_index: int) -> Dict[str, Any]:
        parent = self.get_elements_by_index(parent_index)
        if parent is None:
            return {}
        result: Dict[str, Any] = {"direct_parent": parent.to_dict()}
        if parent.parent:
            grandparent = self.get_elements_by_index(parent.parent)
            if grandparent:
                result["grandparent"] = grandparent.to_dict()
        return result

    def get_stats(self) -> Dict[str, Any]:
        return self.store.stats()
