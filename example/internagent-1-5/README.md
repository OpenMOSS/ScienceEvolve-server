# InternAgent 1.5 workflow 设计

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本例提供 [workflow.json](workflow.json) 和 [requirement.txt](requirement.txt)。使用默认 main 引擎、Git-on v3，方法 Skill 与逐角色 MCP 工具代码内嵌。

方法后端尚未完整实现/接通，知识图、向量、记忆、图增强 Monte Carlo 数值选择/回传及真实 Task 评测需按[原子工具合同](https://github.com/OpenMOSS/ScienceEvolve/blob/main/scripts/example-workflows/BACKEND-CONTRACT.md)落实。部署变量前缀为 `SCIENCEEVOLVE_INTERNAGENT`；填写服务 URL 不会自动实现后端。当前固定双槽批次与原即时动态调度仍有差距。

固定来源见 [SOURCES.json](https://github.com/OpenMOSS/ScienceEvolve/blob/main/example/SOURCES.json)，方法映射、资源和验收缺口见[复现度报告](https://github.com/OpenMOSS/ScienceEvolve/blob/main/docs/workflows/method-review-20261014.md)。当前方法边界见[方法映射](../METHODS.md#internagent-1-5)。

## 方法与执行边界

依据 [论文 §2.1–2.4](https://arxiv.org/html/2602.08990v1)：Generation 包含知识流与假设生成；Verification 包含图增强搜索、并行实验和复核；Evolution 更新证据与 SPM/TEM/SKM。

```text
Generation:   flow_planner ↔ knowledge
                  ↓
              generation
                  ↓
Verification: verification ↔ optimization
                  ↓
Evolution:    evolution → generation / flow_planner / audit
```

`verification` 管理 optimization 组，并按当前批次真实状态区分首次派工与返回后的复核；不能重派已完成实验。固定双槽仍是受限适配，不声称实现论文动态依赖调度。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。

Status: draft. 知识、记忆、搜索和评测驱动的研究流程设计。

## 前端画布

真实前端组件的独立文档展示，不是完整应用窗口；静态配置，未运行科研任务。

**[查看知识组、Verification 优化组的组内细节与总览](../../docs/readme/workflows/internagent-1-5.md)**。

[查看 21 个示例的总览与细节](../../docs/readme/workflows/README.md) · [原始 Workflow JSON](workflow.json)
