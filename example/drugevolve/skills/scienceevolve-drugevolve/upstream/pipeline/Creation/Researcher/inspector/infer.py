"""Inspector agent invocation."""

from __future__ import annotations

import asyncio

from Database import create_client
from utils.agent import run
from utils.algorithm import Algorithm
from .model import inspector
from .prompt import inspector_input


async def check_repeated_motivation(algorithm: Algorithm):
    """Compare ``algorithm`` against the database's most similar experiments."""
    client = create_client()
    similar_elements = await asyncio.to_thread(
        client.search_similar_motivations, algorithm
    )
    context = _similar_motivation_context(similar_elements)
    return await run(
        "inspector",
        inspector,
        inspector_input(context, algorithm),
    )


def _similar_motivation_context(similar_elements) -> str:
    """Render similar elements as a Markdown-friendly block."""
    if not similar_elements:
        return "No previous motivations found for comparison."

    context = ""
    for i, element in enumerate(similar_elements, 1):
        algorithm = Algorithm.from_value(element.algorithm)
        context += f"#### Reference [{i}]  {element.name})\n"
        context += f"- explain: {algorithm.explain}\n"
        context += f"- math: {algorithm.math}\n\n"

    context += (
        f"\n**Total Previous Motivations**: {len(similar_elements)}\n"
        "**Analysis Scope**: Compare target motivation against each reference above\n"
    )
    return context


async def get_repeated_context(repeated_index: list[int]) -> str:
    """Build a "do-not-repeat" prompt block for the generator."""
    client = create_client()
    repeated_elements = await asyncio.to_thread(
        client.get_multi_elements_by_index, repeated_index
    )

    if not repeated_elements:
        return "No repeated experimental context available."

    structured = "### REPEATED EXPERIMENTAL PATTERNS ANALYSIS\n\n"
    for i, element in enumerate(repeated_elements, 1):
        if element is None:
            continue
        algorithm = Algorithm.from_value(element.algorithm)
        structured += f"#### Reference [{i}]  {element.name})\n"
        structured += f"- explain: {algorithm.explain}\n"
        structured += f"- math: {algorithm.math}\n\n"

    structured += (
        f"**Pattern Analysis Summary:**\n"
        f"- **Total Repeated Experiments**: {len(repeated_elements)}\n"
        "- **Innovation Challenge**: Break free from these established pattern spaces\n"
        "- **Differentiation Requirement**: Implement orthogonal approaches that "
        "explore fundamentally different design principles\n\n"
        "**Key Insight**: The above experiments represent exhausted design spaces. "
        "Your task is to identify and implement approaches that operate on "
        "completely different mathematical, biological, or physical principles.\n"
    )
    return structured


__all__ = ["check_repeated_motivation", "get_repeated_context"]
