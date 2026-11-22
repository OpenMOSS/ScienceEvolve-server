# Google AI co-scientist workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

同步方法适配：目标与资源分配 → 四种假设生成 → 六类反思 → 相似图 → 单轮/多轮论辩与 Elo 比赛 → 六种假设进化 → 元评审和研究概览 → 专家/实验反馈。同步 Main 调度和文件持久池不等同论文异步队列；wetlab 是外部验证扩展。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。

## 实现与外部能力

假设内容不可覆盖；pool.py负责文件锁、原子写入、评审门槛、相似图、优先配对、Elo更新、幂等比赛、目标epoch与反馈版本。完整输入字段见[records.md](skills/scienceevolve-co-scientist/references/records.md)。

```bash
python example/co-scientist/skills/scienceevolve-co-scientist/scripts/pool.py --root /absolute/task/co-scientist init --plan /absolute/task/plan.json
python example/co-scientist/skills/scienceevolve-co-scientist/scripts/pool.py --root /absolute/task/co-scientist stats
```

plan.json至少含goal、criteria、constraints、stop_condition。检索、长文献/多模态读取、领域数据库/预测模型和湿实验由Task实际工具提供。wetlab Agent按实际接口提交/监控/读取结果；只生成协议不算完成实验。

来源：[Google官方论文v1 §3.2–3.5](https://arxiv.org/html/2502.18864v1)。此为公开算法的独立实现；不是Google未公开源码的逐行重建。Elo初始1200来自论文；K=32、scale=400、top范围25%、相似配对权重和cluster阈值属于明确披露的本地参数，可配置，不能写成Google的内部值。

## 验证边界

交付完整公开科研流程、实际工具连接与执行协议；已进行本地算法/文件状态/真实本地执行或IO契约测试。尚未完成真实模型、完整领域环境和湿实验的端到端科研验收，不能声称论文科学结果已复现。外部共享服务不列为workflow缺失；实际运行仍必须连接并取得真实结果。

## Workflow 画布

真实前端组件的独立文档展示，不是完整应用窗口。方法导读包含共享假设／比赛状态、Proximity→Ranking、进化候选重评与 Meta-review 反馈；六核心角色和外部 wetlab 分开展示。

**[查看核心角色、外部扩展细节与总览](../../docs/readme/workflows/co-scientist.md)** · [方法映射](../METHODS.md#co-scientist)。静态配置，未运行科研任务。

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
