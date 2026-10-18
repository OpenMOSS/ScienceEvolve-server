"""Summarizer-evolve agent invocation with retry."""

from __future__ import annotations

from config import Config
from utils.agent import run
from utils.algorithm import Algorithm
from utils.output_parser import coerce_agent_output
from .model import SummarizerEvolveFields, summarizer_evolve
from .prompt import summarizer_evolve_input


async def summary_for_evolve(algorithm: Algorithm, analysis: str, cognition: str) -> str:
    """Generate a one-shot experience summary for the algorithm."""
    last_error: Exception | None = None
    for attempt in range(Config.MAX_SUMMARY_ATTEMPTS):
        try:
            summarized = await run(
                "summarizer_evolve",
                summarizer_evolve,
                summarizer_evolve_input(algorithm, analysis, cognition),
            )
            summarized = coerce_agent_output(summarized, SummarizerEvolveFields)
            return summarized.summary
        except Exception as e:
            last_error = e
            if attempt == Config.MAX_SUMMARY_ATTEMPTS - 1:
                raise Exception(
                    f"[FAILED] Summary generation failed after "
                    f"{Config.MAX_SUMMARY_ATTEMPTS} attempts with error: {e}"
                ) from e
            continue

    if last_error is not None:
        raise last_error
    return ""


__all__ = ["summary_for_evolve"]