import os


class Config:
    """Configuration settings for the DrugEvolve experiment.

    DrugEvolve is a generic, task-agnostic algorithm-evolution framework for
    drug discovery / pharmaceutical ML tasks. All paths, samplers and retry
    budgets are centralized here so that downstream agents, scripts and
    utility modules can stay task-agnostic.
    """

    # ---- Repository / runtime layout ----
    # ROOT_DIR points to the absolute path of the DrugEvolve repository.
    # Override via environment variable in production deployments.
    ROOT_DIR: str = os.getenv(
        "DRUGEVOLVE_ROOT",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
    )

    # GPU identifier used by the direct local trainer.
    CUDA_DEVICE: str = os.getenv("CUDA_DEVICE", "0")

    # ---- Algorithm workspace ----
    # SOURCE_FILE: the template run script of the current task. The Engineer
    # copies this script and rewrites MODEL_PATH to point at the candidate
    # algorithm implementation under CODE_DIR.
    SOURCE_FILE: str = os.getenv(
        "DRUGEVOLVE_SOURCE_FILE",
        f"{ROOT_DIR}/tasks/<your_task>/src/run.sh",
    )
    CODE_DIR: str = os.getenv(
        "DRUGEVOLVE_CODE_DIR",
        f"{ROOT_DIR}/tasks/<your_task>/src",
    )
    LOGS_DIR: str = os.getenv(
        "DRUGEVOLVE_LOGS_DIR",
        f"{ROOT_DIR}/tasks/<your_task>/src",
    )
    AGENT_LOG_DIR: str = os.getenv(
        "DRUGEVOLVE_AGENT_LOG_DIR",
        f"{ROOT_DIR}/pipeline/logs/"
        f"{os.getenv('DRUGEVOLVE_TASK_NAME', '<your_task>')}_cuda{CUDA_DEVICE}",
    )

    # ---- Reproducible run workspace ----
    RUN_NAME: str = os.getenv("DRUGEVOLVE_RUN_NAME", "default")
    RUNS_DIR: str = os.getenv("DRUGEVOLVE_RUNS_DIR", f"{ROOT_DIR}/.drugevolve/runs")
    RUN_DIR: str = os.getenv("DRUGEVOLVE_RUN_DIR", f"{RUNS_DIR}/{RUN_NAME}")
    RUN_SPEC: str = os.getenv("DRUGEVOLVE_RUN_SPEC", f"{RUN_DIR}/run_spec.yaml")
    PROMPT_DIR: str = os.getenv("DRUGEVOLVE_PROMPT_DIR", "")
    REQUIRE_PREFLIGHT: bool = os.getenv(
        "DRUGEVOLVE_REQUIRE_PREFLIGHT", "1"
    ).lower() not in {"0", "false", "no"}

    TRAINING_TIMEOUT: int = int(os.getenv("DRUGEVOLVE_TRAINING_TIMEOUT", "7200"))
    EVALUATION_TIMEOUT: int = int(os.getenv("DRUGEVOLVE_EVALUATION_TIMEOUT", "7200"))

    # ---- Retry / sanity budgets ----
    MAX_DEBUG_ATTEMPT: int = int(os.getenv("MAX_DEBUG_ATTEMPT", "5"))
    ENTROPY_THRESHOLD: float = float(os.getenv("ENTROPY_THRESHOLD", "2.0"))

    MAX_RETRY_ATTEMPTS: int = int(os.getenv("MAX_RETRY_ATTEMPTS", "3"))
    MAX_ABLATION_ATTEMPTS: int = int(os.getenv("MAX_ABLATION_ATTEMPTS", "3"))
    MAX_CREATION_ATTEMPTS: int = int(os.getenv("MAX_CREATION_ATTEMPTS", "3"))
    MAX_AC_ATTEMPTS: int = int(os.getenv("MAX_AC_ATTEMPTS", "5"))
    MAX_SUMMARY_ATTEMPTS: int = int(os.getenv("MAX_SUMMARY_ATTEMPTS", "3"))
    MAX_ANALYSIS_ATTEMPTS: int = int(os.getenv("MAX_ANALYSIS_ATTEMPTS", "3"))
    MAX_CONSECUTIVE_FAILURES: int = int(
        os.getenv("DRUGEVOLVE_MAX_CONSECUTIVE_FAILURES", "3")
    )

    # ---- Sampler configuration ----
    SAMPLER_TYPE: str = os.getenv("DRUGEVOLVE_SAMPLER_TYPE", "ucb1")  # "ucb1" or "island"
    SAMPLER_EXPLORATION_COEFFICIENT: float = float(
        os.getenv("DRUGEVOLVE_SAMPLER_EXPLORATION_COEFFICIENT", "1.414")
    )
    SAMPLER_NUM_ISLANDS: int = int(
        os.getenv("DRUGEVOLVE_SAMPLER_NUM_ISLANDS", "4")
    )
    SAMPLER_EXPLORATION_RATIO: float = float(
        os.getenv("DRUGEVOLVE_SAMPLER_EXPLORATION_RATIO", "0.2")
    )
    SAMPLER_EXPLOITATION_RATIO: float = float(
        os.getenv("DRUGEVOLVE_SAMPLER_EXPLOITATION_RATIO", "0.3")
    )
    SAMPLER_FEATURE_DIMENSIONS: list[str] = [
        item.strip()
        for item in os.getenv(
            "DRUGEVOLVE_SAMPLER_FEATURE_DIMENSIONS", "complexity,diversity"
        ).split(",")
        if item.strip()
    ]
    SAMPLER_FEATURE_BINS: int = int(
        os.getenv("DRUGEVOLVE_SAMPLER_FEATURE_BINS", "10")
    )

    # Parent node sampling ratios (exploitation-focused).
    PARENT_EXPLORE_RATIO: float = float(os.getenv("DRUGEVOLVE_PARENT_EXPLORE", "0.2"))
    PARENT_EXPLOIT_RATIO: float = float(os.getenv("DRUGEVOLVE_PARENT_EXPLOIT", "0.5"))

    # Context/reference node sampling ratios (exploration-focused).
    CONTEXT_EXPLORE_RATIO: float = float(os.getenv("DRUGEVOLVE_CONTEXT_EXPLORE", "0.5"))
    CONTEXT_EXPLOIT_RATIO: float = float(os.getenv("DRUGEVOLVE_CONTEXT_EXPLOIT", "0.2"))

    # Objective-only scoring preserves the historical behavior. Users may
    # opt into a blended LLM score explicitly.
    OBJECTIVE_SCORE_WEIGHT: float = float(
        os.getenv("DRUGEVOLVE_OBJECTIVE_SCORE_WEIGHT", "1.0")
    )
    LLM_SCORE_WEIGHT: float = float(os.getenv("DRUGEVOLVE_LLM_SCORE_WEIGHT", "0.0"))


__all__ = ["Config"]
