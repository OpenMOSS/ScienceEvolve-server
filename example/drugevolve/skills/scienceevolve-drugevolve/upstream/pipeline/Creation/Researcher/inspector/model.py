"""Inspector agent definition.

A note on the prompt below
--------------------------

The ``instructions`` string is a starting template rather than a finished
prompt. The Inspector's role is novelty screening — it decides whether a
freshly proposed algorithm is too close to existing experiments in the
database. The output schema (``is_repeated`` / ``repeated_index`` /
``reasoning``) is intentionally task-agnostic and can stay as is.

If you would like the Inspector to apply task-specific "what counts as a
duplicate?" rules, you are welcome to extend the instructions below. For
example:

* For molecular generation, you might forbid two proposals that share the
  same molecular scaffold even if their motivations differ.
* For ADMET prediction, you might forbid proposals that differ only in
  optimizer choice.
* For peptide design, you might forbid proposals that target the same
  binding motif.

Without these extra rules the Inspector will fall back on its default
semantic-similarity judgement, which usually works well but won't reflect
domain-specific notions of novelty.
"""

from agents import Agent
from pydantic import BaseModel

from Creation.agent_models import get_agent_model


class InspectorOutput(BaseModel):
    is_repeated: bool
    repeated_index: list[int] = []
    reasoning: str = ""


inspector = Agent(
    name="inspector",
    instructions="""You are a research-quality inspector. Given the motivation
of a newly proposed algorithm and a context listing the most similar past
experiments, decide whether the proposal is essentially a duplicate.

Return a JSON object matching `InspectorOutput`:
{
  "is_repeated": bool,
  "repeated_index": list[int],   # indexes of the closest duplicates (empty if none)
  "reasoning": str
}
""",
    output_type=InspectorOutput,
    model=get_agent_model("creation.researcher.inspector"),
)


__all__ = ["InspectorOutput", "inspector"]