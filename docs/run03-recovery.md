# run03 第 16 节修复记录

[← 返回中文 README](../README_zh-CN.md) · [English README](../README.md)

基线：`923d354`（2026-09-22 拉取的 `origin/main`）。范围是 `openfars2.md` 第 16 节，前文 OF2-001/002 等旧问题不作为本次新修复项。

当前状态：本轮实现已提取至独立 PR 分支 `fix/run03-afg-recovery`，不代表七项问题均已定位或解决。A 按用户选择保留 Main 自动兜底：正常路由不补调，Worker 漏路由才补一次，仍失败则由 Main 接手；已移除额外固定 60 秒超时，保留完整交接内容，并纠正“业务已完成”的提示措辞。B 尚未定位独立根因；C 按用户要求完全搁置，后续遇到具体故障再逐案处理；D/E 新增的文件约束、环境预检查、累计预算和无进展自动取消机制已按用户要求回滚；相关参数和专项测试已移除。F/G 保留现有修改。另一任务的上下文压缩和上下文限制处理未包含在本 PR 中。

## 对照清单

交接范围：用户将 B/C/D/E 交由持有完整运行记录的人处理。本地没有保留 B/C 的独立修复：通用 session resume/replacement、断流重试、Harness 超时及错误映射未作本轮修改；D/E 新增机制已回滚。保留的会话续接与精简上下文只服务于 A 的补路由流程，不代表修复了 B。接手者应以实际运行记录重新定位 B/C/D/E，不将本轮的 A/F/G 测试当作这些问题的复现证据。

| 条目 | 本次处理 | 边界 |
| --- | --- | --- |
| A：业务返回与路由缺失耦合 | Worker 漏路由时追加一次 decision-only repair；仍缺路由或补调异常则由 Main 用精简上下文选择原候选边，保留工作区和完整 handoff。事件不再将这一情况描述为 failure limit。`routeRecovery` 单独记录 repairing / awaiting_main / repaired。 | 正常路由不增加补调；一条强边仍沿用现有确定性路由。修复回合撤去工作区 MCP、额外 MCP、Skills、搜索配置；沿用既有 Harness 超时和取消机制。Main 自身仍遵循现有有限恢复规则，不保证模型持续失败时也能推进。 |
| B：会话恢复不保留进度 | 仅有 A 场景的精简上下文改动，不计作 B 的独立修复。 | 当前 Facade 替换会话时已复制项目状态、复用工作区和控制上下文。没有本轮原始 session/frames，无法确认另一处状态丢失，暂不重写通用 replacement 协议。 |
| C：代理断流重试 | 本轮不作统一定位或修复。 | 连接中断可能涉及响应时间与 Harness 超时冲突、原始错误被覆盖等不同原因，遇到具体情况再逐案复现和处理。 |
| D：completed 不代表交付 | 已回滚本轮新增的声明式输入/输出文件约束、缺文件暂停逻辑及 API 参数。 | 问题未宣称解决，后续需针对具体交付协议定位。 |
| E：依赖与资源保护 | 已回滚本轮新增的 Python/工作区预检查、三层预算和文件/控制动作无进展检测及自动取消。 | 原有 Harness 活动监控保持不变。G 仍可记录外部调用方传入的取消原因，但本轮不再自动检测预算超限。 |
| F：恢复成果索引 | 每次 invocation 收尾生成不可覆盖的 JSON manifest，保存变更文件路径、大小、mtime、SHA-256、Agent、invocation、生成时间和未验收标记。项目状态保存最近 50 个清单摘要，完整清单留在磁盘；前端显示最近的可恢复清单入口。 | 清单是当时的元数据记录，不复制或冻结工作区文件；不注册正式 artifact，不声称经过 verifier。后续文件可能变化，应比较 hash。 |
| G：取消归因与收尾竞态 | cancel 支持 actor / reason / waitForSettlement；保存请求、取消和收尾时间。重复取消保留首次原因，事务回滚保留取消元数据。前端区分超时与用户取消。 | 普通 HTTP 200 仍表示取消请求已接受，冻结前应等待收尾选项返回或观察 `project.cancellation.settled`。进程外的任意后台写入不在该同步点的保证内。 |

