# ScienceEvolve Workflow files and reference implementations

[← Back to README](../README.md#examples) · **English** | [简体中文](README.md)

This directory presents 21 examples corresponding to a pinned SDK source: three starters and 18 workflows from papers or open-source projects, with JSON, requirements, and reference assets. See the [SDK repository](https://github.com/OpenMOSS/ScienceEvolve) for SDK execution. In Web / Server, these are static files for reading, citation, and manual reuse. The application has no dedicated example gallery/API, automatic loading, or example packaging.

## Manual use in Web

1. Keep this directory and its Skill resources on the machine running Server. At the repository root, manually run:

   ```bash
   node example/export-web-workflow.mjs \
     example/aris/workflow.json /tmp/aris.web.json
   ```

   On Windows, replace `/tmp/aris.web.json` with a writable path. The output must be a new file; the script does not overwrite files. Replace `aris` with your chosen directory. Original `workflow.json` and `requirement.txt` remain unchanged.
2. The exported copy adds the Web orchestration format, removes top-level Git and SDK deployment fields, resolves relative Skill references to actual `SKILL.md` paths on this machine, and preserves roles, instructions, models, Harnesses, paths, Loops, and inline Skill/MCP definitions. Check original model and reasoning options against your gateway.
3. On the home page, click **“导入 SDK workflow.json”** (import SDK workflow.json) and select the exported file. The imported original is read-only, with canvas/JSON views and download. Close the preview, then select it under **“快速发起研究任务 → Agent 配置预设”** (quick research task → Agent configuration preset) to load an editable copy using Web-host rules.
4. Copy the corresponding `requirement.txt` separately into the task requirements and add real task inputs. Choose an installed Harness, available gateway, model, and reasoning options per Agent. Git configuration is not part of the imported preset. If the original has `git.enabled: true`, configure a Web GitHub account, enable parallel collaboration, and inspect collaboration groups.
5. Click **“提交并继续”** (submit and continue) to start. If input uploads are needed, first use **“保存 → 另存为新配置”** (save → save as new configuration) in quick start, then select that configuration and upload files on the new-project page. Imported originals cannot be overwritten; edited copies can be saved as configurations or task drafts.

For another Server machine, re-export there or update Skill references to actual paths. Copying JSON does not install Skills, MCP, data, or experiment tools. The existing generic runtime resolves selected Skill paths; the application does not register this directory's resources automatically. Remote Web users first download the Server-host export, then select that file in the browser. UI labels above retain the current Chinese interface wording for identification.

[Full Web tutorial](../README.md#tutorial) · [Detailed configuration](../docs/configuration.md#workflow) · [21 actual canvases](../docs/readme/workflows/README_en.md)

## Workflow examples

| Example | Type | Flow |
| :--- | :--- | :--- |
| [Default research workflow](dynamic-research-workflow/) · [JSON](dynamic-research-workflow/workflow.json) · [Canvas](../docs/readme/workflows/dynamic-research-workflow.jpg) | Starter | Ideation, execution, writing, review, and Main coordination |
| [AHE · Code evolution](01-ahe-evolve/) · [JSON](01-ahe-evolve/workflow.json) · [Canvas](../docs/readme/workflows/01-ahe-evolve.jpg) | Starter | Execution, scoring, refinement Loop, and batch decisions |
| [Software development and testing](02-software-development/) · [JSON](02-software-development/workflow.json) · [Canvas](../docs/readme/workflows/02-software-development.jpg) | Starter | Coding → Testing → repair or delivery |
| [ARIS](aris/) · [JSON](aris/workflow.json) · [Canvas](../docs/readme/workflows/aris.jpg) | Method workflow | W1 → W1.5 → W2 → writing and cross-model review |
| [Meta-Harness](metaharness/) · [JSON](metaharness/workflow.json) · [Canvas](../docs/readme/workflows/metaharness.jpg) | Method workflow | Harness candidates, full-dataset evaluation, and selection |
| [autoresearch](autoresearch/) · [JSON](autoresearch/workflow.json) · [Canvas](../docs/readme/workflows/autoresearch.jpg) | Method workflow | Training experiments and Git keep/discard |
| [FunSearch](funsearch/) · [JSON](funsearch/workflow.json) · [Canvas](../docs/readme/workflows/funsearch.jpg) | Method workflow | Multi-island program database, sampling, and actual evaluation |
| [Agent Laboratory](agent-laboratory/) · [JSON](agent-laboratory/workflow.json) · [Canvas](../docs/readme/workflows/agent-laboratory.jpg) | Method workflow | Seven research substages and solver feedback |
| [SciAgents](sciagents/) · [JSON](sciagents/workflow.json) · [Canvas](../docs/readme/workflows/sciagents.jpg) | Method workflow | Graph reasoning, hypothesis refinement, and independent review |
| [Robin](robin/) · [JSON](robin/workflow.json) · [Canvas](../docs/readme/workflows/robin.jpg) | Method workflow | Candidate screening, live-experiment handoff, and analysis |
| [Google AI co-scientist](co-scientist/) · [JSON](co-scientist/workflow.json) · [Canvas](../docs/readme/workflows/co-scientist.jpg) | Method workflow | Hypothesis generation, reflection, ranking, and evolution |
| [Biomni A1 / E1](biomni/) · [JSON](biomni/workflow.json) · [Canvas](../docs/readme/workflows/biomni.jpg) | Method workflow | Resource retrieval and real biological tool feedback |
| [AgentRxiv](agentrxiv/) · [JSON](agentrxiv/workflow.json) · [Canvas](../docs/readme/workflows/agentrxiv.jpg) | Method workflow | Laboratory research and shared-preprint accumulation |
| [RRSI](rrsi/) · [JSON](rrsi/workflow.json) · [Canvas](../docs/readme/workflows/rrsi.jpg) | Method workflow | Harness diagnosis, measurement, and regularized selection |
| [DrugEvolve](drugevolve/) · [JSON](drugevolve/workflow.json) · [Canvas](../docs/readme/workflows/drugevolve.jpg) | Method workflow | Generation, training, debugging, scoring, and archiving |
| [ScientistTwo](scientist-two/) · [JSON](scientist-two/workflow.json) · [Canvas](../docs/readme/workflows/scientist-two.jpg) | Method workflow | Idea evolution, experiments, writing, and review |
| [AI Scientist v2](ai-scientist-v2/) · [JSON](ai-scientist-v2/workflow.json) · [Canvas](../docs/readme/workflows/ai-scientist-v2.jpg) | Workflow adaptation | Ideation, experiment management, research branches, and writing/review nodes |
| [InternAgent 1.5](internagent-1-5/) · [JSON](internagent-1-5/workflow.json) · [Canvas](../docs/readme/workflows/internagent-1-5.jpg) | Workflow adaptation | Research planning, generation, verification, and evolution |
| [Biomni-R0](biomni-r0/) · [JSON](biomni-r0/workflow.json) · [Canvas](../docs/readme/workflows/biomni-r0.jpg) | Workflow adaptation | Data preparation, trajectories, rewards, training, deployment, and evaluation nodes |
| [Chemical Coscientist](chemical-coscientist/) · [JSON](chemical-coscientist/workflow.json) · [Canvas](../docs/readme/workflows/chemical-coscientist.jpg) | Workflow adaptation | Planner schedules search, documentation, code, and experiment nodes |
| [Raven Host](raven/) · [JSON](raven/workflow.json) · [Canvas](../docs/readme/workflows/raven.jpg) | Workflow adaptation | Two specialist slots and batch decisions |

Examples are included for their workflow structure and orchestration. Individual directories record mappings and adaptation scope; their original implementation notes and requirements retain their source language.

## Files and provenance

Each directory retains `workflow.json`, `requirement.txt`, and implementation notes. Named methods include Skills, scripts, reference implementations, licenses, and source metadata. Original graphs and execution protocols target SDK; Web copies follow main scheduling/session rules. See [Web / SDK boundaries](../docs/main-sdk-parity.md).

The pinned SDK source is `feat/sdk-only-v0.1.1` commit `4160a2cf0259b2a1ed9dc4eb36bc0484d2527a42`. [catalog.json](catalog.json) records directories and status for reference/maintenance; the application does not load it. Project-specific branding uses ScienceEvolve; third-party licenses and source hashes are retained.

Validate original workflows, importable configurations, offline protocols, and scientific outcomes separately. Optional offline checks require Python 3.10+. Install `example/tests/requirements.txt` in an isolated environment, then run `python -m unittest discover -s example/tests`. These checks do not invoke research models or GPU experiments.
