# Research workflows, dual loops, and method sources

**English** | [简体中文](./research-workflows_zh-CN.md) | [← Back to README](../README.md)

This guide explains Main / Worker roles, dual loops, Web / SDK boundaries, and original sources. Use the [collapsed Web tutorials](../README.md#tutorial) for operations and [setup and configuration](configuration.md) for parameters.

## Choose your interface

**Web / Server (main)** provides visual orchestration, project management, execution traces, and artifact browsing. Examples are static repository Workflow files that users can reuse manually through the existing generic importer.

**[SDK / CLI](https://github.com/OpenMOSS/ScienceEvolve)** runs corresponding workflows through TypeScript or the command line. See the detailed [main / SDK parity and host boundaries](main-sdk-parity.md).

## Main and Workers

Every project contains exactly one required `main` Agent. It interprets requirements, schedules work, handles user input and recovery, and verifies delivery under the termination protocol. Workers perform research, experiments, writing, review, and custom tasks. A method may authorize a terminal Worker to verify completion directly. An edge to finish alone is insufficient.

Each Agent can select Codex, Claude Code, DSH, or pi, with its own model, prompt, Skills, MCP services, reasoning options, and execution permissions. Gateways support OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. See [gateways](configuration.md#global-gateways) and [Agent settings](configuration.md#agent).

Git collaboration organizes parallel paths through internal workflows and nested groups. References to the same Agent share configuration and sessions. Leaders coordinate within group scope, with PR integration at each level. See [scoped collaboration workflows (v3)](openfars-collaboration/scoped-workflow-v3-en.md).

## Dual loops

The task loop uses execution feedback to improve methods. The process loop uses research results to improve the workflow. Task iteration can operate in a fixed graph; process evolution requires dynamic-reconfiguration authorization.

![Task, research workflow, and Evolver form task and process feedback loops](images/dual-loop-en.png)

### Evolver within the research workflow

![Evolver lives inside the workflow and updates its configuration using feedback](images/self-evolving-workflow-en.png)

The current Evolver is an authorized Main. Enable `orchestration.allowMainReconfiguration` before creation. Permitted autonomous Main turns can edit the generated `workflow.json` proposal and call `apply_workflow`. Server validates the entire document, graph, references, runtime capabilities, and base version before accepting it atomically. Failed validation preserves the previous state.

Main can change its own and other Agents' editable settings. Credentials, permissions, session/reasoning policies, and authorization remain managed by the host. Accepted Project Skill/MCP content cannot be overwritten under the same name; add a definition and update references for a new version. See the [Workflow scope](configuration.md#workflow). Actual task evaluation determines whether the change improves research.

## Research papers and method examples

The main branch's [example index](../example/README_en.md) presents 21 workflow examples: three starters and 18 workflows from papers or open-source projects. Inspect source files and real canvas screenshots, then manually export and import a copy; the application does not load them automatically. The SDK source commit is `4160a2cf0259b2a1ed9dc4eb36bc0484d2527a42`; [catalog.json](../example/catalog.json) records their status.

### Papers, official projects, and implementations

The links below attribute the original work. We adapt public processes as ScienceEvolve Workflows. Each example retains source pins, licenses, capability mappings, and execution protocols.

| Method and local implementation | Original paper | Official code / project |
| --- | --- | --- |
| [ARIS](../example/aris/README.md) · [Workflow](../example/aris/workflow.json) | [ARIS: Autonomous Research via Adversarial Multi-Agent Collaboration](https://arxiv.org/abs/2605.03042) | [Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) |
| [Meta-Harness](../example/metaharness/README.md) · [Workflow](../example/metaharness/workflow.json) | [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052) | [meta-harness](https://github.com/stanford-iris-lab/meta-harness) |
| [autoresearch](../example/autoresearch/README.md) · [Workflow](../example/autoresearch/workflow.json) | Official project is the source | [autoresearch](https://github.com/karpathy/autoresearch) |
| [FunSearch](../example/funsearch/README.md) · [Workflow](../example/funsearch/workflow.json) | [Mathematical discoveries from program search with large language models](https://www.nature.com/articles/s41586-023-06924-6) | [funsearch](https://github.com/google-deepmind/funsearch) |
| [Agent Laboratory](../example/agent-laboratory/README.md) · [Workflow](../example/agent-laboratory/workflow.json) | [Agent Laboratory: Using LLM Agents as Research Assistants](https://arxiv.org/abs/2501.04227) | [AgentLaboratory](https://github.com/SamuelSchmidgall/AgentLaboratory) |
| [SciAgents](../example/sciagents/README.md) · [Workflow](../example/sciagents/workflow.json) | [SciAgents: Automating scientific discovery through multi-agent intelligent graph reasoning](https://arxiv.org/abs/2409.05556) | [SciAgentsDiscovery](https://github.com/lamm-mit/SciAgentsDiscovery) |
| [Robin](../example/robin/README.md) · [Workflow](../example/robin/workflow.json) | [Robin: A multi-agent system for automating scientific discovery](https://arxiv.org/abs/2505.13400v1) | [robin](https://github.com/Future-House/robin) |
| [Google AI co-scientist](../example/co-scientist/README.md) · [Workflow](../example/co-scientist/workflow.json) | [Towards an AI co-scientist](https://arxiv.org/abs/2502.18864v1) | — † |
| [Biomni A1 / E1](../example/biomni/README.md) · [Workflow](../example/biomni/workflow.json) | [Biomni: A General-Purpose Biomedical AI Agent](https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1) | [Biomni](https://github.com/snap-stanford/Biomni) |
| [AgentRxiv](../example/agentrxiv/README.md) · [Workflow](../example/agentrxiv/workflow.json) | [AgentRxiv: Towards Collaborative Autonomous Research](https://arxiv.org/abs/2503.18102) | [AgentLaboratory](https://github.com/SamuelSchmidgall/AgentLaboratory) |
| [RRSI](../example/rrsi/README.md) · [Workflow](../example/rrsi/workflow.json) | [RRSI: Regularized Recursive Self-Improvement of Agent Harnesses](https://arxiv.org/abs/2609.24972) | [rrsi](https://github.com/google-research/rrsi) |
| [DrugEvolve](../example/drugevolve/README.md) · [Workflow](../example/drugevolve/workflow.json) | [An AI System for Autonomous Algorithm Evolution in Drug Development](https://www.biorxiv.org/content/10.64898/2026.08.16.745117v1) | [DrugEvolve](https://github.com/GAIR-NLP/DrugEvolve) |
| [ScientistTwo](../example/scientist-two/README.md) · [Workflow](../example/scientist-two/workflow.json) | [ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI](https://arxiv.org/abs/2609.19644v1) | — † |

† The pinned sources for Google AI co-scientist and ScientistTwo do not provide the complete official systems. Their implementations use published papers and available components; independent parameters and assumptions are documented per example. Components such as PaperOrchestra are not the complete ScientistTwo codebase. autoresearch uses the official project as its source; AgentRxiv reference code is in Agent Laboratory. Compact reference metadata is in [method-sources.json](readme/method-sources.json).

### Use manually in the Web UI

1. Choose an original Workflow, requirement, and reference assets from [example/](../example/README_en.md). [Canvas screenshots](readme/workflows/README_en.md) show their layout.
2. Run the optional exporter on the Server host, then select the generated copy with **“导入 SDK workflow.json”** on the homepage. The original stays read-only; select it in quick launch to load an editable copy.
3. Paste requirements separately, prepare real inputs/data, and configure each Agent's Web gateway, Harness, model, and reasoning option. Preserve required cross-family review, fixed evaluation targets, and mandatory stages.
4. Check Git mode, Skill paths, and external tools before starting; inspect actual traces, commands, raw outputs, and final deliverables.

See [manual usage](../example/README_en.md#manual-use-in-web). SDK profiles, bindings, `--workspace`, and state-directory arguments do not automatically configure Web gateways. Use the [SDK branch guide](https://github.com/OpenMOSS/ScienceEvolve) for SDK execution and [Workflow configuration](configuration.md#workflow) for the generic importer.

### Validation and attribution boundaries

Workflow implementation, offline protocol checks, real end-to-end execution, and paper-metric reproduction require different evidence. The examples record their configuration, algorithm/tool-contract, and source-check scope. Such checks do not establish successful model runs, GPU experiments, or wet-lab execution.

For each research run, retain input/data versions, actual models/Harnesses, tools and compute, parameters, baselines, all candidates and failure branches, raw measurements, and final artifacts. Compare evaluation against the original paper's protocol. Record missing resources or environment blocks as unfinished work; do not omit stages and claim complete reproduction.

Additional imported designs are included as workflow configuration adaptations. Per-example notes and the pinned SDK source retain the implementation details and scope.
