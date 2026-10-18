# DrugEvolve：完整公开单机算法进化流程

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本例将 [GAIR-NLP/DrugEvolve](https://github.com/GAIR-NLP/DrugEvolve/tree/e26347c4a3dfbd639702b68b2f19d1420d78199b) 的公开 compatibility Creation 流程拆成 SCIENCEEVOLVE 的 Main、Generator、Inspector、Implementer、Trainer、Debugger、Judger、Analyzer 和 Summarizer。Task 是被优化的药物研发算法及固定评测环境，不需要 Evolver 或 workflow 自修改。

原采样器、上下文/提示/schema、训练器、熵监控、客观评分、实验存储与 cognition 随 Skill 下载并固定版本。`scripts/steps.py` 执行确定性操作、输出原角色请求并核验响应；它不运行上游完整自治管线，也不调用模型。完整能力与替换见 [核对表](skills/scienceevolve-drugevolve/references/mapping.md) 和 [CAPABILITIES.json](CAPABILITIES.json)。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

## 状态与验证

`sample → generator → inspector → implementer → train → judger → analyzer → summarizer → archive`；各阶段由Main根据持久phase分发。重复提案返回generator，实现失败返回Researcher外层，训练失败到debugger，熵异常走零客观分分支。Judger在LLM权重0时仍执行。外部知识和实验经验分别保存在 cognition 和实验节点中。

用同一run-dir的 `steps.py status` 观察/继续。已提交响应由request_id防重复；正在执行或中断的training/sampling/archiving不能盲目重跑，先检查真实进程、日志及原库写入状态。模板不要求SDK新增Agent回退、workspace Git或并行讨论功能。

```sh
/absolute/path/to/drug-env/bin/python -m unittest discover -s example/drugevolve/tests -v
```

测试使用明确标注的合成Task执行真实本机Bash训练，覆盖失败→修复→再训练、实际熵超阈值进程终止/零客观分分支、原始CSV评分、全部角色原提示/schema、原库入库/best、重新采样和重复反馈、嵌套重试以及过期提交拒绝。没有调用真实科研模型，也没有完成论文11任务/120测试集的端到端科学结果复现。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![DrugEvolve 的实际 Workflow 画布](../../docs/readme/workflows/drugevolve.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
