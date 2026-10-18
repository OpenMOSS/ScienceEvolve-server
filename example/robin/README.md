# Robin workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

assay 的五阶段选择 → 候选五阶段生成/调查/两两比较排名 → 真实实验交接 → 5 条并行 R 分析 → 共识 → 解释/后续建议 → 下一轮候选。

参考版本：[上游 4a5cce310f3b](https://github.com/Future-House/robin/tree/4a5cce310f3bc7663a67117db88af43b84733ffe)。完整能力对应关系见 [CAPABILITIES.json](CAPABILITIES.json)，Agent 必须执行的协议见 [Skill](skills/scienceevolve-robin/SKILL.md)。阶段依赖的原始 prompt、算法与工具是执行规范，不能只读角色名称后自行简化流程。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

## 必需环境与等价替换

本例使用 main 的项目共享工作区，关闭 Agent Git 协作；通过网页上传 Task 输入。按[统一使用说明](../README.md)为各角色选择网关、已安装 Harness、可用模型和思考选项，不会隐式导入 SDK profile 或 bindings。保留方法对模型家族、角色和实验协议的要求；任务工具所需的数据、代码与算力须实际准备。

旧 reasoningEffort 已从 workflow 移除；原配置的 high 表达思考深度意图，不代表任意模型都有同名选项。启动前须按具体网关的 modelReasoning 能力配置选择真实 gatewayReasoningOption，或在适用的可信原生 profile 中配置并验证；不预填臆造 optionId，不统一覆盖原模型或家族。配置校验不代表思考深度、模型、工具或科研环境已验收。

Python>=3.12 及上游依赖；Edison CROW/FALCON/data-analysis API 能力、真实疾病目标、实验执行方和真实 flow_cytometry/RNA_seq 数据。明确研究轮数/停止条件。

SCIENCEEVOLVE 编排各阶段，原检索/排名工具与远程分析执行器提供实际能力。湿实验如上游一样由外部人员执行，request_user/respond 等待回传；不会生成假数据。修正反馈轮排名读取旧报告目录的上游 bug。

模型/Harness 可按实际网关调整；ARIS 须保持作者与 reviewer 不同已知家族。缺必需能力时停在对应阶段并报告阻断，不能减少候选、跳过实验、改评分/停止规则后宣称完整执行。原上游明确可配置或可选的分支按用户配置执行；记录实际参数，不能把未运行分支写成已完成。

Task 是被研究或优化的对象及其反馈环境；research workflow 负责研究决策。本例为单层闭环，关闭流程自修改，不添加 Evolver，也不把 Task 内部 Agent 当作额外研究角色。

## 核对与验证边界

[核对记录](/../feat/sdk-only-v0.1.1/docs/sdk/science-rsi-feasibility.md)逐项说明保留能力、执行提供者与验证方式。离线验证包含配置、上游文件哈希和关键算法/交接协议；未调用真实科研模型、GPU 实验、付费远程服务或湿实验。因此本例交付的是完整流程配置与执行协议，**尚无真实端到端科研运行验收记录**，不能据此声称论文结果已复现。运行后须保存全部实际证据，再验收这一次研究任务。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![Robin 的实际 Workflow 画布](../../docs/readme/workflows/robin.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
