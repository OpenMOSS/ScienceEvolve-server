# 研究工作流、双循环与方法来源

[English](./research-workflows.md) | **简体中文** | [← 返回中文 README](../README_zh-CN.md)

本页解释 Main / Worker 分工、双循环、Web / SDK 边界与论文来源。网页操作见 [README 折叠教程](../README_zh-CN.md#tutorial)，具体参数见[安装与配置指南](configuration_zh-CN.md)。

## 选择使用方式

**Web / Server（main）**：可视化编排、项目管理、执行轨迹与产物浏览。示例作为仓库中的静态 Workflow 文件提供，由用户通过现有通用导入入口手动复用。

**[SDK / CLI](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)**：通过 TypeScript 和命令行运行相应工作流。详细能力对照见 [main / SDK 功能一致性与宿主边界](main-sdk-parity-zh.md)。

## Main 与 Worker

每个项目都包含唯一且必需的 `main` Agent，负责理解需求、项目级调度、处理用户输入与失败恢复，并按终止协议验收交付。Worker 执行研究、实验、写作、评审或自定义工作。具体方法可以让获准的终止 Worker 直接验收，不能仅凭存在结束连线判定项目完成。

每个 Agent 可独立选择 Codex、Claude Code、DSH 或 pi，以及模型、提示词、Skills、MCP、思考选项和运行权限。模型网关支持 OpenAI Responses、OpenAI Chat Completions 与 Anthropic Messages；配置步骤见[网关](configuration_zh-CN.md#全局网关)与 [Agent](configuration_zh-CN.md#agent)。

Git 协作通过组内 Workflow 和嵌套协作组组织并行路径。相同 Agent 引用共享配置与会话，Leader 在组内范围协调，PR 按层级集成。详见[协作组内 Workflow（v3）](openfars-collaboration/scoped-workflow-v3.md)。

## 双闭环

任务循环利用执行反馈改进方法，流程循环利用研究结果改进工作流。前者可以在固定编排中持续迭代，后者需要动态重配置授权。

![Task、研究工作流与 Evolver 的任务和流程双循环](images/dual-loop.png)

### Evolver 内置于研究工作流

![Evolver 位于工作流内部，依据反馈修改流程配置](images/self-evolving-workflow.png)

当前 Evolver 对应获得授权的 Main。创建前开启 `orchestration.allowMainReconfiguration` 后，获准的 autonomous Main 轮可编辑系统生成的 `workflow.json` 提案，再调用 `apply_workflow`。Server 校验完整文档、图、引用、运行能力与基础版本，原子提交接受的配置；校验失败保留原状态。

Main 可调整自身及其他 Agent 的可编辑配置；凭据、权限、会话与思考策略、授权开关由宿主管理。已接受的 Project Skill/MCP 内容不可同名覆盖，变更需创建新定义并更新引用。详见 [Workflow 范围](configuration_zh-CN.md#workflow)。流程变化是否改善研究表现，需要实际任务评估。

## 科研论文与方法示例

main 的 [example 展示目录](../example/README.md)收录 21 个工作流示例：3 个入门流程、18 个论文或开源项目工作流。这些文件不由应用自动加载；用户可查看源码、阅读实际画布截图，并手动导出及导入。来源版本为 `4160a2cf0259b2a1ed9dc4eb36bc0484d2527a42`，条目状态见 [catalog.json](../example/catalog.json)。

### 论文、官方项目与实现

以下链接用于引用原始工作。我们将其公开流程适配为 ScienceEvolve Workflow，具体来源 pin、许可、能力映射和执行协议保存在每个例子中。

| 方法与本地实现 | 原始论文 | 官方代码 / 项目 |
| --- | --- | --- |
| [ARIS](../example/aris/README.md) · [Workflow](../example/aris/workflow.json) | [ARIS: Autonomous Research via Adversarial Multi-Agent Collaboration](https://arxiv.org/abs/2605.03042) | [Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) |
| [Meta-Harness](../example/metaharness/README.md) · [Workflow](../example/metaharness/workflow.json) | [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052) | [meta-harness](https://github.com/stanford-iris-lab/meta-harness) |
| [autoresearch](../example/autoresearch/README.md) · [Workflow](../example/autoresearch/workflow.json) | 以官方项目为来源 | [autoresearch](https://github.com/karpathy/autoresearch) |
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

† Google AI co-scientist 与 ScientistTwo 的固定来源未提供完整官方系统源码；相应实现依据公开论文及可用组件，独立实现的参数和假设在各例中标注。ScientistTwo 使用的 PaperOrchestra 等组件不等于完整系统官方代码。autoresearch 以官方项目为来源，AgentRxiv 的参考代码在 Agent Laboratory 仓库中。精简引用数据见 [method-sources.json](readme/method-sources.json)。

### 在 Web 中手动使用

1. 从 [example/](../example/README.md) 选择原始 Workflow、需求与参考资源；[画布截图](readme/workflows/README.md)用于查看布局。
2. 在 Server 主机运行可选导出脚本生成网页副本，再点击主页 **“导入 SDK workflow.json”**。原文只读，在快速发起下拉框中载入可编辑副本。
3. 单独复制需求，准备真实输入与数据，为每个 Agent 配置网页网关、Harness、模型和思考选项。保持方法要求的跨家族评审、固定评估目标和必需阶段。
4. 按原例检查 Git 模式、Skill 路径与外部工具后启动，检查实际轨迹、命令、原始输出和最终交付。

详细步骤见[手动使用说明](../example/README.md#在-web-中手动查看和使用)。SDK 的 profile、bindings、`--workspace` 与状态目录参数不会自动配置 Web；SDK 运行见[分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)，通用导入机制见 [Workflow 配置](configuration_zh-CN.md#workflow)。

### 验证与归因边界

流程实现、离线协议检查、真实端到端运行和论文指标复现分别需要对应证据。当前方法例子记录其配置、算法/工具合同与来源检查范围；这些检查不构成真实模型、GPU 任务或湿实验成功的记录。

验收一次研究时，应保留输入与数据版本、实际模型/Harness、工具及算力条件、参数、基线、所有候选与失败分支、原始测量和最终产物，并对照原论文的评测口径。资源不足或环境阻断要记录为未完成，不能省略阶段后宣称完整复现。

补充导入的设计以 workflow 配置与编排适配纳入展示；各例说明与固定 SDK 来源保留具体实现范围和状态。
