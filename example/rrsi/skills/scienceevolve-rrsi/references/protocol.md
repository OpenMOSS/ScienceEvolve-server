# RRSI 执行协议

本模板复现论文 Algorithms 1–2 的完整方法，采用官方 `google-research/rrsi@be50316e1db05914068a973f322770ef08ed7ba1` 的角色协议和确定性算法。它接受实际科研 Task 的等能力替换，**不声称恢复作者未公开的三域实验资产或复现论文数值**。论文原评测的具体差异见项目 `docs/sdk/rrsi-fidelity-audit.md`。

## Task 与 research workflow

Task 是冻结 policy 驱动的、可编辑源码的 harness 在固定任务集合上的实际运行。研究流程是 Main、analyst、digester、proposer、critic、measurement、selector、heldout、audit。Task 内即使有 subagent，也不是自动向 research workflow 加节点。研究 workflow 不进化，`allowMainReconfiguration=false`，没有 Evolver。

`rrsi-task/` 是独立 Git 仓库；只有 `task-harness/` 进入候选 diff。每轮 A/B 均从同一个 incumbent 建立独立 worktree。评测器、数据、模型与方法配置不属于可编辑内容。

## 完整状态与分支

1. **setup**：建立真实 Task / 原子评测工具，冻结来源、模型、evolve / heldout / smoke IDs、领域 guards、组件分类、泄漏模式与参数。configure 后不得调参。
2. **baseline**：完整 evolve 集每任务 k 次；固定加权分母，缺失计零。缺失超过门槛则修复基础设施后恢复同一作业；不能拿缺失高的基线启动选择。保存 H0 commit、S、C、S*、轨迹和 BASELINE history。保存官方 bootstrap 校准；delta=null 时使用该校准，固定 delta 时保留固定值。
3. **analysis**：使用 incumbent 自身评测。最差任务取最差 trial，最好任务取最好 trial，并去除重叠；不足一半所需轨迹阻塞。analyst 只看 task table 和 digests，最多30轮；每次最多8项 digest 请求。独立 digester 的 failure / capability_gap / success 镜头、后续追问、15轮、每 digest 6000字符、工具反馈/输出上限均沿用原实现。保留失败模式/成功习惯命名跨轮记忆。
4. **directives**：计算余弦退火编辑预算、停滞标志、已测/未测组件、保留探索槽、近窗无正收益组件及其已接受机制剪枝指令。完整 history 持久化；官方 proposer 输入使用最近40条（最多4条未测失败），归因 scoreboard 最近20条。
5. **proposal**：m 个候选独立提出；每候选最多40轮、80次文件修改操作，独立编辑数不得超过 b_t。保存每项 component / hypothesis / targets_mode / predicted_affected / retroactive_check。包含 success-habit regression guard、最小复杂度、下层杠杆、触发条件、事后归因与原始 trace 工具。前三次 abort 被要求继续，第四次才退出，沿用上游协议。
6. **critic / repair**：确定性泄漏 precheck；完整差分包含新文件。模型检查 benchmark-specific 内容、grader gaming、隐藏组合编辑、死代码、跨 trial 污染与无界成本；JSON 最多3次解析尝试。初审后最多5次修复，修复从当前修改后的候选开始。通过后用实际 diff 校验组件标签；保留探索槽必须真的触及未测组件，否则再修复/拒绝。没有提案、预算/轮数用尽、审查拒绝都保留失败记录，不能跳到评测。
7. **smoke / evaluate**：提交候选 Git commit，真实 liveness smoke；失败即淘汰。所有存活候选完整 evolve 集 × k，缺失过高重试一次（只补缺失）；仍无效则 eval_invalid。异常也记 eval_invalid，不伪造分数。原始任务记录保存实际 policy token 数，不能把研究角色成本当 Task 成本。
8. **selection**：调用官方 select_round，不能由语言模型改阈值或选择。先历史最佳 floor，再 gain-dependent cost / within-band shaped rule，再各项独立 domain guard；在 admissible 候选中 argmax S，平分按 A/B 次序，无候选则保留 incumbent。允许带内略降分但满足所有门槛的候选；不能另加“必须严格升分”。S* 仅随被选中的 incumbent 更新。
9. **history / attribution**：每独立编辑记一条；同一 bundle 共享实测 deltaS/deltaC，ACCEPTED / LOST / REJECTED / gate failures 区分。记录预测命中和未预测回归。只有 measured edit 更新 tried；novelty 是从未出现在 winning edits 中的结构组件类型数。官方 accepted counts 为累计接受记录，不假装是删除机制后的源码静态计数。
10. **next round**：完成全部 T 轮；无进步不擅自早停。STOP 只在轮间暂停，保留精确状态。每轮选择通过持久 transaction 幂等写 frontier/history/Git ref，恢复不重复记账。
11. **heldout / audit**：冻结最终 incumbent；每个预登记 surface 对 H0 / champion 两臂使用同一固定 policy/工具/k，完整分母、缺失计零、单报基础设施失败。结果不可反馈给进化/调参。核对所有 T 轮和所有 heldout receipts 的哈希后才能 export。

