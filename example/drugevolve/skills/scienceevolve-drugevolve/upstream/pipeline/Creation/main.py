"""DrugEvolve Creation pipeline.

The Creation pipeline is the central place where new candidate algorithms are
discovered. Each round of the outer loop corresponds to one experiment:

    1. **Sample** parent + reference nodes from the algorithm database.
    2. **Evolve** a new candidate algorithm using LLM-driven Researcher agents.
    3. **Evaluate** the candidate by training, scoring and judging it.
    4. **Analyze** the result and write it back into the database.

The pipeline is intentionally task-agnostic. Task-specific knowledge lives
inside the prompts of each agent (see ``Creation/<Stage>/<Role>/prompt.py``)
and inside the train/eval scripts pointed to by ``Config.SOURCE_FILE``.
"""

from __future__ import annotations

from .Analyst import analyze
from .Engineer import evaluation
from .infer import sample, update, debug_sample
from .Researcher import evolve
from Database import DataElement


async def creation() -> None:
    """Run a single DrugEvolve creation experiment.

    Raises:
        Exception: Propagates any exceptions from the pipeline steps with
            context.
    """
    # --- Step 1: Sampling --------------------------------------------------
    context, parent, parent_island = await sample()

    # --- Step 2: Evolution --------------------------------------------------
    name, algorithm = await evolve(context)

    # --- Step 3: Evaluation (train + judge) --------------------------------
    (
        name,
        program,
        result,
        score,
        score_detail,
        llm_score,
        complexity,
        case_study,
    ) = await evaluation(name, algorithm)

    # --- Step 4: Analysis ---------------------------------------------------
    result_element = await analyze(
        name=name,
        algorithm=algorithm,
        program=program,
        result=result,
        score=score,
        score_detail=score_detail,
        parent=parent,
        island=parent_island,
        llm_score=llm_score,
        complexity=complexity,
        case_study=case_study,
    )

    # --- Step 5: Persist to the database -----------------------------------
    await update(result_element)


__all__ = ["creation"]
