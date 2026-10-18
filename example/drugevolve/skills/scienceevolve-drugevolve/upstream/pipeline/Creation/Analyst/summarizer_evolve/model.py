"""Summarizer-evolve agent definition.

A note on the prompt below
--------------------------

The ``instructions`` string is a starting template rather than a finished
task-specific prompt. The agent's job is to compress an analyzer report
into a Markdown "experience" snippet that future Creators see as
context — the *substance* of that snippet should reflect whatever
drug-discovery task you have plugged in.

When you are ready to run DrugEvolve on a real problem, a couple of
tweaks you might consider:

* Rewrite the role description to match your domain (e.g. "ADMET
  benchmark summarizer", "Peptide-design retrospective analyst").
* Adapt the four-section output template (Performance Summary /
  Algorithm Mechanism / Component Impact Analysis / Experimental
  Lessons) so that the component categories and known failure modes
  match the vocabulary of your specific problem.

If you keep the generic wording the summarizer will still produce valid
Markdown, but the experience strings it writes back to the database
won't carry the domain vocabulary that helps Creators explore more
diverse directions.
"""

from agents import Agent
from pydantic import BaseModel

from Creation.agent_models import get_agent_model


class SummarizerEvolveFields(BaseModel):
    summary: str


summarizer_evolve = Agent(
    name="summarizer_evolve",
    instructions="""# Role: Drug-Discovery Algorithm Experiment Analyst

You are a senior research analyst. You excel at dissecting drug-discovery /
pharmaceutical ML algorithm experiments from a rigorous, objective, and
concise perspective. Your core competency is to synthesize algorithm
principles, procedural analysis, and experimental results into a clear,
accurate, and highly structured technical summary.

## Objective
Generate a concise Markdown-ready summary of a new algorithm experiment based
on the `algorithm`, `analysis`, and `cognition` inputs. The summary will be
embedded directly into future experiment prompts.

## Rules of Conduct
1. Absolute Objectivity: All outputs must be strictly based on the provided
   input information. Refrain from adding subjective judgments or external
   knowledge.
2. High Conciseness: Use professional and succinct language. Avoid lengthy
   narratives.
3. Fidelity to Input: Your role is to "summarize," not to "create."
4. Format Adherence: Strictly follow the schema below.

## Output Format
Return ONLY a single valid JSON object with exactly one key `summary`. No
extra text, no leading/trailing whitespace outside the JSON.
""",
    model=get_agent_model("creation.analyst.summarizer"),
    tools=[],
    output_type=SummarizerEvolveFields,
)


__all__ = ["SummarizerEvolveFields", "summarizer_evolve"]
