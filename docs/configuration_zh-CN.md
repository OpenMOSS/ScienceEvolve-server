# 安装与配置指南

[English](./configuration.md) | **简体中文** | [← 返回中文 README](../README_zh-CN.md)

首次本地任务见首页的[快速开始](../README_zh-CN.md#快速开始)。本指南保留完整的安装、网关、Agent、Workflow、Git 协作、实验平台与生产部署配置。

[安装](#快速开始) · [网关](#全局网关) · [Git 协作](#github-账号库与-git-协作) · [Workflow](#workflow) · [生产运行](#生产运行)

## 快速开始

### 1. 环境要求

- Node.js 24 或更高版本（协作运行的内置 SQLite 权威状态依赖 Node 24）
- npm 10 或更高版本
- 可执行的 Codex CLI 与 [Inspire CLI](../.agents/skills/inspire/references/setup/install-and-config.md#1-安装)；使用 SII 实验工具时还需完成账号和项目初始化
- 至少一个可用的模型网关
- Git（启用 Git 协作时需要）

当前 Server 启动会解析 Inspire 可执行文件，并获取默认 Codex 的版本信息。Codex 可使用仓库内置版本，也可以通过环境变量指向外部安装；Inspire 默认从 `PATH` 查找。即使本次不运行 SII 实验，当前启动入口仍要求能找到 Inspire CLI；SII 账号、Project 和资源上下文在实际使用实验工具前配置。

### 2. 安装依赖

安装 Web 与 Server 依赖：

```bash
npm ci
```

安装最小必需的内置 Codex Harness：

```bash
npm ci --prefix harness/codex
```

需要其他 Harness 时再分别安装：

```bash
npm ci --prefix harness/dsh
npm ci --prefix harness/pi
npm ci --prefix "harness/claude code"
```

如果机器上已经安装了这些 CLI，可以跳过对应安装，并在 `.env` 中配置其绝对路径。

### 3. 创建配置文件

首次安装且根目录尚无 `.env` 时执行；已有配置直接补充需要的变量。

```bash
cp .env.example .env
```

使用内置 Codex 时将 `SCIENCEEVOLVE_CODEX_BIN` 留空，确认已执行上面的 Harness 安装命令；填写 `codex` 会改为从 `PATH` 查找。使用 SII 前，将 `SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` 改成包含实际 Agent 工作区的绝对目录：默认 `SCIENCEEVOLVE_DATA_DIR=./data` 时可填写仓库根目录的绝对路径，在仓库根目录执行 `pwd` 获取；数据目录放在仓库外时填写对应的实际父目录。

最小配置示例：

GitHub OAuth 项仅在使用网页 Git 协作时填写：先按下文 [GitHub 账号库与 Git 协作](#github-账号库与-git-协作) 注册 OAuth App，再填入真实值。留空可启动普通项目，GitHub 登录入口保持禁用。模型网关 API key 与 GitHub OAuth 的 Client Secret 分别配置。

```dotenv
HOST=127.0.0.1
PORT=4311
SCIENCEEVOLVE_DATA_DIR=./data

# 内置 Codex 安装后通常无需填写；外部 CLI 建议使用绝对路径。
# SCIENCEEVOLVE_CODEX_BIN=/absolute/path/to/codex
SCIENCEEVOLVE_INSPIRE_BIN=inspire

# 可留空，启动后在“全局网关库”中配置。
AIGW_BASE_URL=https://example.com/v1
AIGW_API_KEY=
SCIENCEEVOLVE_MODELS=model-a,model-b

# 启用 Git 协作账号库时配置 GitHub OAuth App；本机开发可使用 loopback callback。
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID=
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET=
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE=
SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL=http://127.0.0.1:5173/api/github/auth/callback
```

### 4. 启动开发环境

```bash
npm run dev
```

- Web：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:4311>
- 健康检查：<http://127.0.0.1:4311/api/health>

### 5. 首次运行前检查

| 检查 | 操作与预期结果 |
| --- | --- |
| API 与前端代理 | 浏览器分别打开 `http://127.0.0.1:4311/api/health` 和 `http://127.0.0.1:5173/api/health`，两处都应返回包含 `"status":"ok"` 的 JSON。第二处失败说明前端尚未正确转发 `/api`。 |
| Harness | 在全局网关页检查项目实际使用的 CLI 可用；外部路径指向真实可执行文件。 |
| 模型 | 保存真实网关、API key、模型及所需思考选项，再执行连接测试和实际 Harness/model 组合验证。仅保存 URL 或健康检查通过，不代表模型配置可运行。 |
| Git 协作 | 需要 Git 时，先完成下文 OAuth App 配置、网页登录和账号验证，再在项目中选择该账号；普通非 Git 项目跳过。 |
| 项目资源 | 为每个 Agent 检查网关、模型、Harness、Skills/MCP 和输入材料；使用 SII 的 Worker 另选实验工具并完成平台初始化。 |

## 配置方法

推荐按“服务环境 → 全局网关 →（需要 Git 时）GitHub 账号 → Harness → Agent → Workflow”的顺序配置。

### 服务环境

建议统一使用仓库根目录的 `.env`。通过 npm workspace 脚本启动时，Server 会先查找 `server/.env`，存在时优先读取它，再回退到根目录 `.env`；已设置的进程环境变量也可能覆盖文件值。修改后重启服务，并确认没有另一份配置覆盖预期值。Vite 的 `SCIENCEEVOLVE_WEB_HOST`、`SCIENCEEVOLVE_API_URL` 和 `SCIENCEEVOLVE_WEB_BASE` 通过启动进程环境传入，方法见 [前端与反向代理](#前端与反向代理)。常用服务端变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API 与生产 Web 的监听地址。 |
| `PORT` | `4311` | API 与生产 Web 的监听端口。 |
| `SCIENCEEVOLVE_DATA_DIR` | `./data` | 项目、网关、预设、用户 Skills 和运行轨迹的持久化根目录。 |
| `SCIENCEEVOLVE_CODEX_BIN` | 内置 Codex 或 `codex` | Codex 可执行文件；外部安装建议填写绝对路径。 |
| `SCIENCEEVOLVE_INSPIRE_BIN` | `inspire` | Inspire CLI 路径或命令名。 |
| `SCIENCEEVOLVE_SII_REFRESH_MS` | `30000` | 后台代码查询 CPU/GPU 实验状态的间隔（毫秒）；查询故障时退避。 |
| `SCIENCEEVOLVE_MODELS` | 内置建议列表 | 逗号分隔的模型建议；也用于首次 AIGW 网关初始化。 |
| `SCIENCEEVOLVE_AGENT_CONCURRENCY` | `10` | 共享调度器中 Main 与 Worker 两类队列各自允许的最大并发调用数；Git 协作项目使用各自的管理与 Worker 调度队列。 |
| `SCIENCEEVOLVE_RETRY_BASE_MS` | `2000` | 调用重试的初始退避时间。 |
| `SCIENCEEVOLVE_RETRY_MAX_MS` | `60000` | 调用重试的最大退避时间。 |
| `SCIENCEEVOLVE_DSH_HANDSHAKE_TIMEOUT_MS` | `60000` | DSH 初始化、prompt 回执和关闭握手的超时时间；不限制 turn 总时长。 |
| `SCIENCEEVOLVE_DSH_TURN_IDLE_TIMEOUT_MS` | `1200000` | 普通 DSH Adapter turn 无任何原生事件时的 inactivity 窗口。 |
| `SCIENCEEVOLVE_RESIDENT_MODEL_INACTIVITY_TIMEOUT_MS` | `1200000` | 所有 resident Harness 等待模型/provider 有效活动的公共 inactivity 窗口。 |
| `SCIENCEEVOLVE_RESIDENT_TOOL_INACTIVITY_TIMEOUT_MS` | `7200000` | 所有 resident Harness 活跃工具无有效更新时的公共 inactivity 窗口。 |
| `SCIENCEEVOLVE_PROTOCOL_PROXY_TIMEOUT_MS` | `1200000` | 协议代理单次上游请求的无活动超时时间；SSE 帧会重置计时。 |
| `SCIENCEEVOLVE_INTERRUPT_FORCE_TIMEOUT_MS` | `8000` | 中断调用时，强制清理前的等待时间。 |
| `SCIENCEEVOLVE_MAX_EVENT_HISTORY` | `10000` | 普通项目快照中保留的最大事件数；SSE 仍可恢复完整历史。 |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID` | 留空 | GitHub OAuth App 的 Client ID；留空时账号库可查看，但登录入口禁用。 |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET` | 留空 | GitHub OAuth App 的服务端 Client Secret；不会发送给浏览器。 |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE` | 留空 | Client Secret 文件路径；未设置明文 Secret 时从该文件读取。 |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL` | 留空 | OAuth callback 完整地址，必须与浏览器页面同源，路径为 `/api/github/auth/callback`；生产必须 HTTPS，本机 loopback 可用 HTTP。 |

`.env` 中不要提交真实凭据。`SCIENCEEVOLVE_DATA_DIR` 内包含网关凭据、研究资料和运行日志，也应视为敏感目录。

Agent 队列看板同时读取共享队列和 Git 项目的调度状态，按实际调用统计并行 Agent，分别显示执行中、等待调度和等待恢复。Git 项目的并发上限单独显示；历史进程记录与当前模型调用不会重复占用显示计数。

### 全局网关

有两种配置方式。

#### 方法一：在界面中配置（推荐）

启动系统后进入“全局网关库”，按以下步骤操作：

1. 点击“新增网关”。
2. 填写显示名称、HTTPS 地址和 API key。VPN / 内网网关需要先连接相应网络。
3. 选择网关实际使用的协议：Responses、Chat Completions 或 Anthropic Messages。
4. 刷新或手工添加可用模型，为每个模型设置上下文长度（默认 256K，最大 1M），再指定默认模型。
5. 保存后执行“测试连接”。
6. 执行“验证全部 Harness / model”，确认项目需要的组合可以运行。
7. 将常用网关设为默认网关。

项目启动前会校验所选 `Harness + 网关 + model` 配置。Harness 的原生协议与网关协议不一致时，系统会自动经过协议路由。连接测试未验证、失败或旧记录失效时，界面会提醒运行可能失败，仍可保存配置、生成推荐和尝试执行；实际调用失败会显示错误。

每个 Gateway 可按 model 配置独立的“思考参数路径 + 候选值”，再由 Agent 选择一个 option。支持 `reasoning_effort`、`reasoning.effort`、`chat_template_kwargs.reasoning_effort` 和 `thinking.effort`，适配不同供应商字段；不选择时不会发送该参数。映射、候选值或 Gateway revision 改变后，旧的组合探测会失效，可按新 option 重新验证，也可直接尝试运行。这个 Gateway reasoning 选择与 Harness 原生的 `reasoningEffort` 是两个字段，Main 动态重配置无权修改任何一个。

网关必须使用 HTTPS 443。公网地址和 RFC1918 私网地址均可直接配置；私网网关仍需由运行 ScienceEvolve 的机器先连接 VPN 或目标内网。本机回环、CGNAT、链路本地元数据、组播、文档测试、基准测试、其他保留地址，以及同时返回公网和私网地址的 DNS 结果仍会被拒绝。保存网关时只校验 URL 格式，真实网络与协议兼容性由“测试连接”和项目启动检查验证。

#### 方法二：首次启动时从环境变量初始化

```dotenv
AIGW_BASE_URL=https://gateway.example.com/v1
AIGW_API_KEY=replace-with-real-key
SCIENCEEVOLVE_MODELS=model-a,model-b
```

当 `AIGW_API_KEY` 非空且 `${SCIENCEEVOLVE_DATA_DIR}/gateways.json` 尚不存在时，Server 会创建一个 AIGW 系统网关。网关库一旦写入，以界面中的持久化记录为准；后续修改 `.env` 不会覆盖用户已编辑或删除的网关。

### GitHub 账号库与 Git 协作

研究产物浏览器会随文件和发布记录更新，包含共享文件及已退出当前 Workflow 的产物作者。Git 成果按发布记录对应的提交读取，清理执行 worktree 不影响已发布内容；同路径的历史版本仍使用各自的发布 ID 与提交校验。最终结果同时展示已接受的 Git 交接摘要；项目完成但没有指定展示清单时，会列出已发布成果并说明来源，不把未接受的工作区文件当作最终交付。

Web Git 协作采用 **GitHub OAuth App + 用户登录授权**。OAuth App 由部署这套 Web/Server 的人注册一次；使用该站点的人在“GitHub 账号库”登录自己的账号即可，用户无需各自注册 App。自己部署时，需要为自己的访问地址配置 App。SDK 的 Git 使用宿主提供的凭据，配置方式见 [SDK GitHub 认证](/../feat/sdk-only-v0.1.1/README_zh-CN.md#github-认证与-git-协作)。

#### 1. 部署者注册 OAuth App

登录用于管理部署的 GitHub 账号，进入 **Settings → Developer settings → OAuth Apps → New OAuth App**，也可直接打开 [OAuth App 注册页](https://github.com/settings/applications/new)。当前实现使用 OAuth Apps 这一入口。步骤参考 [GitHub 官方注册说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)。

填写 Application name（例如 `ScienceEvolve Local`）、Homepage URL 和 Authorization callback URL。后两项按实际访问场景选择：

| 场景 | Homepage URL / 浏览器访问地址 | Authorization callback URL |
| --- | --- | --- |
| 本机开发 `npm run dev` | `http://127.0.0.1:5173` | `http://127.0.0.1:5173/api/github/auth/callback` |
| 本机生产 `npm start` | `http://127.0.0.1:4311` | `http://127.0.0.1:4311/api/github/auth/callback` |
| 对外 HTTPS 部署 | `https://research.example.com`（替换为实际站点） | `https://research.example.com/api/github/auth/callback` |

注册后，在 App 详情复制 **Client ID**，生成并保存 **Client Secret**。这些是应用配置；用户的 GitHub 密码、PAT 和模型 API key 都不能填进 Client Secret。服务使用网页授权回调，不要求启用 Device Flow。

#### 2. 配置 Server 并重启

在根目录 `.env` 中填写新建 App 的真实值。以下以前端开发地址为例：

```dotenv
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET=YOUR_OAUTH_APP_CLIENT_SECRET
SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL=http://127.0.0.1:5173/api/github/auth/callback
```

也可将 Client Secret 单独保存为服务端可读的纯文本文件；此时把明文 Secret 留空，设置 `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client-secret`。修改后重启 Server。Client Secret 只在服务端使用，不写入前端配置或提交 Git。

**浏览器地址、`.env` 的 Callback URL 和 GitHub App 中的 Authorization callback URL 要配套使用。** 本项目要求回调与浏览器页面同源；`localhost` 与 `127.0.0.1`、5173 与 4311 分别是不同的 origin。开发环境回调经 Vite 转发，不能在浏览器访问 5173 时填写独立 API 的 4311 回调。远程访问使用实际 HTTPS 地址；Notebook 或子路径代理还需保留浏览器可访问的完整前缀，并将回调路径转发到 Server。

#### 3. 使用者登录并验证账号

进入“GitHub 账号库”，点击“登录新账号”，允许浏览器打开登录窗口，在 GitHub 选择并授权实际执行项目的账号。ScienceEvolve 请求经典 OAuth `repo` scope，用于个人仓库与 PR 操作，不请求 `workflow`/Actions 权限；权限定义见 [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。返回后应看到账号和授权正常状态，再执行账号验证。

浏览器访问站点的 `/api/github/accounts` 可看到 `oauthConfigured`。`true` 仅表示服务端三项配置齐全；**实际登录返回、账号验证通过**才完成认证检查。未配置 OAuth 不影响非 Git 项目的启动。

账号库支持同时登录多个 GitHub 账号、验证授权状态和设置默认账号。新建项目开启 Git 后必须显式选择一个授权正常的账号，并可在文字版或画布弹窗中填写仓库名、选择 Private（默认）或 Public；真正的仓库只会在启动项目后创建。如果账号库为空，界面会保留当前草稿并跳转到登录页。项目创建后以 GitHub 数字用户 ID 固定账号身份，登录名变化不会改变绑定，项目也不会静默改用服务进程的 Git credential helper。历史上没有账号绑定的 Git 项目会停在 `git:waiting_for_github`，不会猜测账号。

访问令牌与 refresh token 只在 Server 使用 AES-256-GCM 加密保存于 `${SCIENCEEVOLVE_DATA_DIR}/github-accounts.json`；本机密钥为同目录下权限 `0600` 的 `github-accounts.key`。列表、项目快照、日志和浏览器 API 都不返回令牌。仍被项目绑定的账号不能从本地账号库移除；“移除”只删除 ScienceEvolve 本地授权记录，不会删除 GitHub 仓库，也不等同于在 GitHub 撤销 OAuth 授权。

#### 常见配置失败

| 现象 | 检查方法 |
| --- | --- |
| 登录按钮禁用 / OAuth 尚未配置 | 检查 Client ID、Secret 或 Secret 文件、Callback URL 是否齐全，Server 是否重启，以及 `server/.env` 或进程环境是否覆盖根配置。 |
| 回调不匹配 / 只能从 callback 所属站点发起 | 对照上表核对浏览器 origin、GitHub App 和 `.env`；切换开发/生产端口时同步更新。 |
| 登录窗口打不开 | 允许当前站点弹窗后重试。 |
| Client Secret 错误 / 授权交换失败 | 使用同一个 OAuth App 的 Client ID 与 Secret；确认文件内容是 Secret，服务端能访问 `github.com` 与 `api.github.com`。 |
| 登录会话已失效 | 重新从账号库发起登录；授权过程不要重启 Server，登录会话有效期为 10 分钟。 |
| 项目等待 GitHub / 401 / 403 | 在账号库重新授权并验证，再确认项目选择的账号、`repo` 授权和新仓库名称。 |

### Harness

| Harness | 原生协议 | 内置目录 | 外部可执行变量 |
| --- | --- | --- | --- |
| Codex | OpenAI Responses | `harness/codex` | `SCIENCEEVOLVE_CODEX_BIN` |
| DSH | OpenAI Chat Completions | `harness/dsh` | `SCIENCEEVOLVE_DSH_BIN` |
| pi | OpenAI Chat Completions | `harness/pi` | `SCIENCEEVOLVE_PI_BIN` |
| Claude Code | Anthropic Messages | `harness/claude code` | `SCIENCEEVOLVE_CLAUDE_CODE_BIN` |

外部 Harness 变量建议使用可执行文件的绝对路径。也可以通过 `SCIENCEEVOLVE_HARNESS_ROOT` 指向一个包含 `codex/`、`dsh/`、`pi/` 和 `claude code/` 子目录的自定义 Harness 根目录；使用自定义根目录时仍建议显式配置 `SCIENCEEVOLVE_CODEX_BIN`。

配置完成后，可在全局网关页查看 Harness 是否可用，并用网关矩阵依次完成协议 route probe 与真实 Adapter smoke probe。两者都通过且身份缓存仍匹配当前 Gateway revision、Adapter 版本和可执行文件时，该组合显示为已验证；测试状态仅作提醒，不阻止尝试执行。更详细的内置运行时说明见 [harness/README.md](../harness/README.md)；扩展步骤见 [新增 Harness 指南](adding-a-harness.md)。

Harness 的用途按 Catalog 能力分别发布，不会因为能运行工作流就自动出现在 Project Explainer 中。项目解说可在 Codex、pi 和 DSH 之间选择，默认使用 Codex；Claude Code 保留兼容数据，但不再显示为可选项。交互助手的原生 Harness 保持文件只读、Shell 和浏览器禁用，仅注入本轮专用的产品 MCP，可读取上下文、修改与保存草稿、撤销修改，以及提交现有项目的 Workflow 调整。配置推荐等独立调用仍禁用所有 MCP。切换 Harness 会重建原生会话，同时保留项目解说历史。

### Agent

在“新建项目”页面或 Workflow 画布中配置每个 Agent：

| 配置项 | 作用 |
| --- | --- |
| Harness | 选择实际执行该 Agent 的 CLI。 |
| 网关与模型 | 从全局网关库中选择组合，未通过验证时显示提醒并允许尝试运行。 |
| Harness 思考深度 | `low`、`medium`、`high` 或 `xhigh`，传给所选 Harness。 |
| Gateway reasoning | 从当前 Gateway/model 配置的候选值中选择；省略时不注入上游字段。 |
| Prompt | 该 Agent 的完整职责、输入约束和输出要求。 |
| 固定 Skills | 每次调用都加载。 |
| 自动 Skills | 作为候选项，由 Agent 根据当前任务选择。 |
| MCP | 每次调用时连接的 Streamable HTTP MCP 服务。 |
| 权限 | 当前任务工作区（`workspace`）、项目内工作区（`compute`）或原生完全访问（`yolo`）。 |
| Web Search | 是否允许支持该能力的 Harness 使用联网搜索。 |
| 会话持久化 | Worker 是否在同一项目内复用线程；Main 始终持久化。 |
| 弱边决策 | 普通弱边由 Main 或当前 Worker 决定；Main 固定由自身决策。 |

`main` 是每个项目唯一且必需的 Agent，不能删除或重命名。它负责项目级调度、用户输入、失败恢复和完成判断。每轮 Main 都使用服务端生成的唯一 capability 快照：`autonomous` 可在全部普通 Agent 中调度，`weak-branch` 只能选择本轮弱边候选；完成、用户介入和动态重配置权限分别受快照控制。项目正式启动后，直接更新配置的用户 API 保持锁定；用户可通过专用 Workflow 调整机制提交允许范围内的变更（见 [Project Explainer](#推荐配置与-project-explainer)）。若要由 Main 自主改编排，还必须在创建前显式开启“允许 Main 动态重配置（高级权限）”，autonomous Main 才能通过服务端生成的 `workflow.json` 提交白名单内的变更。该开关默认关闭，Main 不能自行开启或关闭。

### Workflow

#### 手动复用仓库中的 Workflow

[example/](../example/README.md) 展示 16 个已实现流程，作为源码和文档提供；应用不展示、自动加载、注册其 Skill 或将其随 Server 构建打包。选择所需 JSON、需求与工具资源，按例子说明自行配置。

原始 SDK 文件含顶层 Git 部署配置，部分旧流程省略网页编排版本；不要直接当成网页预设上传。可在 Server 主机从仓库根目录执行 `node example/export-web-workflow.mjs example/aris/workflow.json /tmp/aris.web.json`，生成单独副本，再用主页现有通用导入入口查看和载入。脚本解析本机相对 Skill 路径并保留研究协议，原文件不变。

需求需要单独复制，模型网关和 Git 账号需要手动选择。跨机器复制时重新导出或调整 Skill 路径；不会自动安装实验依赖。详见[手动使用说明](../example/README.md#在-web-中手动查看和使用)及 [README 实操教程](../README_zh-CN.md#tutorial)。

#### 手工导入 SDK 配置

主页“Agent 配置预设”支持导入 SDK 的单个 `workflow.json`（最大 1 MB，支持 UTF-8 BOM）。导入后保存到配置库并打开只读预览，支持查看 Agent、连线和原始 JSON，也可下载原文或删除条目。导入项也可在主页快速发起的配置选择器及画布已保存流程中载入为可编辑副本；原文不可覆盖，修改后可另存为新配置。

原文预览保留 SDK 的 Main 路由与会话设置，展示服务端真实 Harness 目录，不执行运行资源。选择快速发起时，副本转换为网页端调度规则（包括 Main 路由与会话约束），不保证与 SDK CLI 等价。启动前必须为每个 Agent 选择网页网关，并检查模型、Harness、Skills 和 MCP；不会从 SDK 环境变量或 profile 自动导入网关。导入失败不会改变现有预设或正在编辑的研究任务。新建课题页没有导入入口，另存后的普通配置可在那里复用。

Workflow 画布主要配置以下内容：

- 首次用户输入交给哪个 Agent。
- Worker 之间的强边和弱边。
- 用强边闭合确定路径，画布会自动建立 Loop；再设置每批迭代数和退出目标。
- 哪个 Agent 负责触发结束判断。
- 是否允许非 Main 终止 Agent 依据自然语言条件自动完成。
- 是否允许 Main 在 autonomous 轮动态重配置（高级权限，默认关闭）。
- 节点位置、端口和展示布局。

强边表示完成后直接进入唯一目标；多条弱边表示候选路径，由配置的决策方选择。新建 Agent 或从模板添加副本时不自动创建出边，需要手动连接；Main 到全部 Worker 的分发边由系统维护，不受这一默认值影响。默认由 Main 验收终止；仅当非 Main 终止 Agent 显式开启“允许自动完成”且处于合法终止上下文时，它才获得受限完成能力，不会同时获得通用路由或高级权限。

Loop 不创建新节点。可编辑画布中，普通 Agent 的强边闭合为合法环时，新增的强边成为 `from -> to` 返回边，画布同时写入 `orchestration.loops[]`。同一 Loop 的所有强边同色，不同 Loop 异色，且与普通强边区分；点击任意成员边可选中整组，在右侧编辑 Loop ID、每批迭代数和退出目标。选中单边时只在该边显示流向小球；选中 Loop 时在全部成员强边和虚拟退出边显示各自方向的小球，其余边淡化。`from -> exitTo` 是只读批次退出边，虚线与弱边接近但颜色不同；其小球仅表示方向，不代表每轮都会退出。打断闭环会同步移除 Loop 配置，非法闭环会被拒绝；节点改名会同步 Loop 引用。运行画布显示 batch、iteration 与 total。暂停、恢复、失败重试和普通重配置不会重置计数，批次耗尽进入 Main 也不会绕过原终止条件。

Agent 后续调用的脚本网络沿用服务统一环境；旧文件中的 Agent 代理字段在读取时忽略，新配置不再提供逐 Agent 代理选择。

开启高级权限后，服务端在允许重配置的 autonomous Main 轮提供 `workflow.json` 提案。文件包含宏观 `orchestration`、可编辑 Agent 字段、Project Skill/MCP、只读 `lockedRuntime`、编辑说明和防止覆盖新状态的 `baseHash`。Main 可修改 Agent 名单、输入、路由、Loop、终止、结果形式、用户介入、instructions、model、Harness、已配置 `gatewayId`、Skills、MCP、SII 工具选择 `experimentMcp` 和弱边决策归属 `decisionBy`；permission、Web Search、Session 持久策略、Harness reasoning、Gateway reasoning、凭据、运行快照及授权开关保持锁定。已接受的 Project Skill/MCP 定义保持不可变；调整内容时新增定义名称并更新 Agent 引用。

Main 编辑后必须以 `apply_workflow` 作为本轮唯一终结控制动作。服务端先校验完整文档、引用、图和运行能力，再通过 invocation journal 原子提交；过期 base hash 或任一错误都保留旧状态，不会部分应用。成功后保存已接受的配置并继续调度，后续调用按运行时的会话连续性规则加载新配置。动态编排没有一次性限制，只要后续 Main capability 仍允许，就能继续提交。

对已存在 Agent 修改 `template` 只会改变宏观角色标签，不会把已有 Agent 的 Harness、权限或其他运行时配置切换到模板默认值；需要执行权限等运行能力时，应在项目启动前配置。模板默认值只用于新增 Agent。

### Skills 与 MCP

所有工作流 Agent（包括 Main、Worker 和协作组中的常驻 Agent）自动获得内置 `scienceevolve-sleep` stdio MCP，适用于 Codex、Claude Code、DSH 和 pi，无需在 Agent 配置中手动添加。工具 `sleep({ "duration_ms": 1000 })` 等待指定毫秒数；与 Codex 内置 sleep 的时长范围一致，接受 1–43200000 的整数（最长 12 小时），返回请求时长和实际等待时长。等待支持 MCP 取消通知，连接关闭时也会取消；用户立即打断 Agent 时会取消等待，排队消息则按原有调度处理。Codex 的内置 sleep MCP 单独配置了足够的调用超时；只暂停当前工具调用，不改变工作流状态或结束 Agent 回合。Project Explainer 和配置推荐不注入该工具。`scienceevolve-sleep` 为保留名称，不能被自定义 MCP 覆盖。

运行 `npm run smoke:sleep-mcp -w server` 可构建并启动真实 sleep MCP 子进程，通过官方 MCP 客户端实测 1 秒和 3 秒等待、并发响应、取消、参数校验及子进程退出。此检查无需模型网关或凭据。

Skills 会从以下位置合并读取：

- 项目内置：`.agents/skills`
- 用户创建：`${SCIENCEEVOLVE_DATA_DIR}/skills`
- 用户目录：`~/.agents/skills`、`${CODEX_HOME}/skills`
- 额外目录：`SCIENCEEVOLVE_SKILL_ROOTS`

多个额外目录使用操作系统路径分隔符连接（Linux/macOS 为 `:`，Windows 为 `;`）。每个 Skill 目录必须包含 `SKILL.md`。

自定义 MCP 通过名称和 HTTP(S) URL 配置，每个 Agent 最多 32 项。系统 MCP 的名称和 URL 固定；如果部署提供了系统 MCP 凭据，可配置：

```dotenv
SCIENCEEVOLVE_FIXED_MCP_TOKEN=replace-with-system-mcp-token
```

该凭据只会注入实际选择了系统 MCP 的 Agent 调用。

Workflow 还可定义 Project Skill 和 Project stdio MCP。Project Skill 是包含非空 `SKILL.md` 的完整文本文件映射，Agent 用 `project:<name>` 分配；Project MCP 保存源码、entrypoint、command/args 和只引用宿主环境变量名的 `envFrom`，Agent 用 `{ "name": "...", "project": "definition-name" }` 分配。新建项目页的“项目级 Skill 与 MCP”区域编辑这些定义，保存或启动时由服务端统一校验，失败不会部分应用。高级权限关闭时可以使用预配置资源；开启后 Main 可新增定义和调整分配，已接受定义的同名改写、替换和删除会被拒绝。

### 推荐配置与 Project Explainer

“新建项目 → 01 研究任务”中的“推荐配置”使用用户选择的顾问模型与网关，将项目名称、需求、用途说明和当前 `user_inputs/` 中的文件、图片一起作为输入，生成完整草稿和 warnings。配置推荐支持 UTF-8 文本、DOCX、XLSX、PPTX、PDF 及 PNG/JPEG/GIF/WebP；无法读取或超限的附件会明确报错，不会静默忽略。推荐过程不使用工具、不修改项目、不自动启动；结果通过正常 Workflow/Harness/Gateway/Skill/MCP 校验后才填回可编辑表单。

推荐弹窗显示准备材料、生成推荐、校验配置和应用配置的实际阶段及耗时，支持取消和失败后重试。成功后自动填入 Agent 与完整 Workflow，执行一次画布分层重排与智能整理，并在同一弹窗中列出实际修改；未调整执行编排时也会明确说明。关闭“允许 Main 自动调整 Workflow”只限制项目运行中的修改，不限制推荐阶段设计 Workflow。

项目列表和详情中的流程进度按当前外层 Workflow 节点估算：进度 = 起点到当前节点的最短步数 ÷（该步数 + 当前节点到结束节点的最短步数）。分支按最短可达路径计算，循环回退时进度可以下降，协作组整体按一个节点计算；调用次数、耗时和 Explainer 建议不影响百分比。未完成项目最多显示 99%，确认完成后显示 100%。例如 A → B → C → D → 结束依次显示 0%、25%、50%、75%、100%。

首页、新建项目的文字版和画布版、项目详情共享 Project Explainer 悬浮助手。它是所选 Harness 的原生 Agent，由模型自行决定工具调用与讨论顺序；可用自然语言调整 Workflow、协作组及 Agent 的 Harness、模型、提示词等配置。创建项目仅保存到首页的科研任务草稿库，成功后提供入口，由用户查看并主动启动；工具中没有启动研究或创建 Git 仓库的能力。草稿导航、用户启动项目之后继续沿用同一会话与历史，原有详情面板也共享该会话。

助手和详情面板共用 Harness 执行过程展示：可见回复、公开思考摘要及工具调用状态随事件流更新，参数、结果预览和失败详情可展开，刷新后从同一份历史恢复。仅明确发布为摘要的内容进入摘要展示；Harness 未提供公开摘要时显示分析状态，内部推理正文仍作为无正文活动信号处理。

助手的 Harness、网关、模型和思考强度可在悬浮窗内设置。修改期间的手动编辑不会自动被覆盖，重复操作不会重复创建草稿，跨窗口的保存冲突会要求重新读取。运行项目的修改通过原有 Workflow 调整机制提交，保留基础版本与安全应用时机。原生文件系统仍只读，禁止 Shell、Skills 执行、业务 MCP 和 Web Search，仅允许专用产品工具；所选 Harness 不能机械保证只读时会拒绝运行。切换 Harness 会更换原生 Session，但保留产品历史。同一会话只允许一个活跃 turn。项目进度由系统根据 Workflow 的当前节点位置计算，Explainer 只解释进度。

### Workspace 与成果完整性

未开启 Git 协作的项目中，Main 和所有 Worker 使用 `${SCIENCEEVOLVE_DATA_DIR}/projects/<project-id>/workspaces/` 下的共享业务 Workspace 与 `Memory.md`；Session、日志和调用级临时目录仍保持隔离。Git 协作项目按组内 Workflow 使用隔离 worktree、发布与集成流程，规则见 [协作组内 Workflow（v3）](openfars-collaboration/scoped-workflow-v3.md)。旧项目的 `<agent>/shared/` 文件原地保留，不自动合并或覆盖。

开启新课题时可选择文件、图片或整个文件夹，也可从本机点击“打开目录”，通过 Windows 文件资源管理器、macOS Finder 或 Linux 系统文件管理器（`xdg-open`）直接向临时 `user_inputs/` 添加文件。服务需运行在图形桌面会话中；打开失败时仍可通过选择文件或文件夹上传。下方默认显示最多五个文件或顶层文件夹，可展开查看其余条目；上传完成或从文件管理器返回页面后会自动更新。文件名按服务所在系统的规则校验，重复上传和删除按实际文件系统的大小写规则处理。创建时文件进入共享 Workspace 的 `user_inputs/`，之后也可继续向该目录添加。所有 Agent 均可读取，原件作为补充资料而非自动发布的成果；单文件上限 50 MiB，单次最多 1000 个文件、总计 200 MiB。

`publish_artifact` 会登记路径、size、producer、invocation、media type、mtime 和 SHA-256。预览、选择展示、读取或下载时重新校验内容；发布后文件被改写会显示完整性错误，生产者必须重新发布。没有 hash 的旧记录保持 legacy/unverified，不能冒充已经验证的成果。

### 运行权限

| 权限 | 行为 |
| --- | --- |
| 当前任务工作区（`workspace`） | 可修改当前任务分配的可信工作目录，其他目录按实际只读授权访问。 |
| 项目内工作区（`compute`） | 可修改当前任务及本项目登记的工作目录，不包含其他项目和受保护系统目录。 |
| 原生完全访问（`yolo`） | 使用所选 Harness 的原生权限模式，受操作系统和当前调用条件约束。 |

这些兼容标识描述文件修改范围；Leader、协调和终态对账调用仍遵守自己的角色授权。名称调整不修改实际目录权限，也不迁移已完成项目。Skill 和业务 MCP 的配置另行处理。

Main 默认使用 `yolo`，Worker 可分别配置。实验执行需要同时满足三层配置：

1. 为实际执行实验的 Worker 勾选“SII 实验工具”（配置字段 `experimentMcp: true`），并使用支持 MCP 的 Harness。未选择时不注入；Main、Leader、协调及终态对账轮次也不获得实验工具。
2. Agent 通过 `sii_read_knowledge` 按需读取原 Inspire 的资源选型、提交、验收和清理知识。新 Execution 模板无需再选择 `builtin:inspire`；旧项目保留该 Skill 仍可使用。
3. 运行 Server 的同一个操作系统用户已完成 Inspire/SII CLI 的账号认证、项目发现和资源上下文初始化。

文件范围与实验选择独立：三档权限都可以显式选择实验工具，工具不会扩大实际授权目录。仅设置 `compute` 或 `yolo` 不会获得 SII 工具，也不会登录或预先申请资源；资源由 Agent 按任务提交。

长实验使用 `sii_submit_experiment`，提交后立即返回，由 Server 的代码监测。Agent 可以继续本任务中不依赖实验结果的工作，也可以调用 `sii_defer_task` 保存自己的续接上下文并自然结束本轮；运行时保留未完成任务、释放模型调度槽位，完成或失败后续接同一原生会话。必需实验未结束或结果未接收时，任务完成和后继路由会被拒绝。Notebook/Ray/Serving 的后台程序需原子写入带本次 `request_id` 和退出码的完成标记，资源 RUNNING 不算实验完成。

完整 CLI 操作经 `sii_command` 执行，批量提交经 `sii_submit_batch` 逐项登记。日志、资源选择、重提和清理由 Agent 按需发起；系统不替 Agent 做科研或路由决策。监测绑定提交时的账号；切换活动账号会暂停该账号实验的有效查询并报告监控异常。工具合同、恢复规则和验收说明见 [SII 实验 MCP](inspire-async-experiments.md)。

在已有 Notebook/Ray/Serving 上运行新程序时，先用 `sii_register_experiment` 登记新的 run_id 和完成文件，再由 Agent 启动后台程序；无需为每次实验重新创建资源。

#### ScienceEvolve 本地绑定

先在 `.env` 中配置 CLI 和本地工作区边界：

```dotenv
SCIENCEEVOLVE_INSPIRE_BIN=/absolute/path/to/inspire
SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT=/absolute/path/containing-your-data-dir
SCIENCEEVOLVE_INSPIRE_CONFIG_PATH=
SCIENCEEVOLVE_INSPIRE_NO_PROXY=
```

把上面的路径替换为本机真实路径；未配置工作区边界时，当前内核回退到 `/inspire/qb-ilm`，该路径不适用于所有安装位置。`SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` 是本机文件系统边界，必须包含实际的 Agent 工作区（通常位于 `${SCIENCEEVOLVE_DATA_DIR}/projects/...`）；它不是 SII 平台上的 Workspace 名称。`SCIENCEEVOLVE_INSPIRE_CONFIG_PATH` 是可选的兼容配置层，不能替代 Inspire CLI 6.x 的账号目录。`SCIENCEEVOLVE_INSPIRE_NO_PROXY` 只补充逗号分隔的直连域名，也不能替代账号登录或平台代理配置。

#### Inspire/SII 账号初始化

以下命令必须由运行 ScienceEvolve Server 的同一个系统用户执行，将 `your-account-alias` 替换为要使用的本地账号别名；账号配置保存在 `~/.inspire/accounts/<account-alias>/`。如果 `inspire` 不在 `PATH`，请把命令替换为 `SCIENCEEVOLVE_INSPIRE_BIN` 的绝对路径。

```bash
SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS=your-account-alias
inspire --version
inspire account add "$SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS"
inspire account use "$SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS"
inspire config check
inspire init
```

然后在 ScienceEvolve 仓库中初始化项目上下文，并明确选择本项目的点券归属：

```bash
cd /path/to/ScienceEvolve
inspire init --scope project --select-project "具有能动性的科学大模型"
```

`inspire account add` 会要求填写平台登录 ID、平台地址和可选代理。登录 ID 是实际 username，不是网页显示名。需要通过 SII Proxy 访问平台时，应把代理写入 Inspire 账号配置；ScienceEvolve 的 compute wrapper 会清除通用 Shell HTTP(S) 代理变量，避免实验命令意外走普通公网代理。

#### Project 与资源条件

当前 ScienceEvolve 实验 Workload 的点券必须归属项目 `具有能动性的科学大模型`。Execution Agent 创建 Notebook、Job、HPC、Ray 或 Serving 时，必须显式使用该 `--project`，不能依赖 Active Project，也不能静默切换到其他项目。

提交实验前先确认账号和实时资源：

```bash
inspire account current
inspire config check
inspire config context
inspire project detail "具有能动性的科学大模型" --workspace "<目标 Workspace>"
inspire notebook quota --workspace "CPU资源空间"
inspire job quota --workspace "分布式训练空间"
inspire resources availability --workspace all --include-cpu
```

每次资源申请都需要五类调度条件：

| 条件 | 含义 |
| --- | --- |
| Workspace | 运行区域，例如 `CPU资源空间` 或 `分布式训练空间`。 |
| Project | 点券归属；当前项目固定为 `具有能动性的科学大模型`。 |
| Compute Group | 具体硬件与调度区，必须使用实时查询返回的完整名称。 |
| Quota | `gpu,cpu,mem` 三元组，必须来自对应 Workload 的实时 Quota 行。 |
| Image | Notebook、Job 或其他 Workload 使用的运行镜像。 |

这些条件没有可安全依赖的隐式默认值。重复使用同一套条件时，可以通过 `inspire <workload> profile set` 保存 Workload Profile，但创建命令仍需显式使用该 Profile。资源可用量会变化，Agent 在每次提交前仍应查询 Quota 和 Availability，提交后继续检查 Events、Logs、Metrics、Instances 和 Status，并清理不再使用的资源。

完整的 Inspire 配置与资源规则见 [安装与账号配置](../.agents/skills/inspire/references/setup/install-and-config.md) 和 [资源与调度条件](../.agents/skills/inspire/references/resources-and-paths.md)。具体命令参数始终以当前安装版本的 `inspire --help` 和子命令 `--help` 为准。

### 前端与反向代理

Vite 开发服务默认监听 `0.0.0.0:5173`，并将 `/api` 转发到 `http://127.0.0.1:4311`。需要覆盖时，在启动命令的环境中设置：

```bash
SCIENCEEVOLVE_WEB_HOST=127.0.0.1 \
SCIENCEEVOLVE_API_URL=http://127.0.0.1:4311 \
npm run dev
```

子路径部署可使用 `SCIENCEEVOLVE_WEB_BASE`。Inspire/Notebook 环境存在 `VSCODE_PROXY_URI` 时，Vite 会自动计算代理前缀。

默认 `HOST=127.0.0.1` 只允许本机访问。若改为 `0.0.0.0`，应在外层反向代理配置 TLS、身份认证和访问控制，不要将管理接口直接暴露到公网。

## 生产运行

```bash
npm run build
npm start
```

生产模式由 Server 在 `HOST:PORT` 同时提供 API 和 `web/dist` 静态页面。修改环境变量、网关或 Harness 可执行路径后，需要重启 Server；项目状态与工作区文件会从 `SCIENCEEVOLVE_DATA_DIR` 恢复。

## 验证

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

更详细的状态机、持久化结构和失败恢复策略见 [docs/architecture.md](architecture.md)。
