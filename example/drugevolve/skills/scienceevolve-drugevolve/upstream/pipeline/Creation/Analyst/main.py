"""Analyst stage entry point.

Given a finished evaluation, the Analyst stage:

1. Pulls contextual elements (parent, grandparent, …) from the database.
2. Calls the ``analyzer`` agent to produce a structured comparison report.
3. Calls the ``summarizer_evolve`` agent to compress the report into an
   "experience" string that future creators will see in their context.
4. Bundles everything into a ``DataElement`` and returns it for storage.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Dict

from config import Config
from drugevolve.cognition import CognitionStore
from Database import DataElement
from Database import create_client
from utils.algorithm import Algorithm
from utils.experiment import keep_header_and_final
from .analyzer.infer import analysis
from .summarizer_evolve.infer import summary_for_evolve


async def analyze(
    name: str,
    algorithm: Algorithm,
    program: Dict[str, str],
    result: Dict[str, Any],
    score: float,
    score_detail: Dict[str, Any],
    parent: int,
    island: int,
    llm_score: float,
    complexity: int,
    case_study: str,
) -> DataElement:
    """Build a ``DataElement`` describing the just-finished experiment."""
    db = create_client()
    ref_elements = (
        await asyncio.to_thread(db.get_contextual_elements, parent)
        if parent and parent != 0
        else []
    )

    result_content = (
        "\n--- TEST CSV START ---\n\n"
        f"{keep_header_and_final(result.get('test', ''))}\n"
        "--- TEST CSV END ---"
    )

    analysis_result = await analysis(name, result_content, algorithm, ref_elements, case_study)
    analysis_output = (
        f"Is the algorithm achieve its stated motivation? {analysis_result.get_expectation}\n"
        f"Is the algorithm better than the baseline? {analysis_result.better_than_baseline}\n"
        f"Component comparison analysis: {analysis_result.component_comparison_analysis}\n"
        f"Related element analysis: {analysis_result.related_element_analysis}\n"
        f"Existing problems: {analysis_result.existing_problems}\n"
        f"Generated case assessment: {analysis_result.case_assessment}\n"
    )

    # Query the run-local cognition store for related prior experience.
    cognition_query = " ".join(
        (algorithm.motivation, algorithm.explain, algorithm.math)
    )
    cognition_matches = CognitionStore(
        Path(Config.RUN_DIR) / "cognition"
    ).search(cognition_query, top_k=3)
    content_str = (
        "\n".join(f"- {item.content}" for item, _ in cognition_matches)
        if cognition_matches
        else "NULL"
    )

    experience = await summary_for_evolve(algorithm, analysis_output, content_str)

    return DataElement(
        index=0,  # The database assigns the final index.
        parent=parent,
        name=name,
        mode="creation",
        result=result,
        program=program,
        algorithm=algorithm,
        analysis=analysis_output,
        cognition=content_str,
        experience=experience,
        ablation=None,
        enhancement=None,
        score=score,
        score_detail=score_detail,
        llm_score=llm_score,
        complexity=complexity,
        island=island,
    )


__all__ = ["analyze"]
