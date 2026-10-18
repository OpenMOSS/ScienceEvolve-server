"""Prompt construction for the analyzer agent.

A note on the prompt below
--------------------------

``analyzer_input`` assembles a generic user prompt — the section headers
("Experimental Setup", "Results & Training Metrics", "Generate Case",
"Baseline") are placeholders you are welcome to adapt to the active
drug-discovery task.

A few small touches usually make a big difference:

* Swap the literal "drug discovery / pharmaceutical ML algorithm" wording
  for the actual task description (ADMET prediction, docking scoring,
  molecule generation, …).
* Replace the example metric labels with the concrete metrics of your
  problem and indicate the expected direction (↑ or ↓).
* Adapt ``case_study`` / ``case_assessment`` to the qualitative output of
  your task.

The agent will still produce JSON if you keep the template untouched,
but the reports will be correspondingly generic — customising a few
words here is usually a worthwhile investment.
"""

from __future__ import annotations

from utils.algorithm import Algorithm
from utils.experiment import get_baseline_content


def analyzer_input(
    name: str,
    result: str,
    algorithm: Algorithm,
    ref_context: str,
    case_study: str,
) -> str:
    """Compose the user prompt fed into the analyzer agent.

    Args:
        name: Candidate experiment name.
        result: CSV-formatted test metrics.
        algorithm: ``Algorithm`` dataclass instance (motivation/explain/math).
        ref_context: Pre-rendered context for related experiments.
        case_study: Qualitative description of one or more generated samples.
    """
    return f"""# EXPERIMENT COMPARATIVE ANALYSIS

## 1. Experimental Dossier

### Algorithm Specification
- **Name**: {name}
- **Motivation**: {algorithm.motivation}
- **Algorithm Explanation**: {algorithm.explain}
- **Mathematical Formulation**: {algorithm.math}

### Experimental Setup
- **Task**: Drug discovery / pharmaceutical ML algorithm
- **Training**: see logged metrics

### Results & Training Metrics
{result}

### Current Generate Case
{case_study}

### Baseline Experiment Results
--- BASELINE TEST CSV START ---
{get_baseline_content()}
--- BASELINE TEST CSV END ---

### Additional Context & Related Information
{ref_context}

---

## 2. Analytical Task

Conduct a rigorous comparative analysis and return a single JSON object
matching the `AnalyzerOutput` schema with the following fields:

1. `get_expectation` (bool): Did the algorithm achieve its stated motivation?
2. `better_than_baseline` (bool): Does the candidate beat the baseline?
3. `component_comparison_analysis` (str): Which architectural changes drove
   the metric deltas, and which underperformed?
4. `related_element_analysis` (str): How do these results align with, or
   contradict, related prior experiments?
5. `existing_problems` (str): Document weaknesses, instabilities or
   concerning trade-offs.
6. `case_assessment` (str): Qualitative analysis of the generated case(s) –
   plausibility, diversity, scientific validity, and consistency with the
   motivation.

Provide ONLY the JSON object, with no extra commentary.
"""


__all__ = ["analyzer_input"]
