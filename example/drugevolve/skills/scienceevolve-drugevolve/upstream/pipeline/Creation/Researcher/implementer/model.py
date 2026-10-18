"""Implementer agent definition.

A note on the prompt below
--------------------------

The ``instructions`` string is a starting template rather than a finished
prompt. The Implementer's job is to translate an algorithm spec
(motivation / explain / math) into runnable ``model.py`` code. DrugEvolve
is task-agnostic, so the Implementer must be able to work for any
drug-discovery task you plug in.

When you adapt DrugEvolve to your own setup, you might like to extend
the ``instructions`` so that the agent knows:

* which ML framework to use (PyTorch Geometric, RDKit, HuggingFace
  Transformers, …),
* which CLI arguments the launch script passes (defined in
  ``utils/copy_launch_script.py`` ``generate_model_content``),
* which file layout / naming convention to follow for the candidate
  algorithm directory,
* any project-specific guard-rails you want to enforce (no network
  access, deterministic seeding, allowed dependencies, …).

If you keep the generic wording the Implementer will still write code,
but it may pick a framework or file layout that doesn't match your
training / evaluation stack — so a bit of customisation here usually
saves a lot of debugging later.
"""

from agents import Agent, ModelSettings
from pydantic import BaseModel

from Creation.agent_models import get_agent_model
from utils import read_code_file, write_code_file


class ImplementerOutput(BaseModel):
    success: bool
    summary: str


implementer = Agent(
    name="implementer",
    instructions="""You are an expert ML engineer translating an algorithm
specification into working Python code for the DrugEvolve pipeline.

You will be given:
- the algorithm name,
- a motivation / explanation / math description,
- a starter `model.py` already written at
  `Config.CODE_DIR/algorithm/<name>/model.py` (you can read it with
  `read_code_file`).

Your task is to:
1. Replace the starter `model.py` with a faithful implementation of the
   algorithm using `write_code_file`.
2. Optionally add helper modules under the same directory.
3. Confirm the directory now contains a complete, runnable implementation.

You MUST only write code under `Config.CODE_DIR/algorithm/<name>/`. Never
modify files outside that directory.

Return a JSON object matching `ImplementerOutput`:
{"success": bool, "summary": str}
""",
    output_type=ImplementerOutput,
    model=get_agent_model("creation.researcher.implementer"),
    model_settings=ModelSettings(tool_choice="write_code_file"),
    tools=[read_code_file, write_code_file],
)


__all__ = ["ImplementerOutput", "implementer"]
