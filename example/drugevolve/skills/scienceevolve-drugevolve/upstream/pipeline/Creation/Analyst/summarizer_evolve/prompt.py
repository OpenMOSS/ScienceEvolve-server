"""Prompt construction for the summarizer-evolve agent.

A note on the prompt below
--------------------------

``SUMMARIZER_USER_PROMPT_TEMPLATE`` is a generic Markdown skeleton. The
section headings (Performance Summary / Algorithm Mechanism / Component
Impact Analysis / Experimental Lessons) and their sub-bullets are meant
to be tuned to the vocabulary and known failure modes of your concrete
drug-discovery task (ADMET, docking, generation, peptide design, …).

If you keep the generic wording the experience strings written back to
the database will still be valid Markdown, but they will not carry the
domain signals that help Creators explore more diverse directions — so
a small amount of customisation here is usually worthwhile.
"""

from __future__ import annotations

from utils.algorithm import Algorithm
from utils.prompt_loader import render_prompt


SUMMARIZER_USER_PROMPT_TEMPLATE = """## Task: Summarize a New Drug-Discovery Algorithm Experiment

Generate a structured experiment summary based on the `algorithm`,
`analysis`, and `cognition` inputs provided below.

### Inputs
1. Algorithm
   - motivation: {algorithm.motivation}
   - explain: {algorithm.explain}
   - math: {algorithm.math}
2. Analysis: {analysis}
3. Cognition (optional): {cognition}

### Output Requirements
Output a concise Markdown snippet suitable for embedding in a future
creator prompt. The snippet must include four sections:

#### 1. Performance Summary
- One or two sentences describing the overall outcome and whether the
  candidate beat the baseline.

#### 2. Algorithm Mechanism
- Motivation: <single-line summary>
- Core Idea: <single-line summary>

#### 3. Component Impact Analysis
- For each significant component: identification, design intention,
  empirical performance, individual contribution, interactions with other
  components and (if applicable) comparison against the baseline.

#### 4. Experimental Lessons
- Distilled takeaways: which components worked, which did not, instabilities,
  parameter sensitivities, etc.
"""


def summarizer_evolve_input(algorithm: Algorithm, analysis: str, cognition: str) -> str:
    override = render_prompt(
        "summarizer",
        {
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
            "analysis": analysis,
            "cognition": cognition,
        },
    )
    if override is not None:
        return override
    return (
        SUMMARIZER_USER_PROMPT_TEMPLATE
        .replace("{algorithm.motivation}", algorithm.motivation)
        .replace("{algorithm.explain}", algorithm.explain)
        .replace("{algorithm.math}", algorithm.math)
        .replace("{analysis}", analysis)
        .replace("{cognition}", cognition)
    )


__all__ = ["summarizer_evolve_input", "SUMMARIZER_USER_PROMPT_TEMPLATE"]
