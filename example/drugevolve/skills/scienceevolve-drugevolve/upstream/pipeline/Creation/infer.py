"""Database-facing helpers used by the DrugEvolve Creation pipeline."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional, Set, Tuple

from config import Config
from drugevolve.cognition import CognitionStore
from Database.element import DataElement
from Database import create_client


db = create_client()


def is_db_empty(_db) -> bool:
    """Return ``True`` when the algorithm database contains no usable entries."""
    return len(_db.get_ucb1_elements(1)) == 0


def log_element(tag: str, element, extra_info: str = "") -> None:
    """Pretty-print a sampled element for debugging."""
    log_str = (
        f"[{tag}] index={element.index} "
        f"parent={getattr(element, 'parent', None)} "
        f"score={getattr(element, 'score', None)}"
    )
    if extra_info:
        log_str += f" {extra_info}"
    print(log_str)


async def sample() -> Tuple[str, int, int]:
    """Sample a parent element and reference context for the next experiment.

    Returns:
        A tuple of (context, parent_index, parent_island). When the database
        is empty, ``parent_index`` is ``0`` and ``parent_island`` is ``-1``.
    """
    context = ""
    index_selected: Set[int] = set()

    parent_element = None
    parent_max_retries = 10
    parent_found = False
    island_fail_count = 0
    for _ in range(parent_max_retries):
        try:
            if getattr(Config, "SAMPLER_TYPE", "ucb1") == "island":
                parent_candidates = await asyncio.to_thread(
                    db.get_island_elements,
                    num=1,
                    exploration_ratio=Config.PARENT_EXPLORE_RATIO,
                    exploitation_ratio=Config.PARENT_EXPLOIT_RATIO,
                )
                if not parent_candidates:
                    island_fail_count += 1
                    if island_fail_count >= 4:
                        parent_candidates = await asyncio.to_thread(db.get_ucb1_elements, 1)
                        island_fail_count = 0
                        if parent_candidates:
                            parent_element = parent_candidates[0]
                            parent_found = True
                            break
                    continue
                parent_element = parent_candidates[0]
                island_fail_count = 0
            else:
                parent_candidates = await asyncio.to_thread(db.get_ucb1_elements, 1)
                if not parent_candidates:
                    continue
                parent_element = parent_candidates[0]

            if parent_element is None:
                continue

            score = getattr(parent_element, "score", None)
            if score is not None and score < 0:
                continue

            parent_found = True
            break
        except Exception:
            continue

    if not parent_found or parent_element is None:
        return "### System Initialization\nThe database is currently empty.\n", 0, -1

    context += "### Parent Element\n" + await parent_element.get_context() + "\n"
    cognition_query = " ".join(
        (
            parent_element.algorithm.motivation,
            parent_element.algorithm.explain,
            parent_element.algorithm.math,
        )
    )
    cognition_matches = CognitionStore(
        Path(Config.RUN_DIR) / "cognition"
    ).search(cognition_query, top_k=3)
    if cognition_matches:
        context += "### External Cognition\n"
        context += "\n".join(f"- {item.content}" for item, _ in cognition_matches)
        context += "\n"
    if (
        hasattr(parent_element, "ablation")
        and parent_element.ablation is not None
    ):
        ablation_indexes = parent_element.ablation
        if not isinstance(ablation_indexes, (list, tuple)):
            ablation_indexes = [ablation_indexes]
        ablation_elements = await asyncio.to_thread(
            db.get_multi_elements_by_index, ablation_indexes
        )
        for element in ablation_elements:
            context += "### Ablation Study For Parent Element\n" + await element.get_context() + "\n"

    parent = parent_element.index

    if (
        hasattr(parent_element, "island")
        and parent_element.island is not None
        and parent_element.island >= 0
    ):
        parent_island = parent_element.island
    else:
        parent_island = parent % 4

    index_selected = {parent}

    reference_target = 2
    for _ in range(reference_target):
        attempts = 0
        success = False
        while attempts < 20 and not success:
            attempts += 1
            try:
                if getattr(Config, "SAMPLER_TYPE", "ucb1") == "island":
                    ref_candidates = await asyncio.to_thread(
                        db.get_island_elements_from_island,
                        island_id=parent_island,
                        num=1,
                        exploration_ratio=Config.CONTEXT_EXPLORE_RATIO,
                        exploitation_ratio=Config.CONTEXT_EXPLOIT_RATIO,
                    )
                    ref = (
                        ref_candidates[0]
                        if ref_candidates
                        else await asyncio.to_thread(db.sample_element)
                    )
                else:
                    ref = await asyncio.to_thread(db.sample_element)

                if ref is None or ref.index <= 0 or ref.index in index_selected:
                    continue

                ref_score = getattr(ref, "score", None)
                if ref_score is not None and ref_score < 0:
                    continue

                index_selected.add(ref.index)
                context += "### Reference Element\n" + await ref.get_context() + "\n"
                success = True
            except Exception:
                continue

    print("Selected indices:", sorted(index_selected))
    print("Total selected:", len(index_selected))
    return context, parent, parent_island


async def debug_sample(max_retry: int = 5) -> Tuple[Optional[str], Optional[int], Optional[int]]:
    """Variant of :func:`sample` with built-in validation."""
    for retry in range(max_retry):
        context, parent, parent_island = await sample()
        sections = [s for s in context.split("### ") if s.strip()]
        if len(sections) < 3:
            print("[ERROR] Too few sampled elements. Retrying...")
            continue
        print("[SUCCESS] Sampling validation passed")
        return context, parent, parent_island

    print("[FAIL] Sampling failed after retries")
    return None, None, None


async def update(result: DataElement) -> bool:
    """Persist a freshly evaluated ``DataElement`` back into the database."""
    print(result.to_dict())
    await asyncio.to_thread(db.add_element, result.to_dict())
    return True


__all__ = [
    "db",
    "is_db_empty",
    "log_element",
    "sample",
    "debug_sample",
    "update",
]
