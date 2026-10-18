"""Function tools exposed to the DrugEvolve agents.

The set of tools is intentionally small:

- :func:`read_code_file` / :func:`write_code_file`: manipulate the
  candidate algorithm under ``Config.CODE_DIR/algorithm/<name>/``.
- :func:`read_csv_file`: read CSV outputs produced by the trainer.
- :func:`list_dir`: enumerate files inside ``Config.CODE_DIR``.

Experiment cognition is provided by the local :class:`CognitionStore` and
does not require a remote service.
"""

from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path
from typing import Any, Dict, List

import patch
from agents import function_tool

from config import Config


def _resolve_under(base: str, raw_path: str) -> Path:
    """Resolve ``raw_path`` below ``base`` and reject path traversal."""
    base_path = Path(base).expanduser().resolve()
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = base_path / candidate
    target = candidate.resolve()
    if not target.is_relative_to(base_path):
        raise PermissionError(f"Path is outside the approved workspace: {raw_path}")
    return target


def _resolve_code_path(raw_path: str, *, require_algorithm: bool = False) -> Path:
    target = _resolve_under(Config.CODE_DIR, raw_path)
    if require_algorithm:
        algorithm_root = (Path(Config.CODE_DIR).expanduser().resolve() / "algorithm").resolve()
        if not target.is_relative_to(algorithm_root):
            raise PermissionError("Writes are restricted to CODE_DIR/algorithm")
    return target


def _run_bounded(command: List[str], timeout: int) -> Dict[str, Any]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return {
            "success": False,
            "output": stdout,
            "error": f"Command timed out after {timeout} seconds\n{stderr}".strip(),
        }
    return {
        "success": process.returncode == 0,
        "output": stdout,
        "error": stderr if process.returncode != 0 else "",
    }


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

@function_tool
def read_code_file(file_path: str) -> Dict[str, Any]:
    """Read a source file from the candidate algorithm directory."""
    try:
        source_file = _resolve_code_path(file_path)
        with source_file.open("r", encoding="utf-8") as f:
            content = f.read()
        return {"success": True, "content": content}
    except Exception as e:
        return {"success": False, "error": str(e)}


@function_tool
def read_csv_file(file_path: str) -> Dict[str, Any]:
    """Read a CSV file inside ``Config.CODE_DIR``."""
    try:
        csv_path = _resolve_code_path(file_path)
        with csv_path.open("r", encoding="utf-8") as f:
            content = f.read()
        return {"success": True, "content": content}
    except Exception as e:
        return {"success": False, "error": str(e)}


@function_tool
def write_code_file(file_path: str, content: str) -> Dict[str, Any]:
    """Write (or patch) a file under ``Config.CODE_DIR``.

    The function auto-detects whether ``content`` is a unified-diff patch
    (``*** Begin Patch`` … ``*** End Patch``) or a full file replacement.
    Writes are restricted to the ``algorithm/`` subtree.
    """
    try:
        source_file = _resolve_code_path(file_path, require_algorithm=True)
    except (OSError, PermissionError) as exc:
        return {"success": False, "error": str(exc)}

    is_model_patch = content.strip().startswith("*** Begin Patch")
    if not is_model_patch:
        try:
            source_file.parent.mkdir(parents=True, exist_ok=True)
            with source_file.open("w", encoding="utf-8") as f:
                f.write(content)
            return {"success": True, "message": f"Successfully wrote {file_path}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # Apply patch
    try:
        import re

        match = re.search(r"@@.*", content, re.DOTALL)
        if not match:
            return {"success": False, "error": "Invalid patch format: missing diff body."}
        clean_patch = match.group(0).replace("*** End Patch", "").strip()

        original = ""
        if source_file.exists():
            with source_file.open("r", encoding="utf-8") as f:
                original = f.read()

        patch_set = patch.fromstring(clean_patch.encode("utf-8"))
        patched = patch_set.apply(original.encode("utf-8"))
        if patched is False:
            return {
                "success": False,
                "error": f"Failed to apply patch to {file_path} (does not apply cleanly).",
            }
        with source_file.open("w", encoding="utf-8") as f:
            f.write(patched.decode("utf-8"))
        return {"success": True, "message": f"Applied patch to {file_path}"}
    except Exception as e:
        return {"success": False, "error": f"Patch error on {file_path}: {e}"}


@function_tool
def list_dir(dir_path: str = "") -> Dict[str, Any]:
    """List files/directories inside ``Config.CODE_DIR/dir_path``."""
    try:
        target = _resolve_code_path(dir_path)
        if not target.exists():
            return {"success": False, "error": f"Directory not found: {dir_path}"}
        if not target.is_dir():
            return {"success": False, "error": f"Not a directory: {dir_path}"}
        items: List[Dict[str, Any]] = [
            {"name": child.name, "is_dir": child.is_dir()}
            for child in sorted(target.iterdir(), key=lambda item: item.name)
        ]
        return {"success": True, "items": items, "dir": dir_path}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Bounded helper runners
# ---------------------------------------------------------------------------


@function_tool
def run_plot_script(script_path: str) -> Dict[str, Any]:
    """Execute a plotting script (use sparingly)."""
    try:
        approved_script = _resolve_code_path(script_path)
        return _run_bounded(
            ["python", str(approved_script)], Config.EVALUATION_TIMEOUT
        )
    except Exception as exc:
        return {"success": False, "output": "", "error": str(exc)}


__all__ = [
    "read_code_file",
    "read_csv_file",
    "write_code_file",
    "list_dir",
    "run_plot_script",
]
