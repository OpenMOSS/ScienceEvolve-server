"""Generator agent definition.

A note on the prompt below
--------------------------

The ``instructions`` string is a starting template rather than a finished,
task-specific prompt. The Generator's job is to propose a new algorithm
spec (``name`` / ``motivation`` / ``explain`` / ``math``); the substance
of the proposal should be whatever drug-discovery task you have plugged
in.

A few things you might like to adjust when you adapt DrugEvolve to a
real problem:

* Rewrite the role description and the "CORE PRINCIPLES" block so they
  encode the concrete task domain. For example:
    - ADMET prediction → graph neural networks over molecular graphs,
      multi-task heads, scaffold split, …
    - Molecular generation → RL on latent space, property-conditional
      VAE, diffusion on SELFIES, …
    - Peptide binder design → sequence-only conditional generation,
      motif-conditioned decoding, …
    - Docking scoring → 3D equivariant networks, physics-informed
      heads, …
* Spell out any hard constraints the proposals must respect (Lipinski
  rule-of-five, novelty thresholds, structural validity, …).

The Generator will still emit valid JSON if you keep the template
verbatim, but its proposals will then fall back on general ML knowledge
rather than the prior art of your domain. The matching user-prompt
template in the sibling ``prompt.py`` should be edited in the same way.
"""

from agents import Agent
from pydantic import BaseModel, Field

from Creation.agent_models import get_agent_model


class GeneratorOutput(BaseModel):
    name: str = Field(description="Snake_case algorithm name.")
    motivation: str = Field(description="Insight and rationale. Plain text.")
    explain: str = Field(description="Step-by-step mechanics.")
    math: str = Field(description="Mathematical formulation.")


generator = Agent(
    name="generator",
    instructions="""# ROLE: Drug-Discovery Research Scientist

You are an expert research scientist designing new algorithms for a
pharmaceutical / drug-discovery task. You will be given a context describing
the parent algorithm and a few reference experiments, and you must propose a
new candidate algorithm that is plausibly better than both.

## CORE PRINCIPLES
1. Practicality: Stay computationally efficient. The candidate must be
   trainable on the configured hardware.
2. Verifiable Improvement: Propose a design that is explicitly expected to
   outperform the established baseline.
3. Task-aware design: The candidate should exploit domain knowledge for
   the active task (e.g. ADMET, molecular generation, peptide design).
4. Diversity: Prefer designs that explore orthogonal directions from the
   parent.
5. Output Structure: Return ONLY a valid JSON object matching
   `GeneratorOutput`:
   {{"name": ..., "motivation": ..., "explain": ..., "math": ...}}
   No markdown, no extra commentary.
""",
    output_type=GeneratorOutput,
    model=get_agent_model("creation.researcher.creator.generator"),
)


__all__ = ["GeneratorOutput", "generator"]