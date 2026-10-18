# 上下文分层索引与单次注入预算

2026-10-18 按用户确认的讨论方案实现。设计原文位于 `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/ky26306/temp/md/openfars/openfars.md` 第 16 节，实现和验证记录见第 17 节。当前修改尚未重启部署。

## 直接提供什么

当前研究要求、有效用户纠正、本轮任务、角色权限、验收条件、必须补齐的动作与事实直接完整提供。正在执行、等待处理、重试或未解决的记录属于当前状态，不能因产生时间较早就归为历史。

串行 Inbox 和常驻当前指令都参与最终装配。有限控制修复使用其当前修复指令，原业务任务仍可查阅。发送前追加的通知和配置调整也参与预算，不能绕过检查。

## 历史如何查全

`agent-context-index.ts` 保存不可变详情、完整逐条目录和可逐层展开的目录树。近期逐条，旧记录按稳定批次归组，再逐级合并；默认每批 10 条，发布参数可调整。目录本身也分层限制大小。

每层都提供全部子项及路径，没有隐藏分页或只保留前若干条的查询。完整平面目录保留供审计，普通研究只打开选定树、组和详情。显示元数据允许简化人类名称，但不截断成一个假的 ID；精确元数据和正文保留在原记录中。

`context-index-organizer.ts` 使用一次处理一个任务的后台队列调用 Project Explainer，在新的独立 session 中组织摘要。整理调用复用项目配置的 Harness、模型、网关，只授予上下文只读工具，不接触交互会话或正式研究决策。

代码验证摘要的条目与分组成员精确覆盖来源，拒绝缺失、重复和虚构 ID。来源副本、摘要、冷却状态和成功送达版本存入项目 `runtime/context-index/`，不进入业务 Git 工作区。队列最多 128 个待处理任务，摘要内存缓存最多 2,048 项；失败冷却 5 分钟。未生成摘要时直接使用完整事实目录，业务不等待模型。

同一原生 session 已成功处理且没有变化的来源，下一轮只显示未变化和完整入口。失败轮次不推进送达版本；新 session/generation 重新送达。

## 单次注入怎样限制

`context-injection-budget.ts` 读取选中模型的窗口，限制为 50%。旧 Gateway 快照未存窗口时沿用已有 256 Ki token 默认值。

估算使用 UTF-8 字节上界，同时考虑 NFKD 规范化扩张和协议余量；这是保守准入估算，不是服务商 usage。最终包含任务、应用规则、权限、背景、通知、恢复文字及发送前补充输入；`protocol-router.ts` 再计入协议转换后实际发送的工具定义。

超预算时只把明确标记的背景索引换为更高层目录，不任意裁切当前指令。若必要内容仍超限，返回明确的输入预算错误并拒绝超额转发。发送前拒绝保留健康的常驻进程和原生 session，后续合格输入可以继续；已提交后的失败继续遵守现有执行所有权规则。

助手和摘要提示词明确允许 `read_context` 及本次注入的只读文件工具，禁止业务及修改工具。执行摘要可以在小窗口下把引用正文替换成完整输出文件入口，避免按字符数判断容量。

这个上限只保证本次系统新注入。原生会话历史、模型自身工具循环和 Agent 主动读取由 Harness 自身管理，保留原生压缩。

## 入口与验证

| 范围 | 入口 |
| --- | --- |
| 当前要求与角色 | `prompt.ts`、`harness-runtime/invocation-policy.ts` |
| Workflow 和全部原始资料 | `workflow-context.ts`、`agent-context-index.ts`、`storage.ts` |
| 串行、常驻及最后补充输入 | `harness-runtime/runtime.ts`、`resident-runtime-adapter.ts`、`resident-native-driver.ts` |
| 网关预算与三种模型协议 | `harness-runtime/gateway-route.ts`、`protocol-router.ts` |
| 摘要、新 session 和只读读取 | `context-index-organizer.ts`、`project-explainer.ts`、`internal/shared/project-explainer.ts`、`explainer-assistant-mcp.ts` |
| 回执局部事实 | `terminal-push-coordinator-runtime.ts` |

回归覆盖千条历史的全量遍历、未解决事项、缓存和送达版本、临时快照保留、小窗口拆批、工具路径权限、实际工具定义预算，以及四种 Harness 的发送前拒绝后继续。另用真实安装的 Codex 和本地模拟模型验证原生文件工具能够打开索引与选定详情。

相关 18 个测试文件合计 773 项回归用例通过，另完成 1 项开启原生环境开关的真实 Codex 读取验证。服务端、前端类型检查通过。完整前后端隔离构建回执：`temp/build-checks/check-shVIrN/receipt.json`，原服务构建目录内容及链接未改变。README 未修改，4311 服务尚未重启加载本次改造。
