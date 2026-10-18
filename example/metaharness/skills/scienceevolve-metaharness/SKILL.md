---
name: scienceevolve-metaharness
description: 执行 Meta-Harness：完整文本分类参考搜索流程 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# Meta-Harness 完整文本分类参考流程

本模板具体复现上游`reference_examples/text_classification/meta_harness.py`这一完整公开参考流程，不把Terminal-Bench专用Task的实现混进来。固定源码随Skill归档为执行规范，Task benchmark须在用户workspace有完整可运行checkout。

先读`upstream/ONBOARDING.md`和`upstream/meta_harness.py`，proposer逐条执行`upstream/proposer.md`。SCIENCEEVOLVE只替换外层Claude proposer调用/角色调度，**不替换**MemorySystem Task、数据协议或评分器。不能调用`run_evolve`或外层CLI再包一层完整搜索。

## Baseline与目录

运行命名、logs/results/traces/pending/summary/frontier/finalized路径遵循原run_evolve初始化。读实际config的datasets、models、baselines、seeds、offline/online训练参数；不是默认把所有数据合成一个集合。未finalized的具名run可续跑；finalized run禁止演化。基线按原benchmark逐个运行并更新frontier，已存在结果按原复用机制处理。所有原始轨迹供proposer使用，test目录在搜索阶段不暴露。

## 每个iteration

1. 清理上一轮pending指针（保留归档）；按原render_task_prompt提供run路径、迭代编号和数据集数，记录proposer完整交互与耗时，默认propose_timeout=2400秒。
2. proposer执行原Skill全部机制、原型、反过拟合与接口要求，一次3候选。SCIENCEEVOLVE替代原Claude wrapper；不要把3改成1或省去原型。
3. 按原validate_candidates用独立进程进行import检查（30秒）；无pending/失败提案按原跳过该iteration；全无效时登记候选失败。有效候选调用Task `benchmark` 对配置的所有数据集和种子执行，原算法负责cold-start/train/learn/val与记忆持久化。
4. 按原 `benchmark --frontier --model` 计算逐数据集best与Pareto前沿。保留原完整计算和比较规则，不能用一个incumbent平均数取代。使用真实val结果计算平均，并按原update_evolution_summary字段/单位/舍入/失败标记/timing登记所有候选。
5. 迭代预算按上游默认20或用户明确配置执行。无提升不是隐式早停。保留每批3候选、失败和完整代码/轨迹。

## 独立finalize

仅显式finalize时执行：选取**所有baseline、Pareto成员、每个数据集best_system的并集**；先写finalized.json in_progress与冻结集合，再逐系统跑test、计算test frontier和results。检查每个model×dataset×system应有的完整test结果，任一失败保持in_progress。重试仅补测试，不返回propose。全部完整才写complete；再次finalize只读取已有结果，不重复付费。搜索预算结束不自动偷看test；test不能成为下一轮输入。

上游评测代码是Task工具；仅可逐步调用benchmark与纯函数，SCIENCEEVOLVE负责每个外层阶段。用户换领域时需另写完整domain_spec和等价Task接口/评测，并重新核对能力；不能仅改标题就宣称另一个参考实验已复现。
