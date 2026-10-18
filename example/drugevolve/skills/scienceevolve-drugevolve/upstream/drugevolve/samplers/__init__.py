"""Sampler factory."""

from __future__ import annotations

from typing import Any, Dict

from .base import BaseSampler
from .builtin import GreedySampler, IslandSampler, RandomSampler, UCB1Sampler


def create_sampler(
    algorithm: str,
    *,
    state: Dict[str, Any] | None = None,
    **kwargs: Any,
) -> BaseSampler:
    samplers = {
        "random": RandomSampler,
        "greedy": GreedySampler,
        "ucb1": UCB1Sampler,
        "island": IslandSampler,
    }
    try:
        sampler_type = samplers[algorithm]
    except KeyError as exc:
        raise ValueError(
            f"Unknown sampler {algorithm!r}; choose one of {sorted(samplers)}"
        ) from exc
    return sampler_type(state=state, **kwargs)


__all__ = [
    "BaseSampler",
    "GreedySampler",
    "IslandSampler",
    "RandomSampler",
    "UCB1Sampler",
    "create_sampler",
]
