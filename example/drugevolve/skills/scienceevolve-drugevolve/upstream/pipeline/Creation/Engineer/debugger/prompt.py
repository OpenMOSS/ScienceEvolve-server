"""Prompt construction for the debugger agent.

A note on the prompt below
--------------------------

``debugger_input`` returns a generic user prompt. The Debugger reads the
last lines of the training log plus any metric error file and emits a
fix; the "Previous Error" section is filled dynamically and everything
else is a placeholder.

If you would like the Debugger to recognise the failure modes that are
common in your drug-discovery setup, you are welcome to add concrete
guidance here — common CUDA OOM triggers, gradient-explosion patterns,
numerical-stability footguns, chemistry-specific issues such as invalid
SMILES, etc. Pair every edit here with the matching edit in
``Creation/Engineer/debugger/model.py``.

If you keep the generic wording the Debugger will still return JSON, but
the patches it emits will be correspondingly generic.
"""

from __future__ import annotations

from utils.algorithm import Algorithm
from utils.prompt_loader import render_prompt


def debugger_input(name: str, algorithm: Algorithm, previous_error: str) -> str:
    """Compose the user prompt for the debugger."""
    override = render_prompt(
        "debugger",
        {
            "name": name,
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
            "previous_error": previous_error,
        },
    )
    if override is not None:
        return override
    return f"""# Debug Request for DrugEvolve

## Algorithm
- Name: {name}
- Motivation: {algorithm.motivation}
- Explanation: {algorithm.explain}
- Mathematics: {algorithm.math}

## Previous Error
{previous_error}

## What to do
1. Diagnose the most likely root cause.
2. Read the relevant source file with `read_code_file` if you need to.
3. Use `write_code_file` to persist a fix. The fix can either be a
   unified-diff patch (starting with '*** Begin Patch') or a full file
   replacement.
4. Return a JSON object with `changes_made`, `diagnosis` and
   `patch_or_file`.
"""


__all__ = ["debugger_input"]
