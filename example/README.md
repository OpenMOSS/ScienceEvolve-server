# ScienceEvolve Workflow 文件与参考实现

[← 返回中文 README](../README_zh-CN.md#examples) · [English](README_en.md) | **简体中文**

本页展示与固定 SDK 来源对应的 21 个工作流示例：3 个入门流程、18 个论文或开源项目工作流，提供 JSON、需求和参考资源。SDK 运行入口见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。main 中这些文件用于阅读、引用与手动复用，前后端不提供专门的示例展示区、示例 API、自动加载或打包。

## 在 Web 中手动查看和使用

1. 在运行 Server 的机器上保留本目录及相应 Skill 资源。在仓库根目录手动执行：

   ```bash
   node example/export-web-workflow.mjs \
     example/aris/workflow.json /tmp/aris.web.json
   ```

   Windows 可将 `/tmp/aris.web.json` 换成实际可写路径。输出文件须为新文件，脚本不会覆盖现有文件。将 `aris` 换成需要的目录即可；原始 `workflow.json` 和 `requirement.txt` 不会改变。
2. 生成的副本补齐网页编排格式，移除顶层 Git 与 SDK 部署字段，将相对 Skill 引用改为当前机器的真实 `SKILL.md` 路径，保留角色、指令、模型、Harness、路径、Loop 及内嵌 Skill/MCP 定义。原始模型和思考选项仍需按实际网关检查。
3. 在主页点击 **“导入 SDK workflow.json”**，选择生成的文件。导入原文只读，可查看画布、原始 JSON 或下载。关闭预览，在 **“快速发起研究任务 → Agent 配置预设”** 中选择导入项，载入按网页宿主规则运行的可编辑副本。
4. 单独复制相应 `requirement.txt` 到任务需求，补全真实任务输入。为每个 Agent 选择已安装 Harness、可用网关、模型与思考选项。Git 配置不在导入的预设中：原例 `git.enabled: true` 时，先配置网页 GitHub 账号，再开启并行协作并检查协作组。
5. 确认后点击 **“提交并继续”** 启动。需要上传输入时，先在快速发起中 **“保存 → 另存为新配置”**，再到新建项目页选择该配置并上传文件。导入原文不可覆盖，修改副本可另存配置或研究任务草稿。

跨机器部署应在 Server 主机重新导出，或手动将 Skill 引用改为其真实路径；仅复制 JSON 不会自动安装 Skills、MCP、数据或实验工具。Skill 的选中路径由现有通用运行机制解析，应用不会默认注册本目录中的方法资源。远程 Web 用户先下载该主机导出的 JSON，再在网页中选择文件。

[完整网页教程](../README_zh-CN.md#tutorial) · [详细配置](../docs/configuration_zh-CN.md#workflow) · [21 张实际画布](../docs/readme/workflows/README.md)

## 工作流示例目录

| 示例 | 类型 | 流程 |
| --- | --- | --- |
| [默认科研工作流](dynamic-research-workflow/) · [JSON](dynamic-research-workflow/workflow.json) · [画布](../docs/readme/workflows/dynamic-research-workflow.jpg) | 入门 | 构思、执行、写作、评审与 Main 协调 |
| [AHE · 代码自进化](01-ahe-evolve/) · [JSON](01-ahe-evolve/workflow.json) · [画布](../docs/readme/workflows/01-ahe-evolve.jpg) | 入门 | 执行、评分、改进循环与批间裁决 |
| [软件开发与测试](02-software-development/) · [JSON](02-software-development/workflow.json) · [画布](../docs/readme/workflows/02-software-development.jpg) | 入门 | Coding → Testing → 修复或交付 |
| [ARIS](aris/) · [JSON](aris/workflow.json) · [画布](../docs/readme/workflows/aris.jpg) | 方法模板 | W1 → W1.5 → W2 → 写作与跨模型评审 |
| [Meta-Harness](metaharness/) · [JSON](metaharness/workflow.json) · [画布](../docs/readme/workflows/metaharness.jpg) | 方法模板 | Harness 候选、全数据集评测与筛选 |
| [autoresearch](autoresearch/) · [JSON](autoresearch/workflow.json) · [画布](../docs/readme/workflows/autoresearch.jpg) | 方法模板 | 训练实验与 Git keep/discard |
| [FunSearch](funsearch/) · [JSON](funsearch/workflow.json) · [画布](../docs/readme/workflows/funsearch.jpg) | 方法模板 | 多岛程序数据库、采样与真实评估 |
| [Agent Laboratory](agent-laboratory/) · [JSON](agent-laboratory/workflow.json) · [画布](../docs/readme/workflows/agent-laboratory.jpg) | 方法模板 | 七个研究子阶段与求解器反馈 |
| [SciAgents](sciagents/) · [JSON](sciagents/workflow.json) · [画布](../docs/readme/workflows/sciagents.jpg) | 方法模板 | 图推理、假设细化与独立评审 |
| [Robin](robin/) · [JSON](robin/workflow.json) · [画布](../docs/readme/workflows/robin.jpg) | 方法模板 | 候选筛选、真实实验交接与分析 |
| [Google AI co-scientist](co-scientist/) · [JSON](co-scientist/workflow.json) · [画布](../docs/readme/workflows/co-scientist.jpg) | 方法模板 | 假设生成、反思、排名与进化 |
| [Biomni A1 / E1](biomni/) · [JSON](biomni/workflow.json) · [画布](../docs/readme/workflows/biomni.jpg) | 方法模板 | 资源检索与真实生物工具闭环 |
| [AgentRxiv](agentrxiv/) · [JSON](agentrxiv/workflow.json) · [画布](../docs/readme/workflows/agentrxiv.jpg) | 方法模板 | 实验室与共享预印本累计研究 |
| [RRSI](rrsi/) · [JSON](rrsi/workflow.json) · [画布](../docs/readme/workflows/rrsi.jpg) | 方法模板 | Harness 诊断、测量与正则化选择 |
| [DrugEvolve](drugevolve/) · [JSON](drugevolve/workflow.json) · [画布](../docs/readme/workflows/drugevolve.jpg) | 方法模板 | 生成、训练、调试、评分与归档 |
| [ScientistTwo](scientist-two/) · [JSON](scientist-two/workflow.json) · [画布](../docs/readme/workflows/scientist-two.jpg) | 方法模板 | 想法进化、实验、写作与审稿 |
| [AI Scientist v2](ai-scientist-v2/) · [JSON](ai-scientist-v2/workflow.json) · [画布](../docs/readme/workflows/ai-scientist-v2.jpg) | 工作流适配 | 构思、实验管理、研究分支与写作评审节点 |
| [InternAgent 1.5](internagent-1-5/) · [JSON](internagent-1-5/workflow.json) · [画布](../docs/readme/workflows/internagent-1-5.jpg) | 工作流适配 | 研究规划、生成、验证与演化 |
| [Biomni-R0](biomni-r0/) · [JSON](biomni-r0/workflow.json) · [画布](../docs/readme/workflows/biomni-r0.jpg) | 工作流适配 | 数据整理、轨迹、奖励、训练、部署与评测节点 |
| [化学 Coscientist](chemical-coscientist/) · [JSON](chemical-coscientist/workflow.json) · [画布](../docs/readme/workflows/chemical-coscientist.jpg) | 工作流适配 | Planner 调度搜索、文档、代码与实验节点 |
| [Raven Host](raven/) · [JSON](raven/workflow.json) · [画布](../docs/readme/workflows/raven.jpg) | 工作流适配 | 双 specialist 槽位与批次裁决 |

本目录按 workflow 结构与编排收录示例；各目录记录具体映射与适配范围。

## 文件与来源

每个目录保留 `workflow.json`、`requirement.txt` 与说明；具名方法随附 `skills/`、脚本、参考实现、许可与来源文件。原始图和执行协议用于 SDK；网页副本会应用 main 的调度及会话规范，宿主差异见 [Web / SDK 边界](../docs/main-sdk-parity-zh.md)。

固定 SDK 来源为 `feat/sdk-only-v0.1.1` 的 `4160a2cf0259b2a1ed9dc4eb36bc0484d2527a42`。目录与状态记录在 [catalog.json](catalog.json)，该文件仅供参考和维护，不由应用自动读取。项目专用名称为 ScienceEvolve，第三方许可与来源哈希保留。

原始流程、可导入配置、离线协议测试与真实科学结果应分别验收。可选离线检查需要 Python 3.10+；在独立环境安装 `example/tests/requirements.txt` 后，运行 `python -m unittest discover -s example/tests`。这些检查不调用真实科研模型或 GPU 实验。
