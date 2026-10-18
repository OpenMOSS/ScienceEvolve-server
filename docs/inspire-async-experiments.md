# SII 实验 MCP：实现与使用合同

[← 返回中文 README](../README_zh-CN.md#configuration) · [English](inspire-async-experiments-en.md) | **简体中文**

本功能已实现于 `server/src/sii-experiments.ts`，并接入普通 workflow 与四种 Harness 的常驻 Agent。平台操作迁到内置 `scienceevolve-sii` MCP，原 Inspire skill 和 references 保留为按需读取的知识及旧项目兼容入口。

## 1. 固定职责

Agent 选择资源、准备程序、提交实验、决定是否继续独立工作、是否让出当前轮次，以及收到结果后的分析、重提、清理和任务完成。系统执行参数化操作、持久化事实、用代码查询状态、投递通知并续接原会话。

提交 MCP 本身不会结束模型 turn、完成任务或改变路由。Agent 主动调用 `sii_defer_task` 后自然结束本轮，运行时释放模型执行槽位，但整个逻辑任务的 Promise 保持未完成。因此既有缺报告/finish_task/Git 的补跑机制只会在最终返回后执行，依赖此任务的后继不会提前放行，其他独立分支可按原规则运行。

平台成功仅意味着实验进入终态。Agent 接收事实并完成自己的任务目标后，再使用原有完成/路由工具。

## 2. 开启方式

1. 运行 Server 的操作系统用户安装并初始化 Inspire CLI，完成账号、workspace 和计费 project 配置。
2. 配置 `SCIENCEEVOLVE_INSPIRE_BIN`；`SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` 必须包含实际 Agent 工作区。
3. 为执行实验的 Worker 显式选择“SII 实验工具”（`experimentMcp: true`）。文件范围可选 `workspace / compute / yolo`，与实验工具分别配置；未选择的 Agent 以及 Main/Leader/协调/终态对账轮次不提供 SII。未配置该字段的旧配置不会自动授权。
4. 可设置 `SCIENCEEVOLVE_SII_REFRESH_MS`，默认 30000 毫秒，最小 1000 毫秒。系统串行查询活动实验，单次 CLI 调用有超时，失败后退避，最长 300 秒。

每个实验另有 `check_interval_minutes`，用于唤醒等待中的原 Agent 检查实验进展，接受 5–60 的整数，默认 5 分钟。这与后台平台状态查询间隔独立：实验提前成功、失败或取消时，在监测到终态后立即通知，不等检查间隔；运行不到 5 分钟的实验也按此返回。

新 Execution 模板不再默认加载 `builtin:inspire`。旧项目可保留该 skill；兼容 wrapper 仍存在，但新的异步会话通知以 MCP 登记的实验为准，不能根据旧账本猜测原 Agent 会话。

内置 `scienceevolve-sii` 的地址只由 runtime 为当前调用生成，不接受同名自定义远程或项目 MCP。文字与各级画布配置、Main 提案、保存/加载共用 `experimentMcp`；不会根据指令关键词或权限名称隐式启用。

本地 SCP 上传/下载、Notebook artifact 下载、CLI 文件选项遵守同一 invocation 的文件范围；resident 使用原文件 broker 的可信项目 worktree 登记。错任务目录、越范围、symlink/hardlink 别名拒绝；完成文件仍限定在原任务目录且必须匹配本次 run_id。远端资源及科研命令由 Agent 选择，系统不解析命令文本替它安排实验。

`yolo` 的 Harness 原生工具沿用其原生/OS 权限合同；SII 业务 MCP 的本地传输仍检查授权路径。其当前已分配 worktree 即使位于服务用户主目录外也可正常上传/下载，服务用户根仍按可信绑定使用；其他任务目录、受保护状态、路径穿越和文件别名不会因 `yolo` 被跳过。受保护文件也不能作为上传源。

CLI 以 `execFile` 和字面参数数组执行，不经 shell 展开；沿用 `--no-env-file --json`、可选全局配置、代理处理、指定计费项目和共享路径约束。配置里不要手工覆盖保留名称 `scienceevolve-sii`。

已兼容 CLI 的进度文字加 JSON 返回，以及连接准备等只返回文本的成功操作。普通命令保留实际文本和退出码；资源提交及实验状态查询仍须得到 JSON 事实，不能把一段成功进度文字当作实验提交或完成证据。

Notebook CLI 默认等待资源启动，而且配置里的 post-start 动作会强制等待。MCP 创建时统一追加 `--no-wait --post-start none`；显式 post-start 脚本/动作会在远端提交前被拒绝并提示分阶段执行。先提交资源、defer 至 `resource_ready`，再自行配置连接、登记并启动后台程序。这样既保留原平台能力，也避免把隐藏的 CLI 等待带回提交调用。

Codex 的普通和常驻入口只对运行时注入、URL 匹配当前可信绑定的 `scienceevolve-sii` 设置工具自动批准；其他外部 MCP 的授权规则保持原合同。仅使用相同名称不能获得这一授权。原生配置说明见 [Codex 配置参考](https://developers.openai.com/codex/config-reference/)。

## 3. 实际工具

| 工具 | 合同 |
| --- | --- |
| `sii_command({args})` | 一次性 CLI 操作：帮助、账号/context、资源、Notebook exec/scp、镜像、模型、诊断和清理。创建会转入登记流程；拒绝 follow/watch/wait 等等待形式。 |
| `sii_submit_experiment({args,request_id,completion_file?,required_for_task?,check_interval_minutes?})` | 提交单个 job/hpc/notebook/ray/serving create，记录监测，返回当前事实和说明。默认结果是本任务必需输入；可指定原 Agent 定时检查间隔。 |
| `sii_register_experiment({kind,name,workspace,request_id,completion_file?,required_for_task?,check_interval_minutes?})` | 在已有且已确认可供本任务使用的资源上登记实验监测；不创建、重启或自动启动程序。 |
| `sii_submit_batch({experiments})` | 逐项执行同样的提交合同，包括各项自己的 `check_interval_minutes`，返回每项的成功、明确失败或结果不明；Agent 指定所有资源和参数。 |
| `sii_get_experiment({experiment_id})` | 读取本任务拥有的持久状态，不阻塞等待、不自动调用模型；原生 Session 实际收到终态工具结果后才确认接收。 |
| `sii_defer_task({experiment_ids,context,check_interval_minutes?})` | 保存 Agent 自己的续接上下文和所需实验，立即返回“任务未完成”收据；可统一调整所列实验的检查间隔，省略则保留各自配置；Agent 随后自然结束本轮。 |
| `sii_read_knowledge({path?})` | 无 path 时列出原知识文档；用 `SKILL.md` 作为入口，按需读取 references。 |

`sii_command` 的日志/事件/指标查询代替专门的输出读取工具。原 CLI 的资源批量创建改用 `sii_submit_batch`：每项都有独立稳定键和会话归属。原 CLI batch 的帮助和 dry-run 仍可查询。

所有 create 显式提供 `--name`、`--workspace`、`--project 具有能动性的科学大模型`。提交使用稳定 `request_id`；响应丢失后使用同一 ID 和同一参数读取原收据，不重新申请资源。新的实验使用新 ID 和唯一名称。同一 ID 改资源提交参数会拒绝，同一项目账本中的同名账号/类型/workspace 任务会拒绝重复创建。检查间隔不参与资源提交身份：同一 ID 可显式调整未结束实验的间隔而不重复创建；重放时省略间隔则保留原配置和期限。

返回包含 `experiment`（ID、状态、runId、原会话和提交归属）、`monitoring` 和自然语言 `message`。提交已确认、平台明确拒绝和提交结果不明分别返回真实情况。返回说明告知 Agent 可继续独立工作或主动暂存，不替 Agent 作出该选择。

示例（资源参数仍须由 Agent 根据实时发现补充）：

```json
{
  "args": ["job", "create", "--name", "training-a", "--workspace", "训练空间", "--project", "具有能动性的科学大模型", "--command", "python train.py"],
  "request_id": "training-a-v1",
  "check_interval_minutes": 10,
  "required_for_task": true
}
```

收到 `experiment.id` 后，需要让出执行时调用：

```json
{
  "experiment_ids": ["exp_..."],
  "context": "任务尚未完成。检查当前日志与指标，比较 baseline；实验结束后验收 metrics.json，并决定是否需要补充实验。"
}
```

此工具立即返回。Agent 再自然返回 pending handoff，不调用 finish_task 或后继路由。系统保存并回传该 handoff 和上下文。

首次检查从实验登记时计时，重复保存等待上下文不会延后期限。到点后，系统以明确的“定时检查”通知续接原 Session；Agent 使用 `sii_command` 查看实际日志、指标，自行决定继续、调整或停止。继续等待时再次调用 `sii_defer_task`，可传入例如 `check_interval_minutes: 15` 调整下一次检查。间隔与下次期限持久保存，服务重启后保留；定时检查本身不会确认实验完成或放行后继任务。

复用已有 Notebook/Ray/Serving 的程序按此顺序执行：确认资源账号/workspace/项目归属 → `sii_register_experiment` 登记新的 request_id 和完成文件 → `sii_command` 启动 Agent 自己准备的后台程序 → 继续独立工作或 defer。同一资源可以登记多个实验。已有文件若含本次 run_id，或该完成路径/run_id 已用于另一任务，会拒绝登记，要求新的 run_id。

## 4. 任务完成约束

`required_for_task` 默认 true。必需实验仍在运行、状态不明或终态结果尚未接收时，运行时在原完成控制动作的副作用之前拒绝 finish_task/route_to_agent/complete_project/complete_group，并说明原因。直接返回一个最终结果也需通过相同检查，不能绕过约束。

进入系统等待时只关闭 MCP 工具访问，任务完成门禁持续保留；它在逻辑任务结束或取消、绑定关闭时才释放。真实验收增加了等待期间的完成动作检查，避免只在模型轮次活跃时验证这一约束。

系统通知在原持久 Session 的实际原生 `user.message` 完整包含本批通知后确认送达。普通 Codex `exec` 不发出该事件时，既有完成门禁可做一次受限只读核对：只查该 Agent 的项目内隔离 CODEX_HOME、准确线程的原生 rollout，要求 session_meta 的线程/cwd/source 匹配，并找到完整包含本批通知的原生 user response_item。账本记录来源、文件相对位置、字节偏移、摘要和原生时间，不合成官方事件，不读取推理或借用其他线程。目录查询上限4096条，文件只读64KiB首段和8MiB尾段；缺失/歧义/截断/未完整写入/链接均保持未确认。

普通 Adapter 与常驻入口均通过私有观察接收完整脱敏原生 user 输入，显示事件继续使用原有长度限制。普通 Claude 选择 SII 时使用官方 stream-json 输入及 `--replay-user-messages` 回显，一次发送一个准确 Session 的 user frame；原生回显实收后才确认通知。该回显不等于模型已理解或科研成功。

准备通知、输入排队或模型返回均不算实收。原实验账本保存对应 event、invocation、原生证据与 Session 证明；普通入口和常驻入口均保留完成门禁。每条结果完整放入有限通知，放不下的结果列出 ID，保持未确认，由 Agent 使用 `sii_get_experiment` 读取。后续是否达标由 Agent 判断；系统不进行科研验收，也不能证明 Agent 的语义理解，Agent 仍须按任务要求显式完成。

同步 `sii_get_experiment` 也遵守这一门禁：MCP handler 只保存待接收快照与结果标记，不能因为响应已生成或 socket 已写入就确认。运行时匹配当前原 Session、invocation、真实工具调用和实际原生完成事件中的标记，再记录 `native_tool_result` 回执；Claude 的无名称结果帧通过先前真实工具调用 ID 关联。重复 content/structuredContent 中的同一标记可去重，不同结果标记、错误 Session、旧调用或失败事件不能确认。若断连或服务重启后仍未实收，复用既有等待/通知流程在同一原 Session 补送终态事实，不重新提交实验。

旧版本仅有 `acknowledged:true`、缺少原生实收回执的记录不能放行当前未完成任务。该原任务被正常调用时，代码仍要求准确原 Session，并通过现有通知补送终态事实；后续真实回执成立后才确认。没有全账本历史迁移或自动重开已完成项目，其他任务的旧记录保持原样。

实收证明到原生 CLI 的工具结果边界为止。CLI 可能压缩模型上下文，或像 Claude 一样把较大输出保存为原会话文件并向模型提供摘要及路径；回执不证明 Agent 已读取完整证据或理解结果。Agent 仍须通过实际文件/工具读取完成科研判断；受控 provider/平台测试也不能替代真实实验验收。

多个实验中任意一个到达检查期限、结束或出现持续监控异常即可唤醒。其他必需结果仍未到达时继续阻止完成；Agent 处理进展和已到达事实后可以再次 defer 等待剩余结果。

`required_for_task:false` 用于资源启动、长期服务或明确只要求提交收据的委派。它不表示依赖实验结果的任务可以提前完成。任务已完成或项目已取消后，系统不自动重开 workflow；资源仍由 Agent 或用户按既有流程清理。

Notebook/Ray/Serving 的资源启动声明 false 且无完成文件时，代码监测到 RUNNING/READY 会发送 `resource_ready`，证据明确标注 `completion_scope:resource_startup`。Agent 可 defer 等这条通知，再自行登记并启动实际科研程序；该通知只结束资源启动观察，不声称科研实验成功。

## 5. 状态与完成文件

| 类型 | 系统读取的事实 | Agent 负责的部分 |
| --- | --- | --- |
| Job/HPC | CLI 的明确成功、失败或取消终态 | 实际产物验收、日志分析、后续实验与清理 |
| Notebook/Ray/Serving | 资源失败/取消，或本 run 的完成文件 | 准备后台程序、写退出信息、业务验收与资源复用 |

Notebook/Ray/Serving 的 RUNNING/READY 不是实验完成。结果必需时必须提供 `completion_file`，位于当前 Agent 的真实工作目录内；系统只读取普通文件，限制大小并检查路径。Agent 准备程序原子写入，例如先写同目录临时文件再 rename：

```json
{"run_id":"training-a-v1","exit_code":0,"result_path":"results/metrics.json"}
```

`run_id` 必须等于该次提交的 `request_id`。退出码 0 表示程序成功，其他整数表示失败；旧 run 的标记不触发新实验。长时间运行的 notebook/ray/serving 仅创建资源时可声明 false，具体科研程序仍需 Agent 自己安排。

未知平台状态保持 unknown；一次查询错误不会被判作实验失败。连续三次查询失败向等待任务投递一次监控异常通知，代码继续退避查询；同一持续异常不反复唤醒模型，成功查询后重置异常周期。

## 6. 持久化、会话和生命周期

每项目 `runtime/sii-experiments.json` 保存实验、原 Harness/native SessionRef/generation、task/execution 归属、工作目录、账号、workspace、run ID、查询证据和未完成任务收据。写入通过项目内串行队列和临时文件 rename；远端 create 前先保存意图，结果不明先核对同一名称，不自动重提。

监测不依赖 MCP 客户端连接或模型进程。Server 启动扫描项目账本恢复查询；只用代码等待，不启动模型来维持监测。MCP 新建的 Workload 也登记到原 `inspire-workloads.jsonl`，继续参与现有用量统计；复用资源保留原有登记。CPU 监测不受 GPU collector 的过滤规则影响。

通知附带持久 event ID、真实观测、Agent 原上下文和 handoff。普通 workflow 在等待时释放全局模型调度槽位，事件到达后重新公平排队。常驻 Agent 在物理 turn 之外等待，允许原有 pause/resume/close，同时保持同一个逻辑 submit。

两条路径都串行续接原 session、generation 和工作目录；不会开一个替代会话来完成该任务。通知续接失败时保留未确认事件。事件在续接 turn 结束前保留为 ready，重启可重放；最终逻辑任务返回后清除等待收据。外部平台和模型副作用不具备绝对 exactly-once 保证，因此 Agent 的续接处理应利用已有文件和提交 ID 避免重复操作。

普通与常驻 DSH 共用受信 SDK 插件，通过官方 Agent resume API 加载原生会话。普通调用验证原持久文件后，先发送准确 session/resume 并校验返回的 Session ID 与最后原生序号，再发送当前 prompt；旧恢复状态不会满足本轮 idle 等待。仅复用 session/prompt 的 ID 不能证明已加载原历史。恢复身份或序号不符时保留原 SII 会话与未确认结果，不通过替换 Session 完成通知。

运行中的 Agent 不被实验事件打断，事件保留至其主动 defer 后的安全边界。暂停遵守原调度/进程暂停规则，恢复后再执行模型；取消/关闭中止本地等待而不自动重启 workflow，也不替 Agent stop/delete 平台资源。

当前 CLI 使用活动账号存储。提交记录固定读取 `~/.inspire/current` 的别名，显式账号参数须匹配；监测发现活动别名改变会报告查询异常，不在错误账号下读取同名任务。恢复对应活动账号后继续监测。本次不虚构尚未验证的逐任务多账号 CLI 参数。

## 7. 原能力映射

| 原知识/功能 | 新入口 |
| --- | --- |
| account、配置、context、初始化与安装知识 | `sii_command` + `references/setup/install-and-config.md`；交互认证由运行 Server 的系统用户预先完成 |
| project/workspace/group/quota/availability、共享盘、网络及选型 | `sii_command` + `references/resources-and-paths.md`、`references/paths.md`、`references/network-and-sources.md` |
| Notebook 创建、exec、scp、日志、连接与复用 | `sii_submit_experiment`/`sii_register_experiment`/`sii_command` + `references/notebook.md` |
| Job/HPC/Ray/Serving、Profile、批量资源与生命周期操作 | `sii_submit_experiment`/`sii_submit_batch`/`sii_command` + `references/compute-workloads.md` |
| 镜像、模型仓库、结果验收和清理 | `sii_command` + `references/image-management.md`、`references/model.md`、`references/workflows.md`；保留 Agent 决策 |
| 长实验观察、Notebook Sentinel | 系统 monitor + `sii_defer_task`；Agent 按需做一次性诊断 |

主 skill 与 Notebook 文档中的模型轮询说明已更新。其余操作规范和领域判断不删减，也不把全部 references 塞入每次模型调用。

## 8. 验证与部署边界

测试覆盖真实 MCP 客户端、创建去重/响应丢失、状态错误与 CPU/HPC、旧完成文件、监控异常去重、任务归属、提交后完成限制、原 GPU 登记链路、Server 重启和原会话保留。普通 Harness 测试验证中间 turn 不成为最终任务；四类 fixture 原生进程验证常驻暂停及同进程/会话续接；调度器测试验证释放槽位和公平续接。

本次验收：前后端类型检查、完整构建通过；SII、Harness、四类常驻进程、Main、调度队列、调用策略和模板的 279 项相关回归通过；更新后新建项目页面的 48 项测试通过。全量扫描发现的旧模板断言已同步修订。复杂嵌套流程触及默认 5 秒测试时限，使用 15 秒 runner 时限后通过；全量高负载下的一项 watchdog 时序断言也在上述相关回归中通过。业务运行时的超时设置未放宽，不把最初的全量扫描报告宣称为全绿。

复核命令：

```bash
npm run typecheck
npm run build
npm run test -w server -- tests/sii-experiments.test.ts tests/harness-runtime.test.ts tests/resident-adapter-factory.test.ts tests/orchestrator-main.test.ts tests/orchestrator-queue.test.ts tests/invocation-policy.test.ts tests/validation.test.ts --maxWorkers=2 --testTimeout=15000
npm run test -w web -- src/pages/NewProjectPage.test.tsx
```

代码和 fixture 验证本地提交、等待与会话续接机制；真实平台验证的范围单独记录。

### 本环境 CLI 配置与真实查询（2026-10-07）

已恢复可用的 Inspire CLI，沿用原部署的 6.2.0 版本和 Playwright 1.62.0，在当前工作区建立 Python 3.12 虚拟环境。原安装的入口指向迁移前目录，虚拟环境的解释器也不匹配；本次重新建立运行环境，不覆盖原部署。

- 终端入口：`/usr/local/bin/inspire`。
- 项目入口：`/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/ky26306/.tools/inspire/bin/inspire`。
- 账号：当前系统用户的 `~/.inspire` 链接到原部署 `openfars/.home/.inspire`；按用户要求新增并切换到活动账号 `ky26306`。密码仅保存在该账号目录，配置文件与会话文件权限均为 `0600`，未写入仓库、命令参数或验证记录。
- 浏览器：复用原部署的 Chromium，并安装实际缺少的系统动态库。当前环境可直连 SII，CLI 启动器清除通用 HTTP(S)/ALL 代理；账号配置里的专用代理仍由 CLI 自身解析。
- Notebook 连接：从平台共享的官方 bootstrap kit 安装本地 rtunnel，`~/.local/bin` 指向工作区 CLI 目录。独立生成的 SSH 密钥存放在 `.tools/inspire/ssh`，私钥权限 `0600`，链接到原先不存在的默认密钥路径，供 CLI 的连接自检和自动恢复使用；没有覆盖已有密钥。
- `main-fix/.env` 已配置 CLI 绝对路径、`/inspire/qb-ilm2` 工作区边界、SII 直连域名和 30 秒后台查询间隔；该文件被 Git 忽略。

已实际运行 `--version`、`--help`、`config check`（`auth_ok=true`）、全部 workspace 的项目和 Notebook 查询，并通过真实 MCP 客户端调用本服务的 `sii_command` 完成认证检查。Notebook 的真实状态查询与本服务状态归一化已验证。

原账号 `sii` 看不到代码固定要求的 `具有能动性的科学大模型`。用户指定切换到 `ky26306` 后，已完成账号登录和项目/compute group 初始化，真实项目查询确认所需计费项目可见，因此保留原项目约束。初始化漏填的 Docker Registry 已依据该账号实时查询到的官方镜像 URL 补齐为 `docker.sii.shaipower.online`，不是从旧账号推断。

再次通过真实 MCP 客户端验证：活动账号为 `ky26306`、认证身份与指定账号一致、`auth_ok=true`、所需计费项目可见。验证记录保存在工作区 `.tools/inspire/account-verification.json`，不含凭据。账号配置阶段仅做本地初始化和查询；后续真实实验联调的结果与资源清理单独记录。

### 可重复的真实验收

仓库根执行 `node server/live-sii-acceptance.mjs` 仅显示测试范围；加 `--run` 才执行真实测试。脚本使用当前配置的 CLI、`ky26306` 账号、已有 AIGW 网关的 `kimi-k3` 模型和原生 Codex，创建隔离的本地测试项目与一个临时 Notebook。它查询该账号实时 CPU quota，使用原 `openfars` Notebook 正在运行的官方镜像，但不修改原 Notebook。

测试 Notebook 为 1 CPU / 4 GiB，按默认 30 秒代码查询间隔运行。测试驱动预先准备程序和工作文件，原生 Agent 负责资源提交、实验登记、后台启动、defer、接收结果和停止资源。实际程序分别原子写入退出码 0 和故意失败的退出码 7；后台启动命令整体分组，避免 CLI 的 `cd … &&` 前缀让 SSH 等待程序退出。公钥可通过 `SCIENCEEVOLVE_SII_TEST_PUBLIC_KEY` 指定，本环境默认使用工作区 `.tools/inspire/ssh/id_ed25519.pub`。

脚本检查真实提交、资源就绪、实验成功/失败、原生 Session 与 generation 连续性、未完成逻辑任务、必需结果到达前的完成限制、等待期间模型请求计数不变以及最终等待收据清除。`finally` 只停止本轮唯一名称的测试资源，并在平台确认 `STOPPED` 后才算释放成功；停止失败或超时会使验收失败。报告与原生事件保存在 Git 忽略的 `temp/sii-live-*/`，不把网关凭据写入脚本或报告。

结果已接收后，模型偶尔只描述下一步收尾而没有执行。验收驱动对此最多追加一次明确收尾请求，保持原 taskSessionId、原生 Session、generation 和工作目录，不重新申请资源。这是结果到达后的验收收尾，不参与实验状态轮询；科研目标的语义验收仍由既有 workflow 完成检查负责。

原生 MCP 授权修复后，`codex-runner`、四类常驻入口以及 SII 服务的 3 个测试文件共 131 项回归全部通过。补齐系统等待期间的完成门禁及 CLI 文本返回兼容后，SII 服务、普通 Harness、调度队列和四类常驻入口的 4 个测试文件共 182 项回归全部通过；前后端类型检查和构建通过，最终修改后再次构建服务端通过。真实验收只覆盖 CPU Notebook 路径；Job/HPC/Ray/Serving、批量部分失败和常驻 Harness 生命周期的覆盖仍来自回归，不能据此声称所有资源类型都已线上实测。

### 最终真实记录（2026-10-07 UTC）

最终测试资源为 `sii-mcp-muyaygbk`，账号 `ky26306`，1 CPU / 4 GiB。原始记录位于 `temp/sii-live-2026-10-07T16-08-53-786Z/`。

| 检查 | 实际结果 |
| --- | --- |
| 提交与启动 | 提交返回 queued，系统查询后投递 resource_ready |
| 资源等待 | 49.6 秒，模型请求计数 6 → 6 |
| 真实实验等待 | 两项必需实验仍为 running 时主动 defer；等待 70.9 秒，模型请求计数 11 → 11 |
| 完成限制 | 系统等待期间尝试 finish_task，实际被拒绝 |
| 成功与失败 | 新 run_id 的原子完成文件分别记录退出码 0 和 7；两项结果 sum_squares 均为 285 |
| 分批结果 | 先收到 succeeded、另一项仍 running；Agent 再次 defer，随后收到 failed |
| 会话连续性 | 所有续接与收尾复核使用同一原生 Session，generation 为 0 |
| 资源释放 | 测试驱动确认 STOPPED；同会话 Agent 再通过 MCP 查询确认 STOPPED |
| 最终状态 | 必需结果全部确认接收，等待收据清除，原 Notebook 未被操作 |

原验收脚本要求固定的英文收尾标记；本轮 Agent 在主链路完成后只返回“准备停止资源”，因此原始 `report.json` 保留其严格失败记录。随后使用同一 Session 追加收尾复核，实际执行两次 `sii_get_experiment` 和一次 Notebook status MCP 查询，并返回包含退出码 0/7 和 STOPPED 的结论；没有新增或启动资源。合并事实验证和收尾复核后的 `verified-result.json`（验收环境中被 Git 忽略的本地记录） 为 `passed:true`，原始严格报告未被改写。可重复脚本已加入同样的最多一次收尾续接，通过标准以程序事实、会话连续性、门禁、等待和资源释放为准。

联调中实际修复了 Notebook 隐含等待、Codex 内置 MCP 审批、系统等待阶段的完成门禁释放以及 CLI 进度/文本返回兼容。只读预检查遇到 HTTP 429 时由代码间隔 30 秒重试，创建不自动重提。隔离环境中的原生本地 Shell 出现 bubblewrap 只读锁错误；验收使用预先准备的程序，Agent 的平台操作由 MCP 完成。此次未重启生产 Server，也未进行 UI 全流程部署验收。
