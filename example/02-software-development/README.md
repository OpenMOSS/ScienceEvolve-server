# 02-software-development：软件设计、编码与测试闭环

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

通过自然语言需求启动的通用软件开发 workflow。需求直接输入 `coding`，所有 Agent 使用同一个 workspace，可开发新软件，也可修改已有项目。

```text
输入 → coding → testing ── 全部测试通过 → 完成
          ↑        │
          └────────┘
           未通过：测试结果与修复分析
```

- `coding`：`instructions` 为空，不配置角色指令；直接根据用户需求实现软件，再根据测试反馈修复代码。运行时通用执行协议仍保留。
- `testing`：对比需求、测试用例与实际实现，补充缺失覆盖并独立执行测试。未通过则记录期望/实际差异、复现方法及修复建议；全部通过才调用 `complete_project`。
- `main`：保留 运行时必需的异常恢复与用户输入协调职责，正常的编码—测试循环不运行。

## 路由与终止

`input.target` 为 `coding`；`coding → testing` 为唯一强边。`testing` 有两条弱边：返回 `coding` 和 `finish`。`termination.agent: "testing"` 与 `automatic: true` 将完成判断交给 Testing。Testing 未提交完成动作时，执行器按唯一普通返工目标直接返回 Coding，无需 Main 选择。

`termination.decisionBy` 保留 共同编排合同要求的 `"main"`；`automatic: true` 是明确允许指定终止 Agent 自行完成的例外，本模板实际由 Testing 判断结束。不是检测到通往 `finish` 的边就自动结束，必须由 Testing 核对证据后显式调用完成工具。

没有固定循环次数或批次出口；循环持续到当前版本全部必测样例和相关回归实际通过。零测试、未运行、环境阻断或靠跳过测试得到的成功不满足终止条件。新增用户输入、执行失败与暂停恢复继续沿用 运行时机制。

本模板默认 `allowMainReconfiguration: false`，编码循环不改变 workflow 或验收标准。测试判断由 Agent 依据真实命令结果作出，运行时校验终止权限与提交状态，不内置特定语言的测试结果解析器。

## 工作区与交付

产品代码和测试保存在 main 创建的共享 workspace 中；已有代码先通过网页上传到 `user_inputs/`，再由 Coding 按需求清单复制到工作目录，恢复时不覆盖。Coding 不要求输出固定的需求、设计或变更文档；Testing 如发现这些材料可以参考，但以用户需求和实际测试为准。

`development/` 是本模板约定的测试证据目录，由 Testing 创建，不是 系统固定成果目录：

- `testing/round-NNN/`：本轮命令、原始输出、被测版本摘要、`results.json` 与 `report.md`。
- `final.md`：全部通过后的最终报告，由 Testing 发布并选择展示。

所有启动步骤和模板使用示例统一见 [example/README.md](../README.md)。

SDK 命令行运行请切换到 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。当前 main 从网页载入示例并管理工作区。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![软件开发与测试 的实际 Workflow 画布](../../docs/readme/workflows/02-software-development.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
