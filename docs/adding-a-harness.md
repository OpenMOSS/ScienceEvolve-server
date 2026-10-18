# 新增 Harness

[← 返回中文 README](../README_zh-CN.md#configuration) · [Harness 运行时](../harness/README.md) · [English](adding-a-harness-en.md) | **简体中文**

OpenFARS 使用代码级 Adapter 注册，不支持从请求或磁盘动态加载任意第三方插件。
新增 Harness 的扩展契约是：实现一个自带 `HarnessDescriptor` 的 Adapter，然后在
应用组合根通过 `additionalAdapters` 注册这一个对象。Registry、Catalog、Gateway
矩阵和前端都从该对象的 descriptor 派生；Orchestrator、Project Explainer、
Protocol Router 和 React 页面不应修改，也不应新增 Harness ID 分支。

## 1. 在 Adapter 上声明能力与元数据

Adapter 的 `descriptor` 是扩展 Harness 的唯一注册载荷。`registry.ts` 中的表只维护
仓库随附的内置 Harness；新增代码级 Adapter 不需要再向 Registry 复制一份元数据。
descriptor 应满足：

- `id` 使用 1–64 位小写安全 ID；不得复用已有 ID。
- 声明 label、Adapter 版本、原生协议、可执行环境变量和默认命令。
- 明确 `workflow`、`explainer`、`probe` purpose。只有能兑现严格只读语义的
  Adapter 才能声明 `explainer`。
- 正式 Adapter 必须支持 durable session 和官方结构化事件；能力字段必须反映
  实际实现，不能为了显示为“可用”而虚报。
- 扩展 Adapter 不得声明 `default: true`；生产 Registry 已有且只能有一个默认项。

`capabilities.explainerInputFormats` 声明只读 Explainer 实际接收的资料格式，可包含
`text`、`image`、`pdf`，必须包含 `text` 且不得重复。省略时按仅文本处理：上传或
暂存了二进制文件不等于模型已经读取内容。推荐服务按此元数据提示不可读附件，
不按 Harness 名称猜能力；声明格式也不替代目标网关/模型上的真实资料验收。

注册时 Registry 同时校验 ID 唯一性、descriptor 冲突、purpose/能力一致性以及正式
Harness 所需的 durable session/official event 能力。Catalog 随后自动发布前端安全
投影；可执行路径、环境变量名、路由细节不进入浏览器。前端从 Catalog 生成选项、
标签、可用原因和原生协议，不得在页面中新增 Harness 常量。

## 2. 实现 Adapter

在 `server/src/harness-runtime/adapters/` 新增 Adapter，并实现
`HarnessAdapter`：

1. 解析可执行入口并生成可执行文件指纹。
2. 将统一 `InvocationSpec` 编译成 CLI 原生参数、允许的环境增量和临时配置。
3. 实现原生 session create、resume ID 校验以及兼容期 legacy ID 双写转换。公共
   `SessionCoordinator` 和 SessionRef 校验器负责持久化对象的 schema、Harness、
   Adapter 版本、generation 与 durable 一致性；Adapter 只负责原生 ID 格式。
4. 只使用 `context.processHost` 启动 CLI。它是 Facade 为当前 invocation 绑定好的
   `InvocationProcessHost`，统一持有取消信号、进程树/marker 生命周期、环境权威边界
   和 invocation 级恢复预算。Adapter 不得构造或持有 `CommonProcessHost`，不得调用
   `recoveryBudget.startAttempt`，也不得自行 `spawn`；每次原生进程启动由公共宿主自动
   记一次预算。Pi MCP 子进程桥是唯一明确的 Adapter 内部子进程豁免，且只能注入
   明确 allowlist 环境，不能展开整个 `process.env`。
5. 通过 `OfficialEventBridge` 消费 CLI 官方 JSONL、stream-json 或 SDK event。
6. 把官方字段浅映射为 assistant、tool、usage、activity、diagnostic 事件。

`LaunchPlan` 必须使用绝对可执行路径、当前 invocation 的 workspace 作为 cwd、当前
SessionRef、有限日志尺寸，以及公共运行时生成的环境。Adapter 自有的非敏感环境键
必须列在 `adapterEnvironmentKeys` 中；Gateway token、控制 capability、项目/Agent
身份和工作区路径由公共宿主逐项核对，Adapter 不能覆盖或额外泄露宿主凭据。

Adapter 不解析自然语言或 stderr 来猜工具调用，不重放模型 tool call，不自行执行
模型决定的工具，也不存储隐藏 reasoning。工具输出预览必须走公共脱敏与 40,000
字符截断。官方事件通道损坏时应失败并返回稳定错误。

所有 invocation 都从公共输入层获得工作区内的只读 Inbox 镜像和 `Memory.md`
路径。Adapter 收到的是裁剪后的调用视图：看不到 `messages/` 中的权威 Inbox 路径、
原始 Gateway 凭据、其他 Agent 配置或宿主侧 Skill 路径，也不能把镜像作为恢复或
下游派发的事实来源。Main 永久 durable；Worker 服从 `sessionPersistence`。resume
失败只能在同一个 Harness 创建下一 generation，不能切换 Harness。

若 CLI 没有原生 user-input 事件，可选实现 `readNativeNotification`，在有界范围内
核对当前 Agent、工作目录及准确持久 Session 的可见原生 user 输入，返回
`NativeInputHistoryEvidence`（相对路径、真实字节偏移、行摘要和时间）。原生格式解析
留在 Adapter 内，不能读宿主其他会话或隐藏 reasoning。Facade 仅将所选 Adapter 的
该能力接到通知实收门禁；未实现、证据不匹配、原调用未合法续接时不能自动确认。

## 3. 在组合根注册一次

在创建 Facade 的应用组合根把 Adapter 对象放入 `additionalAdapters`：

```ts
const runner = new HarnessRuntimeFacade({
  // 其他公共运行时选项……
  additionalAdapters: [new ExampleAdapter(exampleOptions)]
});
```

这就是唯一的生产注册点。不要同时改 Registry、Gateway Acceptance、业务调用方或
前端，也不要从 Adapter 外部按 Harness ID 选择参数。`adapters` 选项会替换全部内置
Adapter，只用于隔离契约测试；生产扩展使用 `additionalAdapters`，保留所有内置项。
Facade 只构造一个 `CommonProcessHost`，再按 invocation 向每个 Adapter 注入绑定后的
`InvocationProcessHost`。

## 4. 兑现真实 smoke 契约

任何要供工作流选择的正式 Adapter 必须同时支持 `probe` purpose。仅服务于其他
purpose 的 Adapter 不会进入默认 Gateway smoke 矩阵。公共 smoke 流程会创建隔离
临时项目和共享工作区，通过 Facade 的公开 `runSmoke` 路径真实启动该 Adapter 的
CLI，要求它用原生只读工具读取固定 sentinel，并核对同一 call ID 的官方
tool.started/tool.completed 事件以及包含 sentinel 的最终 handoff。route probe 只证明
协议线路可用，不能替代真实 Adapter smoke。缓存身份自动包含：

- Harness ID 与 Adapter 版本；
- 可执行文件指纹；
- model、Gateway ID/revision/protocol；
- 原生协议与 Router 兼容版本。

## 5. 增加官方事件 fixture 和契约测试

在 `server/tests/fixtures/harness-events/` 增加脱敏的官方事件 fixture。fixture 只能
包含合成 ID、路径、输入和输出，不能包含用户 Prompt、凭据、真实路径或隐藏思维链。

把 Adapter 接入 `harness-runtime-contract.ts` 的同一组断言，并至少覆盖：

- tool started → updated/result → completed/failed 的稳定 call ID；
- assistant handoff、usage、活动心跳、损坏事件流和空结果；
- durable create/resume、ephemeral、同 Harness replacement generation；
- Main/Worker 对 Inbox 与 `Memory.md` 的真实读取；
- workspace/compute/yolo Prompt 与 CLI 原生权限不回退；
- 取消、异常退出、日志上限、脱敏、截断和孤儿清理；
- sentinel smoke 确实启动目标 CLI。

另用测试用第五个 Adapter 通过 `additionalAdapters` 注册，验证它与四个内置项同时
存在，且 Catalog、Gateway matrix、配置校验和 canonical UI 无业务分支即可自动
工作。测试还必须直接覆盖 Facade 的公开 `runSmoke`，而不只是调用 Adapter 或伪造
route probe。删除测试 Adapter 后，带该 ID 的历史项目仍应显示为“不可用”，不能
被替换为默认 Harness。

若新增 `explainer` purpose，还必须增加真实的负向边界测试：快照内读取成功，而
原工作区、兄弟目录、用户目录、系统文件和经 symlink 逃逸的读取均失败，任何写入
也失败。Prompt 中写“只读”或仅启用允许全盘读取的 read-only 模式都不构成能力
证明；无法兑现时应从 Catalog 移除该 purpose 并 fail-closed。

架构守卫还应保持：只有 `harness-runtime/runtime.ts` 能构造
`CommonProcessHost`；具体 Adapter/Codex CLI driver 不直接记恢复预算、不持有通用
宿主；除 Pi MCP 桥外不得导入 `node:child_process`；业务层不得出现字面 Harness ID
分支。

## 6. 验证

先运行标准离线验证：

```bash
npm run typecheck
npm test
npm run build
npm run acceptance:gateway:plan
```

真实 Gateway Acceptance 会产生外部请求和费用，只有在明确授权、确认目标网关与
模型后才运行 `npm run acceptance:gateway`。验证使用隔离端口和隔离 data 目录，
不得复用正在运行的 4310 项目数据。
