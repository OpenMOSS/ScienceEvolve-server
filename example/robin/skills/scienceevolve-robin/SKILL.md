---
name: scienceevolve-robin
description: 执行 Robin complete research workflow 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# 完整 Robin 执行协议

`upstream/robin/{assays,candidates,analyses,configuration,prompts,utils,multitrajectory_runner}.py`是必读执行规范。运行前逐段读对应阶段实现及引用的prompt/helper，原算法与模板完整保留；用SCIENCEEVOLVE角色替换原普通LLM消息调用，真实检索、调查、R执行能力仍由Edison提供。禁止调用experimental_assay、therapeutic_candidates、data_analysis整条阶段管线冒充workflow；只调用当前节点负责的原子工具/比较/远程执行。

## 真实能力与默认值

- Task需要Python>=3.12，按随附upstream/pyproject.toml安装Robin依赖，Edison CROW/FALCON/data-analysis权限、真实疾病目标/实验数据及实验执行方。运行前检查权限与API可用性，不能用普通聊天假装检索或执行R。可换提供者，但必须覆盖检索引用、深度调查、异步任务ID/结果、上传下载、并行R分析和同一统计协议。
- num_queries=3，num_assays=3，num_candidates=5；以用户实际研究配置为准，不能自行减量。论文特定试验的候选数/疾病/数据必须填写原试验配置，默认值不代表那次论文实验。
- 配置写`robin/config.json`，状态写`robin/state.json`，记录schema、round、phase、输入/产物sha256、真实任务ID、待用户问题和下一步。解析所有原始prompt变量，不把引用代码仅作为阅读材料。
- 普通LLM阶段用SCIENCEEVOLVE当前角色；原run_comparisons/format_final_report也可用已配置原LLM客户端，不能让Main凭印象排顺序。pair采样、Game Score合法性、ILS排名完全依源代码，不用Elo或平均分替换。
- 文献、详细调查、候选和排名的所有中间产物都要保留；恢复前核对输入版本。5条分析是真并行远程Task执行，不是SDK并行讨论组。

## 实验闭环

上游实验由外部实验者完成，SCIENCEEVOLVE使用request_user/respond提供同等交接；交付协议后等待真实实验数据。不得模拟湿实验结果。`analysis_step.py`分别执行一个analysis/consensus原子阶段，保留5条独立轨迹和共识依赖；输入数据路径写配置，flow_cytometry与RNA_seq使用各自原prompt。运行时提供同一config文件和绝对output路径，阶段命令见脚本--help。

分析错误、空CSV、四段解析失败必须显式阻断。interpret保留已测药物排除清单，followup产出四键完整insights，下轮候选查询和生成均消费这些信息。候选反馈轮从本轮_experimental报告目录排名，修复上游路径误指旧目录的实现bug；这项修复保留原方法意图与全部能力。用户只提供初始疾病、未提供后续数据时停在等待实验，不能报告完整研究已结束。

## 终点与证据

人工预先指定的研究轮次/终止条件决定结束；上游无默认10轮或一轮即收尾。保存所有assay、候选、比较、远程轨迹、原始实验数据引用、分析CSV/图、insights和最终报告。工作流复现是调度与能力复现，不承诺重现某种药效或论文数字。
