#!/bin/bash
# =============================================================================
# DrugEvolve — environment-variable source of truth
# =============================================================================
#
# Every launcher in this repository (`run.sh`) sources this
# file to (1) pick a default for every environment variable the framework
# understands, and (2) sanity-check that the user-supplied values look
# reasonable before kicking off the pipeline.
#
# You only need to set the variables whose default you want to override.
# Variables you do not care about can simply be left blank.
#
# A quick recipe:
#
#   cd DrugEvolve/pipeline
#   export DRUGEVOLVE_API_KEY="sk-..."
#   export DRUGEVOLVE_BASE_URL="https://api.openai.com/v1/"
#   # edit the task-specific block below to match your drug-discovery task
#   bash run.sh
#
# All variables are namespaced with `DRUGEVOLVE_` to avoid clashing with
# other tools in your shell environment. ``CUDA_DEVICE`` follows the common
# GPU-selection convention.
# =============================================================================

# Fail loudly if this file is sourced incorrectly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "[env.sh] Please source this file, do not execute it directly." >&2
    echo "        e.g.  source pipeline/env.sh" >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# 1. LLM (OpenAI-compatible endpoint)
# -----------------------------------------------------------------------------
# Required. The framework talks to the LLM through the `openai-agents` SDK,
# which is compatible with any OpenAI-shaped endpoint. For convenience we
# also export the standard OPENAI_API_KEY so the SDK can fall back to it.
export DRUGEVOLVE_API_KEY="${DRUGEVOLVE_API_KEY:-${OPENAI_API_KEY:-}}"
export DRUGEVOLVE_BASE_URL="${DRUGEVOLVE_BASE_URL:-https://api.openai.com/v1/}"
export OPENAI_API_KEY="${DRUGEVOLVE_API_KEY}"  # SDK default

# -----------------------------------------------------------------------------
# 2. Local GPU selection
# -----------------------------------------------------------------------------
# The direct trainer maps this to CUDA_VISIBLE_DEVICES when it is not already
# set by a scheduler or container runtime.
export CUDA_DEVICE="${CUDA_DEVICE:-0}"

# -----------------------------------------------------------------------------
# 3. DrugEvolve project layout
# -----------------------------------------------------------------------------
# Path of the DrugEvolve repository. Used as the anchor for every other
# default below.
export DRUGEVOLVE_ROOT="${DRUGEVOLVE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Algorithm workspace — the directory where the candidate
# ``launch_bash.sh`` and ``model.py`` live. Replace ``<your_task>`` with
# the actual task directory you created.
export DRUGEVOLVE_TASK_NAME="${DRUGEVOLVE_TASK_NAME:-<your_task>}"
export DRUGEVOLVE_TASKS_DIR="${DRUGEVOLVE_TASKS_DIR:-${DRUGEVOLVE_ROOT}/tasks}"
export DRUGEVOLVE_SOURCE_FILE="${DRUGEVOLVE_SOURCE_FILE:-${DRUGEVOLVE_TASKS_DIR}/${DRUGEVOLVE_TASK_NAME}/src/run.sh}"
export DRUGEVOLVE_CODE_DIR="${DRUGEVOLVE_CODE_DIR:-${DRUGEVOLVE_TASKS_DIR}/${DRUGEVOLVE_TASK_NAME}/src}"
export DRUGEVOLVE_LOGS_DIR="${DRUGEVOLVE_LOGS_DIR:-${DRUGEVOLVE_CODE_DIR}}"
export DRUGEVOLVE_AGENT_LOG_DIR="${DRUGEVOLVE_AGENT_LOG_DIR:-${DRUGEVOLVE_ROOT}/pipeline/logs/${DRUGEVOLVE_TASK_NAME}_cuda${CUDA_DEVICE}}"

