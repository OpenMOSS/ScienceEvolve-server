"""Creator agent invocation with retry & duplicate detection."""

from __future__ import annotations

from config import Config
from utils.agent import run
from utils.algorithm import Algorithm
from utils.output_parser import coerce_agent_output

from .generator import generator, generator_input, generator_input_duplicate
from .generator.model import GeneratorOutput
from ..inspector.infer import check_repeated_motivation, get_repeated_context


async def creation(context: str) -> tuple[str, Algorithm]:
    """Generate a new algorithm proposal (name + motivation/explain/math)."""
    plan = await _generate(context)
    algorithm = Algorithm(plan.motivation, plan.explain, plan.math)
    return plan.name, algorithm


async def _generate(context: str) -> GeneratorOutput:
    repeated = None
    last_error: Exception | None = None
    for attempt in range(Config.MAX_CREATION_ATTEMPTS):
        if attempt == 0 or repeated is None or not getattr(repeated, "is_repeated", False):
            input_content = generator_input(context)
        else:
            repeated_context = await get_repeated_context(repeated.repeated_index)
            input_content = generator_input_duplicate(context, repeated_context)

        try:
            plan = await run("generator", generator, input_content, max_turns=20)
            plan = coerce_agent_output(plan, GeneratorOutput)

            algorithm = Algorithm(plan.motivation, plan.explain, plan.math)
            repeated = await check_repeated_motivation(algorithm)

            if repeated.is_repeated:
                if attempt == Config.MAX_CREATION_ATTEMPTS - 1:
                    raise Exception("[SKIP] Maximum retry attempts reached (repeated content)")
                continue
            return plan
        except Exception as e:
            last_error = e
            repeated = None
            if attempt == Config.MAX_CREATION_ATTEMPTS - 1:
                raise Exception(f"[ERROR] Failed after all attempts: {e}") from e
            continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("Generator fell through without producing a plan.")


__all__ = ["creation"]
