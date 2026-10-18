"""Prompt construction for the implementer agent.

A note on the prompt below
--------------------------

``implementer_input`` returns a generic user prompt. The phrase
"Drug-Discovery Algorithm" and the surrounding prose are placeholders
meant to be replaced with concrete instructions for your task — for
example, point the Implementer at your preferred ML framework, at the
starter ``model.py`` template under
``tasks/<your_task>/src/algorithm/<name>/``, and at the CLI arguments
that ``launch_bash.sh`` will pass.

Whenever you edit this file, please also update the matching description
in ``Creation/Researcher/implementer/model.py`` so the two files stay
consistent.
"""

from __future__ import annotations

from utils.algorithm import Algorithm
from utils.prompt_loader import render_prompt


def implementer_input(name: str, algorithm: Algorithm) -> str:
    """Compose the user prompt for the implementer."""
    override = render_prompt(
        "implementer",
        {
            "name": name,
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
        },
    )
    if override is not None:
        return override
    return f"""# Implement Drug-Discovery Algorithm

## Algorithm
- Name: {name}
- Motivation: {algorithm.motivation}
- Explanation: {algorithm.explain}
- Mathematics: {algorithm.math}

## What to do
1. Read the existing `model.py` template from
   `Config.CODE_DIR/algorithm/{name}/model.py` if you need to.
2. Rewrite it (and add helpers as needed) so it faithfully implements the
   algorithm above.
3. Stay within `Config.CODE_DIR/algorithm/{name}/`.
4. Return a JSON object with `success` (bool) and `summary` (str).
"""


__all__ = ["implementer_input"]
