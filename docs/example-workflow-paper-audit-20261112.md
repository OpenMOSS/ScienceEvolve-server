# ScienceEvolve 示例 Workflow 与原论文/官方实现对照

核对日期：2026-11-12。

范围：`openfars/example` 的 21 个示例，以及 `openfars-SDK/example` 的 23 个示例。检查当前工作树；两边已有其他未提交修改，本次没有改动 Workflow、Skill 或运行时代码。

## 1. 结论

**不能把现有全部画布直接当成原论文流程图。主要问题是方法图与宿主调度图混用，不是已发现前端普遍把箭头画反。**

- 21 个共同示例的 `input/routes/scopedWorkflow/loops/termination` 两边一致；SDK 另外包含 Kosmos 和 AlphaEvolve。因此相同拓扑问题通常不是两个仓库之间不同步造成的。
- 11 个方法示例采用 `Main ↔ 各角色` 的中心调度图。它们展示“谁可以被调度”，并不展示完整的研究先后关系、条件分支、共享科学状态与数据反馈。不能仅凭这种图认定方法缺失，也不能凭角色齐全认定方法正确。
- **明确的原方法结构偏离**：化学 Coscientist 增加必经的 `experiment → optimization → planner`；Raven 把动态依赖就绪执行与逐节点判定缩成固定双槽批次；InternAgent 的固定双槽知识流存在调度保真限制，且图中 Generation/Verification 的职责边界容易误读。
- **已披露的适配，而非无意接错线**：Google AI co-scientist 的同步调度、FunSearch 的公开串行管线、Biomni A1 的步骤拆分、AgentRxiv 的单实验室模板、Robin 的公开代码规模。它们可以是适配 demo，但不宜标成与论文架构完全一致。
- **无法通过原方法校验**：Biomni-R0 的训练图目前只能归为待核验设计。官方技术报告链接本次返回 HTTP 404，公开 model card 不足以确认完整训练/reward 流程。
- AI Scientist v2、Kosmos、AlphaEvolve 的主要闭环在角色指令或内嵌工具中有对应，未发现必须倒置的主干边；它们仍是缩小任务适配，不是原引擎、原规模或科学结果复现。

本次实际读取了 17 项方法的原论文/技术报告相关方法章节、流程图图注及必要算法描述；ARIS、autoresearch 对照固定官方仓库；Biomni-R0 对照官方 README/model card 并记录报告访问失败。没有把历史审计报告的评分当作本次结论。

## 2. “画对”的三个不同标准

| 层级 | 应回答的问题 | 本次结论 |
| --- | --- | --- |
| 配置与画布 | JSON 中的节点、路由、Input、Finish、Loop、组内并行入口是否被正确映射？ | 静态导出/导入及画布拓扑检查通过；不是逐像素视觉验收 |
| 研究方法 | 原论文的顺序、分支、并行、反馈、角色与工具边界是否被保留？ | 有结构偏离、已声明适配和展示遗漏，详见下文 |
| 科学复现 | 实验是否真正执行、数据是否有效、结果是否复现？ | 本次未运行科研任务，不能给出通过结论 |

前端 `web/src/components/workflow-canvas/core/canvas-layout.ts:94` 从真实路由构造边；Main 的外发边另标记为 `main-dispatch`。`:174` 起还会依据 `termination.agent` 补充显示 Finish 边。这些是宿主语义，不是论文原生模块或科研成功证据。

`example/export-web-workflow.mjs` 保留编排结构，转换 Skill 路径并去除 Web 不接收的 SDK 部署字段。`server/src/workflow-import.ts:67` 的原文预览不应用 Web 执行规范化。**原文预览、载入 Web 可编辑副本、实际执行仍应分开理解。**

## 3. 优先处理的问题

### 3.1 化学 Coscientist：实验反馈路径增加必经优化节点

