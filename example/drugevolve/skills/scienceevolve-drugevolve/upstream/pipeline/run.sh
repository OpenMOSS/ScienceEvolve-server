#!/bin/bash
# DrugEvolve single-process launcher. Useful for debugging.
#
# Required environment variables (all defined in ``env.sh``):
#   DRUGEVOLVE_API_KEY    : OpenAI-compatible API key
#   DRUGEVOLVE_BASE_URL   : OpenAI-compatible base URL
#
# Optional (all have sensible defaults — see env.sh):
#   DRUGEVOLVE_TASK_NAME, DRUGEVOLVE_SAMPLER_TYPE, CUDA_DEVICE, …
#
# Usage:
#   export DRUGEVOLVE_API_KEY="sk-..."
#   cd DrugEvolve/pipeline
#   bash run.sh

set -e

# Pull in every environment variable + default the framework understands.
# shellcheck disable=SC1091
source "$(dirname "$0")/env.sh"

# Select the GPU visible to the direct trainer.
export CUDA_DEVICE="${CUDA_DEVICE:-0}"

# Conda activation (best-effort).
if command -v conda >/dev/null 2>&1; then
    CONDA_PATH=$(conda info --base)
    # shellcheck disable=SC1091
    source "$CONDA_PATH/etc/profile.d/conda.sh"
    conda activate "$CONDA_ENV"
fi

exec python -u "$(dirname "$0")/pipeline.py"
