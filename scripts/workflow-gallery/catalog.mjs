// Presentation notes only. Stage membership never changes executable routes.
const stage = (title, ids) => ({ title, ids: ids.split(' ') });
export const gallery = [
  {
    id: 'dynamic-research-workflow', title: '通用科研 / General research',
    scope: '入门分工模板，不对应某篇论文。Main 协调选题、执行、写作与评审。',
    method: ['研究问题 / Question', '构思 / Idea', '实验 / Execution', '写作与评审 / Write + review'],
    feedback: '评审反馈由 Main 决定交回相应角色；下方是实际路由，不是科学结果。',
    source: 'example/dynamic-research-workflow/workflow.json', stages: []
  },
  {
    id: '01-ahe-evolve', title: 'AHE · 代码自进化 / Code evolution',
    scope: '入门代码改进示例；不认证为 AHE 论文完整系统。',
    method: ['执行 / Execute', '评分 / Judge', '改进 / Optimize', '批次裁决 / Main'],
    feedback: 'execute → judge → optimizer → execute；Loop 批次退出到 Main，不等于自动终止项目。',
    source: 'example/01-ahe-evolve/workflow.json', stages: []
  },
  {
    id: '02-software-development', title: '软件开发 / Software development',
    scope: '入门开发与独立测试模板，不是论文复现。',
    method: ['需求 / Task', '实现 / Coding', '独立测试 / Testing', '交付 / Delivery'],
    feedback: '测试不通过回 coding 修复；通过后按真实交付条件完成。',
    source: 'example/02-software-development/workflow.json', stages: []
  },
  {
    id: 'aris', title: 'ARIS',
    scope: '官方协议适配；作者侧 Pi，跨模型评审。星形路由表示调度，不是阶段顺序。',
    method: ['W1 · 选题 / Ideas', 'W1.5 · 实验桥接 / Bridge', 'W2 · 研究 / Research', 'Summary → W3（条件写作）'],
    feedback: 'review continuation 返回发起评审的阶段；W3 仅在 AUTO_WRITE 条件满足时进入。',
    source: 'https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/341f914024d270dc5c8fa51337d1ad38829273aa/skills/research-pipeline/SKILL.md',
    stages: [stage('W1 · 文献、想法与评审', 'literature ideas novelty refine reviewer'), stage('W1.5 / W2 · 研究与反馈', 'bridge research_loop summary reviewer'), stage('W3 · 条件写作与论文评审', 'paper_plan figures paper_write paper_compile paper_improve paper_assurance paper_reviewer')]
  },
  {
    id: 'metaharness', title: 'Meta-Harness',
    scope: '文本分类参考任务；提案 Agent 外围的执行与分析角色是宿主分工。',
    method: ['基线 / Baseline', '提案 / Propose', '固定评测 / Evaluate', '日志与筛选 / Analyze'],
    feedback: '评测日志 → 下轮提案；搜索与冻结后的最终 test 分离，不能用测试集选候选。',
    source: 'https://arxiv.org/html/2603.28052v1', stages: []
  },
  {
    id: 'autoresearch', title: 'autoresearch',
    scope: '官方 Git keep/discard 循环的角色拆分适配。',
    method: ['基线 / Baseline', '修改 train.py / Propose', '固定时长训练 / Train', 'Keep / discard / crash'],
    feedback: '保留或回退后再提案；单次训练预算与整个研究停止预算分别核对。',
    source: 'https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md', stages: []
  },
  {
    id: 'funsearch', title: 'FunSearch · 串行参考适配 / Serial reference',
    scope: '对齐官方单线程参考实现，不是论文分布式异步系统。程序数据库是工具状态，不是缺失的 Agent。',
    method: ['程序库 / Programs DB', 'Best-shot prompt', '采样 / Sample', '评估 → 入库 / Evaluate'],
    feedback: '真实得分回写多岛程序库；工具按策略重置岛。一个 pending prompt 批次处理完才取下一批。',
    source: 'https://www.nature.com/articles/s41586-023-06924-6', stages: []
  },
  {
    id: 'agent-laboratory', title: 'Agent Laboratory',
    scope: '七阶段由 Main/Skill 管理；角色会跨阶段复用。MLE-solver 按固定公开源码串行尝试。',
    method: ['文献 → 计划 / Literature + plan', '数据 → 实验 / Data + experiment', '解释 → 写作 / Interpret + write', '评审 / Review'],
    feedback: '代码/论文求解器内部有执行、评分与修正；公开代码在候选严格改善时反思，不等同论文所有批量并行描述。',
    source: 'https://arxiv.org/html/2501.04227v1',
    stages: [stage('研究阶段 · 同一角色可跨阶段复用', 'phd postdoc ml_engineer sw_engineer professor'), stage('代码求解器 · 串行尝试与反馈', 'code_propose code_execute code_reward code_reflect'), stage('论文求解器与三位评审', 'paper_propose paper_execute paper_reward review_1 review_2 review_3')]
  },
  {
    id: 'sciagents', title: 'SciAgents',
    scope: '同时支持 fixed 与自动 speaker；不能把所有科学角色强制画成并行。',
    method: ['图路径 / Graph path', '本体与提案 / Ontology + proposal', '七方面细化 / Refinement', '批评与新颖性 / Critique'],
    feedback: 'fixed 模式按协议顺序；automated 由管理者选 speaker，保留反馈，不以星形图推断缺少方法顺序。',
    source: 'https://arxiv.org/html/2409.05556v1',
    stages: [stage('图推理与提案', 'planner assistant ontologist scientist'), stage('七方面细化', 'hypothesis_agent outcome_agent mechanism_agent design_principles_agent unexpected_properties_agent comparison_agent novelty_agent'), stage('批评、新颖性与报告', 'critic_agent novelty_assistant report')]
  },
  {
    id: 'robin', title: 'Robin · 公开代码适配 / Public-code adaptation',
    scope: '真实实验由外部研究人员完成并上传数据；公开代码为 5 条分析轨迹，论文描述 10 条。',
    method: ['Assay 选择', '候选筛选 / Candidates', '人类实验 / Human experiment', '5 analyses → 共识 → 洞见'],
    feedback: '真实测量与洞见 → 后续候选/实验；analysis 节点内部调用远程并行轨迹，不能把节点数当轨迹数。',
    source: 'https://arxiv.org/html/2505.13400v1',
    stages: [stage('Assay 检索与筛选', 'assay_queries assay_literature assay_proposals assay_reports assay_rank'), stage('候选检索与筛选', 'candidate_queries candidate_literature candidate_proposals candidate_reports candidate_rank'), stage('外部实验后 · 分析与下一轮', 'analysis consensus interpret followup')]
  },
  {
    id: 'co-scientist', title: 'Google AI co-scientist · 同步适配 / Synchronous',
    scope: '六个核心科学角色；Main 同步调度代替论文异步队列。wetlab 是外部验证扩展，不是第七个原生核心角色。',
    method: ['生成 / Generation', '反思 / Reflection', 'Proximity → Ranking', '进化 / Evolution'],
    feedback: '共享 hypothesis / tournament 状态；进化新候选重新评审与排名；Meta-review 反馈后续角色。',
    source: 'https://arxiv.org/html/2502.18864v1',
    stages: [stage('核心科学角色 · 同步调度', 'generation reflection proximity ranking evolution meta_review'), stage('外部验证扩展', 'wetlab')]
  },
  {
    id: 'biomni', title: 'Biomni A1 / E1',
    scope: '论文是单个 generalist A1 使用 E1 环境；下方多角色拆分 A1 内部步骤，不代表论文原生多科学家团队。',
    method: ['资源检索 / Retrieval', 'A1 规划与代码', 'E1 执行 / Environment', 'Observation → A1'],
    feedback: 'bridge 保留生成/执行/观察转移；critic 可选，wetlab 是外接扩展，环境不是额外决策 Agent。',
    source: 'https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1.full', stages: []
  },
  {
    id: 'agentrxiv', title: 'AgentRxiv · 单实验室模板 / Single lab',
    scope: '一个 workflow 实例代表一个 lab。多 lab 必须独立启动并共享 archive；archive 角色是客户端。',
    method: ['检索 archive / Retrieve', '独立实验室 / Laboratory', '发布论文 / Publish', '后续轮次消费 / Reuse'],
    feedback: 'Lab A ⇄ 共享 archive ⇄ Lab B 属于部署层；单次启动不证明跨实验室协作。求解器沿用 Laboratory 的公开源码限制。',
    source: 'https://arxiv.org/html/2503.18102v1',
    stages: [stage('单实验室研究与 archive 客户端', 'phd postdoc ml_engineer sw_engineer professor archive'), stage('代码求解器', 'code_propose code_execute code_reward code_reflect'), stage('写作、评审与发布准备', 'paper_propose paper_execute paper_reward review_1 review_2 review_3')]
  },
  {
    id: 'rrsi', title: 'RRSI',
    scope: '控制器维护编辑预算、正则化与固定划分；不是简单选最高分。',
    method: ['Baseline → 诊断 / Digest', '预算内提案 / Propose', 'Critic / repair → 测量', '正则化选择 / Select'],
    feedback: '选择结果 → 下一轮诊断与提案；搜索结束后冻结 Harness 再做 heldout，不用 heldout 选候选。',
    source: 'https://arxiv.org/html/2609.24972v1',
    stages: [stage('准备、诊断与候选修复', 'task_setup analyst digester proposer critic'), stage('测量、正则化选择与冻结评测', 'measurement selector heldout audit')]
  },
  {
    id: 'drugevolve', title: 'DrugEvolve',
    scope: 'Researcher / Engineer / Analyst 三域；控制器内保存生成-检查与训练-调试循环。',
    method: ['Generator ⇄ Inspector', 'Implementer', 'Trainer ⇄ Debugger', 'Judger → Analyst → Memory'],
    feedback: 'Idea Pool / Experience Pool → 下一代；工具里的实际分支不能用直接连线替代，否则会绕过 controller。',
    source: 'https://www.biorxiv.org/content/10.64898/2026.08.16.745117v1.full',
    stages: [stage('Researcher / Engineer', 'generator inspector implementer trainer debugger'), stage('评价、分析与记忆反馈', 'judger analyzer summarizer')]
  },
  {
    id: 'scientist-two', title: 'ScientistTwo',
    scope: '49 个角色是注册表，不是 49 个线性阶段。protocol.py 管理条件分支、实验状态与评审接续。',
    method: ['候选 / Ideas', 'Subset → Full（Good / Bad / Engineer）', '消融 → 论文 / Ablation + paper', '评审 / Rebuttal → Meta-review'],
    feedback: 'Bad 修订想法；Engineer 修复执行；Good 才推进；Meta-review 可再实验或保留旧最佳，不把所有候选都画成成功。',
    source: 'https://arxiv.org/html/2609.19644v1',
    stages: [stage('任务、局限与种子', 'task_setup limitation_extract limitation_verify seed_generate novelty_check'), stage('Baseline / Subset · 评价与修复', 'baseline_coding subset_coding subset_critic subset_engineering'), stage('Full · 进化与选择', 'full_coding full_critic full_engineering spec_filter idea_evolve selector'), stage('消融与结果对照', 'ablation_plan ablation_coding ablation_critic result_comparison'), stage('论文草稿与质量整合', 'draft_outline draft_literature draft_figures draft_sections draft_quality draft_quality_merge'), stage('内容与格式；评审准备', 'content_refine format_review format_fix review_summary review_literature review_expand'), stage('评审证据与问答', 'review_historian review_baselines novelty_questions soundness_questions novelty_answer soundness_answer'), stage('同行评审、rebuttal 与 meta-review', 'peer_review rebuttal_plan rebuttal_coding paper_enhancer meta_review'), stage('引用、方法与最终审计', 'reference_verify method_audit integrity_writer score_reproduce final_spec_audit export')]
  },
  {
    id: 'ai-scientist-v2', title: 'AI Scientist v2',
    scope: '缩小任务适配；四个实验阶段和 checkpoint / replication / aggregation 保存在 manager 与 tree tools。',
    method: ['构思 / Idea', '四阶段树搜索 / Experiments', '写作 → Reflection', '独立评审 / Reviewer'],
    feedback: 'manager ⇄ experiments；组内两个 worker 不是四个实验阶段。Reflection 在最终评审之前，不擅加 reviewer → writer 回边。',
    source: 'https://arxiv.org/html/2504.08066v1', stages: []
  },
  {
    id: 'internagent-1-5', title: 'InternAgent 1.5',
    scope: 'Generation 含知识流与假设；Verification 管理 optimization 并复核；Evolution 更新证据和记忆。',
    method: ['Generation · 知识 + 假设', 'Verification · 搜索 + 实验 + 复核', 'Evolution · SPM / TEM / SKM', '下一轮 / Next cycle'],
    feedback: 'verification ⇄ optimization；固定双槽知识流引入批次屏障，不等同论文任意动态依赖就绪调度。',
    source: 'https://arxiv.org/html/2602.08990v1', stages: []
  },
  {
    id: 'biomni-r0', title: 'Biomni-R0 · 待核验 / Unverified design',
    scope: '原训练 / reward recipe 尚不足以核验；官方报告在 2026-11-12 审计时返回 404。缺 recipe 必须阻断。',
    method: ['核验 recipe / Preflight', '真实轨迹与奖励 / Rollout + reward', '训练 → 部署 / Train + deploy', '固定划分复评 / Evaluate'],
    feedback: '这是带前置条件的训练合同设计，不是经原报告认证的训练流程；成品推理不算训练复现。',
    source: 'https://huggingface.co/biomni/Biomni-R0-32B-Preview', stages: []
  },
  {
    id: 'chemical-coscientist', title: '化学 Coscientist / Chemical Coscientist',
    scope: 'Planner 按需调用工具，各结果和错误直接返回 Planner。optimization 是可选分析扩展，不是必经阶段。',
    method: ['研究目标 / Goal', 'Planner', '按需 Web / Docs / Python / Experiment', '结果或错误 → Planner'],
    feedback: 'Python / Experiment 是执行能力；外部设备需授权。Preflight / audit 为宿主约束，不是原论文科学模块。',
    source: 'https://www.nature.com/articles/s41586-023-06792-0', stages: []
  },
  {
    id: 'raven', title: 'Raven · 受限双槽 / Limited batch',
    scope: 'strict-host 保持阻断；仅明确 limited-batch 可验证双槽子项，不接受为完整 Raven。',
    method: ['Host / Main', 'Slot A ∥ Slot B', '批次边界 Judge', 'Host 决定下一批'],
    feedback: '原方法是依赖全部结算后的动态 DAG + 逐节点 Judge + 在线异常处理。当前批次骨架不具备这些完整语义。',
    source: 'https://github.com/EverMind-AI/Raven/releases/download/tech-report-v1/technical-report.pdf', stages: []
  },
  {
    id: 'kosmos', title: 'Kosmos · 缩小周期 / Reduced-scale cycles',
    scope: 'SDK 示例；两条轨迹、两轮分析，不代表原论文规模。world model 是工具状态。',
    method: ['规划 / Planner', '数据 ∥ 文献轨迹', '周期 World update', '再规划 / Report'],
    feedback: '下一周期实际消费带来源的 world evidence；原文按 cycle 更新，不要求改成完全异步。',
    source: 'https://arxiv.org/html/2511.02824v1', stages: []
  },
  {
    id: 'alphaevolve', title: 'AlphaEvolve · 缩小异步适配 / Reduced-scale',
    scope: 'SDK 示例；程序库、验证器与异步评测是工具层。两个 worker 内可消费已经完成的反馈。',
    method: ['Parent + inspirations', '生成差分 / Generate', '异步评测 / Evaluate', '程序库反馈 / Database'],
    feedback: '不要为图整齐添加全局逐代屏障；固定几何任务与缩小预算不等于原论文规模或结果复现。',
    source: 'https://arxiv.org/html/2506.13131v1', stages: []
  }
];
