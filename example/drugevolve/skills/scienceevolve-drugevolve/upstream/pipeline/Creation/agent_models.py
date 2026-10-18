"""Centralized model configuration for DrugEvolve agents.

LLM Configurations for Each Functional Module
--------------------------------------------
Different roles may use different models when a deployment benefits from
heterogeneous cost, latency, and reasoning trade-offs. The framework itself
does not require a particular provider or model family.

The public default assigns every role to ``DRUGEVOLVE_DEFAULT_MODEL``.
Deployments can still use heterogeneous models with the
``DRUGEVOLVE_AGENT_MODELS`` environment-variable override:

    DRUGEVOLVE_AGENT_MODELS='{"creation.researcher.creator.generator": "your-model"}'
"""

from __future__ import annotations

import json
import os
from typing import Dict, Optional


# Provider/model choice is deployment configuration, not framework logic.
DEFAULT_MODEL = os.getenv("DRUGEVOLVE_DEFAULT_MODEL", "gpt-4o-mini")

AGENT_MODELS: Dict[str, str] = {
    # ------------------------------------------------------------------ #
    # Researcher: synthesize & inspect novel algorithmic hypotheses.       #
    # ------------------------------------------------------------------ #
    # Generator: strongest reasoning model — proposes new algorithms.
    "creation.researcher.creator.generator": DEFAULT_MODEL,
    # Inspector: lightweight model — high-throughput redundancy screening.
    "creation.researcher.inspector": DEFAULT_MODEL,

    # ------------------------------------------------------------------ #
    # Implementer: translate the abstract hypothesis into runnable code.  #
    # Strong software-engineering / code-generation capability required.  #
    # ------------------------------------------------------------------ #
    "creation.researcher.implementer": DEFAULT_MODEL,

    # ------------------------------------------------------------------ #
    # Engineer: validation & assessment stages.                           #
    # Debugger can use a lightweight model for fast iteration.           #
    # ------------------------------------------------------------------ #
    "creation.engineer.debugger": DEFAULT_MODEL,

    # ------------------------------------------------------------------ #
    # Judger & Analyst: multi-dimensional evaluation + interpretability.   #
    # ------------------------------------------------------------------ #
    "creation.engineer.judger": DEFAULT_MODEL,
    "creation.analyst.analyzer": DEFAULT_MODEL,
    "creation.analyst.summarizer": DEFAULT_MODEL,
}


def _load_env_overrides() -> Dict[str, str]:
    raw = os.getenv("DRUGEVOLVE_AGENT_MODELS")
    if not raw:
        return {}
    try:
        return {str(k): str(v) for k, v in json.loads(raw).items()}
    except json.JSONDecodeError:
        return {}


_ENV_OVERRIDES = _load_env_overrides()


def get_agent_model(key: str, default: Optional[str] = None) -> str:
    """Return the model name for a given agent key.

    Resolution order:
    1. ``DRUGEVOLVE_AGENT_MODELS`` JSON env-var override.
    2. Static ``AGENT_MODELS`` mapping.
    3. Caller-provided ``default``.
    4. Fallback ``gpt-5-mini``.
    """
    if key in _ENV_OVERRIDES:
        return _ENV_OVERRIDES[key]
    if key in AGENT_MODELS:
        return AGENT_MODELS[key]
    return default or DEFAULT_MODEL


__all__ = ["AGENT_MODELS", "DEFAULT_MODEL", "get_agent_model"]
