# 真实科研 Task 与原子评测工具

模板执行完整 RRSI 算法，Task 由用户科研需求决定。`task_setup` 需要实际源码、数据、grader、执行环境和 frozen policy；不能用一个“以后接入”的空命令交差。共享服务可外部提供。下面是工具合同，不是可运行的假成绩示例。

## 输入冻结文件 environment.json

所有路径为绝对路径。Task setup 实际准备并验证后生成此文件；Main 的 configure 校验并复制 harness 到独立 Git 仓库。配置、数据分割、方法参数与冻结文件均记录哈希。后续不能修改。

```json
{
  "environment": {},
  "policy_model": "实际冻结的Task模型标识",
  "substitutions": ["所用模型/Task/工具与论文的具体差异及保留的能力"],
  "frozen_files": [{"path": "/absolute/evaluator.py", "sha256": "实际文件SHA256"}],
  "parameters": {"delta": null},
  "task": {
    "description": "科研目标、任务输入、成功条件、可修改harness范围、真实执行/评测能力",
    "harness_source": "/absolute/original-harness",
    "evaluate_argv": ["/absolute/python", "/absolute/evaluator.py"],
    "evaluate_cwd": "/absolute/evaluator-project",
    "policy_model": "实际冻结的Task模型标识",
    "evolve_ids": ["e1", "e2"],
    "heldout_ids": ["h1", "h2"],
    "smoke_ids": ["e1"],
    "weights": {"e1": 1, "e2": 1, "h1": 1, "h2": 1},
    "constitution": "冻结Task的禁止事项、交付契约、可编辑接口与实验隔离要求",
    "patterns": "对应Task的通用harness优化模式，禁止写入测试答案/评测内部细节",
    "source_exts": [".py", ".md", ".txt", ".json"],
    "briefs": {
      "analyst": "领域与评分语义、失败/能力缺口/成功行为的实际证据结构",
      "digester": "轨迹、交付物、grader反馈的解释，如何区分infra failure与科学失败",
      "proposer": "harness接口、工具能力、输入/输出合同与不可修改的边界",
      "critic": "领域泄漏、任务特化、grader gaming及其他禁止模式"
    },
    "component_signals": [["config", ["实际配置文件/参数的diff正则"]]],
    "critic_patterns": [["实际任务/答案/评分内部标识的正则", "拒绝理由"]],
    "guards": [
      {"metric": "valid_rate", "direction": "max_drop", "limit": 0.03, "missing_value": 0},
      {"metric": "no_payload_rate", "direction": "max_rise", "limit": 0.02, "missing_value": 1}
    ]
  },
  "heldout": [{"name": "预登记的泛化评测集", "ids": ["h1", "h2"], "k": 4}]
}
```

上面的 ID/路径/正则只解释格式，必须换成完整真实数据。task_setup 需逐项填写实际组件分类规则，至少覆盖 Task 中存在的 prompt/control_flow/config/output_plumbing/context_mgmt 与结构机制；源实现 generic signals 会补充 memory/skill/client_tool/subagent。验证样例 diff 不会把纯 prompt 文字误计为新工具。guard 可依据实际 Task 定义，不能没有理由地删除原有非补偿性标准。

`frozen_files` 应覆盖 evaluator/数据清单/隐藏 grader/rubric/判断阈值/Task adapters，以及 evaluator 导入的本地代码。巨大数据可冻结内容寻址清单，但必须由实际 evaluator 验证内容哈希。不要仅写一个 README 的哈希。模型认证凭据继承启动环境，不写进 JSON；environment 仅放非敏感的模型路由、依赖路径、服务地址等固定配置。

默认使用 eng 原参数。新任务的规模/统计量不一定和论文61×4相同，`parameters` 的显式修改、校准来源及原因必须在 substitutions 中说明。delta=null 使用 unchanged H0 的 trial bootstrap（官方支持的校准方式），不能拿 heldout 成绩调 delta。需要 repeated-base 校准时应事先冻结独立基线测量协议；本模板默认使用官方单基线 bootstrap 分支。

## evaluator 的可执行合同

控制器执行：

```text
evaluate_argv + [absolute_request_json]
```

request 包含 `harness_dir`（当前候选worktree内源码）、`task_ids`、`k`、`output_dir`、`job`、`policy_model`。工具必须：

1. 从指定 harness_dir 加载 harness；模型、输入、工具与 grader 固定。候选不能接触评测器、隐藏答案或其他 trial 状态。
2. 对完整 task_ids 每项执行 k 个独立 trial；真实调用 policy/工具/模拟器或实验服务。分别保存完整轨迹、交付物、grader证据和**实际** policy 输入+输出 token 数。即使任务失败也保存真实证据，reward=0。基础设施未完成的 trial 不伪造成科学失败记录，留作 missing。
3. 以 `(job, task_id, trial)` 幂等：重启只补缺失，完成的测量和随机样本不得重抽。用临时文件+原子rename保存 trials.json；必要时先查询外部 job 状态。
4. 最后写 `output_dir/trials.json`，每个实际完成 trial 一条：

```json
{
  "task_id": "冻结的task ID",
  "trial": 0,
  "reward": 0.0,
  "tokens": 12345,
  "trace": "/absolute/实际完整轨迹.txt",
  "grader_evidence": "/absolute/实际判分证据.txt",
  "live": true,
  "summary": "真实运行摘要",
  "extra": {"valid_rate": 1, "no_payload_rate": 0}
}
```

数值仅说明数据类型。reward必须是实际评分、范围[0,1]，高为好；tokens必须来自实际模型计量。权重在配置中冻结，缺失的 trial 保留其权重并计零，不能缩小分母。`live` 是独立 liveness 判断：源码可加载、harness成功构造、必要接口正常且实际产生有效提交；不得只凭进程退出码填 true。需要“smoke score>0”的领域也必须纳入 live 判定。

可将已有正式 benchmark runner 作为原子工具，适配其真实产物为此合同；不能把上游完整 RRSI 外循环塞进 evaluator。测试用 synthetic evaluator 只存在于测试文件，不可用于实际科研运行或宣称支持已验收。

## 科研场景与原始实验的边界

推荐用真实工程设计或科学代码任务作 Task：已有可运行harness、物理约束/verifier、evolve设计目标与未参与选择的设计目标；guards同时约束可行率和缺交付率。task_setup 从用户实际项目准备这些能力，而不是生成随机数评分示例。

归档保留 coding/workspace/eng 官方 adapter、原始harness与benchmark工具供实际接入使用；当前模板统一走上述 Task 合同，不自动冒用作者未发布的评测资产。若需求是论文原八套benchmark配置一字不差，必须先完成专项核对中列出的外部协议/资产核实，再配置 Task；不能以普通 weighted score 取代 Frontier Medal、JobBench 双judge或GDPval三模型双顺序裁决。