## 数学规则

```text
b_t = ceil(b_min + (b_max-b_min)*(1+cos(pi*t/T))/2)
sigma_t = 1[S_t-S_(t-w) <= delta]，t<w 时为0
DeltaS = S_candidate - S_incumbent
DeltaC = (C_candidate-C_incumbent)/C_incumbent
floor: S_candidate >= S_star-delta
DeltaS > delta: DeltaC <= beta0 + beta1*DeltaS
否则: w_s*DeltaS - w_c*DeltaC + w_n*novelty > 0（严格）
```

K 为 prompt/control_flow/config/output_plumbing/context_mgmt/client_tool/skill/memory/subagent；结构子集为最后四项。新颖性不是任意 diff 大小或提案自评分。prune 使用官方近期最大 deltaS≤0 的已测组件，未测尝试不能假装负证据。

## Profile 与能力替换

| profile | T / k / m | b_min..b_max | delta | beta0 / beta1 | w_s / w_c / w_n | n_prune |
|---|---|---|---|---|---|---|
| coding | 20 / 2 / 2 | 1..4 | .017 | .1 / 44.5 | 0 / 15 / .5 | 4 |
| workspace | 20 / 2 / 2 | 1..3 | .004 | .1 / 35.4 | 1414 / 15 / .5 | 4 |
| eng（默认） | 40 / 4 / 2 | 1..4 | .020 | .15 / 24.4 | 244 / 2 / .5 | 5 |

共同 w=3、m_draft=1、repair_rounds=5。Task 更换后可在 configure 前显式设置 parameters；新的统计量应校准 delta（设 null），并声明成本/分数单位和权重依据。不能暗中把 T、k、m 缩小以通过验收。

workflow 的研究角色默认为 gpt-6-sol，替换论文 Claude Opus4.8；Task policy 独立冻结。模型能力不因名字相同自动保证，需要实际任务验收。独立 digest 请求按原顺序串行执行，保持各自完整上下文和 batch barrier；替换的是并行调度吞吐，不合并角色、不共享额外信息。三个官方实例的候选评测默认 eval_parallel=1，本模板保留全部候选测量后再选择。

## 恢复与边界

角色每个 generate 调用变成 durable ticket。响应不可修改，重放检查完整输入哈希；proposer 每次从该 repair attempt 的起始快照重放文件动作，防止重复替换。LLM transport 被 SCIENCEEVOLVE 替换；脚本禁止调用上游 search-model client。读取/编辑动作和解析仍由原协议执行。

SDK Ctrl-C/pause 保存调度状态；控制器保存科学状态。两者必须保留，不能拿 Git checkout 当 Agent 会话回退。外部评测器必须按固定 job/trial ID 幂等，不能因重启重新抽样已完成任务。控制器文件锁防止并发写状态；工作目录访问约束是协议约束，实际 Task runner 仍需隔离候选与评测器/隐藏答案。官方 digester Bash allowlist 不是完整操作系统沙箱，不能据此宣称实现了强隔离。
