"""Judger agent definition.

A note on the scoring scheme below
---------------------------------

The ``JudgerOutput`` Pydantic model and the ``instructions`` string below
are **one possible scoring design** — a starting template, not a
contract. DrugEvolve is deliberately permissive about how you score
candidate algorithms: the Judger agent returns whatever fields you ask
for, the rest of the framework treats the score as a generic number,
and only the data you persist ends up in the database.

You are warmly invited to redesign the scoring rules to match your
concrete drug-discovery task. A few directions you might explore:

* **Different fields.** The default schema returns three numbers
  (``algorithm_score`` / ``final_score`` / ``complexity``) plus a
  ``reasoning`` string. Feel free to add or remove fields — e.g.
  ``safety_score`` for ADMET, ``synthesizability`` for molecular
  generation, ``novelty`` for generation, ``interpretability`` for
  docking, or whatever else your search needs.
* **Different aggregation.** Replace the simple weighted mean
  (``0.7 * task + 0.3 * algorithm``) with a Pareto front, a
  hard-threshold pass/fail, a multi-objective scalarizer, or a learned
  preference model. Just make sure the prompt in the sibling
  ``prompt.py`` describes the rule you want the agent to apply.
* **Different complexity axis.** The current ``complexity`` integer is
  for MAP-Elites diversity ("M + T + G" — model / training / generation
  macro-components). If you don't use MAP-Elites, drop the field; if
  you do, feel free to add other axes (data-efficiency, training cost).
* **Different rubric.** The "Task-Level Performance" / "Algorithm
  Rationality" / "Complexity" four-part rubric is a sensible default
  but not the only option. You could collapse it to a single
  ``final_score``, or add a fourth "Robustness" part, or any other
  structure that fits your task.

Whatever you choose, keep this file and the sibling ``prompt.py``
consistent:

* This file defines ``JudgerOutput`` (the Pydantic schema the agent must
  obey) and the agent's ``instructions`` (the system prompt).
* ``prompt.py`` builds the user prompt that contains the candidate's
  test metrics and the baseline description.

The rest of DrugEvolve will treat the score as a generic number, so you
have full freedom here.
"""

from agents import Agent
from pydantic import BaseModel, confloat, conint

from Creation.agent_models import get_agent_model


class JudgerOutput(BaseModel):
    algorithm_score: confloat(ge=0, le=10)
    final_score: confloat(ge=0, le=10)
    complexity: conint(ge=0)
    reasoning: str


judger = Agent(
    name="judger",
    instructions="""You are the Model Evaluator within the DrugEvolve pipeline.
Your task is to compare a candidate algorithm against the provided baseline
and emit 0-10 sub-scores.

Sub-scores:
1. algorithm_score: Algorithmic design rationality.
2. Task-specific scores: Compare each test metric against the baseline and
   aggregate them into a final task score (default to 5.0 when data is
   missing).

Default aggregation:
   final_score = 0.7 * task_mean_score + 0.3 * algorithm_score

## OUTPUT FORMAT REQUIREMENT (STRICT)
Return ONLY a valid JSON object with exactly these four keys:
{
  "algorithm_score": 0.0,
  "final_score": 0.0,
  "complexity": 1,
  "reasoning": str
}
""",
    output_type=JudgerOutput,
    model=get_agent_model("creation.engineer.judger"),
    tools=[],
)


__all__ = ["JudgerOutput", "judger"]