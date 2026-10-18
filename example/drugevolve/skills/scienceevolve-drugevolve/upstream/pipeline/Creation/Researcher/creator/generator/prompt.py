"""Prompt construction for the generator agent.

A note on the prompt below
--------------------------

``generator_input`` and ``generator_input_duplicate`` return generic user
prompts. The "TASK: Design a Novel Drug-Discovery Algorithm" header, the
"Baseline / Parent / Reference Experiments" sections and the
"Requirements" list are placeholders that you are warmly invited to
adapt to your own drug-discovery task.

A few touches you might like to add when you adapt DrugEvolve:

* Rename "Drug-Discovery Algorithm" in the title to your concrete problem
  (e.g. "ADMET Classifier", "Peptide Binder Generator", "3D Docking
  Scorer").
* Expand the "Requirements" section with task-specific constraints —
  scaffold split, ADMET filters, synthesizability, docking priors, etc.
* If your task has hard evaluation constraints (novelty thresholds,
  Lipinski rule-of-five, structural validity, …), spell them out so
  the Generator respects them by design.

The matching ``model.py`` should be edited in the same way so both
files stay consistent.
"""

from __future__ import annotations

import re
from utils.prompt_loader import render_prompt


def extract_parent_element(context: str) -> str:
    """Extract the ``### Parent Element`` block from ``context``."""
    pattern = r"### Parent Element\n(.*?)(?=\n### |\Z)"
    match = re.search(pattern, context, re.S)
    return match.group(1).strip() if match else ""


def remove_parent_section(context: str) -> str:
    """Strip the ``### Parent Element`` block from ``context``."""
    pattern = r"### Parent Element\n.*?(?=\n### |\Z)"
    return re.sub(pattern, "", context, flags=re.S).strip()


def generator_input(context: str) -> str:
    """Prompt: design a new algorithm given a fresh context."""
    parent_content = extract_parent_element(context)
    context_without_parent = remove_parent_section(context)
    override = render_prompt(
        "generator",
        {"parent": parent_content, "references": context_without_parent, "context": context},
    )
    if override is not None:
        return override

    return f"""# TASK: Design a Novel Drug-Discovery Algorithm

Your objective is to design a new deep learning algorithm that improves over
the baseline and the current parent for a drug-discovery task. Your design
should propose a concrete, trainable architecture (or training strategy) that
explains how it will be implemented.

## 1. Baseline

The baseline is the established reference architecture used as the starting
point for the search. It is a reasonable initial solution but leaves headroom
for improvement in any of the following axes: representation power,
conditioning fidelity, diversity, training stability, inference efficiency.

## 2. Parent Algorithm

{parent_content}

## 3. Reference Experiments

{context_without_parent}

## 4. Requirements

1. Practicality: stay trainable on the configured hardware.
2. Verifiable improvement: explicitly explain why your design is expected to
   outperform both the baseline and the parent.
3. Diversity: prefer designs that explore orthogonal directions from the
   parent.
4. Concrete: name every module, every loss term and every decoding strategy.

## 5. Output

Return ONLY a valid JSON object matching `GeneratorOutput`:
{{"name": ..., "motivation": ..., "explain": ..., "math": ...}}
"""


def generator_input_duplicate(context: str, repeated_context: str) -> str:
    """Prompt variant used when the previous attempt was too close to an
    existing experiment.
    """
    parent_content = extract_parent_element(context)
    context_without_parent = remove_parent_section(context)
    override = render_prompt(
        "generator_duplicate",
        {
            "parent": parent_content,
            "references": context_without_parent,
            "repeated_context": repeated_context,
            "context": context,
        },
    )
    if override is not None:
        return override

    return f"""# TASK: Design a Drug-Discovery Algorithm — Break Out of the Repeated Pattern

Your previous attempt was too similar to existing experiments. Use the
following list of repeated experiments as a "do-not-repeat" guide and
intentionally explore orthogonal directions.

## Repeated Experiments (avoid)
{repeated_context}

## Parent Algorithm
{parent_content}

## Other Reference Experiments
{context_without_parent}

## Output

Return ONLY a valid JSON object matching `GeneratorOutput`:
{{"name": ..., "motivation": ..., "explain": ..., "math": ...}}
"""


__all__ = [
    "extract_parent_element",
    "remove_parent_section",
    "generator_input",
    "generator_input_duplicate",
]
