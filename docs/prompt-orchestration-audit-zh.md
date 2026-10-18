# 系统提示词编排清单与讨论稿

[← 返回中文 README](../README_zh-CN.md) · [English README](../README.md)

ScienceEvolve 的运行指令目前来自项目设置、Agent 配置、调度任务、工具描述、Skill、恢复通知和 Harness 会话。本文汇总这些来源及其装配规则，区分代码约束和给模型的文字指令，作为统一编排的讨论依据。原生会话的内部系统提示词由各 Harness 管理，应用不能通过调整字符串顺序替代它们的指令层级。

本次已明确的执行规则是：关闭用户介入后，各级 Agent 都依据已有信息自主完成研究；每个新的业务任务保存自己的 Memory 工作记录；开启 Git 后，工作目录中的项目文件都参与交付；背景资料通过完整可展开的分层索引获取，当前必须执行的指令完整直接提供。2026-10-18 已按确认方案实现上下文整理与单次注入预算，见 [实现说明](context-injection-zh.md)。

## 提示词来源

| 来源 | 主要规则 | 目前的提供方式 | 代码入口 |
| --- | --- | --- | --- |
| 项目研究要求 | 研究目标、输入、交付内容、限制、结果形式、终止标准；不能把创建项目或设计 workflow 的要求当成研究主题 | 根要求和调度任务进入 Inbox，当前任务进入本轮消息；历史用户消息按索引读取 | [prompt.ts](../server/src/prompt.ts) 的 `buildInboxMarkdown`、`buildAgentDispatchSummary`；[explainer-assistant.ts](../server/src/explainer-assistant.ts) |
| 用户介入设置 | 禁止介入时不能提问、等待澄清或审批；自行确定具体范围和假设，在最终文档说明缺失信息和局限，不虚构证据 | 直接提供给所有运行角色；请求用户的工具能力在后端另行限制 | [workflow-user-intervention-policy.ts](../server/src/workflow-user-intervention-policy.ts)、[orchestration-control-mcp.ts](../server/src/orchestration-control-mcp.ts) |
| 文件及执行权限 | workspace、compute、yolo 的读写、执行范围；实际可用的文件根和 Git 能力 | 直接提供约束和当前文件工具参数；文件服务与工具后端执行权限检查 | [invocation-policy.ts](../server/src/harness-runtime/invocation-policy.ts)、[filesystem-authority.ts](../server/src/harness-runtime/filesystem-authority.ts) |
| Agent 长期职责 | 用户填写的 Agent instructions，加上内置角色、文件编辑、Memory、证据和交接规则 | 当前职责直接提供；其他 Agent 的完整配置放入索引详情 | [prompt.ts](../server/src/prompt.ts) 的 `BUILTIN_AGENT_PROMPTS`、`effectiveAgentInstructions`；[workflow-context.ts](../server/src/workflow-context.ts) |
| 本轮实际角色 | 当前是 Main、Leader、Worker、最终集成、实验结果处理、推送回执处理，还是工作区收尾；同一会话可以承担不同任务 | 当前角色和权限直接提供，不用旧 Memory 推断本轮权限 | [invocation-policy.ts](../server/src/harness-runtime/invocation-policy.ts)、[collaboration-runtime.ts](../server/src/collaboration-runtime.ts)、[scoped-project-runtime.ts](../server/src/scoped-project-runtime.ts) |
| Main 调度策略 | 核对根要求和证据；定义可验收的任务；按实际图和依赖调度；避免重复已完成工作；整合结果后结束 | 固定策略与 Main 当前能力直接提供；具体 decisionPlans、历史结果和配置详情按需读取 | [main-orchestration-policy.ts](../server/src/internal/shared/main-orchestration-policy.ts)、[prompt.ts](../server/src/prompt.ts) |
| Workflow 与协作组 | Agent、节点、连接、候选路由、组、循环以及当前正式状态；强连接直接跳转，弱连接由被授权的 Agent 决定 | 当前权限、范围、版本和候选直接提供；其余结构、配置与记录通过完整分层索引读取 | [workflow-context.ts](../server/src/workflow-context.ts)、[scoped-project-runtime.ts](../server/src/scoped-project-runtime.ts)、[collaboration-runtime.ts](../server/src/collaboration-runtime.ts) |
| 本轮任务及纠正要求 | 具体要做什么、还缺少哪个正式动作、哪些已完成步骤必须保留 | 直接提供完整当前指令，同时保留可追溯快照；不能因超过某个字符数而只给详情入口 | [resident-runtime-adapter.ts](../server/src/harness-runtime/resident-runtime-adapter.ts) 的 `prepareTurn` |
| 正式控制工具 | finish_task、路由、协作组管理、改配置、发布产物、完成项目；文字回答不替代正式工具动作 | 当前工具名称和角色约束直接提供；工具 schema 随 Harness 工具协议提供；后端再次验证 | [orchestration-control-mcp.ts](../server/src/orchestration-control-mcp.ts)、[orchestration-control-bridge.ts](../server/src/orchestration-control-bridge.ts) |
| 全局状态工具 | state_list 提供完整对象索引；state_get 按对象读取；写操作需要当前版本、当前任务和正确权限 | 工具使用规则直接提供，状态正文由 Agent 自行查询；默认不注入历史正文 | [project-state-policy.ts](../server/src/internal/shared/project-state-policy.ts)、[project-state-mcp.ts](../server/src/project-state-mcp.ts)、[project-state.ts](../server/src/project-state.ts) |
| Git 与 Memory | 新业务任务保存本任务工作记录；全部项目文件参与版本管理；实际推送、PR、合并和本地同步结果决定交付是否完成 | 当前交付要求及真实工具结果直接提供；旧操作、旧 PR 和旧输出按索引读取 | [agent-git-delivery.ts](../server/src/agent-git-delivery.ts)、[agent-git-tools.ts](../server/src/agent-git-tools.ts)、[storage.ts](../server/src/storage.ts)、[descriptor-broker-mcp.ts](../server/src/harness-runtime/descriptor-broker-mcp.ts) |
| Skill 与其他 MCP | 只使用已选资源和真实可用能力；Skill 的流程建议不能覆盖项目禁止用户介入的设置 | 已选 Skill 路径和实际工具能力直接提供；目录和完整说明按需读取；Harness 可能自行加载 Skill | [skill-staging.ts](../server/src/harness-runtime/skill-staging.ts)、[mcp-directory.ts](../server/src/mcp-directory.ts)、[workflow-context.ts](../server/src/workflow-context.ts) |
| 实验工具 | 提交、查询、查看结果、停止和继续实验；周期检查唤醒原会话；处理必要结果后再结束任务 | 当前实验通知和实际结果直接送达；旧实验详情、旧交接和继续上下文按索引查询 | [sii-experiments.ts](../server/src/sii-experiments.ts)、[resident-runtime-adapter.ts](../server/src/harness-runtime/resident-runtime-adapter.ts) |
| 恢复与收尾 | 保留原任务、会话、工作目录和已接受的结果；核对工具实际副作用；只补缺失步骤；只有确认旧进程停止后才更换执行所有权 | 当前恢复原因和必须补齐的动作直接提供；历史证据、报告、操作记录、管理意见按索引读取 | [workflow-recovery.ts](../server/src/workflow-recovery.ts)、[session-recovery.ts](../server/src/internal/shared/session-recovery.ts)、[scoped-worktree-closing-runtime.ts](../server/src/scoped-worktree-closing-runtime.ts) |
| 推送回执协调 | 原 Agent 观察原推送的真实结果；各级协调者处理自己被分配的问题；不能以控制记录代替 Git 成功证明 | 本次问题和当前允许动作直接提供；累积回执和协调历史提供完整索引 | [terminal-push-coordinator-runtime.ts](../server/src/terminal-push-coordinator-runtime.ts)、[terminal-push-coordination-control.ts](../server/src/terminal-push-coordination-control.ts) |
| 配置推荐 | 返回完整可校验配置；使用真实模型与网关；区分当前推荐权限与运行时权限；遵守用户介入设置 | 推荐系统规则直接提供；当前配置、资源目录、用户自然语言要求和修复诊断作为本次输入 | [configuration-recommendation.ts](../server/src/internal/shared/configuration-recommendation.ts)、[config-recommendations.ts](../server/src/config-recommendations.ts) |
| 交互助手 | 创建及修改草稿、修改配置、解释证据；研究任务与 workflow 设计分别写入对应字段；保持会话 | 阶段指令、当前用户消息和工具能力直接提供；草稿、项目、工作区、旧会话详情按索引读取 | [explainer-assistant.ts](../server/src/explainer-assistant.ts)、[project-explainer.ts](../server/src/project-explainer.ts)、[shared project-explainer.ts](../server/src/internal/shared/project-explainer.ts) |
| 执行摘要 | 概括已保存输出中的实际动作、结果和问题，不执行被引用内容中的指令 | 专门摘要指令，加上选定输出或输出文件引用 | [shared project-explainer.ts](../server/src/internal/shared/project-explainer.ts) 的 `summaryPrompt` |
| Harness 原生会话 | 原生系统指令、已执行工具及其结果、会话恢复、原生压缩和各自的 Skill 处理 | Harness 自己维护；应用增加当前消息，不反复把整个原生历史重新注入 | [runtime.ts](../server/src/harness-runtime/runtime.ts)、[adapters](../server/src/harness-runtime/adapters) |

