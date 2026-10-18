# Google RRSI

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

[论文](https://arxiv.org/abs/2609.24972) / [官方代码](https://github.com/google-research/rrsi)。此例用10个 SCIENCEEVOLVE 角色执行完整 RRSI harness 进化算法，Task 与评测工具允许等能力替换；研究编排固定，没有 Evolver。

SDK 命令行运行请切换到 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。当前 main 从网页载入示例并管理工作区。

需要真实科研 Task 的 harness、数据、冻结 policy 和评测器。将具体项目与资源位置写入 requirement.txt；task_setup 会按 [Task工具合同](skills/scienceevolve-rrsi/references/environment.md) 准备并验证实际执行能力。缺少资源时阻塞，不能用模拟数据继续。网页启动为每个 Agent 显式选择全局网关，不隐式读取 SDK profile；研究角色默认 gpt-6-sol，脚本沿用宿主统一启动环境，Task policy 单独配置并冻结。

流程包含：基线/噪声校准 → 三镜头 analyst/digester → 退火预算/停滞探索/结构剪枝 → m个独立候选 → 泄漏审查与最多5次修复 → 真实smoke/全量测量 → 官方Algorithm 2选择 → Git保留与逐编辑归因 → 全部T轮 → 冻结后的H0/冠军双臂heldout评测 → 证据审计。

每次模型调用都由 workflow 对应角色处理，复用官方 JSON动作/工具反馈/原始提示词，未把完整自治框架当工具启动。Git worktree只隔离被优化的Task代码；它不意味着SDK已经支持Agent会话回退。角色缓存、输入哈希、修复起始快照和选择transaction支持中断后继续。独立digester串行执行但保留各自上下文与批次汇合，所有候选测完后统一选择。

默认 eng profile 保留40轮、每任务4次、每轮2候选及官方正则化参数；coding/workspace的原profile也随附。新Task的参数/噪声校准须明确记录，不能把原论文61×4对应的权重当成普适常数。完整参数和失败分支见 [协议](skills/scienceevolve-rrsi/references/protocol.md)。

这里“完整”指RRSI算法及必要能力覆盖，**不是作者三域八基准实验资产的完整复刻，也不是论文数值复现**。官方公开评测存在未补齐的包装、缺失资产和口径矛盾，具体见 [源码/论文核对](/../feat/sdk-only-v0.1.1/docs/sdk/rrsi-fidelity-audit.md)。不能将随附的原始 benchmark adapter 自动视为这些原实验已接通。

推荐使用随例附带的 [scienceevolve-rrsi Skill](skills/scienceevolve-rrsi/SKILL.md)，workflow会自动暂存它及完整上游资源。所有来源与SHA256在 [UPSTREAM.json](skills/scienceevolve-rrsi/UPSTREAM.json)，许可证保留原样。

网页使用“暂停项目”与“启动并恢复”，先核对已有轨迹和外部进程，不重复提交仍在运行的实验。SDK 的进程信号与 `run resume / run cancel` 命令仅适用于 SDK 分支。保留完整 dataDir 和 workspace 中的 `.rrsi/`、`rrsi-task/`、`rrsi-runs/`。方法自身需要跑完当前轮再停时，可创建 `rrsi-runs/research/STOP`；移除后继续方法流程。最终交付 `.rrsi/report.json`、所有原始测量、history/attribution/decisions以及H0/冠军Git版本。

离线验证：

```bash
python -m unittest discover -s example/tests -p test_rrsi.py -v

```

这些验证覆盖算法边界、真实Git/子进程工具合同和持久恢复；模型响应与评测值使用明确的测试fixture，不能作为真实科研成功证据。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![RRSI 的实际 Workflow 画布](../../docs/readme/workflows/rrsi.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