**原文依据**：[Nature 原文](https://www.nature.com/articles/s41586-023-06792-0)，`Coscientist system architecture`、Fig. 1。

原文由 Planner 按需调用 GOOGLE、DOCUMENTATION、PYTHON、EXPERIMENT，命令输出返回 Planner。PYTHON 是隔离容器中的代码执行模块，EXPERIMENT 是硬件执行/人工实验交接，并非四个对等研究决策 Agent。

当前：

```text
planner → web_search / documentation / code → planner
planner → experiment → optimization → planner
```

定位：`example/chemical-coscientist/workflow.json:434–485`；`optimization` 的指令还负责提出下一实验改动，而不只是转发回执。

**判定：如果宣称复画原架构，这是实质偏离。** 原论文不要求每次实验之后都先经过一个独立 Optimization Agent。当前方案可被解释为额外分工，但必须明确标记为 ScienceEvolve 扩展。

建议的原方法表达：

```text
用户目标 → Planner
              ├─ 按需调用 Web Search ──────────┐
              ├─ 按需调用 Documentation ──────┤
              ├─ 按需调用 Python Execution ───┤→ 结果/错误 → Planner
              └─ 按需调用 Experiment ─────────┘
```

若保留独立优化角色，应由 Planner 按需委派，而不是把它画成所有实验反馈的必经阶段。Preflight、授权与最终审计作为宿主外围约束保留，不应被误标为论文模块。

### 3.2 Raven：固定双槽与批次 Judge 不是原生动态 DAG

**原文依据**：[官方技术报告](https://github.com/EverMind-AI/Raven/releases/download/tech-report-v1/technical-report.pdf)，§3.1–3.3、Fig. 4–5、Algorithm 1；以及固定官方代码 `25c5768` 的 `raven/agent/subagent/dag_runner.py`、`raven/memory_engine/skills/subagent-dag-orchestration/SKILL.md`。

原方法关键语义：

- 节点所有前驱完成且判定已结算后才执行；无关分支不必等待。
- 每个节点独立判定；失败节点的输出不能被后继消费。
- Host 在其他分支仍执行时接收异常，选择 continue、abandon 或 replan。
- 动态任务节点、instance 会话复用与排他、跨图已完成产物引用。

当前：

```text
Main → delegation(slot_a ∥ slot_b) → judge → Main
```

定位：`example/raven/workflow.json:288–368`。该配置自己明确声明 strict-host 应阻断、limited-batch 不等于完整 Host。

本次使用当前 SDK 源码做了三个无模型探针：

1. Input 的两条 parallel 边确实生成两次独立 activation。
2. `A → C` 与 `B → C` 各自生成一次 C activation，**不是等待 A、B 后只执行一次 C 的 AND-join**。
3. 向节点添加 `dependsOn` 被严格 schema 拒绝。

源码位置：`openfars-SDK/sdk/src/core/scoped-workflow-planner.ts:77,106,141`；`scoped-workflow-contract.ts:38`。

**判定：完整 Raven 方法校验不通过；受限 demo 的自我描述是诚实的。** 不能通过多画几条汇合箭头修复执行语义，也不能把一次批次审核改名为逐节点 Judge 就算对齐。这里需明确选择“保留受限示例”或另行建设通用动态依赖执行能力。

### 3.3 InternAgent 1.5：子系统归属与知识流调度需区分

**原文依据**：[论文](https://arxiv.org/html/2602.08990v1)，§2.1–2.4、Fig. 3、Fig. 5。

原文：Generation 负责 deep research/知识整合与假设；Verification 内包含 solution refinement 和多轮并行实验优化；Evolution 负责证据解释及 SPM/TEM/SKM 更新。

当前：

```text
flow_planner ↔ knowledge(research_a ∥ research_b)
        → generation → optimization(optimizer_a ∥ optimizer_b)
        → verification → evolution → generation / flow_planner
```

两个需要纠正的理解：

- `optimization` 在论文语义上属于 Verification 子系统；当前名为 `verification` 的节点实际上偏向分支完成后的独立复核。`optimization.leaderAgentId` 却是 `generation`（`workflow.json:548–549`）。不能按节点名称把“优化”归入论文 Generation、把整个 Verification 简化成最后一次检查。
- 论文知识流是动态 search/solve/answer 依赖图；当前是两个预绑定 worker 的分批派发。即使后台保存 FlowGraph，也不能据此把宿主的固定批次声称为原依赖就绪调度。

**判定：三子系统的总体循环存在；子系统边界表达不准确，动态调度仅部分对应。** 建议方法图用分组框标明 `Generation=[知识流+假设]`、`Verification=[图增强搜索+实验+复核]`，同时明确固定双槽的限制。不是简单交换两个节点即可解决。

### 3.4 Biomni-R0：通用训练图不能代替原训练方法

定位：`example/biomni-r0/workflow.json`。

```text
curator → rollout → reward → trainer → deployer → evaluator → rollout / audit
```

官方 [model card](https://huggingface.co/biomni/Biomni-R0-32B-Preview) 确认 Qwen3-32B 基础模型、Biomni-E1 环境和端到端 RL，但没有足够信息核对该图的训练循环、奖励分配、优化器和部署/提升策略。README/model card 指向的[技术报告](https://biomni.stanford.edu/blog/biomni-r0-technical-report)本次为 404。

**判定：待核验，不判定为“原论文正确流程”。** 当前 Preflight 阻断符合其设计声明。资料未取得不等于上游从未发布，也不应猜测 SFT/GRPO/PPO 等步骤来补图。

## 4. 11 个中心调度图隐藏了什么

以下共同示例的所有非 Main 角色，配置出边均只有 `→ main`：

`agent-laboratory`、`agentrxiv`、`aris`、`biomni`、`co-scientist`、`drugevolve`、`funsearch`、`robin`、`rrsi`、`sciagents`、`scientist-two`。

这不自动构成运行错误。部分方法本来就由 supervisor/group manager 动态选人；部分由脚本维护真实阶段。但作为论文展示图，需要另显方法层关系，不能把角色清单当成流程。

| 示例 | 原文/官方方法中必须表达的关系 | 当前依据与判定 |
| --- | --- | --- |
| ARIS | W1 → W1.5 → W2 → summary；W3 按 AUTO_WRITE 分支；评审后返回原阶段续跑 | Main 指令和 review bridge 保留；星形图看不出阶段顺序和评审 continuation。不能为美观改成每个角色只执行一次的直线 |
| Agent Laboratory | 文献 → 计划 → 数据 → 实验 → 解释 → 写作 → 评审；求解器内修复/评分/反思；评审可回计划 | 七阶段在 Main/Skill 中；角色图不是七阶段图。同一 PhD/Postdoc 会跨阶段复用 |
| AgentRxiv | 独立实验室各自研究，与共享 archive 异步检索/发布；后续研究消费已发表成果 | 一个项目代表一个 lab，`archive` 是客户端角色，不是整台共享服务器。单图不能代表多实验室部署已发生 |
| Biomni A1/E1 | 资源检索 → A1 规划/代码 → E1 执行 → observation → A1；完成后回答 | `bridge.py` 保留状态转移。图中的多个角色是 A1 内部步骤拆分，E1 是环境。critic 可选；wetlab 是外接扩展 |
| Google AI co-scientist | Supervisor/队列；生成、反思、排名、进化、相似图、meta-feedback；共享假设/比赛状态 | 六核心角色存在；同步替代异步是当前配置明确选择。方法图须画反馈和共享状态，不能伪装成原异步架构 |
| DrugEvolve | Generator ↔ Inspector → Implementer → Trainer ↔ Debugger → Judger → Analyst → 记忆/下一代 | `steps.py` 中存在分支和状态，非真正缺少回路。需要显示 Researcher/Engineer/Analyst 三域及两类记忆 |
| FunSearch | 程序库 → best-shot prompt → sampler → evaluator → 程序库；论文是异步分布式 | `runtime.py` 和原 ProgramsDatabase 保留；当前只有一个 pending prompt 批次，是公开串行适配 |
| Robin | Assay 选择 → 候选筛选 → 人类实验 → 多轨迹分析 → 共识 → insights → 新候选 | 人类实验等待在 Main 指令中；5 条远程并行分析在 `analysis_step.py` 中。画布缺显式人类/数据边界，不等于代码未实现等待 |
| RRSI | baseline → 诊断/digest → 带编辑预算提案 → critic/repair → smoke/测量 → 正则化选择 → 下一轮；结束后冻结 heldout | `protocol.py` 和官方算法约束比星形图丰富；不应简化成“最高分候选获胜” |
| SciAgents | 固定顺序与自动 speaker 两种模式；图路径 → Ontologist → proposal → 七方面细化 → Critic/novelty | 原文 Fig. 1 本身有两种模式；自动 speaker 的中心调度可合理适配，不应强制改成全并行 |
| ScientistTwo | subset/full 的 Good/Bad/Engineer 分支；想法进化；消融再优化；review/rebuttal；meta-review 后再实验或保留旧最佳 | 49 个节点只是角色注册表。关键分支在 `scripts/protocol.py:285–425`，并没有因画布缺直接边而被删掉 |

建议把**方法视图**与**执行路由视图**分开。方法图可以用分组/注释说明 script 或 tool 内部的子流程，但不要为展示效果直接改可执行 JSON：这可能绕过 ticket、prompt ID、阶段门槛和正确的上下文交接。

## 5. 必须披露的论文与参考实现差异

### Google AI co-scientist

[论文](https://arxiv.org/html/2502.18864v1) §3.1–3.3/Fig. 2 明确包含异步 worker/task queue、context memory，以及 meta-review 向后续多个角色传播反馈。

`example/co-scientist/workflow.json:13` 和 Skill 第 11 行明确选择同步替代。六个科学核心角色都在，不能说漏掉某个核心 Agent；但 `wetlab` 是当前增加的外部验证适配，不是论文六种核心 Agent 中的第七种。

建议标识为“同步方法适配”；若画原论文图，应保留异步队列、共享 hypothesis/tournament 状态、Proximity→Ranking、Evolution 新候选回评审/排名、Meta-review→后续角色等数据关系。

### FunSearch

[Nature 原文](https://www.nature.com/articles/s41586-023-06924-6) 的 `Distributed approach` 明确为 programs database、samplers、evaluators 异步通信，通常使用多个 sampler/evaluator。

固定官方 `upstream/funsearch/implementation/funsearch.py:16` 明确标为 single-threaded implementation；当前 `scripts/runtime.py:104–143` 维护单一 pending prompt，全部样本完成后才切换下一 prompt。

**结论：对公开串行实现的定位合理；不是原论文分布式架构。** 程序库不是缺失，而是被隐藏在工具中；应以状态/工具节点展示，不要凭空增加一个会替代确定性数据库逻辑的 LLM Agent。

### Biomni A1/E1

[论文](https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1.full) 的 Overview/Fig. 1c 是一个 generalist A1 使用 E1 环境，动态规划并按 observation 修订。

当前 `scripts/bridge.py:139–173` 以及固定 `biomni/agent/a1.py:1613–1638` 保留生成/执行与可选 critic 转移。因此“多角色”属于宿主实现拆分，不能称为论文原生多科学家团队。方法图应画 A1/E1 边界，标清 critic 可选、湿实验能力外接。

### AgentRxiv

[论文](https://arxiv.org/html/2503.18102v1) §3.1 包含单实验室累计研究，§3.2/Fig. 3 包含多个独立实验室异步共享论文，二者都合法。

Skill 第 35–47 行明确每个项目一个 lab，其他 lab 另起独立项目。因此不能把单模板直接判错，也不能只运行一次 `workflow.json` 就声称完成跨实验室协作。SDK 当前研究课题要求两个实验室；实际验收必须核对两个实例、共享服务和第二轮真实内容消费。

### Robin

[论文](https://arxiv.org/html/2505.13400v1) §2.1 描述研究人员执行实验并上传数据；数据分析可启动 10 条 Finch 轨迹。固定公开 `upstream/robin/analyses.py:13` 则为 `PARALLEL_ANALYSIS = 5`，当前适配脚本也固定 5。

这说明示例对齐的是公开软件版本，不是原论文所有实验规模；不能误报为“SDK 没有并行分析”，也不能说本配置已经等于论文轨迹数。外部人类实验应在展示图中显式出现。

### Agent Laboratory / AgentRxiv 的 MLE-solver

[Agent Laboratory 论文](https://arxiv.org/html/2501.04227v1) §3.2/Fig. 3 描述成功/失败都进行 self-reflection，并提到 batch-parallelization。

固定公开 `mlesolver.py:276–317` 用串行 while 处理尝试，`reflect_code()` 在候选严格改善并替换池项时触发；当前 Skill 与指令按这一源码语义执行。

**这是论文叙述与所选官方源码之间的差异，不是前端接线错误。** 原论文层面验收不能把“忠实跟随固定源码”自动等同于“每条论文机制完全一致”。

## 6. 全部 23 个示例的静态结论

“主干对应”只表示此次未发现必须纠正的主干方向，不表示真实运行或完整源码等价已验证。

| 示例 | 判定 | 原始依据/说明 |
| --- | --- | --- |
| 01-ahe-evolve | 入门示例，不作论文复刻认证 | 检查 execute→judge→optimizer 回路及批次退出即可 |
| 02-software-development | 入门示例，不作论文复刻认证 | coding→testing，修复/交付分支 |
| dynamic-research-workflow | 入门示例，不作论文复刻认证 | 通用研究分工，不对应一篇固定原论文 |
| ARIS | 官方流程适配；方法顺序被调度图隐藏 | [固定 research-pipeline](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/341f914024d270dc5c8fa51337d1ad38829273aa/skills/research-pipeline/SKILL.md) |
| Meta-Harness | 主干对应；单 proposer 被外围执行角色包围 | [论文 §3 / Algorithm 1](https://arxiv.org/html/2603.28052v1)，提案→评测→日志→再提案；搜索与最终 test 分离 |
| autoresearch | 官方循环对应；角色拆分是适配 | [固定 program.md](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md)，baseline、训练、keep/discard/crash、持续运行 |
| FunSearch | 串行参考实现，不是论文异步架构 | 见 §5 |
| Agent Laboratory | 七阶段存在；方法图不完整，源码/论文有差异 | 见 §4–5 |
| SciAgents | 自动 speaker 适配合理；fixed 模式须单独表达 | [论文 Fig. 1–2、§4.3–4.4](https://arxiv.org/html/2409.05556v1) |
| Robin | 公开代码适配；外部实验边界和分析并行需展示 | 见 §5 |
| Google AI co-scientist | 六核心职责对应，但同步与原异步不同 | 见 §5 |
| Biomni A1/E1 | A1 步骤拆分适配，不是原生多研究 Agent 架构 | 见 §5 |
| AgentRxiv | 单 lab 模板合理；跨 lab 需要外层部署图 | 见 §5 |
| RRSI | 原算法约束有对应；方法回路藏在 controller | [论文 §3、Appendix C / Algorithms 1–2](https://arxiv.org/html/2609.24972v1) |
| DrugEvolve | 三域闭环在 steps 中存在；画布未表达域与回路 | [论文 §4.1](https://www.biorxiv.org/content/10.64898/2026.08.16.745117v1.full) |
| ScientistTwo | 核心条件分支有 controller 对应；49 节点星形图不足以展示 | [论文 §3.1–3.6](https://arxiv.org/html/2609.19644v1) |
| AI Scientist v2 | 主干对应；四实验阶段隐藏在 manager/tree-store | [论文 §3.2–3.4、Fig. 1–2](https://arxiv.org/html/2504.08066v1)：并行树搜索、阶段 checkpoint、replication/aggregation、VLM、单次写作后独立 reflection |
| InternAgent 1.5 | 部分对应；知识流批次限制及子系统归属需标清 | 见 §3.3 |
| Biomni-R0 | 原训练方法待核验 | 见 §3.4 |
| 化学 Coscientist | 原架构保真存在明确偏离 | 见 §3.1 |
| Raven Host | 仅受限骨架，不通过完整原方法校验 | 见 §3.2 |
| Kosmos（SDK 独有） | 主要周期对应；两个轨迹/两轮是缩小配置 | [论文 §2.1 / Fig. 1](https://arxiv.org/html/2511.02824v1)：规划→并行分析/文献→world update→再规划/报告。不要凭“动态”一词误要求每轮必须完全异步，原文也按 cycle 更新 |
| AlphaEvolve（SDK 独有） | 主要异步闭环有对应；外层图隐藏程序库/评测器 | [论文 §2.2–2.6 / Fig. 2](https://arxiv.org/html/2506.13131v1)：parent/inspirations→生成→评测→数据库反馈。两个 worker 内可继续生成、消费已完成反馈，不应误改为每代全局屏障 |

AI Scientist v2 的 `manager ↔ experiments → writer → reflector → reviewer` 与论文主干相符。不能仅因 reviewer 没有直接返回 writer 的边就断言漏掉原论文修订环：该论文把独立 reflection 放在最终 reviewing 之前，具体改稿和图文检查还需查看 reflector/paper-store，而不是套用 AI Scientist v1 或一般投稿流程。

## 7. 画布截图一致性

核对 `docs/readme/workflows/manifest.json`：

- 21/21 张截图文件的 SHA-256 与 manifest 一致。
- 20/21 份源 Workflow 的 SHA-256 与 manifest 一致。
- ARIS 不一致：相对于截图记录的 `frontendCommit=16ad652...`，14 个作者侧角色的 Harness 已由 `claude-code` 改为 `pi`。`orchestration` 未改变。

**判定：ARIS 截图/manifest 不是当前完整配置快照，但不是拓扑接错的证据。** 若文档需要展示当前 Harness，应重截图并更新来源哈希。

本次没有做截图逐像素视觉识别、节点遮挡/折线交叉或浏览器交互验收；关于“未漏边”的结论来自真实导出脚本、导入解析器、画布语义构造及相关测试，不扩张成全部视觉布局无问题。

## 8. 已执行验证与未覆盖部分

### 已执行并通过

1. 使用当前 SDK `src/main-config.ts` 加载两边配置：**44/44 通过**。
2. 对主项目逐个运行 `example/export-web-workflow.mjs`，再调用当前 `server/src/workflow-import.ts` 和画布语义构造：**21/21 通过**。检查路由、Input、Termination、ScopedWorkflow 原样保留，以及外层/组内边、并行入口和 Loop 退出存在。
3. 两仓库共同 21 个示例的主要拓扑字段一致。
4. 当前源码的 Raven 三个调度边界探针通过，确认的正是其能力与限制。
5. Web 最小相关测试：
   ```sh
   cd openfars/web
   npm test -- src/components/workflow-canvas/core/canvas-layout.test.ts src/components/workflow-canvas/core/scoped-canvas-layout.test.ts
   ```
   **2 个文件、17 项通过**。
6. SDK 示例加载/Skill 暂存测试：
   ```sh
   cd openfars-SDK
   npm run test -w sdk -- tests/research-examples.test.ts
   ```
   **1 个文件、14 项通过**。项目规定的 pretest 核心同步检查、资源准备和 branding 检查也通过。

### 未执行/不能据此推出

- 没有调用研究模型、GPU 训练、实验设备、远程科研作业或创建 GitHub 资源。
- 没有全量测试、完整方法端到端执行或论文结果复现。
- 没有逐一复证所有内嵌 MCP 算法、统计公式和外部后端实现；本次重点是工作流结构及直接相关协议。
- 没有将历史实测结果当成本次当前版本的运行证据。

## 9. 建议处理顺序

1. **先明确图的类型**：原方法流程图、ScienceEvolve 执行路由图、工具/数据依赖图不能混标。
2. **优先澄清或修正结构偏离**：化学 Coscientist 的实验反馈路径；InternAgent 的子系统归属；Raven 保持受限标签，完整实现需另行确认范围。
3. **补方法层展示而不是盲改路由**：11 个中心调度图补关键阶段/条件/状态/外部边界；保留正确的 Main、ticket/controller 交接。
4. **明确来源版本和适配范围**：同步/串行、论文与源码的差异、原生角色与拆分执行步骤、单 lab 与多 lab、缩小预算分别标识。
5. **Biomni-R0 先补原始训练资料，再定图；ARIS 更新截图快照。**

上述内容是校验与修改建议，不是已经完成的 Workflow 修复。
