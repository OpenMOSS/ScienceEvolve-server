---
name: scienceevolve-drugevolve
description: 在 SCIENCEEVOLVE 中执行 DrugEvolve 公开单机算法进化流程，保留原采样、重复筛查、实现、训练调试、评分、分析、经验记忆和停止条件。用于本模板的药物研发算法 Task。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# DrugEvolve 执行协议

目标是 `GAIR-NLP/DrugEvolve@e26347c4a3dfbd639702b68b2f19d1420d78199b` 的公开 compatibility Creation 流程。完整原代码与 Apache-2.0 许可在 `upstream/`，逐项映射见 [mapping.md](references/mapping.md)。Task 是固定数据、评价器、训练启动脚本和候选算法；科研角色由 workflow 分工，没有修改 workflow 的 Evolver。

## 准备与命令

从本 Skill 的实际位置解析 `scripts/steps.py`；Skill 可能已被 SDK 复制到 workspace，不能依赖原仓库的绝对路径。需求必须给出用于这些命令的 Python、绝对 run-dir、Task workspace 和配置文件。默认全部角色用 Codex workspace 权限；需要本机 GPU 时按用户实际资源配置，远程训练需 Task 提供真实执行和结果回传接口。

```sh
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run init /absolute/task/config.json
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run status
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run prompt
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run submit /absolute/task/response.json --request-id REQUEST_ID
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run advance
python /absolute/skill/scripts/steps.py --run-dir /absolute/task/run fail '本次失败的具体原因' --request-id REQUEST_ID
```

`init` 仅执行一次。每次接手先 `status`，依据 `phase` 工作；`prompt` 返回原角色系统指令、用户输入、JSON schema、原工具列表和 request_id，同时保存到 `requests/`。完整读取，不用职责简介代替原提示。完成实际工具操作后写匹配 schema 的响应 JSON，再 `submit`。同一响应不能重复提交；stale ID 时读取当前状态，不新编结果。请求失败才用 `fail`，不能跳过必需角色。

模型 API 凭据由 SCIENCEEVOLVE Harness 提供。脚本截获原模型调用以导出提示，**不会调用 OpenAI API**；不运行 `pipeline.py`、`creation()`、`evolve()` 或 `evaluation()`。上游原子工具中只复用确定性操作。

## 状态和路由

| phase | 工作和下一步 |
| --- | --- |
| sample | Main `advance`；原采样器选父节点和最多两条不同参考，保留消融上下文及 top-3 cognition；冷启动使用原初始化文本。到 generator。 |
| generator | 按原提示提出算法，提交四字段；到 inspector。重复后的提示带原重复实验块。 |
| inspector | 对原相似检索结果作独立判断。重复/生成错误消耗本层最多3次；耗尽后重新开始Researcher，外层最多3次。非重复时自动创建 starter，到 implementer。 |
| implementer | 实际实现候选 model.py；用Harness读/写文件等价替换原两个文件工具，只修改当前候选目录。submit校验success、非starter、compile，再生成原launcher；到 train。实现失败重启Researcher外层。 |
| train | Trainer `advance` 实际运行上游本机训练器及熵监控。总共最多5次训练（首次加最多4次调试后训练），默认7200秒/次、熵阈值2.0。失败到debugger或结束失败轮次。熵中止仍到judger，但客观分为0、test标记崩溃。 |
| debugger | 原提示含训练日志末100行、metric错误末50行；同时读真实stdout/stderr。实际修复当前候选文件再提交，回train。不能只返回补丁字符串而不落盘。 |
| judger | 始终执行，包括LLM权重0时；保留算法分、LLM总分、complexity和理由。脚本用原客观分与显式权重归一化合成；到analyzer。 |
| analyzer | 原六项分析、父/祖父上下文和case；只读候选代码以核对机制。失败最多3次；到summarizer。 |
| summarizer | 读取单独cognition库的top-3外部知识，按原四部分总结实验经验；失败最多3次；到archive。 |
| archive | Main `advance`；原DataElement与LocalDatabaseClient持久化结果、源码、谱系、经验、sampler和best。进入下一轮或finished。 |
| finished | Main核对停止原因和产物后结束。达到连续失败上限的运行要明确报告失败，不能宣称找到改进。 |
| sampling / archiving | 原子工具调用尚未返回或中断；核对sampler访问计数、database/steps/best与事件记录，不能无条件重复advance。若无法确认提交是否完成，请求用户处理，不用fail掩盖已提交的节点。 |
| training | 训练调用尚未返回或进程已中断。先检查真实进程与日志，不自动重跑。确认失败后由Main用对应request_id记录fail；不声称恢复了任意GPU/进程内状态。 |

`max_rounds`、`patience`、`max_consecutive_failures` 来自确认过的 run_spec。失败和重复跳过仍消耗轮数；上游 `[SKIP]` 不增加外层连续失败计数。保留原重试默认值，用户显式改变时在 config.settings 记录。不要拿 SCIENCEEVOLVE 的批次 loop.maxIterations 替代总预算。

## Task 合同与验收

- config、run_spec 示例和环境安装见 example README。先核对真实基线、数据划分、训练参数、预算和可修改路径。Task缺失时明确阻断，不能把这里的测试fixture当药物研发实现。
- `run.sh` 必须含双引号的 `export MODEL_PATH="...model.py"`，由原工具替换为候选路径。脚本在候选目录执行；相对数据路径必须正确解析。真实训练/评估应输出候选目录（或其 `default/` 子目录）的 `*_test.csv`、`*_metric.csv`，可选 `score_detail.json`、`case_study.txt`。
- 固定版本客观评分读取末个可用CSV行，忽略step/run列，平均其他数值列×10并截断到[0,10]。Task应输出方向一致且已归一化的指标；不宣称run_spec.core_score/direction会自动改写这个兼容评分器。多数据集应由Task输出一张汇总CSV，上游collect会覆盖多个同后缀文件。
- 训练器额外提供 `DRUGEVOLVE_CURRENT_LOG`，Task将原熵监控CSV日志写到此路径；这是对原 `{LOGS_DIR}/{timestamped_name}.log` 的路径传递，不改监控算法。上游parse_train_log是占位函数，本例提供CSV解析器，日志格式为 `step,entropy` 表头和数值行；其他格式须通过config.task_adapter提供parse_train_log(content,k=1)并返回含train CSV字符串的字典。若没有entropy列，该监控不会凭空推断熵。Debugger的任务日志仍为 `log/<dataset>.txt` / `log/<dataset>_metric.txt`。
- 实验库和cognition分开：外部知识通过run_spec.cognition.seed_files导入，或上游CLI cognition-add；实验经验放节点experience，不能作为虚构文献混入cognition。
- 核对 `scienceevolve-rounds/`、`training/`、`requests/`、`responses/`、候选源码/原始日志、上游 `database/`、`steps/`、`best/`、`state.json` 和停止理由。不要手改state越过阶段。完整workflow覆盖不等于已复现论文的11任务/120测试集数值；实际科研结论必须来自本次真实实验。