# -----------------------------------------------------------------------------
# 4. Retry / sanity budgets (numeric)
# -----------------------------------------------------------------------------
export MAX_DEBUG_ATTEMPT="${MAX_DEBUG_ATTEMPT:-5}"
export ENTROPY_THRESHOLD="${ENTROPY_THRESHOLD:-2.0}"
export MAX_RETRY_ATTEMPTS="${MAX_RETRY_ATTEMPTS:-3}"
export MAX_ABLATION_ATTEMPTS="${MAX_ABLATION_ATTEMPTS:-3}"
export MAX_CREATION_ATTEMPTS="${MAX_CREATION_ATTEMPTS:-3}"
export MAX_AC_ATTEMPTS="${MAX_AC_ATTEMPTS:-5}"
export MAX_SUMMARY_ATTEMPTS="${MAX_SUMMARY_ATTEMPTS:-3}"
export MAX_ANALYSIS_ATTEMPTS="${MAX_ANALYSIS_ATTEMPTS:-3}"
export DRUGEVOLVE_MAX_EXPERIMENTS="${DRUGEVOLVE_MAX_EXPERIMENTS:-1}"
export DRUGEVOLVE_MAX_CONSECUTIVE_FAILURES="${DRUGEVOLVE_MAX_CONSECUTIVE_FAILURES:-3}"
export DRUGEVOLVE_TRAINING_TIMEOUT="${DRUGEVOLVE_TRAINING_TIMEOUT:-7200}"
export DRUGEVOLVE_EVALUATION_TIMEOUT="${DRUGEVOLVE_EVALUATION_TIMEOUT:-7200}"

# -----------------------------------------------------------------------------
# 5. Sampler configuration
# -----------------------------------------------------------------------------
export DRUGEVOLVE_SAMPLER_TYPE="${DRUGEVOLVE_SAMPLER_TYPE:-ucb1}"   # ucb1 | island
export DRUGEVOLVE_SAMPLER_EXPLORATION_COEFFICIENT="${DRUGEVOLVE_SAMPLER_EXPLORATION_COEFFICIENT:-1.414}"
export DRUGEVOLVE_SAMPLER_NUM_ISLANDS="${DRUGEVOLVE_SAMPLER_NUM_ISLANDS:-4}"
export DRUGEVOLVE_SAMPLER_EXPLORATION_RATIO="${DRUGEVOLVE_SAMPLER_EXPLORATION_RATIO:-0.2}"
export DRUGEVOLVE_SAMPLER_EXPLOITATION_RATIO="${DRUGEVOLVE_SAMPLER_EXPLOITATION_RATIO:-0.3}"
export DRUGEVOLVE_SAMPLER_FEATURE_DIMENSIONS="${DRUGEVOLVE_SAMPLER_FEATURE_DIMENSIONS:-complexity,diversity}"
export DRUGEVOLVE_SAMPLER_FEATURE_BINS="${DRUGEVOLVE_SAMPLER_FEATURE_BINS:-10}"
export DRUGEVOLVE_PARENT_EXPLORE="${DRUGEVOLVE_PARENT_EXPLORE:-0.2}"
export DRUGEVOLVE_PARENT_EXPLOIT="${DRUGEVOLVE_PARENT_EXPLOIT:-0.5}"
export DRUGEVOLVE_CONTEXT_EXPLORE="${DRUGEVOLVE_CONTEXT_EXPLORE:-0.5}"
export DRUGEVOLVE_CONTEXT_EXPLOIT="${DRUGEVOLVE_CONTEXT_EXPLOIT:-0.2}"
export DRUGEVOLVE_RUN_NAME="${DRUGEVOLVE_RUN_NAME:-default}"
export DRUGEVOLVE_RUNS_DIR="${DRUGEVOLVE_RUNS_DIR:-${DRUGEVOLVE_ROOT}/.drugevolve/runs}"
export DRUGEVOLVE_RUN_DIR="${DRUGEVOLVE_RUN_DIR:-${DRUGEVOLVE_RUNS_DIR}/${DRUGEVOLVE_RUN_NAME}}"
export DRUGEVOLVE_RUN_SPEC="${DRUGEVOLVE_RUN_SPEC:-${DRUGEVOLVE_RUN_DIR}/run_spec.yaml}"
export DRUGEVOLVE_REQUIRE_PREFLIGHT="${DRUGEVOLVE_REQUIRE_PREFLIGHT:-1}"
export DRUGEVOLVE_OBJECTIVE_SCORE_WEIGHT="${DRUGEVOLVE_OBJECTIVE_SCORE_WEIGHT:-1.0}"
export DRUGEVOLVE_LLM_SCORE_WEIGHT="${DRUGEVOLVE_LLM_SCORE_WEIGHT:-0.0}"

