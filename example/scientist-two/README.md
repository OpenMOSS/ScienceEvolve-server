# ScientistTwo

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

[论文 v1](https://arxiv.org/html/2609.19644v1) 的科研流程实现：limitations/种子 → 子集基线与候选筛选 → 全量验证/工程改进 → 历史驱动想法进化 → 最佳选择 → 完整消融 → PaperOrchestra 写作 → ScholarPeer 审稿/全部补实验 → meta review、严格改进与旧最佳保留 → CoE 核验和导出。

首轮候选数按用户要求为 **3**。种子池默认 **6**；最多 **4轮（含首轮）**，后续每轮 **1个进化候选 + 1个未评种子**，累计 **4个 full Good** 提前停止。零成功会明确退出，不生成论文。

配置及未公开参数的取值来源见 [执行协议](skills/scienceevolve-scientist-two/references/protocol.md)。允许模型/工具能力替换，所有必需阶段与失败分支均保留。论文未公开的 prompt、依赖 commit 和轮数口径不能声称已恢复成作者原实验配置；本例固定公开参考版本并显式标注解释。它也不保证论文数值结果或实际会议接受。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。

## 方法映射和验证

[CAPABILITIES.json](CAPABILITIES.json) 列出全部角色、参数及替换；[逐项核对](https://github.com/OpenMOSS/ScienceEvolve/blob/main/docs/sdk/scientist-two-fidelity-audit.md) 给出论文来源和对应关系。48 个执行角色加 Main，其中包含独立的写作、审稿、完整性检查角色。Main 只读持久状态机调度，不代替科学判断；无 workflow Evolver。

随附 PaperOrchestra 官方固定版本的完整角色源码/prompt/原子工具与 ICLR2025 模板、ScholarPeer v2 Appendix G 全部 prompt，见 [来源/哈希清单](skills/scienceevolve-scientist-two/UPSTREAM.json)。上游自治入口只作审计参考，不作为黑盒执行。

```bash
python -m unittest discover -s example/tests -p 'test_scientist_two.py' -v
```

测试覆盖控制分支、预算、全部计划/问答执行、稿件/最佳版本保留、证据变更拒绝、幂等恢复，以及 SDK 实际加载与 Skill 搬运。它们是离线协议测试，**尚未执行真实模型、GPU实验或完整科学结果复现**。终止状态区分 `no_successful_idea`、`meta_accept`、`retained_previous_best`、`meta_budget_exhausted`，不会把完成调度都记成接受。

## Workflow 画布

真实前端组件的独立文档展示，不是完整应用窗口。49 个角色是注册表，不是线性阶段；protocol.py 中的 Good / Bad / Engineer、subset/full、review/rebuttal 与旧最佳保留分支另作方法说明。

**[查看 9 张可读阶段图与完整总览](../../docs/readme/workflows/scientist-two.md)** · [方法映射](../METHODS.md#scientist-two)。标题固定 16 CSS px，长名称换行；不把全图压缩后当唯一展示。静态配置，未运行科研任务。

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
