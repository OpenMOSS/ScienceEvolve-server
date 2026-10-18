# Raven Host workflow 设计

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

2026-10-15 从 [research 入口](/../feat/sdk-only-v0.1.1/research/todo-seven/raven/workflow.json)迁入并统一项目名称的 [workflow.json](workflow.json) 和 [requirement.txt](requirement.txt)。使用默认 main 引擎、Git-on v3，方法 Skill 与逐角色 MCP 工具代码内嵌。

这是受限双 specialist 槽位和批次边界判定骨架。默认 strict-host 在 preflight 阻断；limited-batch 也不计为完整 Host 复现。任意 AND 依赖、即时就绪调度、在线通知/裁决、在途取消与重规划及动态 instance 等 SDK 能力尚待补齐。

原子 roster/领域工具/记忆服务同样待接通，接口见[原子工具合同](/../feat/sdk-only-v0.1.1/research/todo-seven/design-20261014/BACKEND-CONTRACT.md)，部署变量前缀为 `SCIENCEEVOLVE_RAVEN`。固定来源见 [SOURCES.json](/../feat/sdk-only-v0.1.1/research/todo-seven/SOURCES.json)，方法映射和验收缺口见[复现度报告](/../feat/sdk-only-v0.1.1/research/todo-seven/WORKFLOW-REPRODUCTION-REPORT.md)。本次只复制文件，原研究文件保留。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

Status: draft. 双 specialist 槽位与批次判定骨架；默认 preflight 阻断。

## 前端画布

通过通用 JSON 导入入口打开的只读配置预览。

![Raven Host 的实际 Workflow 画布](../../docs/readme/workflows/raven.jpg)

[查看全部 21 张画布](../../docs/readme/workflows/README.md) · [原始 Workflow JSON](workflow.json)
