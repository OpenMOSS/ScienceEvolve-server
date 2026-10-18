"""Direct single-machine GPU training execution."""

from __future__ import annotations

import asyncio
import os
import signal
import threading
import time
from pathlib import Path
from typing import Tuple

from config import Config


async def _terminate_process_group(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        await process.wait()
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


async def train(
    bash_path: str,
    cancel_event: threading.Event | None = None,
) -> Tuple[bool, str]:
    """Run a candidate training script directly on the current machine."""
    script = Path(bash_path).expanduser().resolve()
    code_root = Path(Config.CODE_DIR).expanduser().resolve()
    if not script.is_relative_to(code_root):
        return False, f"Training script is outside CODE_DIR: {script}"
    if not script.is_file():
        return False, f"Training script not found: {script}"

    environment = os.environ.copy()
    environment.setdefault("CUDA_VISIBLE_DEVICES", Config.CUDA_DEVICE)
    stdout_path = script.parent / "training.stdout.log"
    stderr_path = script.parent / "training.stderr.log"
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
        "w", encoding="utf-8"
    ) as stderr_file:
        process = await asyncio.create_subprocess_exec(
            "bash",
            str(script),
            cwd=script.parent,
            env=environment,
            stdout=stdout_file,
            stderr=stderr_file,
            start_new_session=True,
        )
        deadline = time.monotonic() + Config.TRAINING_TIMEOUT
        cancelled = False
        timed_out = False
        while process.returncode is None:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                await _terminate_process_group(process)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                await _terminate_process_group(process)
                break
            try:
                await asyncio.wait_for(process.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                pass

    stderr = stderr_path.read_text(encoding="utf-8", errors="replace")[-8000:]
    stdout = stdout_path.read_text(encoding="utf-8", errors="replace")[-8000:]
    if cancelled:
        return False, (stderr or stdout or "Training cancelled by monitor").strip()
    if timed_out:
        detail = (stderr or stdout).strip()
        message = f"Training timed out after {Config.TRAINING_TIMEOUT} seconds"
        return False, f"{message}\n{detail}".strip()
    if process.returncode == 0:
        return True, ""
    detail = (stderr or stdout or f"exit code {process.returncode}").strip()
    return False, detail


__all__ = ["train"]
