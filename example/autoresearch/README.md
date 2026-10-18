# autoresearch workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

分支初始化 → 原始基线 → 仅修改 train.py → commit → 300 秒训练 → 真实日志 → keep/discard/crash 与 Git 回退 → 持续运行。

参考版本：[上游 228791fb499a](https://github.com/karpathy/autoresearch/tree/228791fb499afffb54b46200aca536f79142f117)。完整能力对应关系见 [CAPABILITIES.json](CAPABILITIES.json)，Agent 必须执行的协议见 [Skill](skills/scienceevolve-autoresearch/SKILL.md)。阶段依赖的原始 prompt、算法与工具是执行规范，不能只读角色名称后自行简化流程。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

## 必需环境与等价替换

本例使用 main 的项目共享工作区，关闭 Agent Git 协作；通过网页上传 Task 输入。按[统一使用说明](../README.md)为各角色选择网关、已安装 Harness、可用模型和思考选项，不会隐式导入 SDK profile 或 bindings。保留方法对模型家族、角色和实验协议的要求；任务工具所需的数据、代码与算力须实际准备。

旧 reasoningEffort 已从 workflow 移除；原配置的 high 表达思考深度意图，不代表任意模型都有同名选项。启动前须按具体网关的 modelReasoning 能力配置选择真实 gatewayReasoningOption，或在适用的可信原生 profile 中配置并验证；不预填臆造 optionId，不统一覆盖原模型或家族。配置校验不代表思考深度、模型、工具或科研环境已验收。

专用且干净的上游 Task checkout、单 GPU、原 uv 依赖、真实数据 shards/tokenizer。运行 tag 与用户确认；默认持续至用户中止，10 分钟是单次实验超时。

`git.enabled: false` 只关闭 SDK 的 Git collaboration，不删除本方法要求的 Task Git。workspace 仍须是上述专用 checkout；commit、keep/discard/crash 和回到父版本继续按 Skill 执行，不能以关闭 SDK Git 为由跳过。

遵循原复杂度/性能权衡；不以 Agent 状态回退取代 Task Git。未复制没有独立许可证的 program.md，协议为独立撰写，来源固定 commit。

模型/Harness 可按实际网关调整；ARIS 须保持作者与 reviewer 不同已知家族。缺必需能力时停在对应阶段并报告阻断，不能减少候选、跳过实验、改评分/停止规则后宣称完整执行。原上游明确可配置或可选的分支按用户配置执行；记录实际参数，不能把未运行分支写成已完成。

Task 是被研究或优化的对象及其反馈环境；research workflow 负责研究决策。本例为单层闭环，关闭流程自修改，不添加 Evolver，也不把 Task 内部 Agent 当作额外研究角色。

## 核对与验证边界

[核对记录](/../feat/sdk-only-v0.1.1/docs/sdk/science-rsi-feasibility.md)逐项说明保留能力、执行提供者与验证方式。离线验证包含配置、上游文件哈希和关键算法/交接协议；未调用真实科研模型、GPU 实验、付费远程服务或湿实验。因此本例交付的是完整流程配置与执行协议，**尚无真实端到端科研运行验收记录**，不能据此声称论文结果已复现。运行后须保存全部实际证据，再验收这一次研究任务。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![autoresearch 的实际 Workflow 画布](../../docs/readme/workflows/autoresearch.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
