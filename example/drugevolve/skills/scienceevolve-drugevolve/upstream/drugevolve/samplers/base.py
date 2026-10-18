"""Sampler protocol for parent selection."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict

from ..models import ExperimentNode


class BaseSampler(ABC):
    def __init__(self, state: Dict[str, Any] | None = None, **_: Any):
        self.state: Dict[str, Any] = dict(state or {})

    @abstractmethod
    def sample(self, nodes: list[ExperimentNode], n: int) -> list[ExperimentNode]:
        raise NotImplementedError

    def on_node_added(self, node: ExperimentNode) -> None:
        del node

    def get_state(self) -> Dict[str, Any]:
        return self.state

    @staticmethod
    def _mark(nodes: list[ExperimentNode]) -> list[ExperimentNode]:
        for node in nodes:
            node.visit_count += 1
        return nodes
