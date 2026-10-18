"""Judger agent invocation."""

from __future__ import annotations

from typing import Any, Dict, Tuple

from utils.agent import run
from utils.algorithm import Algorithm
from .model import judger
from .prompt import judger_input


async def judge(algorithm: Algorithm, result: Dict[str, Any]) -> Tuple[float, int]:
    """Return ``(final_score, complexity)`` for the candidate algorithm."""
    response = await run("judger", judger, judger_input(algorithm, result))
    return response.final_score, response.complexity


__all__ = ["judge"]