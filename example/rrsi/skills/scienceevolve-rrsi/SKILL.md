---
name: scienceevolve-rrsi
description: 用 SCIENCEEVOLVE workflow 完整执行 Google RRSI 的 harness 进化算法，包括三镜头诊断、正则化提案、泄漏审查修复、真实评测、成本/噪声/领域门槛、组件归因与冻结后的泛化评测。Task 和评测器独立于研究编排。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


阅读 [执行协议](references/protocol.md)。准备 Task 时另读 [环境与工具合同](references/environment.md)。

`P` 表示本 Skill 内 `scripts/protocol.py` 的绝对路径；`W` 表示当前 Task workspace。所有角色使用同一个 W，禁止重复初始化。

```bash
python "$P" --root "$W" init --profile eng
python "$P" --root "$W" next
python "$P" --root "$W" configure --spec /absolute/environment.json
python "$P" --root "$W" submit --id TICKET_ID --response /absolute/action.json
python "$P" --root "$W" execute --id TICKET_ID
```

Main 只路由当前 ticket。模型 ticket 的 `payload.system`、`cache_prefix` 和 `prompt` 合起来是完整输入；角色返回一个原始 JSON action 文件，Main submit。不能只给输入摘要。原始解析、错误反馈、工具动作与预算由官方协议执行。工具 operation 由指定 measurement/selector/heldout/audit 角色 execute，setup 使用 configure。

允许从工程、科研代码或其他真实任务建立 Task；允许更换模型/工具承载，但必须声明等能力替换，冻结 policy、evaluator、数据和门槛。不能减少算法阶段，不能把新 Task 的参数冒称论文原配置。模型角色全部来自 workflow；禁止调用 `rrsi.py run`、`driver.drive`、`Run.round`、`Run._draft` 启动嵌套自治系统。

原始来源、角色提示词、工具、三域配置与许可证在 `UPSTREAM.json` / `upstream/`。归档内的 SKILL.md 是被测 Task 的 constitution，不是让 workflow 自修改的 Evolver 指令。

中断后保留 `.rrsi/`、`rrsi-task/` 和 `rrsi-runs/`，通过 SDK resume 恢复，再 next。STOP 在轮间暂停；移除 STOP 后可继续。`paused`、工具条件缺失、证据损坏均不能标记完成。仅 `terminal=complete` 才交付 `.rrsi/report.json`。
