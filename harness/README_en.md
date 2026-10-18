# Harness — bundled AI coding CLIs

[← Back to README](../README.md#configuration) · **English** | [简体中文](README.md)

This directory pins CLI dependencies and standalone launchers for the bundled Harnesses. Server's Harness Registry is the sole runtime metadata authority; the table below is an installation reference. Dependency directories, account configuration, sessions, and credentials are excluded from Git. After a fresh clone, install the relevant dependencies:

```bash
npm ci --prefix harness/codex
npm ci --prefix harness/dsh
npm ci --prefix harness/pi
npm ci --prefix "harness/claude code"
```

| Directory | Dependency | Native protocol | Standalone launch |
| :--- | :--- | :--- | :--- |
| `codex/` | `@openai/codex` 0.153.x | OpenAI Responses | `./run.sh` or `./run.sh exec "task"` |
| `dsh/` | `@deepseek-ai/dsh` 0.1.2-rc.x | OpenAI Chat Completions | `./run.sh --profile headless "task"` or `./run.sh web` |
| `pi/` | `@mariozechner/pi-coding-agent` 0.73.x | OpenAI Chat Completions | `./run.sh` or `./run.sh -p "question"` |
| `claude code/` | `@anthropic-ai/claude-code` 2.1.x | Anthropic Messages | `./run.sh` or `./run.sh -p "question"` |

For each Agent invocation, `HarnessRuntimeFacade` creates isolated configuration, a unique Inbox mirror, a SessionRef, and invocation-scoped proxies. It injects only the credentials for the gateway selected on the global gateway page. The Facade is the sole composition root for `CommonProcessHost`. Each Adapter uses an `InvocationProcessHost` bound to the current invocation identity, workspace, cancellation signal, process marker, and recovery budget. Adapters must not use these standalone scripts to create separate process management. Pi's MCP subprocess bridge is the sole explicit exception and inherits an allowlisted environment rather than all of `process.env`.

Adapters consume official structured CLI events. Server does not infer tool calls from natural language or depend on account state in these standalone launchers. A new code-level CLI provides its own descriptor and registers once through `additionalAdapters` at the application composition root. Business logic, Gateway matrices, and frontend pages must not add Harness-ID branches.

The gateway route probe checks the protocol route. The Adapter smoke probe starts the real CLI, reads a read-only sentinel, and observes official tool start/result events. Failed checks show a risk notice but still allow an execution attempt; actual invocation failures are reported. See [adding a Harness](../docs/adding-a-harness-en.md) for extension steps and boundaries.

## Standalone configuration

- Codex: supply credentials through the current process's `AIGW_API_KEY` or `SCIENCEEVOLVE_GATEWAY_API_KEY`.
- DSH and pi: use `SII_GW_API_KEY`, `SCIENCEEVOLVE_GATEWAY_API_KEY`, or `SII_API_KEY`. Repository templates contain variable names only.
- Claude Code: access an OpenAI-compatible upstream through the local CCR service in `../protocol-route/`. Its runtime configuration lives in ignored `protocol-route/.home/`; tokens, logs, and databases must stay out of Git.

Credentials come from the current process environment or Server runtime injection. Do not write real keys into `settings.yaml`, `models.json.example`, READMEs, or any tracked file.