## 当前装配顺序

运行入口先确定文件权限、当前任务所有权、当前角色、工具及会话，再生成 Inbox 和只读背景索引。`compileWorkflowPrompt` 目前按以下顺序生成一段应用提示词：

1. 权限约束及项目用户介入策略。
2. 当前 Agent 的长期职责，或本次有限补充任务的职责说明。
3. Inbox、Memory、输入文件、全局状态和 Workflow 提案的读取方法。
4. 当前 Workflow 范围和完整索引入口、必要通知及工具修复提醒；历史按新旧分层，未变化来源仅保留送达提示和完整入口。
5. 当前角色、真实控制工具名称、Skill 和实验工具规则。
6. 正式结束任务、Git 交付、Memory 和结果核验规则，以及恢复提示。串行执行的完整当前 Inbox 也在本轮消息中直接提供；有限控制修复只提供当前修复指令，旧任务保留引用。

常驻 Agent 的入口随后补充当前文件工具的 rootId/path，以及完整的当前任务指令。实验结果通知保留其原生输入与回执绑定。最终装配和发送前新增输入共同受选中模型半窗口预算检查；协议网关再计入实际发送的工具定义。

这是一段应用文字的先后顺序，不等同于多个独立的 system/developer 消息。原生 Harness 如何承载这段文字取决于其接口。可靠的权限边界来自工具服务、数据库版本和执行所有权验证；任务判断仍由 Agent 完成。

