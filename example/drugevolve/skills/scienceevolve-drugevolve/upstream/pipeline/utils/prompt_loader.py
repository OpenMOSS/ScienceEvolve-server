"""Optional task prompt profiles loaded without modifying framework code."""

from __future__ import annotations

import os
from pathlib import Path
from string import Template
from typing import Any, Mapping, Optional


def render_prompt(name: str, values: Mapping[str, Any]) -> Optional[str]:
    """Render ``$variable`` placeholders from ``DRUGEVOLVE_PROMPT_DIR``.

    Returning ``None`` keeps the built-in generic prompt. Prompt names are
    framework constants, but path resolution is still bounded defensively.
    """
    raw_dir = os.getenv("DRUGEVOLVE_PROMPT_DIR", "").strip()
    if not raw_dir:
        return None
    prompt_dir = Path(raw_dir).expanduser().resolve()
    prompt_path = (prompt_dir / f"{name}.txt").resolve()
    if not prompt_path.is_relative_to(prompt_dir):
        raise PermissionError(f"Prompt path escaped profile directory: {name}")
    if not prompt_path.exists():
        return None
    template = Template(prompt_path.read_text(encoding="utf-8"))
    return template.safe_substitute({key: str(value) for key, value in values.items()})
