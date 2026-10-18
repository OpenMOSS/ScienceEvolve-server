"""DrugEvolve top-level pipeline driver.

This module orchestrates an infinite loop of "experiment iterations". Each
iteration randomly samples a `mode` (currently only ``creation`` is wired up)
and runs the corresponding agent pipeline.

Configuration is read from the environment. The recommended deployment is:
    export DRUGEVOLVE_API_KEY=<your key>
    export DRUGEVOLVE_BASE_URL=<your OpenAI-compatible endpoint>
    python -u pipeline.py
"""

import asyncio
import os
import sys
from pathlib import Path
from enum import Enum

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from agents import set_default_openai_api, set_default_openai_client, set_tracing_disabled
from openai import AsyncOpenAI

from config import Config
from drugevolve.config import load_run_spec
from drugevolve.state import RunWorkspace
from utils import log_error, log_info, log_warning, start_pipeline, end_pipeline


class ExperimentMode(Enum):
    """Experiment mode enumeration."""

    CREATION = "creation"


# ---- OpenAI-compatible client setup -----------------------------------------
# The framework is provider-agnostic; any OpenAI-compatible endpoint works.
API_KEY = os.getenv("DRUGEVOLVE_API_KEY", "")
BASE_URL = os.getenv("DRUGEVOLVE_BASE_URL", "https://api.openai.com/v1/")

if not API_KEY:
    raise RuntimeError("DRUGEVOLVE_API_KEY is required for the Agent pipeline")

client = AsyncOpenAI(
    api_key=API_KEY,
    base_url=BASE_URL,
    max_retries=10,
)

set_default_openai_client(client)
set_default_openai_api("chat_completions")
set_tracing_disabled(True)


async def main() -> None:
    """Main function - continuous experiment execution."""
    run_spec = None
    if Config.REQUIRE_PREFLIGHT:
        spec_path = Path(Config.RUN_SPEC)
        if not spec_path.exists():
            raise FileNotFoundError(
                f"Run spec not found: {spec_path}. Initialize and confirm preflight first."
            )
        run_spec = load_run_spec(spec_path)
        run_spec.require_ready(REPOSITORY_ROOT)
        Config.SAMPLER_TYPE = run_spec.sampling.algorithm
        Config.SAMPLER_EXPLORATION_COEFFICIENT = (
            run_spec.sampling.exploration_coefficient
        )
        Config.SAMPLER_NUM_ISLANDS = run_spec.sampling.num_islands
        Config.SAMPLER_EXPLORATION_RATIO = run_spec.sampling.exploration_ratio
        Config.SAMPLER_EXPLOITATION_RATIO = run_spec.sampling.exploitation_ratio
        Config.SAMPLER_FEATURE_DIMENSIONS = list(
            run_spec.sampling.feature_dimensions
        )
        Config.SAMPLER_FEATURE_BINS = run_spec.sampling.feature_bins

    # Import after preflight so storage and sampler configuration are fixed
    # before the legacy Creation module creates its compatibility client.
    from Creation.main import creation

    workspace = RunWorkspace(Config.RUN_DIR).initialize()
    log_info("Starting DrugEvolve experiment pipeline")

    experiment_count = 0
    successful_experiments = 0
    consecutive_failures = 0
    max_experiments = int(os.getenv("DRUGEVOLVE_MAX_EXPERIMENTS", "1"))
    max_consecutive_failures = int(
        os.getenv("DRUGEVOLVE_MAX_CONSECUTIVE_FAILURES", "3")
    )
    if run_spec is not None:
        max_experiments = run_spec.budget.max_rounds
        max_consecutive_failures = run_spec.budget.max_consecutive_failures
    while experiment_count < max_experiments:
        try:
            experiment_count += 1
            state = workspace.load_state()
            state.attempts += 1
            workspace.save_state(state)
            mode = ExperimentMode.CREATION.value

            log_info(f"Experiment #{experiment_count} | Mode: {mode.upper()}")
            start_pipeline(pipeline_name=f"exp{experiment_count}_{mode}")

            if mode == "creation":
                await creation()
            else:
                raise RuntimeError(f"Unknown experiment mode: {mode}")

            log_info(f"Experiment #{experiment_count} completed successfully")
            end_pipeline(success=True, summary=f"Experiment #{experiment_count} ({mode}) completed")
            successful_experiments += 1
            consecutive_failures = 0
            workspace.complete_step(success=True)
            if run_spec is not None and run_spec.budget.patience > 0:
                current_state = workspace.load_state()
                if current_state.rounds_without_improvement >= run_spec.budget.patience:
                    log_info(
                        "Stopping because patience was exhausted after "
                        f"{current_state.rounds_without_improvement} non-improving rounds"
                    )
                    break
        except KeyboardInterrupt:
            log_warning("Pipeline interrupted by user")
            end_pipeline(success=False, summary="Interrupted by user")
            break
        except Exception as e:
            error_msg = str(e)
            loc = None
            try:
                tb = e.__traceback__
                while tb and tb.tb_next:
                    tb = tb.tb_next
                if tb:
                    frame = tb.tb_frame
                    filename = frame.f_code.co_filename
                    lineno = tb.tb_lineno
                    func = frame.f_code.co_name
                    loc = f"{os.path.basename(filename)}:{lineno} in {func}"
            except Exception:
                loc = None

            if error_msg.startswith("[SKIP]"):
                msg = error_msg[6:].strip()
                log_info(f"Experiment #{experiment_count} skipped: {msg}")
                end_pipeline(success=True, summary=f"Skipped: {msg}")
            elif error_msg.startswith("[FAILED]"):
                msg = error_msg[8:].strip()
                log_warning(f"Experiment #{experiment_count} failed: {msg}")
                end_pipeline(success=False, summary=f"Failed: {msg}")
                consecutive_failures += 1
            else:
                if loc:
                    log_error(f"Experiment #{experiment_count} error: {error_msg} [{loc}]")
                else:
                    log_error(f"Experiment #{experiment_count} error: {error_msg}")
                end_pipeline(success=False, summary=f"Error: {error_msg}")
                consecutive_failures += 1

            workspace.complete_step(success=False)

            if consecutive_failures >= max_consecutive_failures:
                log_error(
                    "Stopping after "
                    f"{consecutive_failures} consecutive failed experiments"
                )
                break

            if experiment_count < max_experiments:
                log_info("Waiting 5 seconds before next experiment...")
                await asyncio.sleep(5)

    log_info(
        f"Pipeline stopped after {experiment_count} attempts "
        f"({successful_experiments} successful)"
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
