from dataclasses import dataclass, asdict
from typing import Any, Dict, Mapping, Sequence, Tuple


@dataclass
class Algorithm:
    """Algorithm model for experimental design."""
    motivation: str
    explain: str
    math: str

    def to_tuple(self) -> Tuple[str, str, str]:
        """Convert Algorithm instance to tuple format for DataElement compatibility."""
        return (self.motivation, self.explain, self.math)

    def to_dict(self) -> Dict[str, str]:
        """Convert Algorithm instance to dictionary."""
        return asdict(self)

    @classmethod
    def from_tuple(cls, value: Tuple[str, str, str]) -> "Algorithm":
        """Create Algorithm instance from tuple."""
        motivation, explain, math = value
        return cls(motivation=motivation, explain=explain, math=math)

    @classmethod
    def from_dict(cls, data: Dict[str, str]) -> "Algorithm":
        """Create Algorithm instance from dictionary."""
        return cls(**data)

    @classmethod
    def from_value(cls, value: Any) -> "Algorithm":
        """Normalize legacy tuple/list and current mapping representations.

        JSON persistence turns dataclasses into mappings.  Older DrugEvolve
        deployments sometimes stored a three-item tuple instead, so the
        public model accepts both formats at the storage boundary.
        """
        if isinstance(value, cls):
            return value
        if isinstance(value, Mapping):
            return cls(
                motivation=str(value.get("motivation", "")),
                explain=str(value.get("explain", "")),
                math=str(value.get("math", "")),
            )
        if all(hasattr(value, field) for field in ("motivation", "explain", "math")):
            return cls(
                motivation=str(value.motivation),
                explain=str(value.explain),
                math=str(value.math),
            )
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            if len(value) != 3:
                raise ValueError("Algorithm sequences must contain exactly three values")
            return cls.from_tuple(tuple(str(item) for item in value))
        raise TypeError(f"Unsupported Algorithm value: {type(value).__name__}")


__all__ = ["Algorithm"]
