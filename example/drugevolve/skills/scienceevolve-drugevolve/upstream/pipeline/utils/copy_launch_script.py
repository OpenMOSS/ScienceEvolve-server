"""Helpers that copy the task ``run.sh`` template to a new algorithm directory.

These helpers know nothing about peptide design — they only manipulate the
shell-script and starter ``model.py`` template that the rest of DrugEvolve
needs to launch a candidate algorithm.

You should customise :func:`generate_model_content` to point at your task
implementation (e.g. your ADMET model, your molecular generator, your
docking pipeline, …).
"""

from __future__ import annotations

import os
import re

from config import Config


# ---------------------------------------------------------------------------
# Launch script templating
# ---------------------------------------------------------------------------

def generate_training_script(
    original_name: str,
    name: str,
    input_script_path: str,
) -> str:
    """Materialize ``run.sh`` for a new algorithm.

    Reads the template at ``input_script_path``, rewrites any ``MODEL_PATH``
    occurrences to point at the candidate's ``model.py``, and writes the
    result to ``Config.CODE_DIR/algorithm/<original_name>/launch_bash.sh``.
    """
    with open(input_script_path, "r", encoding="utf-8") as f:
        script_content = f.read()

    script_content = re.sub(
        r'export\s+MODEL_PATH="\$\{?Config\.CODE_DIR\}?/algorithm/[^/"]+/model\.py"',
        f'export MODEL_PATH="{Config.CODE_DIR}/algorithm/{original_name}/model.py"',
        script_content,
    )
    # Best-effort fallback for hard-coded absolute MODEL_PATH paths.
    script_content = re.sub(
        r'export\s+MODEL_PATH="[^"]*model\.py"',
        f'export MODEL_PATH="{Config.CODE_DIR}/algorithm/{original_name}/model.py"',
        script_content,
    )

    script_path = os.path.join(
        Config.CODE_DIR, "algorithm", original_name, "launch_bash.sh"
    )
    os.makedirs(os.path.dirname(script_path), exist_ok=True)
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(script_content)

    init_file_path = os.path.join(
        Config.CODE_DIR, "algorithm", original_name, "__init__.py"
    )
    with open(init_file_path, "w", encoding="utf-8") as f:
        f.write(_INIT_TEMPLATE)

    return script_path


def generate_init_content() -> str:
    """Return the package ``__init__.py`` content used by DrugEvolve."""
    return _INIT_TEMPLATE


# ---------------------------------------------------------------------------
# Starter ``model.py`` template
# ---------------------------------------------------------------------------

def generate_model_content() -> str:
    """Return the starter ``model.py`` content that the implementer agent edits.

    Replace the body with a minimal trainable entry point for your task.
    The default below just reads a CSV and prints the row count, which is
    enough to smoke-test the pipeline end-to-end.
    """
    return '''"""Starter template for a DrugEvolve candidate algorithm.

Replace the body below with the actual implementation produced by the
implementer agent. The script is invoked by ``launch_bash.sh`` with the
following CLI arguments:

    --train_file   path to the training CSV
    --val_file     path to the validation CSV
    --test_file    path to the test CSV
    --output_dir   directory in which to save model checkpoints
    --dataset      dataset / benchmark name
    --logging_dir  directory for TensorBoard / similar logs
"""

from __future__ import annotations

import argparse
import os


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DrugEvolve candidate model")
    parser.add_argument("--train_file", type=str, required=True)
    parser.add_argument("--val_file", type=str, required=True)
    parser.add_argument("--test_file", type=str, required=True)
    parser.add_argument("--output_dir", type=str, required=True)
    parser.add_argument("--dataset", type=str, default="default")
    parser.add_argument("--logging_dir", type=str, default="./logs")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    os.makedirs(args.logging_dir, exist_ok=True)

    for split, path in (
        ("train", args.train_file),
        ("val", args.val_file),
        ("test", args.test_file),
    ):
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                n_lines = sum(1 for _ in f)
            print(f"[{args.dataset}] {split}: {n_lines} rows in {path}")
        else:
            print(f"[{args.dataset}] {split}: file not found at {path}")

    # Write a dummy metric file so DrugEvolve's score parser can pick it up.
    metric_path = os.path.join(args.output_dir, f"{args.dataset}_metric.csv")
    with open(metric_path, "w", encoding="utf-8") as f:
        f.write("metric,value\\nplaceholder,0.0\\n")

    test_csv_path = os.path.join(args.output_dir, f"{args.dataset}_test.csv")
    with open(test_csv_path, "w", encoding="utf-8") as f:
        f.write("metric,value\\nplaceholder,0.0\\n")


if __name__ == "__main__":
    main()
'''


# ---------------------------------------------------------------------------
# Internal templates
# ---------------------------------------------------------------------------

_INIT_TEMPLATE = '''import importlib
import pkgutil

__all__ = []

for _loader, _module_name, _is_pkg in pkgutil.iter_modules(__path__):
    _module = importlib.import_module(f".{_module_name}", __package__)
    for _attribute_name in dir(_module):
        if _attribute_name.startswith("_"):
            continue
        _attribute = getattr(_module, _attribute_name)
        globals()[_attribute_name] = _attribute
        if _attribute_name not in __all__:
            __all__.append(_attribute_name)
'''


__all__ = [
    "generate_training_script",
    "generate_init_content",
    "generate_model_content",
]