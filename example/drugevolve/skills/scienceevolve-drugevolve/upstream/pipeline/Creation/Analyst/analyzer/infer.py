"""Analyzer agent invocation with retry."""

from __future__ import annotations

from typing import Any, Optional

from config import Config
from Database import DataElement
from utils.agent import run
from utils.algorithm import Algorithm
from utils.prompt_loader import render_prompt
from .model import AnalyzerOutput, analyzer


async def analysis(
    name: str,
    result_content: str,
    algorithm: Algorithm,
    ref_elements,
    case_study: str,
) -> Optional[AnalyzerOutput]:
    """Run the analyzer agent with retry on transient failures."""
    ref_context = (
        ""
        if not ref_elements
        else await _build_reference_context(ref_elements)
    )

    last_error: Exception | None = None
    for attempt in range(Config.MAX_ANALYSIS_ATTEMPTS):
        try:
            result = await run(
                "analyzer",
                analyzer,
                _analyzer_input(name, result_content, algorithm, ref_context, case_study),
            )

            for required in (
                "get_expectation",
                "better_than_baseline",
                "component_comparison_analysis",
                "related_element_analysis",
                "existing_problems",
                "case_assessment",
            ):
                if not hasattr(result, required):
                    raise ValueError(f"Analyzer output missing field: {required}")

            return result
        except Exception as e:
            last_error = e
            if attempt == Config.MAX_ANALYSIS_ATTEMPTS - 1:
                raise Exception(
                    f"[FAILED] Analysis generation failed after "
                    f"{Config.MAX_ANALYSIS_ATTEMPTS} attempts with error: {e}"
                ) from e
            continue

    if last_error is not None:
        raise last_error
    return None


async def _build_reference_context(ref_elements) -> str:
    """Render reference elements into a Markdown-friendly context block."""
    ref_context = "# Reference Experiments\n"

    if ref_elements.get("direct_parent"):
        ref_context += "#### Direct Parent: "
        ref_context += await DataElement(**ref_elements["direct_parent"]).get_context()
        ref_context += "\n\n"

    if ref_elements.get("grandparent"):
        ref_context += "#### Grandparent: "
        ref_context += await DataElement(**ref_elements["grandparent"]).get_context()
        ref_context += "\n\n"

    return ref_context


def _analyzer_input(
    name: str,
    result_content: str,
    algorithm: Algorithm,
    ref_context: str,
    case_study: str,
) -> str:
    """Compose the analyzer prompt (kept in-line so this file is self-contained)."""
    override = render_prompt(
        "analyzer",
        {
            "name": name,
            "motivation": algorithm.motivation,
            "explain": algorithm.explain,
            "math": algorithm.math,
            "results": result_content,
            "references": ref_context,
            "case_study": case_study,
        },
    )
    if override is not None:
        return override
    return f"""# EXPERIMENT COMPARATIVE ANALYSIS

## Algorithm
- Name: {name}
- Motivation: {algorithm.motivation}
- Explanation: {algorithm.explain}
- Mathematics: {algorithm.math}

## Test Metrics (CSV)
{result_content}

## Case Study
{case_study}

## References
{ref_context}

## Output
Return ONLY a JSON object with fields: get_expectation, better_than_baseline,
component_comparison_analysis, related_element_analysis, existing_problems,
case_assessment.
"""


__all__ = ["analysis"]
