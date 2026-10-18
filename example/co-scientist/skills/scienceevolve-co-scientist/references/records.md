# 持久状态输入

命令通用形式：`python <skill>/scripts/pool.py --root <workspace/co-scientist> <command> --input <json>`。init/replan使用`--plan`，pair/stats无input；init可用`--options`覆盖显式工程参数。

- plan：`goal`、`criteria`、`constraints`、`stop_condition`；包含实际完整材料路径、版本、实验分支与用户限制。
- add：`summary`、`category`、`mechanism`、`assumptions`、`evidence`、`test_plan`、`source`（generation/evolution/expert）；可指定`id`，evolution还需`parents`和`strategy`。父本不变。证据应有具体来源/材料路径，不以Elo作证据。
- review：`hypothesis`（ID）、`kind`（initial/full/deep_verification/observation/simulation/recurrent）、`decision`（pass/reject/not_applicable）、`rationale`，以及完整`evidence`和原文文件路径。initial必须先pass；not_applicable须说明已检查哪些事实以及为何不适用。
- graph：数组，每项`a`、`b`、`similarity`（0到1）、`rationale`。相似度必须来自实际分析；聚类阈值0.8是本地展示参数，不是论文公开值。
- pair：返回真实调度的`id/a/b/epoch/mode`，写入事件。Main将此记录完整交ranking。
- match：保留pair全部字段，补`winner`（a或b的ID，或tie）、`rationale`、完整`debate`（数组，speaker/content）、`order_swapped_check`（交换呈现后的实际结果/理由）。debate模式至少两方四次发言；是本实现多轮的最小门槛，不声称论文固定4turn。重复提交同ID相同内容不重复计分。
- feedback：`recurring_issues`、`agent_feedback`（各角色对应意见）、`research_overview`、`experiments`、`contacts`。无可确认联系人时contacts为空并在报告中解释，不编造。

pool.json保存完整候选/评审/比赛原文或路径、初始与后续plan、RNG、事件和meta版本。每次调用带锁原子写入；先检查候选内容哈希。实验记录放`experiments/<hypothesis-id>/<job-id>/`，反思/evolution引用真实日志和原始数据。
