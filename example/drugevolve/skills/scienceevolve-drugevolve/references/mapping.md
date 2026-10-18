# 固定上游与能力核对

官方仓库：https://github.com/GAIR-NLP/DrugEvolve
固定提交：`e26347c4a3dfbd639702b68b2f19d1420d78199b`。
源码原样存入 `upstream/`，逐文件hash见 `UPSTREAM.json`。

| 上游路径/函数 | SCIENCEEVOLVE实现与证据 |
| --- | --- |
| pipeline/pipeline.py | Main + steps状态：最大轮数、patience、连续失败和SKIP语义。未运行原外层自治循环。 |
| Creation/infer.py:sample | Main调用原函数；父选择最多10次、island连续4次空选回退、两条参考各最多20次；不以LLM随意挑选替代。 |
| Database/local_database.py + drugevolve/samplers | 原存储/采样算法、visit计数、谱系、岛屿与best；保留兼容接口本身的实际行为。 |
| Researcher/creator/infer.py | generator/inspector独立节点；原生成提示/schema，重复反馈；3次生成×3次Researcher默认嵌套预算。 |
| Researcher/inspector/infer.py | 原相似查询和重复上下文，SCIENCEEVOLVE提交原InspectorOutput。 |
| Researcher/implementer/infer.py | 原starter及提示、实际Harness读写、success/内容变化/compile校验；scope为当前候选目录。 |
| utils/copy_launch_script.py | 原MODEL_PATH替换和启动脚本；保留训练前后original_name与timestamped_name路径语义。 |
| Engineer/trainer/infer.py | 原单机子进程、CUDA选择、7200秒默认超时、进程组TERM/KILL；不使用模拟训练。 |
| Engineer/main.py | 原熵监控线程 + 针对上游占位parse_train_log补齐CSV解析；trainer/debugger路由执行5次总训练上限、熵中止分支、真实结果收集和权重归一化。 |
| Engineer/debugger/infer.py | 原错误上下文和输出schema；Harness实际修改候选，等价替换原文件工具。 |
| Engineer/judger + utils/experiment.py | 原Judger提示、量表、schema和客观计算；默认客观权重1、LLM权重0仍保留判断与complexity。 |
| Analyst/analyzer/infer.py | 原分析提示与父/祖父上下文、六字段输出、3次失败重试。 |
| Analyst/summarizer_evolve/infer.py | 原四部分经验总结提示/schema、3次失败重试。 |
| drugevolve/cognition.py | 原外部知识入库/检索top-3；与实验experience分开。 |
| Database.add_element / RunWorkspace | 原节点、results/program/analysis文件、best快照；额外scienceevolve-rounds保存所有失败和跳过尝试。 |

## 明确的范围与替换

- 对齐公开单机 compatibility pipeline，任务专属数据、11种应用环境和论文数值不作为已跑通交付。`upstream/README.md`保留完整Task接入说明。
- OpenAI Agents模型执行换为SCIENCEEVOLVE角色；原模型系统提示、用户提示、输出schema和角色工具能力都保留。脚本不发模型请求。Harness内多次工具交互由Harness管理，算法级重试由脚本计数；SCIENCEEVOLVE不假称实现了OpenAI Agents内部token/turn计费。
- 为安全恢复拒绝同名候选覆盖已存在目录；要求新候选采用唯一snake_case名称。重试和失败按同一预算记录，不偷偷删除证据。
- sampler.sample_n在原compatibility sample()中不控制上下文个数，仍是1父+2参考；island兼容接口忽略传入的parent/context比例而使用已配置store。保留实现行为，不宣称实现了上游未接通的配置。
- 上游parse_train_log返回空CSV，直接复制不会触发熵中止。本例明确补齐step,entropy日志解析；Task可提供同合同解析器，保留原阈值、进程终止和异常计分分支。
- run_spec评价方向不控制原CSV评分器；本例要求higher-is-better归一化CSV。Task内可把误差指标转成效用，方法选择仍沿用公开评分函数。没有把说明中的任意evaluation.command冒充兼容管线的实际执行入口，实际入口是SOURCE_FILE。
- 完整能力映射不表示实验结果已复现。离线测试包含真实Bash训练失败/修复、熵超阈值中止及零客观分、CSV客观评分、原提示/schema、入库/best、父节点重新采样、重复反馈和嵌套重试，不调用真实科研模型。
