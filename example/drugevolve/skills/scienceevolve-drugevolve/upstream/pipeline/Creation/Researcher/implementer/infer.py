"""Implementer agent invocation."""

from __future__ import annotations

import os

from config import Config
from utils.agent import run
from utils.algorithm import Algorithm
from utils.copy_launch_script import generate_model_content
from .model import implementer
from .prompt import implementer_input


async def implementation(name: str, algorithm: Algorithm):
    """Seed the directory with a starter ``model.py`` and call the implementer."""
    target_dir = os.path.join(Config.CODE_DIR, "algorithm", name)
    os.makedirs(target_dir, exist_ok=True)
    model_path = os.path.join(target_dir, "model.py")
    starter = generate_model_content()
    with open(model_path, "w", encoding="utf-8") as f:
        f.write(starter)

    result = await run(
        "implementer",
        implementer,
        implementer_input(name, algorithm),
        max_turns=10,
    )
    if not result.success:
        raise RuntimeError(f"Implementer reported failure: {result.summary}")

    with open(model_path, "r", encoding="utf-8") as f:
        implemented = f.read()
    if implemented == starter:
        raise RuntimeError("Implementer reported success without updating model.py")
    compile(implemented, model_path, "exec")
    return result


__all__ = ["implementation"]
