import json
import json5
import re
from typing import Any, Dict, Optional, Type

try:
    # Pydantic v2
    from pydantic import BaseModel
except Exception:  # pragma: no cover
    BaseModel = object  # type: ignore


def _extract_json_obj(text: str) -> Optional[Dict[str, Any]]:
    """
    Try to extract a JSON object from arbitrary text.
    Strategy:
    - If whole string parses as JSON, return it
    - Otherwise, search for the largest balanced {...} span and try to parse
    - Fallback: None
    """
    if not isinstance(text, str):
        return None
    text = text.strip()
    # Direct JSON object or array
    if (text.startswith("{") and text.endswith("}")) or (
        text.startswith("[") and text.endswith("]")
    ):
        try:
            loaded = json.loads(text)
            return loaded if isinstance(loaded, dict) else {"value": loaded}
        except Exception:
            pass
    # Heuristic: find candidate JSON object via braces
    brace_positions = [i for i, c in enumerate(text) if c in "{}"]
    if not brace_positions:
        return None
    # Try spans from first '{' to last '}'
    try:
        first_open = text.find("{")
        last_close = text.rfind("}")
        if first_open != -1 and last_close != -1 and last_close > first_open:
            candidate = text[first_open : last_close + 1]
            try:
                loaded = json.loads(candidate)
            except Exception:
                loaded = json5.loads(candidate)
            return loaded if isinstance(loaded, dict) else {"value": loaded}
    except Exception:
        pass
    # Regex fallback for simple JSON-like object
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            loaded = json.loads(match.group(0))
            return loaded if isinstance(loaded, dict) else {"value": loaded}
        except Exception:
            return None
    return None


def _clean_field_value(field_name: str, value: Any) -> Any:
    """
    Clean a single field value by stripping leading "field_name: ..." style labels.
    Examples that will be cleaned for field_name == "name":
      - "name: delta_net_xxx"
      - "Name : delta_net_xxx"
      - "name： delta_net_xxx" (full-width colon)
    """
    if not isinstance(value, str):
        return value

    # Work on a trimmed prefix but preserve original spacing after the label
    s = value.lstrip()
    lower_field = field_name.lower()

    # Find the first ASCII or full-width colon
    first_ascii = s.find(":")
    first_full = s.find("：")
    candidates = [pos for pos in (first_ascii, first_full) if pos != -1]
    if not candidates:
        return value

    idx = min(candidates)
    label = s[:idx].strip().lower()

    # Only strip if the label matches the field name (case‑insensitive)
    if label == lower_field:
        # Skip the colon itself (ASCII or full-width) and any following space
        cleaned = s[idx + 1 :].lstrip()
        return cleaned

    return value


def _clean_data_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Apply _clean_field_value to every key/value pair in a dict.
    """
    return {k: _clean_field_value(k, v) for k, v in data.items()}


def _build_fallback_data(
    model_cls: Type[BaseModel], text: str, default_field: Optional[str]
) -> Dict[str, Any]:
    """
    Build a permissive data dict for model_cls using a free-text string.
    - If default_field provided and exists and is str: put text there
    - Otherwise, fill all str fields with text
    - For bool fields named like 'success': set to True if text suggests success, else False
    - For list fields: set to []
    - Other types: leave unset (model defaults) or set to None if required
    """
    data: Dict[str, Any] = {}
    fields = getattr(model_cls, "model_fields", {})  # pydantic v2

    # Simple success heuristic
    lower = text.lower()
    looks_success = any(
        phrase in lower
        for phrase in [
            "success=true",
            "succeeded",
            "success: true",
            "exit code 0",
            "completed successfully",
        ]
    )

    for name, field_info in fields.items():
        ann = getattr(field_info, "annotation", None)
        if default_field and name == default_field and ann is str:
            data[name] = text
            continue
        if ann is str:
            data[name] = text
        elif ann is bool:
            data[name] = looks_success if "success" in name else False
        elif getattr(ann, "__origin__", None) is list:
            data[name] = []
        else:
            # leave missing; pydantic will use defaults if any
            data.setdefault(name, None)
    # Clean label-style prefixes like "name: xxx" on all string fields
    return _clean_data_dict(data)

def _extract_first_json_dict(text: str) -> Optional[dict]:
    s = text.strip()

    # Strip common leading labels such as "name:" and "json:".
    s = re.sub(r"^\s*(?:name|json)\s*:\s*", "", s, flags=re.I)

    # Extract the first JSON object.
    m = re.search(r"\{.*\}", s, flags=re.S)
    if not m:
        return None

    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def coerce_agent_output(
    agent_result: Any,
    model_cls: Type[BaseModel],
    default_field: Optional[str] = None,
) -> BaseModel:
    """
    Convert an agent call result into a given Pydantic model, tolerating non-JSON outputs.
    - Accepts objects with .final_output, dicts, strings, or existing model instances
    - Attempts JSON extraction from free text; otherwise builds a best-effort payload
    """
    value = getattr(agent_result, "final_output", agent_result)

    # Already correct type
    if isinstance(value, model_cls):
        return value

    # Pydantic model of different class
    if hasattr(value, "model_dump"):
        try:
            dumped = value.model_dump()  # type: ignore[attr-defined]
            dumped = _clean_data_dict(dumped)
            return model_cls.model_validate(dumped)  # type: ignore[attr-defined]
        except Exception:
            pass

    # Dict-like
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, str) and v.strip().startswith("{"):
                nested = _extract_json_obj(v)
                if isinstance(nested, dict) and "name" in nested:
                    value = nested
                    break
        value = _clean_data_dict(value)
        return model_cls.model_validate(value)  # type: ignore[attr-defined]

    # String handling
    if isinstance(value, str):
        # First handle outputs prefixed with labels such as ``name: {...}``.
        obj = _extract_first_json_dict(value)

        # Fall back to the more permissive extraction logic.
        if obj is None:
            obj = _extract_json_obj(value)

        if obj is not None:
            try:
                obj = _clean_data_dict(obj)
                return model_cls.model_validate(obj)  # type: ignore[attr-defined]
            except Exception:
                pass

        # Named proposal models must be retried instead of silently accepting
        # an incomplete free-text response.
        required_fields = set(getattr(model_cls, "model_fields", {}).keys())
        if "name" in required_fields:
            raise ValueError(f"Failed to parse JSON for {model_cls.__name__}")

        # Other output types may use a best-effort fallback.
        data = _build_fallback_data(model_cls, value, default_field)
        return model_cls.model_validate(data)  # type: ignore[attr-defined]

    # Unknown type: stringify and fallback
    text = str(value)
    data = _build_fallback_data(model_cls, text, default_field)
    return model_cls.model_validate(data)  # type: ignore[attr-defined]

