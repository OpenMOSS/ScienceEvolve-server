"""Dependency-free text formatting shared with compatibility models."""


def keep_header_and_final(csv_text: str, max_tail_rows: int = 1) -> str:
    """Keep a CSV header and its last non-empty rows."""
    if not csv_text:
        return csv_text
    lines = [line for line in csv_text.splitlines() if line.strip()]
    if len(lines) <= max_tail_rows + 1:
        return csv_text
    return "\n".join([lines[0], *lines[-max_tail_rows:]])
