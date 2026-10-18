"""Researcher stage entry point.

Combines the Creator and Implementer agents:

1. ``creator.generate`` proposes a new ``Algorithm`` (motivation, explain,
   math) plus a snake_case ``name``.
2. ``implementer.implementation`` turns that ``Algorithm`` into a working
   ``model.py`` under ``Config.CODE_DIR/algorithm/<name>/``.
"""

from __future__ import annotations

from datetime import datetime

from config import Config
from utils.algorithm import Algorithm
from .creator.infer import creation
from .implementer.infer import implementation


async def evolve(context: str) -> tuple[str, Algorithm]:
    """Run creator + implementer with retry logic."""
    last_error: Exception | None = None
    for _attempt in range(Config.MAX_RETRY_ATTEMPTS):
        try:
            name, algorithm = await creation(context)
            _ = await implementation(name, algorithm)
            timestamp = datetime.now().strftime("%Y%m%d-%H:%M:%S-")
            return timestamp + name, algorithm
        except Exception as e:
            last_error = e
            continue

    raise Exception(
        f"[SKIP] Unable to evolve a valid algorithm after "
        f"{Config.MAX_RETRY_ATTEMPTS} attempts ({last_error})"
    )


__all__ = ["evolve"]