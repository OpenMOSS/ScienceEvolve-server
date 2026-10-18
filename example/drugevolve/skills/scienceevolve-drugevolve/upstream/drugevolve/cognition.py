"""Small local cognition store for reusable external insights."""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class CognitionItem:
    content: str
    source: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class CognitionStore:
    """Persist external knowledge separately from experimental outcomes."""

    def __init__(self, storage_dir: Path | str):
        self.storage_dir = Path(storage_dir).resolve()
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.storage_dir / "items.json"

    def _load(self) -> list[CognitionItem]:
        if not self.path.exists():
            return []
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        return [CognitionItem(**item) for item in payload.get("items", [])]

    def _save(self, items: list[CognitionItem]) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix="cognition.", dir=self.storage_dir)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(
                    {"schema_version": 1, "items": [asdict(item) for item in items]},
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def add(
        self,
        content: str,
        *,
        source: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CognitionItem:
        if not content.strip():
            raise ValueError("Cognition content must not be empty")
        items = self._load()
        item = CognitionItem(content=content, source=source, metadata=metadata or {})
        items.append(item)
        self._save(items)
        return item

    def all(self) -> list[CognitionItem]:
        return self._load()

    def search(self, query: str, top_k: int = 5) -> list[tuple[CognitionItem, float]]:
        query_terms = set(re.findall(r"[A-Za-z0-9_]+", query.lower()))
        ranked: list[tuple[CognitionItem, float]] = []
        for item in self._load():
            terms = set(re.findall(r"[A-Za-z0-9_]+", item.content.lower()))
            union = query_terms | terms
            score = len(query_terms & terms) / len(union) if union else 0.0
            if score > 0:
                ranked.append((item, score))
        ranked.sort(key=lambda pair: pair[1], reverse=True)
        return ranked[:top_k]
