"""Built-in exploration/exploitation strategies."""

from __future__ import annotations

import math
import random
import hashlib
from typing import Any, Optional

from .base import BaseSampler
from ..models import ExperimentNode


class RandomSampler(BaseSampler):
    def sample(self, nodes: list[ExperimentNode], n: int) -> list[ExperimentNode]:
        if not nodes:
            return []
        return self._mark(random.sample(nodes, min(n, len(nodes))))


class GreedySampler(BaseSampler):
    def sample(self, nodes: list[ExperimentNode], n: int) -> list[ExperimentNode]:
        selected = sorted(
            nodes, key=lambda item: item.score.selection_value, reverse=True
        )[:n]
        return self._mark(selected)


class UCB1Sampler(BaseSampler):
    def __init__(self, c: float = 1.414, **kwargs: Any):
        super().__init__(**kwargs)
        self.c = float(c)

    def sample(self, nodes: list[ExperimentNode], n: int) -> list[ExperimentNode]:
        if not nodes:
            return []
        n = min(n, len(nodes))
        total_visits = sum(node.visit_count for node in nodes)
        unvisited = [node for node in nodes if node.visit_count == 0]
        if len(unvisited) >= n:
            return self._mark(random.sample(unvisited, n))

        scores = [node.score.selection_value for node in nodes]
        low, high = min(scores), max(scores)
        spread = high - low or 1.0
        ranked: list[tuple[float, ExperimentNode]] = []
        for node in nodes:
            if node.visit_count == 0:
                value = float("inf")
            else:
                quality = (node.score.selection_value - low) / spread
                exploration = self.c * math.sqrt(
                    math.log(max(total_visits, 1) + 1) / node.visit_count
                )
                value = quality + exploration
            ranked.append((value, node))
        ranked.sort(key=lambda item: item[0], reverse=True)
        return self._mark([node for _, node in ranked[:n]])


class IslandSampler(BaseSampler):
    """A compact island/archive sampler with diversity-oriented rotation."""

    def __init__(
        self,
        num_islands: int = 4,
        exploration_ratio: float = 0.2,
        exploitation_ratio: float = 0.3,
        feature_dimensions: list[str] | None = None,
        feature_bins: int = 10,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        if num_islands <= 0:
            raise ValueError("num_islands must be positive")
        if exploration_ratio < 0 or exploitation_ratio < 0:
            raise ValueError("Island sampling ratios must be non-negative")
        if exploration_ratio + exploitation_ratio > 1:
            raise ValueError("Island sampling ratios must sum to at most 1")
        self.num_islands = int(num_islands)
        self.exploration_ratio = float(exploration_ratio)
        self.exploitation_ratio = float(exploitation_ratio)
        self.feature_dimensions = feature_dimensions or ["complexity", "diversity"]
        self.feature_bins = int(feature_bins)
        if self.feature_bins <= 0:
            raise ValueError("feature_bins must be positive")
        self.current_island = int(self.state.get("current_island", 0)) % self.num_islands
        self.state.setdefault("feature_stats", {})
        self.state.setdefault("archive", {})

    def on_node_added(self, node: ExperimentNode) -> None:
        coordinates = self._feature_coordinates(node)
        if coordinates is not None:
            niche = ",".join(str(value) for value in coordinates)
            node.metadata["niche"] = coordinates
            archive = self.state["archive"]
            current = archive.get(niche)
            if current is None or node.score.selection_value > float(current["utility"]):
                archive[niche] = {
                    "node_id": node.id,
                    "utility": node.score.selection_value,
                }
        if "island" not in node.metadata:
            if coordinates is not None:
                digest = hashlib.sha256(str(coordinates).encode("utf-8")).digest()
                node.metadata["island"] = int.from_bytes(digest[:4], "big") % self.num_islands
            elif node.parent:
                node.metadata["island"] = self.current_island
            else:
                node.metadata["island"] = (node.id or 0) % self.num_islands

    def _feature_coordinates(self, node: ExperimentNode) -> list[int] | None:
        features = node.metadata.get("features", {})
        if not self.feature_dimensions:
            return None
        coordinates: list[int] = []
        stats = self.state["feature_stats"]
        for dimension in self.feature_dimensions:
            raw_value = features.get(dimension)
            if not isinstance(raw_value, (int, float)):
                return None
            value = float(raw_value)
            dimension_stats = stats.setdefault(
                dimension, {"min": value, "max": value}
            )
            dimension_stats["min"] = min(float(dimension_stats["min"]), value)
            dimension_stats["max"] = max(float(dimension_stats["max"]), value)
            spread = dimension_stats["max"] - dimension_stats["min"]
            scaled = 0.5 if spread <= 1e-12 else (value - dimension_stats["min"]) / spread
            coordinates.append(
                max(0, min(self.feature_bins - 1, int(scaled * self.feature_bins)))
            )
        return coordinates

    def sample(self, nodes: list[ExperimentNode], n: int) -> list[ExperimentNode]:
        if not nodes:
            return []
        pool = [
            node
            for node in nodes
            if int(node.metadata.get("island", -1)) == self.current_island
        ] or nodes
        selected: list[ExperimentNode] = []
        target_count = min(n, len(nodes))
        while len(selected) < target_count:
            available = [node for node in nodes if node not in selected]
            if not available:
                break
            island_available = [node for node in pool if node not in selected]
            choice_pool = island_available or available
            roll = random.random()
            candidate: Optional[ExperimentNode]
            if roll < self.exploration_ratio:
                candidate = random.choice(choice_pool)
            elif roll < self.exploration_ratio + self.exploitation_ratio:
                archive_ids = {
                    int(item["node_id"])
                    for item in self.state["archive"].values()
                    if item.get("node_id") is not None
                }
                archive_available = [
                    item for item in available if item.id in archive_ids
                ]
                candidate = random.choice(archive_available) if archive_available else max(
                    available, key=lambda item: item.score.selection_value
                )
            else:
                utilities = [item.score.selection_value for item in choice_pool]
                floor = min(utilities)
                weights = [value - floor + 1e-6 for value in utilities]
                candidate = random.choices(choice_pool, weights=weights, k=1)[0]
            selected.append(candidate)
        self.current_island = (self.current_island + 1) % self.num_islands
        self.state["current_island"] = self.current_island
        return self._mark(selected)
