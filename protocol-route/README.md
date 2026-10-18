# openai-anthropic-cc — Claude Code 协议路由（CCR）

[← 返回中文 README](../README_zh-CN.md) · [English README](../README.md)

本目录提供基于 [claude-code-router](https://github.com/musistudio/claude-code-router) 的本地 Anthropic Messages → OpenAI 兼容协议入口，供独立运行 Claude Code 时使用。ScienceEvolve Server 自身的多协议转换位于 `server/src/protocol-router.ts`，覆盖 Responses、Chat Completions 与 Anthropic Messages 之间的运行时路由，不依赖这里的持久 CCR 配置。

## 安装与启动

```bash
npm ci --prefix protocol-route
cd protocol-route
./start.sh
```

`start.sh` 会复用健康的 `http://127.0.0.1:3456` 服务，否则启动本目录安装的 CCR。停止服务时需使用相同的本地 HOME：

```bash
cd protocol-route
HOME="$PWD/.home" node_modules/.bin/ccr stop
```

## 配置与安全

CCR 运行配置位于 `.home/.claude-code-router/`。该目录可能包含 provider 密钥、管理 token、请求日志和本机会话，因此已被 `.gitignore` 排除，不得提交。

首次独立使用时，通过 CCR 的配置界面或管理 API 添加 OpenAI 兼容 provider，并选择所需模型。管理界面输出的 URL 可能包含 `ccr_web_token`，应按密码处理。更换上游时应先探测 provider，再基于最新完整配置修改 provider 与首选项，避免用局部配置覆盖现有设置。

仓库只跟踪依赖锁文件和无凭据的启动脚本；ScienceEvolve Server 会在运行时从全局网关配置注入选定凭据，不会从本目录读取已提交密钥。
