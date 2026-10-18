# AI Scientist v2 workflow 设计

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

2026-10-15 从 [research 入口](/../feat/sdk-only-v0.1.1/research/todo-seven/ai-scientist-v2/workflow.json)迁入并统一项目名称的 [workflow.json](workflow.json) 和 [requirement.txt](requirement.txt)。workflow 来自此前已有 draft，没有修改其中的配置或内嵌工具。

使用默认 main 引擎、Git-on v3，MCP 工具代码内嵌。原配置的服务路径、仓库名及需求仍属于原实验环境，实际运行前需核对真实 Task、资源和部署绑定，不能将旧运行状态当新输入。

方法尚未完整验收：后续研究/消融与论文链、科学协议及最终交付仍有缺口。固定来源见 [SOURCES.json](/../feat/sdk-only-v0.1.1/research/todo-seven/SOURCES.json)，方法映射、历史证据与归因见[复现度报告](/../feat/sdk-only-v0.1.1/research/todo-seven/WORKFLOW-REPRODUCTION-REPORT.md)。本次只复制文件，原研究文件保留。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

Status: draft. 科研流程设计；后半程、科学协议和最终交付待完善。

## 前端画布

通过通用 JSON 导入入口打开的只读配置预览。

![AI Scientist v2 的实际 Workflow 画布](../../docs/readme/workflows/ai-scientist-v2.jpg)

[查看全部 21 张画布](../../docs/readme/workflows/README.md) · [原始 Workflow JSON](workflow.json)
