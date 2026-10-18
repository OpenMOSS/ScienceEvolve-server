---
name: scienceevolve-funsearch
description: 执行 FunSearch：完整公开串行执行管线 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# 完整FunSearch（官方公开串行管线）

以`upstream/funsearch/implementation/funsearch.py`为执行契约。原论文的大规模部署和开源的串行执行共享算法；此模板实现官方完整串行管线，不声称具备分布式吞吐。上游明确将LLM和Sandbox留为需要提供的接口；SCIENCEEVOLVE提供生成能力，用户提供真实隔离评测环境。本模板随附其余原始算法，不以prompt描述代替程序数据库实现。

## 准备

使用本Skill的`scripts/runtime.py`。Python环境需`numpy scipy absl-py`（与上游相同）。Task提供包含唯一`@funsearch.run`和`@funsearch.evolve`的specification，JSON标量test inputs和固定Sandbox适配Python文件。适配文件须实现`create_sandbox()`，其`.run(program,function_to_run,test_input,timeout_seconds)`返回`(score,success)`；实际在用户批准的隔离执行环境运行候选。不得用空实现、虚构返回或裸调用另一整套FunSearch系统替代它。

`runtime.py --state /absolute/workspace/funsearch/state.pkl init --spec <spec.py> --inputs <inputs.json> --sandbox <adapter.py> --seed 42`。状态pickle只能读取本次运行自己生成的可信文件；保存原数据库对象、随机状态、配置、代码模板和固定输入。可通过`--config`传上游Config字段，未指定时使用上游完整默认值。

## 循环

1. `prompt`调用原数据库`get_prompt()`，真实执行均匀选岛、分数signature聚类、温度采样、短代码偏好与版本函数拼接。保存返回的prompt与编号，不能心算或手动挑最好候选冒充采样。
2. 每个prompt按上游`samples_per_prompt=4`通过四个独立worker会话产生四个函数体；Main只负责计数，不修改生成结果。每次sample返回Main，再次调用sample时读取同一prompt，不重新抽岛。模型替代Codey/抽象LLM，不减少抽样数量。
3. 对每个函数体执行`evaluate --sample <body.txt> --index <0至3> --prompt-id <prompt.id>`。逐个使用原Evaluator，抽取/重命名函数、拒绝祖先引用、调用真实Sandbox；按原规则只要存在成功test分数就注册其signature，不擅自改成必须所有测试成功或改分数归约。测试缺失/失败完整记录并在交付中呈现。
4. 原ProgramsDatabase注册候选并按墙钟周期重置弱半岛，保留上游随机tie break与创始程序选择；官方数据库参数和计数不变。脚本每步持久化RNG与数据库，恢复不得重建空库或重复基线。
5. 本轮全部样本已评估才允许下一个prompt。持续运行至用户停止；显式预算是用户需求覆盖，不是模板默认算法删减。

## 产物与恢复

state.pkl旁保存manifest、prompt、每个候选和逐test日志。每个已评估样本ID只登记一次，恢复复用已有结果；待评样本继续本轮。最终从原数据库导出各岛best/完整候选证据。测试性能不构成数学证明。SCIENCEEVOLVE编排采样/评价交接，脚本仅执行原程序数据库与评测原子操作，没有启动上游外层循环。
