"""Storage interface for evolution history."""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import ExperimentNode


class ExperimentStore(ABC):
    @abstractmethod
    def add(self, node: ExperimentNode) -> int:
        raise NotImplementedError

    @abstractmethod
    def get(self, node_id: int) -> ExperimentNode | None:
        raise NotImplementedError

    @abstractmethod
    def all(self) -> list[ExperimentNode]:
        raise NotImplementedError

    @abstractmethod
    def sample(self, n: int) -> list[ExperimentNode]:
        raise NotImplementedError

    @abstractmethod
    def search(self, query: str, top_k: int = 5) -> list[ExperimentNode]:
        raise NotImplementedError

    def best(self) -> ExperimentNode | None:
        nodes = self.all()
        return max(nodes, key=lambda item: item.score.selection_value) if nodes else None
