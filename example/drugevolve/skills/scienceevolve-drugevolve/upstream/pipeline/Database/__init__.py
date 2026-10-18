from functools import lru_cache

from .element import DataElement


@lru_cache(maxsize=1)
def create_client():
    """Create the local JSON compatibility database."""
    from .local_database import LocalDatabaseClient

    return LocalDatabaseClient()


__all__ = ["DataElement", "create_client"]
