# AI Scientist v2 workflow 设计

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本例提供 [workflow.json](workflow.json) 和 [requirement.txt](requirement.txt)，是 AI Scientist v2 的缩小任务适配。

使用默认 main 引擎、Git-on v3，MCP 工具代码内嵌。原配置的服务路径、仓库名及需求仍属于原实验环境，实际运行前需核对真实 Task、资源和部署绑定，不能将旧运行状态当新输入。

方法尚未完整验收：后续研究/消融与论文链、科学协议及最终交付仍有缺口。固定来源见 [SOURCES.json](https://github.com/OpenMOSS/ScienceEvolve/blob/main/example/SOURCES.json)，方法映射、历史证据与归因见[复现度报告](https://github.com/OpenMOSS/ScienceEvolve/blob/main/docs/workflows/method-review-20261014.md)。四个实验阶段与 checkpoint/replication 等在 manager/tree tools 内，当前方法边界见[方法映射](../METHODS.md#ai-scientist-v2)。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。

Status: draft. 科研流程设计；后半程、科学协议和最终交付待完善。

## 前端画布

真实前端组件的独立文档展示，不是完整应用窗口；静态配置，未运行科研任务。

**[查看实验组内细节与总览](../../docs/readme/workflows/ai-scientist-v2.md)**。两个 worker 不是两个实验阶段；Reflection 与最终 Reviewer 分开。

[查看 21 个示例的总览与细节](../../docs/readme/workflows/README.md) · [原始 Workflow JSON](workflow.json)