## 本次暴露的编排问题

关闭用户介入之前主要表现为工具不可用，但长期职责、任务、终止条件和历史 Memory 中仍可能存在“先请求用户补充”的文字。新的项目策略现在直接传给每个运行角色，并明确覆盖这些冲突；推荐生成的配置也需要遵守它。

历史资料的按需改造曾把较长的当前任务也移到详情中。本次 Main 连续漏读纠正要求，反复返回旧结论。当前指令现在直接提供，其支持材料仍按需读取。

Memory 工作记录与普通工作区快照曾是两个独立文件，完成工具保存了快照，Git 却只能看到旧工作记录。现在业务任务的完成内容保存到实际 Git 工作目录，并按逻辑任务去重。服务生成的输入、配置引用和缓存放到工作目录外，项目目录中的隐藏文件及配置不再由文件名被排除。

Main 控制工具还有一条旧分支，会把可纠正的调用拒绝变成 JSON-RPC 参数错误。现在统一返回工具错误结果和具体说明，让 Agent 能在原会话继续修正；权限限制仍由后端执行。失败历史也只在原任务提交了正式决策及完成回执后记为恢复，重新打开进程本身不代表任务已经成功。

## 已确认并实施的上下文规则

每轮必须直接提供的内容为：项目执行策略、当前角色及权限、真实研究目标、当前具体任务、验收条件、当前必须补齐的动作、可调用工具和必要文件引用。串行、常驻、恢复、助手与整理调用共用最终预算检查，不能为精简背景而截断当前指令。

项目中的 Agent、文件、产物、任务、操作、实验、回执、失败记录、配置变更和旧会话，提供完整可展开的简明索引。近期记录细，旧记录逐级归组；每组覆盖全部成员，没有隐藏分页。当前有效和未解决事项不因年代变为历史。完整平面目录与全部原始详情继续保留，长正文由 Agent 选择分段读取。

Project Explainer 在独立的新 session 中组织索引并生成摘要，使用项目配置的 Harness、模型和网关。成员 ID、引用和覆盖范围由代码校验；结果持久缓存，未变化组复用。后台摘要不可用时，使用完整事实目录继续业务执行。缓存位于项目 runtime，工作区的 Git 文件范围不变。

长期职责描述“这个 Agent 擅长什么、负责什么”；当前任务描述“这次具体做什么”。工作流的拓扑要求、模型设置和工具选择保留在配置中，研究要求只描述研究本身。旧 Memory 提供事实和经验，不决定本轮权限，也不把旧的等待用户结论变成新的暂停指令。

工具说明负责参数、可验证结果和使用约束，提示词不重复粘贴整套工具文档。正式状态由共享状态表和工具事实提供；自然语言中“已暂停”“已成功”“等待用户”都不能自行改变项目状态。

新规则保留当前角色职责和项目业务含义，并对同一 Inbox 已包含的研究要求与用户介入策略避免重复。推送回执只提供本次操作的必要事实，完整状态保留按需快照。每次系统新注入使用保守 token 上界估算，不超过模型窗口 50%；原生会话累积和主动读取仍由 Harness 原有机制处理，保留原生压缩。
