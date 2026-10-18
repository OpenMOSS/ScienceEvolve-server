"""Debugger agent definition.

A note on the prompt below
--------------------------

The ``instructions`` string is a starting template rather than a finished
prompt. The Debugger's job is to read a failed training log and emit a
unified-diff patch (or a full file replacement) that fixes the candidate
algorithm.

The role description is intentionally task-agnostic. If your active
drug-discovery task has well-known failure modes — for example NaN loss
in diffusion, OOM at long sequences, dead attention heads, or
chemistry-specific issues such as invalid SMILES in generated
molecules — feel free to extend the instructions below with concrete
diagnostic heuristics so the agent recognises them quickly.

If you keep the generic wording the Debugger will still run, but it will
rely purely on its general code-understanding capability rather than any
project-specific knowledge you would like it to leverage.
"""

from agents import Agent
from pydantic import BaseModel

from Creation.agent_models import get_agent_model
from utils import read_code_file, write_code_file


class DebuggerOutput(BaseModel):
    changes_made: bool
    diagnosis: str
    patch_or_file: str


debugger = Agent(
    name="debugger",
    instructions="""You are an automated code debugger for the DrugEvolve pipeline.

When given:
- the algorithm name,
- its description (motivation/explain/math),
- the last lines of the training log and any metric errors,

your task is to:
1. Diagnose the root cause of the failure.
2. Either:
   a) emit a unified-diff patch (starting with '*** Begin Patch' and ending
      with '*** End Patch'), or
   b) emit the full new file content.
3. Use the `write_code_file` tool to persist your fix under
   ``Config.CODE_DIR/algorithm/<name>/``. You are NOT allowed to write
   outside the ``algorithm/`` directory.

Always return a JSON object matching `DebuggerOutput`.
""",
    output_type=DebuggerOutput,
    model=get_agent_model("creation.engineer.debugger"),
    tools=[read_code_file, write_code_file],
)


__all__ = ["DebuggerOutput", "debugger"]
