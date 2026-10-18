# Claude Code 原生上下文压缩适配

[← 返回中文 README](../README_zh-CN.md) · [English README](../README.md)

日期：2026-09-22。

本次采用“原生压缩优先、最多一次会话重建兜底”的完整修复。摘要生成、历史替换和压缩后续跑均由 Claude Code 执行，应用不实现自己的摘要器。

## 原因与证据

用户报告的请求达到 1,230,139 tokens，超过模型的 1,048,576 上限。Main 使用 Claude Code 2.1.263、Kimi k3，并持续恢复同一个原生会话；重复的任务材料和缓存历史都计入模型上下文。第一次超限后，继续恢复旧会话并追加材料，使请求进一步增长。

当前代码原先设置 `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`。本地真实 CLI 实验还确认：Kimi 的 `Your request exceeded model token limit` 文案未触发原生恢复，转换成 Anthropic 的 `prompt is too long` 后会触发原生压缩。事故包没有进程环境快照，因此不能仅凭当前源码断言事故进程使用的所有环境变量。

## 实现

- `claude-code-adapter.ts`：去掉关闭窗口约束的配置，将网关模型窗口传给 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，并将窗口的 80% 传给 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。未配置模型窗口时沿用现有默认值 262,144。80% 是交给原生机制的窗口预算；实际触发点还受 Claude Code 内部识别的模型窗口和安全余量影响，可能更早。保留 `--bare`；实测它不阻止原生压缩。
- `context-limit.ts` / `protocol-router.ts`：识别上下文错误并保留请求量、上限等信息，将错误转换为原生可识别的文案及 `invalid_request_error`。覆盖 HTTP 错误、SSE、缓冲响应和 HTTP 200 内嵌错误。超限不会封锁网关，后续压缩请求仍可进入；压缩后请求成功则清除错误，失败响应不会留在缓冲缓存里。
- `storage.ts` / `orchestrator.ts` / `invocation-policy.ts`：已有会话只追加新事件涉及的 handoff 和 artifact 正文，并限制正文摘录及内联 Inbox 大小。保留当前需求、状态、材料目录和原文件路径，完整文件不会被截断或删除。
- `runtime.ts`：原生机制仍不能恢复时，在同一个逻辑调用内最多重建一次会话，从 Inbox、Memory 和项目文件恢复。保留已暂存的控制动作，提示检查已完成工作；如已有终结决策则直接保留该决策，不重新执行。第二次上下文超限归类为不可自动重试错误，暂停项目，避免外层重试继续追加上下文。普通进程或恢复错误仍遵守各自原有预算。
- `process-host.ts`：允许原生窗口环境变量作为有界正整数传入；它不是认证令牌。非数字或超范围值仍会被拒绝。

原生设置参考：[环境变量](https://code.claude.com/docs/en/env-vars)、[网关及自定义模型窗口](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id)。

## 验证

1. 使用实际 Claude Code 2.1.263 和本地模拟模型 API，提前压缩、超限后压缩两项均通过。前者包含大量 `cache_read_input_tokens`；后者返回事故中的原始 Kimi 报错。两项均产生原生 `compact_boundary` 并成功返回 `DONE`，没有调用真实 Kimi 服务。
2. 覆盖错误分类、六种响应路径、原生压缩环境、材料增量、只重建一次、保留终结决策、外层停止自动重试、环境校验和架构约束。
3. 独立分支的 server 类型检查通过；十个相关测试文件共 246 项，232 通过、14 失败（两项真实 CLI 测试均通过）。14 项失败均在未修改基线上复现，涉及 Windows 权限、符号链接、进程信号、Inspire 包装器及绝对路径；没有新增失败。

常规验证：

```powershell
npm run typecheck -w server
npm run test -w server -- tests/context-limit.test.ts tests/protocol-router.integration.test.ts
```

真实原生 CLI 验证是显式启用的测试；默认测试不会启动本机 CLI：

```powershell
$env:SCIENCEEVOLVE_TEST_CLAUDE_BIN = (Resolve-Path '.\harness\claude code\node_modules\@anthropic-ai\claude-code\bin\claude.exe').Path
npm run test -w server -- tests/claude-native-compaction.integration.test.ts
Remove-Item Env:SCIENCEEVOLVE_TEST_CLAUDE_BIN
```

部署时保留原项目数据目录，按现有启动方式重新构建并重启服务。此前因上下文超限暂停的项目可在原项目中点击继续：先恢复旧会话并尝试原生压缩，仍然超限时才触发一次会话重建。该流程不要求新建项目或删除历史产物；真实网关上的原事故任务尚未进行完整续跑验证。