# -----------------------------------------------------------------------------
# 6. Task-specific
# -----------------------------------------------------------------------------
# `DRUGEVOLVE_DATASET` is the per-task dataset name the framework appends
# to log file names (``<dataset>.txt``, ``<dataset>_metric.txt``).
# `DRUGEVOLVE_BASELINE_CONTENT` is the markdown block describing the
# baseline algorithm that the Judger and Analyzer agents compare against.
export DRUGEVOLVE_DATASET="${DRUGEVOLVE_DATASET:-default}"
export DRUGEVOLVE_BASELINE_CONTENT="${DRUGEVOLVE_BASELINE_CONTENT:-}"

# -----------------------------------------------------------------------------
# 7. Agent model override (advanced)
# -----------------------------------------------------------------------------
# A JSON document that overrides the static model assignment in
# ``Creation/agent_models.py``. Example:
#   export DRUGEVOLVE_AGENT_MODELS='{"creation.engineer.judger": "gpt-4o"}'
export DRUGEVOLVE_AGENT_MODELS="${DRUGEVOLVE_AGENT_MODELS:-}"
export DRUGEVOLVE_DEFAULT_MODEL="${DRUGEVOLVE_DEFAULT_MODEL:-gpt-4o-mini}"
export DRUGEVOLVE_REASONING_EFFORT="${DRUGEVOLVE_REASONING_EFFORT:-}"
export DRUGEVOLVE_LOG_CONTENT="${DRUGEVOLVE_LOG_CONTENT:-0}"
export DRUGEVOLVE_PROMPT_DIR="${DRUGEVOLVE_PROMPT_DIR:-}"

# -----------------------------------------------------------------------------
# 8. Conda environment
# -----------------------------------------------------------------------------
export CONDA_ENV="${CONDA_ENV:-drugevolve}"

# -----------------------------------------------------------------------------
# 9. Sanity checks
# -----------------------------------------------------------------------------
_drugevolve_check_errors=0

_drugevolve_warn() { echo "[env.sh] WARNING: $*" >&2; }
_drugevolve_die()  { echo "[env.sh] ERROR:   $*" >&2; _drugevolve_check_errors=1; }

if [[ -z "${DRUGEVOLVE_API_KEY}" ]]; then
    _drugevolve_die "DRUGEVOLVE_API_KEY is not set. Export it before running DrugEvolve."
fi
if [[ ! -f "${DRUGEVOLVE_SOURCE_FILE}" ]]; then
    _drugevolve_warn "DRUGEVOLVE_SOURCE_FILE does not exist: ${DRUGEVOLVE_SOURCE_FILE}"
    if [[ "${DRUGEVOLVE_TASK_NAME}" == "<your_task>" ]]; then
        _drugevolve_warn "  -> set DRUGEVOLVE_TASK_NAME (e.g. export DRUGEVOLVE_TASK_NAME=admet)"
        _drugevolve_warn "  -> and place your task at: ${DRUGEVOLVE_TASKS_DIR}/admet/src/run.sh"
    else
        _drugevolve_warn "  -> place the run script at: ${DRUGEVOLVE_SOURCE_FILE}"
        _drugevolve_warn "  -> or override DRUGEVOLVE_SOURCE_FILE to point at the actual file"
    fi
fi
unset _drugevolve_warn _drugevolve_die
if [[ "${_drugevolve_check_errors}" -ne 0 ]]; then
    unset _drugevolve_check_errors
    # `return` is correct when sourced, `exit` is correct when executed
    # directly. Bash gives us both with the `|| exit` idiom.
    return 1 2>/dev/null || exit 1
fi
unset _drugevolve_check_errors

# Print a one-line summary so users can see which env is in effect.
echo "[env.sh] DrugEvolve environment loaded:"
echo "        DRUGEVOLVE_ROOT     = ${DRUGEVOLVE_ROOT}"
echo "        DRUGEVOLVE_TASK_NAME= ${DRUGEVOLVE_TASK_NAME}"
echo "        CUDA_DEVICE         = ${CUDA_DEVICE}"
echo "        DRUGEVOLVE_API_KEY  = configured"
