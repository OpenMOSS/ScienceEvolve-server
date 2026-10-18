---
name: scienceevolve-agentrxiv
description: 执行 Agent Laboratory：完整研究阶段与求解器反馈 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# Agent Laboratory 全流程协议

以随附`upstream/ai_lab_repo.py`的LaboratoryWorkflow、`agents.py`、`mlesolver.py`和`papersolver.py`为完整规范。替换model query/Agent会话调度为SCIENCEEVOLVE角色；保持阶段、工具、内部算法和共享/局部状态。不得只套文献→实验→报告三个粗节点。本模板启用agentRxiv=true，下面的完整单实验室流程加上末尾跨实验室扩展构成一次完整研究。共享预印本服务外部提供，不是科研workflow角色。

## 原始角色/阶段

逐阶段读原函数及角色phase_prompt。文献阶段保留arXiv检索/阅读/论文纳入和停止协议；计划阶段保留Postdoc↔PhD对话；数据阶段保留ML↔SW工程师、数据代码执行反馈；解释阶段保留Postdoc↔PhD；每个子阶段可按human_in_loop拒绝并重做。默认每phase最多100步。对话、工具结果、共享plan/lit_review/dataset_code/results/interpretation保存在laboratory/state与transcript，阶段完成才清本阶段局部history。

## MLESolver

完整执行原initial_solve/solve/process_command，不只改一次代码。初始化REPLACE并真实运行、评分后建立best_codes；优化每次在best_codes中随机取父本，EDIT或REPLACE，真实运行、有限repair、0–1计划遵循度reward。默认max_codes=1、st_hist_len=2、min_gen_trials=1；原attempts从0开始，因此每solve至少2次尝试，且必须有有效score。每solve保留其最高分包，严格优于池尾才替换并触发reflect_code，再降序排序。任务指标与reward分开。

## PaperSolver

完整初稿分节scaffold/填充与引用检索；原PaperEdit/PaperReplace/Arxiv命令实际执行，编译错误恢复上个有效稿。初稿scoring=false保留原占位约定；随后默认5次solve，每solve至少3次尝试且有有效score。默认max_papers=1、st_hist_len=10、min_gen_trials=2；从best_report取父本，真实编译和原get_score的多维JSON加权公式评分，严格改善才替换。不删除引用搜索、LaTeX、修复或reward能力。

## 报告评审与回环

原ReviewersAgent提供3种persona，分成3个独立SCIENCEEVOLVE会话，汇总完整结果。保持review_override与review_total_steps：默认true/0不额外迭代；关闭override则PhD根据3份review选择y回planning或n完成；启用人工反馈时Main实际等待回答并采纳（修正原源码此分支忽略input返回值的问题，保留原意）。回环保存上一轮证据并从planning重做后续6阶段，文献不丢失。

## 工具/等价替换

原Python/数据/arXiv/LaTeX工具必须可执行。SCIENCEEVOLVE角色替代query_model时读取随附原system_prompt和反馈格式，不合并成同一段自评。模型可更换，不变更命令解释、reward公式、候选选择或循环次数。参数允许按上游入口显式配置；预算不足报阻断而非暗中减候选。`state_saves`的pickle可等价为保存同样字段的JSON，但不能丢失prev_*、phase_status、模型/notes、human flags或求解器histories。

paper_reward对真实review输出执行`scripts/paper_score.py <完整review原文文件>`，脚本直接提取固定上游get_score及JSON解析函数计算原加权分，避免语言模型心算另造指标。此步骤仅计算分数，不能替代reviewer实际读取稿件并完成多维审查。

## AgentRxiv跨实验室/跨论文扩展（必需）

以固定ai_lab_repo.py的AgentRxiv、literature_review、report_write和parallel_labs分支为规范。每个SCIENCEEVOLVE项目是独立lab，独立workspace/phase状态/solver池与workspace外的data-dir（不同CLI不能共享锁定状态库），共用真实archive URL及shared uploads目录；可以启动多个项目并发研究，不用把这些lab合并为同一project的对话角色。用户设置lab数量、num_papers、原全部solver/human参数；单lab自循环并不代表已发生跨lab协作，报告必须列实际参与lab、读取来源与关联。

每篇研究重新进入原七阶段。PhD每次arXiv检索同步搜索archive top5，archive角色用scripts/archive.py search调用实际/api/search、下载PDF、提取全文，读全文写每篇5句摘要，保持AgentRxiv:ID与完整PDF/text缓存。PhD选择纳入review或retrieve_full_text时读取实际缓存全文，连同arXiv结果进入lit_review/planning/实验；不能只把标题写到报告。无结果是合法冷启动，不能制造论文。

每篇通过完整report write/compile/reward/review与人工门槛后，发布最终tex/temp.pdf到shared uploads（原实现方式），触发/update后从真实服务读回PDF比对SHA256，保存来源lab、paper序号、parent研究引用、报告标题、archive ID与时间。文件名含lab/paper/内容哈希，防止不同实验室同名覆盖；这是原传输的等价稳健实现。服务仍提供原all-MiniLM-L6-v2余弦语义检索或等价能力。下一篇重建本篇phase/solver状态、保留archive与完整前文，重新读库，其他lab也可读到新结果。

共享服务可以用Skill内原app.py（API服务）独立部署或接已有等价服务。不在workflow内部启动自治LaboratoryWorkflow。SCIENCEEVOLVE取代外层ThreadPoolExecutor承载不同lab项目，保留原工具、提示/参数、每篇科研闭环与跨lab内容消费。原parallel分支在完成futures后无条件raise NotImplementedError、单lab入口错误固定agentRxiv=False；本例按扩展原意启用archive并在所有论文完成后正常终止，固定源码保持原样。

archive.py search/publish只是实际IO，5句摘要与科学综合交真实模型。不要把发布至archive当成用户已授权发邮件或联系研究者。
