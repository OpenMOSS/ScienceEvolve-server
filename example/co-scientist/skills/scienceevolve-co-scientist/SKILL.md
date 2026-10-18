---
name: scienceevolve-co-scientist
description: 执行 Google AI co-scientist：完整科研流程 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# Google AI co-scientist 的完整科研闭环

参考官方论文v1 §3.2–3.5（SOURCES.json）。用户明确允许同步调度替代异步worker、文件系统替代持久假设服务，外部共享服务不属于科研流程本身。模型可等价替换。保留下面全部研究职责；这个Evolution只改假设，没有Evolver。

## 输入与监督

Main解析完整目标/长文献和多模态输入、实验室约束、偏好、是否只收新颖假设、质量评价标准，写版本化research_plan.json。数据/知识服务、检索、专用预测模型和湿实验平台是外部工具；先识别本任务需用哪些真实接口。不能凭“没有内置服务”跳过检索、AlphaFold等需求或实际实验。

初始化：`python scripts/pool.py --root <workspace/co-scientist> init --plan <plan.json>`。每轮查询stats，Main根据生成方式的表现、待审数量、比赛覆盖率/新颖性/多样性调整各角色的工作权重与任务；把理由/预算写日志。持续计算到用户明确预算/终止条件，不设隐含固定轮数。需保存当前工作和产物，进程恢复后继续，不重复登记比赛。

## 必需研究行为

Generation保留文献探索、模拟科学多轮辩论、迭代拆解可检验假设、以已有研究概览扩展方向四种能力；每个新候选保存科学摘要、类别、机制、证据、假设链、可证伪实验。

Reflection保留六种review。initial是不用外部工具的快速判断；通过后full检索支持/反对证据及新颖性；deep_verification独立检验去情境化子假设，并区分根本错误与可修补错误；observation检查对长尾已有实验观测的解释力，允许“无额外发现”；simulation逐步推演机制/实验并列出失败情境；recurrent在比赛/meta/专家新信息后更新review。初审被拒绝可停止昂贵评审；通过的候选不能缺full/deep/observation/simulation就进入本实现的完整评审池。推演不是实测。

Proximity按目标构建候选相似图与cluster，用于相似假设优先比赛、去重和展示多样性；去重仅分组/标识，不删除原始证据。

Ranking新候选Elo=1200（论文明确值）。相似、新、top候选提高对局概率。top双方多轮论辩，低排名可单轮；判断基于新颖性、正确性、可测试性，比较顺序交换以减轻顺序偏置。pool.py只在真实比赛记录提交后更新Elo。论文未公布K/配对权重/高排名范围的确切工程值，本实现显式可配置K=32、scale=400、top_fraction=0.25和seed=42；这些是本地实现参数，**不是Google内部数值**。可复现的是用户允许替换执行底层后的完整公开科研流程。

Evolution包含grounding、coherence/feasibility、inspiration、combination、simplification、out_of_box六种策略。按实际缺陷和多样性安排策略，不能只做“重写摘要”。每次创建不可变新候选、记录所有parent与strategy、重新评审和参赛；不替换旧候选，不继承父本Elo。

Meta-review汇总所有review与比赛反复问题，将具体反馈交所有后续角色，generation选择性利用以避免评论过拟合。周期概览包括重要方向、top例子、实验路线和来自文献的专家建议/理由，可按NIH Specific Aims等格式输出；列联系人不等于获准发送消息。

## 专家与实验反馈

支持用户改目标、提交独立review、注入自己的假设、限制探索文献集合。目标改动写新epoch，保留旧证据并重新审查/排名，不能混用不同目标的Elo。expert假设进入相同池/相同比赛。用户review保留source=expert；不伪称自动审查。

湿实验由wetlab Agent配合用户平台工具执行，保存协议、job/实验ID、工具返回、样本/条件、原始数据与完整观测。结果作为外部证据进入reflection/evolution/meta。shared服务与设备供应不属于workflow代码，但要求实际调用，不能用字典假回执替代。未启用实验分支时，交付是待验证假设/实验方案；启用时必须等真实结果。

## 文件工具

`pool.py --help`给出add/review/graph/pair/match/feedback/stats/replan命令。每个写入用文件锁与原子替换，候选不可改、match ID幂等、旧目标比赛失效。CLI输入JSON字段与实际示例见references/records.md。Main仍负责语义判断，程序负责持久状态和数值更新。文件中不能写API密钥。
