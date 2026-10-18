# harness — ScienceEvolve 内置的 AI 编码 CLI

[← 返回中文 README](../README_zh-CN.md#configuration) · [English](README_en.md) | **简体中文**

本目录锁定当前内置 Harness 的 CLI 依赖与独立启动入口。运行时的唯一元数据来源是 Server 的 Harness Registry；本表只是安装说明。依赖目录、账号配置、会话和凭据均不纳入 Git；全新 clone 后请先安装对应依赖：

```bash
npm ci --prefix harness/codex
npm ci --prefix harness/dsh
npm ci --prefix harness/pi
npm ci --prefix "harness/claude code"
```

| 目录 | 工具依赖 | 原生协议 | 独立启动 |
|---|---|---|---|
| `codex/` | `@openai/codex` 0.153.x | OpenAI Responses | `./run.sh` 或 `./run.sh exec "任务"` |
| `dsh/` | `@deepseek-ai/dsh` 0.1.2-rc.x | OpenAI Chat Completions | `./run.sh --profile headless "任务"` 或 `./run.sh web` |
| `pi/` | `@mariozechner/pi-coding-agent` 0.73.x | OpenAI Chat Completions | `./run.sh` 或 `./run.sh -p "问题"` |
| `claude code/` | `@anthropic-ai/claude-code` 2.1.x | Anthropic Messages | `./run.sh` 或 `./run.sh -p "问题"` |

生产运行时由 `HarnessRuntimeFacade` 为每次 Agent 调用创建隔离配置、唯一 Inbox 镜像、SessionRef 和调用级代理，并只注入全局网关页中选定的网关凭据。Facade 是 `CommonProcessHost` 的唯一组合根；各 Adapter 只能使用已绑定当前调用身份、工作区、取消信号、进程 marker 和恢复预算的 `InvocationProcessHost`，不能依赖本目录脚本另起一套进程管理。Pi 的 MCP 子进程桥是唯一明确豁免，也只继承 allowlist 环境而不是整个 `process.env`。

各 Adapter 读取 CLI 官方结构化事件；Server 不分析自然语言来猜测工具调用，也不依赖这些独立启动脚本中的固定账号状态。新增代码级 CLI 时，Adapter 自带 descriptor，并在应用组合根通过 `additionalAdapters` 注册一次；不要在业务层、Gateway 矩阵或前端增加 Harness ID 分支。

网关矩阵中的 route probe 验证协议线路；Adapter smoke probe 会真实启动对应 CLI、读取只读 sentinel 并观察官方 tool start/result。测试未通过时显示风险提醒，仍可尝试执行，实际调用失败会显示错误。新增 CLI 的步骤和边界见 [新增 Harness 指南](../docs/adding-a-harness.md)。

## 独立启动配置

- Codex：通过当前进程的 `AIGW_API_KEY` 或 `SCIENCEEVOLVE_GATEWAY_API_KEY` 注入凭据。
- DSH、pi：通过 `SII_GW_API_KEY`、`SCIENCEEVOLVE_GATEWAY_API_KEY` 或 `SII_API_KEY` 注入凭据；仓库内模板只包含环境变量名，不包含密钥。
- Claude Code：通过 `../protocol-route/` 的本地 CCR 服务访问 OpenAI 兼容上游。CCR 的运行配置位于被忽略的 `protocol-route/.home/`，不得提交其中的 token、日志或数据库。

所有凭据都应来自本次进程环境或 Server 的运行时注入。不要把真实密钥写入 `settings.yaml`、`models.json.example`、README 或任何可跟踪文件。
