"""Prompt construction for the inspector agent.

A note on the prompt below
--------------------------

``inspector_input`` returns a generic novelty-check prompt. The section
labels are intentionally minimal so that the same template works across
drug-discovery tasks.

If your notion of "duplicate" depends on the active task — for example,
you want to forbid identical molecular scaffolds in molecule generation,
or identical task combinations in ADMET prediction — feel free to edit
the body of this function to inject those rules into the prompt.
"""

from __future__ import annotations

from utils.algorithm import Algorithm
from utils.prompt_loader import render_prompt


def inspector_input(context: str, algorithm: Algorithm) -> str:
    """Compose the user prompt for the inspector."""
    override = render_prompt(
        "inspector",
        {
            "context": context,
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
        },
    )
    if override is not None:
        return override
    return f"""# Duplicate / Novelty Check

## Algorithm Under Inspection
- Motivation: {algorithm.motivation}
- Explanation: {algorithm.explain}
- Mathematics: {algorithm.math}

## Existing Similar Experiments
{context}

## Decision
Return ONLY a JSON object:
{{
  "is_repeated": bool,
  "repeated_index": list[int],
  "reasoning": str
}}
"""


__all__ = ["inspector_input"]
