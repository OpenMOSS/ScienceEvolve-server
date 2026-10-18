"""Analyzer agent definition.

A note on the prompt below
--------------------------

The text in ``instructions`` is a starting template rather than a finished,
task-specific prompt. DrugEvolve is designed to be task-agnostic, so it
ships with a generic role description ("Pharmaceutical Algorithm Analyst")
that you are warmly encouraged to tailor to your own problem — whether
that is ADMET prediction, molecular generation, peptide / protein design,
docking scoring, virtual screening, PROTAC linker design or anything else.

When you are ready to run DrugEvolve on a real problem, a few things you
might want to adjust:

* Give the role a more specific name that reflects your domain (e.g.
  "Senior ADMET prediction researcher", "Peptide binder-design analyst",
  "Molecular-generation benchmark lead") so the model adopts the right
  register and vocabulary.
* Make the success criteria explicit: which metrics matter, and in which
  direction (e.g. AUPRC ↑, docking score ↓, QED ↑, novelty ↑).
* Describe the qualitative checks you would like the agent to perform on
  the generated case-study (validity, synthesizability, ADMET profile,
  structural plausibility, …).
* Adapt the generic ``AnalyzerOutput.case_assessment`` rubric to the
  qualitative checks that matter for your task.

The framework will still run if you keep the generic wording as-is, but
the analyzer reports will be correspondingly generic — so a small amount
of customisation usually pays back quickly in search quality.
"""

from agents import Agent
from pydantic import BaseModel

from Creation.agent_models import get_agent_model
from utils import read_code_file


class AnalyzerOutput(BaseModel):
    get_expectation: bool
    better_than_baseline: bool
    component_comparison_analysis: str
    related_element_analysis: str
    existing_problems: str
    case_assessment: str


analyzer = Agent(
    name="analyzer",
    instructions='''# ROLE: Pharmaceutical Algorithm Analyst

You are an expert analyst for a drug-discovery / pharmaceutical ML task. Your
mission is to rigorously interpret experimental outputs, training dynamics
and evaluation metrics for any candidate algorithm submitted to the
DrugEvolve framework, and to produce a structured comparative report against
the established baseline.

## Analytical Workflow
1. Assimilate Context: Understand the algorithm's motivation, mechanism and
   experimental setup.
2. Evaluate Primary Outcome: Compare final test metrics against the baseline.
3. Diagnose the "Why": Inspect training dynamics for instability, collapse,
   under- or over-fitting patterns.
4. Validate the Hypothesis: Did the proposed innovation actually deliver the
   claimed benefit?
5. Synthesize and Report: Emit a JSON document matching `AnalyzerOutput`.

## Output Format (Strict JSON)
Your final response MUST be a valid JSON object strictly conforming to the
`AnalyzerOutput` schema. Do not include any conversational filler or
markdown code blocks. All string fields should use professional, academic
language.
''',
    output_type=AnalyzerOutput,
    model=get_agent_model("creation.analyst.analyzer"),
    tools=[read_code_file],
)


__all__ = ["AnalyzerOutput", "analyzer"]
