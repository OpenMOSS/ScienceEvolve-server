---
name: scienceevolve-sciagents
description: 执行 SciAgents：完整图推理与多角色科学发现 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# SciAgents 完整双模式流程

原始ScienceDiscovery代码及两份notebook均随Skill提供。主线有**固定顺序**和**自动speaker选择**两种完整方案，本workflow均保留。替换的是模型调用与AG2 GroupChatManager，图工具、上下文、七方面细化、批评和评估能力不删减。不启动AG2完整群聊或research_generation外层代替SCIENCEEVOLVE编排；仅逐步调用原纯工具/图运算。

## 必需工具和输入

Task须提供真实知识图谱、对应node embeddings及embedding tokenizer/model、GraphReasoning环境、实际文献检索接口及Markdown→PDF工具。官方图与embedding地址和初始化方式见upstream/ScienceDiscovery/graph.py与上游README。普通文字列表不能代替图谱；只提供GraphML但缺必要嵌入时不得假装使用了embedding路径算法。

路径能力：支持已有路径直接使用、两个关键词映射、缺词随机节点；按create_path/develop_qa_over_path完整保留shortest path、embedding heuristic、randomness_factor、random waypoints及相关参数。原notebook随机路径默认randomness_factor=0.2、num_random_waypoints=4、shortest_path=false、second_hop=false；不能擅自换普通最短路。保存图/嵌入版本、参数、种子和真实边文本。

## fixed

使用utils.py原提示和顺序：完整定义每个节点/边→生成hypothesis/outcome/mechanisms/design_principles/unexpected_properties/comparison/novelty七字段→每个字段单独批评并细化→合并proposal→科学总结/优缺点/建议→单个最重要分子建模问题及操作方案→单个最重要合成生物学问题及方案→Markdown/PDF与数据输出。七次细化不能缩成一段泛化摘要，数据路径不能变成虚构来源。定量预测需标为预测而非实测。

## automated

原13种角色职责与system_message见role-prompts.json；SCIENCEEVOLVE Main承担manager，原用户代理的工具执行由assistant+Main承接，最大50次角色发言、允许重复speaker。共享完整有序transcript（原AG2共享消息语义），每次角色只完成所分配工作。

planner规划；assistant执行图路径/评估工具；ontologist解释所有节点关系；scientist提七方面初稿；七个专门角色各自细化；critic只做科学批评、模拟与合成生物学优先级，**不评分novelty/feasibility**。最后novelty_assistant使用实际Semantic Scholar查询与摘要做两项1–10分判断，按原最多3次顺序查询/最多10turn子会话、TERMINATE结束。工具失败要重试并记录，不能改用无证据自评分。动态speaker路线不等于原生并行讨论组，原官方这里也是顺序群聊。

模型/Harness可替换，保留原信息可见性、职责和工具能力。每条消息、选人理由、工具参数/结果、所有七方面产物与终止原因保存在sciagents/；不得仅以JSON合法或角色齐全宣称科学发现已验证。
