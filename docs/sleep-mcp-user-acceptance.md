# sleep MCP 用户流程验收

[← 返回中文 README](../README_zh-CN.md) · [English README](../README.md)

验收日期：2026-10-09（Asia/Shanghai）。开发分支：`codex/add-agent-sleep-mcp`。

## 实际用户操作

在独立数据目录启动生产 Web 界面、HTTP API、Orchestrator 和 HarnessRuntimeFacade，通过浏览器执行：

1. 在首页“研究任务需求”输入任务，要求 Main、idea、execution、writing、review 每位 Agent 实际调用 sleep MCP 等待 1000 ms，发布真实返回值。
2. 点击“提交并继续”，确认创建项目并进入执行队列。
3. 点击“查看任务”，进入工作台，检查原生工具调用和产物发布轨迹。
4. 等待项目完成，确认进度为 100%。
5. 点击“最终结果”，确认四份正式结果文件可预览，并显示真实 `duration_ms` / `elapsed_ms`。

成功项目：`prj_698d8d9675fa450e830bab7ac0c0054d`。2026-10-09 19:44:13 创建，19:44:34 完成。

## 验证结果

逐一读取每次调用的 `codex-events.jsonl`，只统计 `item.completed` 且 `item.type=mcp_tool_call`、`server=scienceevolve-sleep`、`tool=sleep` 的原生事件；每条事件均无错误。按项目事件中的 invocationId 关联 Agent，结果如下：

| Agent | 实际调用次数 | 请求 duration_ms | 返回 elapsed_ms |
| --- | ---: | ---: | --- |
| main | 5 | 1000 | 均为 1002 |
| idea | 1 | 1000 | 1002 |
| execution | 1 | 1000 | 1002 |
| writing | 1 | 1000 | 1000 |
| review | 1 | 1000 | 1001 |

共 9 次真实 MCP 调用。项目持久化状态为 `completed`，最终展示包含四份 Worker 发布的 Markdown 文件。未在 Agent 配置中手动添加 sleep MCP。

另通过本机已登录的 Codex CLI 连接真实模型，发送自然语言测试要求：模型自主调用了两次 sleep MCP，请求 1000 / 3000 ms，实际返回 1002 / 3001 ms。原生事件确认工具成功执行，最终模型回答与工具返回值一致。连接最初超时，CLI 重试并回退到 HTTP 后成功完成。

## 范围与边界

- 网页验收使用受控的本地模拟模型网关；Web、API、调度器、协议转换、Codex CLI、sleep MCP、文件写入、正式产物发布和结果预览均实际运行。
- 隔离验收组合根为调用注入测试网关快照；这次网页验收不覆盖生产 GatewayStore 的凭据与连接矩阵校验。
- 真实模型验证使用现有 Codex 登录，通过 CLI 独立执行；不等同于生产网关中的完整多 Agent 模型验收。
- 本次网页验收覆盖 Codex 的普通工作流。其他 Harness 和 Linux 常驻工作流的真实模型验收仍未执行。
- 验收过程中修正了模拟网关对终止工具权限的错误假设，随后重新创建项目并成功完成；未修改生产终止策略。

## 本机证据

证据保存于仓库忽略的 `temp/sleep-user-acceptance/`，包括：

- `native-events.jsonl`：真实模型调用的原生工具事件。
- `native-result.txt`：真实模型最终回答。
- `ui-environment.json`：独立数据目录和测试环境说明。
- `ui-sleep-calls.json`：从原生事件提取的 9 次真实 sleep 调用与最终展示清单。
- `ui-provider-evidence.jsonl`：受控网关收到的真实工具返回值；包含首次未完成验收的记录，应按成功项目 invocationId 过滤。
- `user-flow-result.png`：浏览器中的项目完成状态和最终实测结果截图。
- `ui-server.mjs`：本次隔离验收组合根与受控模拟模型脚本，不用于生产服务。

既有 MCP 通信验收仍可通过 `npm run smoke:sleep-mcp -w server` 重复运行。


## 与 Codex 内置 sleep 对齐后的复测

本次会话直接查看并调用了 Codex 提供的 `clock.sleep`：接口使用 `duration_ms`，范围为 1–43,200,000 ms，说明支持新输入提前打断并报告实际等待时间。未找到其内部源码，因此这里对齐的是公开工具接口与可观察行为。

- 内置 MCP 改为相同的时长范围，继续返回请求时长与实际等待时长，保留 MCP 取消和连接断开时的清理机制。
- Codex 普通与常驻 Agent 的 sleep MCP 单独设置 `tool_timeout_sec = 43260`，覆盖最长等待并留出一分钟通信余量。Codex 的 MCP 工具默认超时为 60 秒，见 [官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。其他 Harness 的运行时及项目的生命周期策略仍然生效；本次不宣称所有后端均完成 12 小时实测。
- 修复 pi 将模型工具调用 ID 当作 MCP JSON-RPC 请求 ID 发送取消通知的问题。使用真实 sleep 子进程模拟 Pi 工具执行，在发送用户打断信号后收到服务器 `-32800`，之后仍能继续调用；已取消的回合不会启动新等待。
- 编译后真实 stdio 复测：1000 ms → 1002 ms、3000 ms → 3001 ms、1 ms → 1 ms；请求 43,200,000 ms 后主动取消，约 1 ms 收到取消响应。该项验证最长参数被接受和及时取消，并未等待 12 小时。
- 用户立即打断当前 Agent 会取消等待。排队用户消息仍由现有调度器处理，不会自动中断当前调用。