## 恢复成果索引的边界

- Manifest 跳过隐藏路径、符号链接、Memory.md 和常见依赖缓存。单次扫描最多 2,000 个文件/目录，SHA-256 读取最多 100 MiB；达到限制或文件变化时明确标记 `incomplete`，不宣称清单完整。
- 清单内 `no_output` 表示本次没有新增/变更的可见输出，不表示整个项目从未生成过文件。已有输入文件不会仅因被读取就成为新输出。

## 截止取消并等待安全快照点

```http
POST /api/projects/<projectId>/cancel
Content-Type: application/json

{"actor":"deadline-monitor","reason":"arm_timeout","waitForSettlement":true}
```

响应中的 `project.cancellationSettledAt` 在 runner、事务回滚和 checkpoint 索引完成之后写入。冻结程序还应记录自己的 snapshot timestamp。旧客户端空请求默认 `actor=user`、`reason=user_cancelled`。

清单接口：`GET /api/projects/<projectId>/checkpoints/<checkpointId>`。实际文件继续通过共享工作区文件接口访问。

## 验证范围

PR 冲突解决：合并最新主分支 `3e2f9cf`（PR #19）后，正常会话保留上游的增量上下文策略，补路由仍使用 A 的专用上下文；保留上下文增量与取消回滚两组测试。相关后端验证共 119 项通过、1 项基线失败、2 项按配置跳过。失败为 `HarnessRuntimeFacade stages the shared Inspire wrapper before a fixture compute Adapter starts`，在 Windows 上找不到 `bin/inspire`，已在未修改的 `3e2f9cf` 工作树复现；两项原生 Claude 压缩测试因未配置本机 CLI 而跳过。类型检查、构建及差异空白检查通过。合并主分支不意味着本 PR 扩大为 B/C/D/E 修复。

PR 独立工作树最终验证：后端 11 个定向文件 102 项通过，取消事务回滚专项 1 项通过；前端 3 个定向文件 55 项通过、2 项已知基线失败（IME 输入、Explainer 停止）。前后端类型检查、构建及差异空白检查通过。以下保留此前各阶段的验证记录，计数有重叠，不应相加。

A 自动兜底调整后：5 个后端测试文件、68 项测试全部通过，覆盖正常路由不补调、Worker 补调成功、补调仍漏路由及补调异常后 Main 自动接手，并检查超过 1,000 字的交接内容完整保留；前后端类型检查和 `git diff --check` 通过。

D/E 回滚后：11 个后端测试文件、100 项测试全部通过；前后端类型检查通过；`git diff --check` 通过。成果索引的集成测试已改用外部截止取消触发，不再依赖已移除的预算机制。随后 A 按用户选择保留 Main 自动兜底，不采用“Worker 补路由失败即暂停”的方案。

测试覆盖 Worker 自行修复及 Main 接手、原文件/交接保留、MCP 只暴露合法路由、取消原因幂等、取消回滚和收尾同步、清单 hash/输入排除、API 参数验证及前端展示。未运行真实付费模型或完整八臂实验；B/C 的原生事件复现仍需 run03 原始记录。

回滚前的历史定向回归：后端 108 项通过；前端 78 项通过、2 项基线失败（在 `923d354` 的未修改副本上完整复现）；取消事务回滚专项 1 项通过。前后端类型检查及 `npm run build` 通过。上述数字不代表全仓库所有测试均通过。

Windows 下原有文件权限测试要求 POSIX `0600`，属于平台差异；前端原有 IME、Explainer 停止测试在未修改的主分支副本上也失败。它们与本次 run03 修改分开记录。验证时同时修正了工作区绝对路径在 Windows 上的归一化，并使 orchestration MCP 测试直接启动 Node，不再依赖 `/bin/bash`。
