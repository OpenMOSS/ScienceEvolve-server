"""Domain object representing one experiment in the DrugEvolve database."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional

from drugevolve.models import Algorithm
from drugevolve.text import keep_header_and_final


@dataclass
class DataElement:
    """A single DrugEvolve experiment record."""

    index: int
    parent: int
    name: str
    mode: str
    result: Dict[str, Any]
    program: Dict[str, str]
    algorithm: Algorithm
    analysis: str
    cognition: str
    experience: str
    ablation: Optional[int]
    enhancement: Optional[str]
    score: float
    score_detail: Dict[str, Any]
    llm_score: float = 0.0
    complexity: int = 0
    island: int = -1  # MAP-Elites island index (-1 if not assigned)

    def __post_init__(self) -> None:
        self.algorithm = Algorithm.from_value(self.algorithm)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    async def get_context(self) -> str:
        """Render a Markdown-friendly context block for the next Creator."""
        algorithm = self.algorithm
        if isinstance(algorithm, dict):
            explain = algorithm.get("explain", "")
            math = algorithm.get("math", "")
        else:
            explain = getattr(algorithm, "explain", "")
            math = getattr(algorithm, "math", "")

        return (
            f"#### Experiment: {self.name}\n"
            f"#### Algorithm Details\n"
            f"- Explanation: {explain}\n"
            f"- Mathematical Formulation: {math}\n\n"
            f"#### Performance Metrics Summary\n"
            f"- Evaluation Results: {keep_header_and_final(self.result.get('test', ''))}\n\n"
            f"#### Synthesized Experimental Insights\n"
            f"{self.experience}\n"
        )

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DataElement":
        normalized = dict(data)
        normalized["algorithm"] = Algorithm.from_value(normalized.get("algorithm", {}))
        return cls(**normalized)


__all__ = ["DataElement"]
