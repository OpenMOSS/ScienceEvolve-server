---
name: scienceevolve-autoresearch
description: 执行 autoresearch：Git keep/discard 的完整实验循环 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# autoresearch 完整协议

参考官方 `program.md` 的全部Setup、Experimentation、Logging和Experiment loop。此处为独立撰写的执行说明；未复制无独立许可证的上游文件。

## Setup

1. 确认Task版本、运行tag、从哪个原始master提交开始；创建不存在的`autoresearch/<tag>`分支。workspace应是专用Task checkout且工作树干净；否则先说明冲突，不能清除用户修改。记录初始SHA。
2. 完整读取README、prepare.py、train.py和pyproject/锁文件，记录只读文件哈希。确认数据shards、tokenizer、uv依赖和GPU真实存在。数据未准备时请求用户准备，不伪造训练。
3. 建立未跟踪的results.tsv，仅含`commit	val_bpb	memory_gb	status	description`五列表头。控制和日志放未跟踪的`.autoresearch/`，不能提交results.tsv。确认启动后先运行原始基线，写keep记录。

## 每轮（无默认总轮数上限）

- 保存当前Git父版本；仅改train.py并git commit。固定prepare.py的evaluate_bpb、数据、300秒训练时间窗和依赖；不通过修改评测获得提升。
- 执行`uv run train.py`，完整stdout/stderr重定向到本轮日志。超10分钟总墙钟终止该任务进程。脚本输出的training_seconds与启动/编译时间分别保存。
- 成功输出解析val_bpb和peak_vram_mb（memory_gb=peak_vram_mb/1024，保留一位小数）；主指标越低越好，VRAM为软约束。缺输出/异常先看trace，简单错误可修复重跑，几次仍失败或方向根本不可行则crash。每次修复提交代码并留日志，不能偷偷换目标。
- 比较收益与复杂度：明确改善通常keep；相同或近似性能且显著简化也可keep；微小改善引入明显复杂度可discard。把理由写description，不把简化条件偷偷改为只接受严格数值改善。
- 每次评估追加一行：短commit、val_bpb、memory_gb、keep/discard/crash、描述。crash按原格式使用0.000000和0.0，选择逻辑先检查status避免把0当最优。timeout按失败处理并记录具体原因。
- keep留在候选commit；discard/crash回到本轮父commit。仅恢复本轮已授权train.py变更，专用分支的Git HEAD须与代码一致；保存被丢弃SHA以便审计。发现无关用户改动时暂停，不覆盖。
- 返回Main继续，没想法或多轮无提升不是终止条件；直到用户中止。允许用户显式提供预算作为其需求覆盖，禁止模板自加10次限制。

## 恢复

核对控制记录、HEAD、只读文件哈希及本轮运行状态。已有完整日志/TSV记录的候选不重复训练；半完成实验先查进程和日志再决定继续/重跑。Task代码Git回退不要求也不冒充Agent会话回退。研究者保留失败经验；不能删除日志来掩盖失败。

候选完成后使用`scripts/finish_trial.py --workspace <Task> --candidate <SHA> --parent <本轮父SHA> --status keep|discard|crash --val-bpb <实际值> --peak-vram-mb <实际值> --description <理由>`落盘和更新Git。先由select按原收益/复杂度原则决策；脚本执行原五列日志和真实Git恢复，拒绝非train.py改动、未提交用户更改和重写既有决策。基线记录仍按上游Setup完成，不把基线作为需要回退的候选。
