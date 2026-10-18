# Biomni A1 / E1 workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

完整公开A1推理闭环：原资源检索 → 原系统提示/工具与know-how → ReAct生成 → 实际Python/R/Bash/CLI → 观察与重规划 → 可选自批评/test-time scaling → 原报告。SCIENCEEVOLVE每次调度一个步骤，不调用整个上游自治graph。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 分支指南](/../feat/sdk-only-v0.1.1/sdk/README_zh-CN.md)。

## 实现与外部能力

已下载的[上游资源](skills/scienceevolve-biomni/upstream/README.md)包括全部22个工具领域模块、工具描述、know-how、E1环境脚本、数据湖下载器和教程；固定commit `400c1f366b96a35ca253e13c9b06c5076af41d65`，文件哈希见UPSTREAM.json。代码按Apache-2.0保留，工具/数据另见[许可清单](skills/scienceevolve-biomni/upstream/license_info.md)。

在独立E1环境中按[官方安装说明](skills/scienceevolve-biomni/upstream/biomni_env/README.md)运行setup.sh，再安装随附包。完整E1依赖和数据体积较大；本仓库提供真实源码/安装及下载入口，不把只安装Python核心包称为E1已经就绪。

```bash
pip install -e example/biomni/skills/scienceevolve-biomni/upstream
python example/biomni/skills/scienceevolve-biomni/scripts/bridge.py prepare-data --config /absolute/task/config.json
# 在Task工作目录和E1解释器下持久运行；脚本路径用绝对路径
python /absolute/path/scienceevolve-biomni/scripts/bridge.py serve --root /absolute/task/biomni-run --config /absolute/task/config.json
```

config.json示例（路径和任务替换为真实值）：

```json
{"task":"实际研究问题与输入材料", "data_path":"/absolute/biomni-data", "use_tool_retriever":true, "timeout_seconds":600, "commercial_mode":false, "self_critic":false, "test_time_scale_round":0}
```

先由Main准备并检查环境，再启动同一个bridge服务进程。`prepare-data`会真实下载默认完整数据湖/benchmark；`serve`会检查缺失文件，不能用上游expected_data_lake_files=[]偷偷绕过数据要求。商业模式按上游许可语义切换对应资源。

bridge通过Unix socket逐步接收SCIENCEEVOLVE角色的真实模型响应，复用原A1单步函数和持久Python REPL。请求JSON与完整调度规则见[Skill](skills/scienceevolve-biomni/SKILL.md)。角色暂停可重连现存进程；进程死亡不能自动恢复任意Python/GPU对象，需核对实际作业后继续，不能重复湿实验提交。

湿实验使用wetlab Agent和Task已配置的真实MCP/CLI/API。上游PyLabRobot的Chatterbox只用于模拟检查；必须取回真实job、原始数据才能报告实测。领域检索/工具里的原子模型调用可以使用外部提供者，但外层科研决策由SCIENCEEVOLVE负责。

## 验证边界

交付完整公开科研流程、实际工具连接与执行协议；已进行本地算法/文件状态/真实本地执行或IO契约测试。尚未完成真实模型、完整领域环境和湿实验的端到端科研验收，不能声称论文科学结果已复现。外部共享服务不列为workflow缺失；实际运行仍必须连接并取得真实结果。

## Workflow 画布

通过主页通用 JSON 导入入口查看的实际前端截图；仅展示配置，未连接模型或执行研究。节点较多时，请导入 JSON 后缩放阅读。

![Biomni A1 / E1 的实际 Workflow 画布](../../docs/readme/workflows/biomni.jpg)

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
