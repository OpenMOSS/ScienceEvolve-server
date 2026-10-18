# 01-ahe-evolve：Workspace 代码自进化

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

通过自然语言需求启动 四 Agent workflow，路由与循环由 `workflow.json` 配置：

```text
输入 → execute → judge（基线）
                    ↓
      [optimizer → execute → judge] × N → main
                    ↑                     │
                    └──── 未结束：新一批 ───┤
                                          └── 满足原终止条件：完成
```

- `execute` 运行 workspace 中已有的任务代码，保存原始执行证据和被测版本；不改算法。
- `judge` 按固定任务目标评分，接受严格改善的版本，否则恢复已评估的最佳代码。
- `optimizer` 通过 Codex 分析证据并修改用户需求允许范围内的代码。
- `main` 保留 项目级全局控制能力；循环组内部不调用，每批循环完成后判断任务是否结束；未结束则直接回到 optimizer 开始下一批。用户介入或故障恢复也可能唤醒 Main。

默认 `maxIterations: 3` 表示每批做三轮修改与重新评估，然后调用一次 Main。第一批前先运行一次基线；Main 判断未结束，就直接调度 optimizer，开启新的三轮循环，不需要改配置或用户确认。循环批数不设额外总上限，项目是否结束仍使用原有 termination.condition 和 complete_project 机制。

启动方式、模型配置和自定义任务输入统一见 [示例运行说明](../README.md)。

## 共享工作区与证据

workspace 由 Server 在项目数据目录内创建；网页上传的输入在 `user_inputs/` 中，首个 execute 按需求清单复制任务代码到共享 cwd，记录来源摘要后再执行。来源目录不被修改；恢复时复用现有 Task，不重复导入。首次 `execute` 保存相关源文件和固定评估文件的初始快照，再开始基线评估；后续轮次复用工作区和历史证据。

同一 main 项目的 Agent 使用 Server 创建的共享工作区（下图以 `task/` 表示）：

```text
task/
├── …                            # 用户已有的任务代码、评估器及文档
├── Memory.md
├── evolution/
│   ├── initial-source/          # 初始任务代码与评估文件快照
│   ├── round-000/               # 基线执行、评分和代码快照
│   ├── round-001/ …             # 修改假设、运行输出、评分和候选快照
│   ├── best/                    # 最后接受且已评估的版本
│   ├── best.json
│   └── final.md
└── workflow.json                # Main 被调用时生成的可编辑快照
```

`evolution/` 是本 workflow 约定的任务文件布局，由 Agent 按 workflow 指令创建，并非 系统固定的成果目录。批次号、批内轮数和累计轮数由运行时持久化，轮次证据与源文件摘要由 Agent 维护。证据目录按累计 totalIterations 编号，避免新一批覆盖历史文件。

## 关闭工作流自进化

本示例默认开启 Main 修改流程的能力。要关闭工作流自进化，在启动前将 [workflow.json](workflow.json) 中的开关设为：

```json
{
  "orchestration": {
    "allowMainReconfiguration": false
  }
}
```

只修改这个字段，保留其他配置。关闭后，运行时不向 Main 提供 `apply_workflow`，执行器也会拒绝应用流程或 Agent 配置修改；Main 不能自行开启此权限。设回 `true` 可在启动时重新启用。

关闭的是工作流自进化权限。`optimizer` 仍按既定流程优化任务代码，循环组照常运行；Main 仍在每批结束后判断继续或完成，原有终止条件保持不变。关闭时，运行时不生成供 Main 编辑的 `workflow.json` 快照。

## 修改循环次数

编辑 `workflow.json` 的 `orchestration.loops`：

```json
[
  {
    "id": "code_evolution",
    "from": "judge",
    "to": "optimizer",
    "maxIterations": 3,
    "exitTo": "main"
  }
]
```

`maxIterations` 必须是正整数。`to` 是循环组入口，`from` 是循环组最后一个 Agent。Main 继续时使用 `route_to_agent(target="optimizer")`，运行时自动开始下一批；不需要修改该值。原有终止判断保持不变，批次完成不能冒充项目完成。详细规则见 [Web usage](../README.md)。

## 与原框架的范围差异

保留“执行 → 评分 → 分析改进”、基线、候选证据、接受/回退和最终统筹的工作方式。任务针对 workspace 自带代码，具体测评命令依据自然语言需求与代码仓库说明确定；没有复制原项目的 RCB staging、私有 Judge 数据隔离、Train/Validation 管线或多次 Judge 平均策略。

运行时确定性执行路由、计数、提交恢复；评分、源文件快照、接受/回退策略是 Agent 的 workflow 指令，并非新的受信任实验控制器。所有 Agent 共用文件且有执行权限，用户声明的修改范围和初始副本用于审查约定，不能提供防恶意篡改的隔离保证。

SDK 命令行运行请切换到 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。当前 main 从网页载入示例并管理工作区。

本例保留 `allowMainReconfiguration: true`。Main 使用服务端注入的实际提案路径；按允许范围提交 `workflow.json` 并调用 `apply_workflow`，校验成功后应用。网页工作区由 Server 管理，不使用 SDK 的外部 workspace 启动参数。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![AHE · 代码自进化 的实际 Workflow 画布](../../docs/readme/workflows/01-ahe-evolve.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
