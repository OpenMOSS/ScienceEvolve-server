# ARIS workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

主线 W1 → W1.5 → W2 → 叙事交接 → 可选完整 W3；真实跨家族评审、pilot、实验回收、合同与终稿审计。

参考版本：[上游 341f914024d2](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/tree/341f914024d270dc5c8fa51337d1ad38829273aa)。完整能力对应关系见 [CAPABILITIES.json](CAPABILITIES.json)，Agent 必须执行的协议见 [Skill](skills/scienceevolve-aris/SKILL.md)。阶段依赖的原始 prompt、算法与工具是执行规范，不能只读角色名称后自行简化流程。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

## 必需环境与等价替换

本例使用 main 的项目共享工作区，关闭 Agent Git 协作；通过网页上传 Task 输入。按[统一使用说明](../README.md)为各角色选择网关、已安装 Harness、可用模型和思考选项，不会隐式导入 SDK profile 或 bindings。保留方法对模型家族、角色和实验协议的要求；任务工具所需的数据、代码与算力须实际准备。

ARIS 需要作者和 reviewer 使用已知不同模型家族。网页中逐一设置各 Agent 的 Harness、全局网关、model 与网关思考强度：作者网关需支持相应作者模型，reviewer 与 paper_reviewer 使用适合独立评审的网关和 Harness。不要将默认模型统一覆盖到所有角色。

模板中的 high / xhigh 表达原有思考深度意图，不能保证任意网关或模型都有同名有效选项。启动前按实际模型支持的候选选择并测试；配置通过不代表实验、工具或深审能力已验收。SDK 的 bindings 和原生 profile 配置只适用于其分支部署。

Anthropic 作者与 OpenAI reviewer 的真实可用模型及对应 Harness/profile；文献工具、Task 代码/数据/算力；启用 W3 时提供 venue、LaTeX、绘图/视觉检查工具。默认 claude-opus-5 / gpt-6-astra，可换为已知不同家族模型。深审保留 ultra 与上游允许的能力错误 fallback；完整性审计另需固定 Anti-Autoresearch pin（已随 Skill 下载）、可用只读 Codex CLI 及该 pin 指定的 gpt-5.6-sol/xhigh。详见 Skill 的深审协议。

上游全部主线 Skills、shared references、tools、templates 均随 Skill 固定版本分发。跨模型调用映射为 SCIENCEEVOLVE reviewer 交接；无宿主 spawn 时使用原 Tier 3 lens 分支，实验并发仍真实执行。

模型/Harness 可按实际网关调整；ARIS 须保持作者与 reviewer 不同已知家族。缺必需能力时停在对应阶段并报告阻断，不能减少候选、跳过实验、改评分/停止规则后宣称完整执行。原上游明确可配置或可选的分支按用户配置执行；记录实际参数，不能把未运行分支写成已完成。

Task 是被研究或优化的对象及其反馈环境；research workflow 负责研究决策。本例为单层闭环，关闭流程自修改，不添加 Evolver，也不把 Task 内部 Agent 当作额外研究角色。

## 核对与验证边界

[核对记录](/../feat/sdk-only-v0.1.1/docs/sdk/science-rsi-feasibility.md)逐项说明保留能力、执行提供者与验证方式。离线验证包含配置、上游文件哈希和关键算法/交接协议；未调用真实科研模型、GPU 实验、付费远程服务或湿实验。因此本例交付的是完整流程配置与执行协议，**尚无真实端到端科研运行验收记录**，不能据此声称论文结果已复现。运行后须保存全部实际证据，再验收这一次研究任务。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![ARIS 的实际 Workflow 画布](../../docs/readme/workflows/aris.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
