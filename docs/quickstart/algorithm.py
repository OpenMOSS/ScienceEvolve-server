"""Upload this CPU-only example as input to your first ScienceEvolve task."""


def unique_in_order(values: list[int]) -> list[int]:
    """Keep the first occurrence of each integer, preserving input order."""
    result: list[int] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result
