"""Prompt construction for the judger agent.

A note on the scoring scheme below
---------------------------------

The four-part rubric and the ``algorithm_score`` / ``final_score`` /
``complexity`` JSON schema shipped here are just **one possible scoring
design** — a starting point, not a contract. DrugEvolve is
deliberately permissive about how you score candidate algorithms: the
Judger agent returns whatever fields you ask for, and the downstream
Analyst / database layer only consumes the values you persist.

You are warmly invited to redesign the scoring rules to match your
concrete drug-discovery task. Some directions you might explore:

* **Different metrics, different weights.** The default rubric weights
  task performance 0.7 vs. algorithm quality 0.3; for early-stage
  exploration you may prefer the opposite, or a fully task-only score.
* **Different aggregation.** Replace the simple weighted mean with a
  Pareto front, a hard-threshold pass/fail, a multi-objective scalarizer,
  or a learned preference model.
* **Different fields.** Add or remove JSON fields — e.g. add a
  ``safety_score`` for ADMET, a ``synthesizability`` flag for molecular
  generation, a ``novelty`` integer for generation, an
  ``interpretability`` rating for docking. Just make sure the Pydantic
  schema in ``judger/model.py`` (``JudgerOutput``) lists exactly the
  fields you want the agent to return.
* **Different complexity definition.** The current "M + T + G" axis is
  for MAP-Elites diversity. If you don't use MAP-Elites, drop
  ``complexity`` entirely; if you do, feel free to add other axes
  (e.g. data-efficiency, training cost).
* **Tier thresholds that match your metrics.** The S/A/B/C/D/F bands
  in "Part 1" assume the baseline anchors at 5.0; retune them to your
  domain (e.g. AUPRC bands for ADMET, docking-score bands for docking,
  novelty bands for molecular generation).

Whatever you choose, please keep the two files in this folder consistent:

* ``Creation/Engineer/judger/model.py`` — defines ``JudgerOutput`` (the
  Pydantic schema the agent must obey) and the agent's
  ``instructions``.
* ``Creation/Engineer/judger/prompt.py`` — builds the user prompt (this
  file).

The rest of DrugEvolve will treat the score as a generic number, so
you have full freedom here.
"""

from __future__ import annotations

from typing import Any, Dict

from utils.algorithm import Algorithm
from utils.experiment import get_baseline_content, keep_header_and_final
from utils.prompt_loader import render_prompt


def judger_input(algorithm: Algorithm, result: Dict[str, Any]) -> str:
    """Compose the user prompt for the judger agent."""
    test_csv = keep_header_and_final(result.get("test", ""))
    baseline = get_baseline_content()
    override = render_prompt(
        "judger",
        {
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
            "results": test_csv,
            "baseline": baseline,
        },
    )
    if override is not None:
        return override

    return f"""You are the Model Judger inside DrugEvolve. Compute three
comparative sub-scores in [0, 10] anchored at 5 for the baseline, then
aggregate them into a final score in [0, 10].

---
### Baseline
{baseline}

---
### Candidate Inputs
Algorithm:
{algorithm.explain}

--- CANDIDATE TEST BENCHMARK RESULTS START ---
{test_csv}
--- CANDIDATE TEST BENCHMARK RESULTS END ---

---
### Part 1: Task-Level Performance
For each available metric, compute the relative delta vs. the baseline and
map it to a 0-10 tier score (S=9-10, A=7.5-9, B=6-7.5, C=4.5-5.5,
D=2-4.5, F=0-2). Then take the weighted mean over all metric scores.
Defaults to 5.0 when no metric is available.

---
### Part 2: Algorithm Rationality
Evaluate architectural merit strictly relative to the baseline.
- 5.0: just a shuffle of baseline blocks
- 6-7: minor genuine improvement
- 8-9: novel biological prior or clever structural inductive bias
- <5: vague "buzzword soup," redundant complexity, opaque logic

---
### Part 3: Complexity (MAP-Elites axis)
Score three macro-components and sum them:
- M (model backbone count): 1 for a single encoder, 2-3 for multi-modal
- T (training strategy): 1 for plain training, 2 for interaction/multi-loss,
  3 for multi-stage/ensemble/energy-guided
- G (generation strategy): 1 for single-pass decoding, 2 for sampling +
  reranking, 3 for iterative refinement / diffusion / search

Complexity = M + T + G

---
### Part 4: Final Aggregation
1. task_mean_score = mean of metric tier scores (default 5.0)
2. final_score = 0.7 * task_mean_score + 0.3 * algorithm_score
3. Clip into [0, 10]

---
Output exactly this JSON:
{{
  "algorithm_score": float,
  "final_score": float,
  "complexity": int,
  "reasoning": str
}}
"""


__all__ = ["judger_input"]
