(function () {
  "use strict";

  var RUNTIME_MODE = new URLSearchParams(window.location.search).get("runtime") === "1";
  var runtimeRoutes = null;
  var runtimeGraphKey = "";
  // Runtime layout is presentation-only. Keep drag positions across host
  // snapshots without ever writing them back to the workflow draft.
  var runtimeLayoutOverrides = {};
  var runtimeScopeId = null;
  var runtimeScopeKey = null;
  var runtimeScopeViews = Object.create(null);
  var runtimeHostPositions = Object.create(null);

  // This branch intentionally uses the original direct-edge workflow model.
  // The selector-based implementation is preserved on the workflow-selector
  // branch; separate storage keys keep the two demos from sharing drafts.
  var DIRECT_EDGE_MODE = true;
  var DRAFT_KEY = DIRECT_EDGE_MODE ? "scienceevolve-agent-flow-draft-direct" : "scienceevolve-agent-flow-draft";
  var SAVED_KEY = DIRECT_EDGE_MODE ? "scienceevolve-agent-flow-saved-direct" : "scienceevolve-agent-flow-saved";
  var AGENT_LIBRARY_KEY = DIRECT_EDGE_MODE ? "scienceevolve-agent-library-direct" : "scienceevolve-agent-library";
  var TEMPLATE_PREFS_KEY = DIRECT_EDGE_MODE ? "scienceevolve-agent-flow-template-prefs-direct" : "scienceevolve-agent-flow-template-prefs";
  var SHOWCASE_VERSION_KEY = "scienceevolve-agent-flow-showcase-version-direct";
  var SHOWCASE_VERSION = "2026-08-29-workflow-refresh";
  var WORKFLOW_SCHEMA_VERSION = 10;
  var PALETTE = {
    green: ["#25714e", "#e7f1e9"],
    blue: ["#446b9b", "#eaf0f7"],
    teal: ["#16828a", "#e3f3f2"],
    amber: ["#b56f17", "#fff2d9"],
    violet: ["#76599d", "#f1ebf8"],
    rose: ["#a65365", "#f9eaed"]
  };
  var PORT_LABELS = { top: "上方", right: "右侧", bottom: "下方", left: "左侧" };
  // Keep the demo's Agent fields aligned with openfars' AgentConfig shape.
  // The catalog is local for now; the backend can replace these options later.
  var SKILL_CATALOG = [
    { id: "builtin:awesome-ai-research-writing-director", name: "科研写作总监", description: "统筹科研任务、证据和交付质量。" },
    { id: "builtin:ccf-literature-searcher", name: "文献检索", description: "检索并整理相关文献与证据。" },
    { id: "builtin:ccf-literature-monitor", name: "文献追踪", description: "持续关注领域进展和关键引用。" },
    { id: "builtin:ccf-experiment-designer", name: "实验设计", description: "设计实验、基线、指标和消融方案。" },
    { id: "builtin:inspire", name: "Inspire 计算", description: "使用项目计算环境完成分析任务。" },
    { id: "builtin:nature-figure", name: "Nature 图表", description: "生成适合科研交付的图表。" },
    { id: "builtin:ccf-paper-writer", name: "论文写作", description: "组织证据并生成论文结构。" },
    { id: "builtin:ccf-paper-reviewer", name: "论文审查", description: "检查论证、引用和交付质量。" },
    { id: "builtin:nature-writing", name: "Nature 写作", description: "润色科研叙事和表达。" }
  ];
  // Keep these values aligned with openfars' AgentPermission union.
  var PERMISSION_OPTIONS = [
    { id: "workspace", name: "工作区权限", description: "工作区范围内的普通执行环境，使用隔离 HOME。" },
    { id: "compute", name: "Compute 权限（实验）", description: "保留 Inspire wrapper、Workload ledger 和 compute usage 统计。" },
    { id: "yolo", name: "YOLO 权限（最高）", description: "使用 Codex 的完全访问参数，不附加产品层限制。" }
  ];
  var DEFAULT_AGENT_RUNTIME = {
    main: { skills: ["builtin:awesome-ai-research-writing-director"], autoSkills: [], permission: "yolo" },
    research: { skills: ["builtin:ccf-literature-searcher", "builtin:ccf-literature-monitor"], autoSkills: [], permission: "workspace" },
    experiment: { skills: ["builtin:ccf-experiment-designer"], autoSkills: [], permission: "compute" },
    analysis: { skills: ["builtin:inspire"], autoSkills: [], permission: "compute" },
    writer: { skills: ["builtin:ccf-paper-writer", "builtin:nature-writing"], autoSkills: [], permission: "workspace" },
    reviewer: { skills: ["builtin:ccf-paper-reviewer"], autoSkills: [], permission: "workspace" }
  };
  var AGENTS = [
    { id: "main", type: "main", builtin: true, name: "Main Agent", model: "gpt-5.6-sol", description: "理解目标、协调上下文并负责工作流中的总体判断。", color: "green" },
    { id: "planner", name: "Planner Agent", model: "gpt-5.6-sol", description: "整理任务边界和执行计划，供 Main Agent 调度。", color: "green" },
    { id: "research", name: "Research Agent", model: "gpt-5.6-sol", description: "检索资料、建立问题边界和证据清单。", color: "blue" },
    { id: "experiment", name: "Experiment Agent", model: "gpt-5.6-sol", description: "制定数据、基线、指标和消融方案。", color: "teal" },
    { id: "analysis", name: "Analysis Agent", model: "gpt-5.6-terra", description: "检查结果、归纳发现并形成证据结论。", color: "amber" },
    { id: "writer", name: "Writing Agent", model: "gpt-5.6-sol", description: "将证据组织为完整、清晰的科研叙事。", color: "violet" },
    { id: "reviewer", name: "Review Agent", model: "gpt-5.6-sol", description: "核验论证、结果和交付质量。", color: "rose" }
  ];
  var templates = {};
  var agentLibrary = [];

  var canvas = document.getElementById("canvas");
  var nodeLayer = document.getElementById("nodes");
  var edgeLayer = document.getElementById("edges");
  // The edge paths have their own group. Keep defs, the Main-control group,
  // and the pending-link group outside this redraw target.
  var edgeGroup = edgeLayer;
  var flowParticleLayer = document.getElementById("flow-particle-layer");
  var mainControlLayer = document.getElementById("main-control-layer");
  var pendingLayer = document.getElementById("pending-layer");
  var pendingEdge = document.getElementById("pending-edge");
  var inspector = document.getElementById("inspector");
  var library = document.getElementById("agent-library");
  var savedList = document.getElementById("saved-workflows");
  var savedCount = document.getElementById("saved-count");
  var nameField = document.getElementById("workflow-name");
  var stateLabel = document.getElementById("save-state");
  var connectButton = document.getElementById("connect-button");
  var clearCanvasButton = document.getElementById("clear-canvas-button");
  var undoButton = document.getElementById("undo-button");
  var canvasToolbar = document.querySelector(".canvas-toolbar");
  var toolbarLeadGroup = canvasToolbar && canvasToolbar.querySelector(".toolbar-group:first-child");
  var toolbarRightGroup = canvasToolbar && canvasToolbar.querySelector(".toolbar-right");
  var layoutControl = document.getElementById("layout-control");
  var layoutMenuButton = document.getElementById("layout-menu-button");
  var layoutMenu = document.getElementById("layout-menu");
  var alignmentGuides = document.getElementById("alignment-guides");
  var verticalAlignmentGuide = alignmentGuides && alignmentGuides.querySelector(".alignment-guide.vertical");
  var horizontalAlignmentGuide = alignmentGuides && alignmentGuides.querySelector(".alignment-guide.horizontal");
  var connectStatus = document.getElementById("connect-status");
  var toast = document.getElementById("toast");
  var dialog = document.getElementById("agent-dialog");
  var dialogForm = document.getElementById("agent-form");
  var flowDialog = document.getElementById("flow-dialog");
  var flowForm = document.getElementById("flow-form");
  var drag = null;
  var pan = null;
  var linkDrag = null;
  var selectedEdge = null;
  var viewport = { x: 0, y: 0, k: 1 };
  var MIN_ZOOM = 0.08;
  var MAX_ZOOM = 2.4;
  var ROUTE_NODE_GAP = 18;
  var ROUTE_PORT_LEAD = 24;
  var ROUTE_OUTER_GAP = 72;
  var ROUTE_CHANNEL_STEP = 16;
  var ROUTE_EPSILON = 0.5;
  var CLEAR_LANE_STEP = 32;
  var CLEAR_RAIL_STEP = 14;
  var CLEAR_RAIL_MARGIN = 18;
  var CLEAR_OUTER_GAP = 64;
  var TIDY_MIN_EDGE_LENGTH = 108;
  var TIDY_SELF_EDGE_LENGTH = 78;
  var currentSavedId;
  var activeSavedId;
  var dirty = false;
  var toastTimer;
  var edgeDrawFrame = null;
  var edgeRoutes = {};
  var mainControlHover = false;
  var hoveredControlGroup = null;
  var hoveredSelectorId = null;
  var hoveredNodeId = null;
  var directEdgeKind = "strong";
  var agentDialogMode = "canvas";
  var flowDialogMode = "new";
  var editingSavedId = null;
  var undoState = null;
  var activeInputUndoTarget = null;
  var activeInputUndoCaptured = false;
  var layoutAnimationFrame = null;
  var layoutBusy = false;
  var layoutEngine = typeof window.ELK === "function" ? new window.ELK() : null;
  // 拖动节点时锁定当前连线的拓扑，避免节点跨列后路由器突然切换车道。
  // 锁只保存前一帧的几何状态，不会写入工作流配置。
  var routeLock = null;

  // This is intentionally separate from the persisted Workflow object. The
  // demo can change the in-memory topology while it runs without changing a
  // user's saved draft or its undo history.
  var demoRunButton = document.getElementById("demo-run-button");
  var demoStageButton = document.getElementById("demo-stage-button");
  var gifExportButton = document.getElementById("gif-export-button");
  var runStatusBar = document.getElementById("run-status-bar");
  var runStatusDot = document.getElementById("run-status-dot");
  var runStatusLabel = document.getElementById("run-status-label");
  var runStatusDetail = document.getElementById("run-status-detail");
  var runScenarioLabel = document.getElementById("run-scenario-label");
  var runCurrentAgent = document.getElementById("run-current-agent");
  var runParallelCount = document.getElementById("run-parallel-count");
  var runVersion = document.getElementById("run-version");
  var runPauseButton = document.getElementById("run-pause-button");
  var runStopButton = document.getElementById("run-stop-button");
  var runFloatingUpdate = document.getElementById("run-floating-update");
  var runDispatchNote = document.getElementById("run-dispatch-note");
  var runLogPanel = document.getElementById("run-log-panel");
  var runLogList = document.getElementById("run-log-list");
  var runLogToggle = document.getElementById("run-log-toggle");
  var demoScenarioSelector = document.getElementById("demo-scenario-selector");
  var selectedDemoScenarioId = "quick";
  var demoRun = {
    active: false,
    hasRun: false,
    paused: false,
    stopped: false,
    stageMode: false,
    stagePaused: false,
    stageBoundaryIndex: -1,
    phase: "idle",
    scenarioId: "quick",
    scenarioLabel: "30s 快速演示",
    scenarioDuration: 30000,
    events: [],
    startedAt: 0,
    elapsed: 0,
    currentEventIndex: -1,
    workflowVersion: 1,
    focusNodeId: null,
    currentAgentId: null,
    runningAgentIds: [],
    completedAgentIds: [],
    skippedAgentIds: [],
    addedAgentIds: [],
    removedAgentIds: [],
    addedEdgeIds: [],
    removedEdgeIds: [],
    updatedEdgeIds: [],
    skippedEdgeIds: [],
    activeEdgeIds: [],
    edgeData: {},
    nodeStates: {},
    nodeResults: {},
    nodeMoves: [],
    movingAgentIds: [],
    floatingUpdate: null,
    dispatchNote: "",
    detail: "",
    log: [],
    logExpanded: false,
    pendingRemovals: [],
    pendingEdgeRemovals: [],
    originalWorkflow: null
  };

  var gifExport = {
    active: false,
    phase: "idle",
    encoder: null,
    canvas: null,
    width: 0,
    height: 0,
    frameInterval: 150,
    nextCaptureAt: 0,
    lastCapturedAt: -1,
    capturePending: false,
    capturePromise: null,
    lastImageData: null,
    boundaryTimer: null,
    finalizing: false,
    segment: 0,
    segmentReady: false
  };

  // One ordered story powers both modes. The fast mode is the primary Demo;
  // the full mode deliberately has the same actions and topology, with more
  // time to inspect each Main decision.
  var DEMO_BASE_DURATION = 30000;
  var DEMO_STORY_EVENTS = [
    { at: 0, type: "run:start", message: "开始播放三阶段动态编排 Demo" },
    { at: 300, type: "agent:complete", agentId: "input", message: "用户输入已接收", data: "task_context", dispatchTo: ["main"] },
    { at: 650, type: "agent:start", agentId: "main", message: "Main Agent 正在理解科研任务", data: "task_context" },
    { at: 1050, type: "agent:complete", agentId: "main", message: "Main Agent 准备编排第一版 Workflow", data: "execution_plan" },

    { at: 1200, type: "main:replace-termination", removeOnly: true, message: "Main 正在移除直达结束路径", reason: "先建立并运行 v1，再决定是否可以交付", duration: 420 },
    { at: 1500, type: "main:move-agents", message: "Main 正在为 v1 Workflow 预留交付位置", content: "结束节点移动到最终交付位置", reason: "为逐步扩展的业务节点保留稳定画布空间", duration: 650, moves: [{ agentId: "end", position: { x: 1530, y: 250 } }] },
    { at: 2200, type: "main:create-agent", agentId: "planner", name: "Planner Agent", nodeType: "planner", color: "green", description: "整理任务边界和第一轮执行计划。", reason: "先建立一版可执行的任务拆解", position: { x: 456, y: 250 }, duration: 440 },
    { at: 2750, type: "main:create-edge", edgeId: "main-planner", source: "main", target: "planner", kind: "weak", message: "Main 正在建立 Planner 调度线", content: "execution_plan", reason: "把首轮规划交给 Planner Agent", duration: 400 },
    { at: 3300, type: "main:create-agent", agentId: "research", name: "Research Agent", nodeType: "research", color: "blue", description: "检索资料并建立初步证据清单。", reason: "为第一轮分析准备研究证据", position: { x: 672, y: 74 }, duration: 440 },
    { at: 3850, type: "main:create-edge", edgeId: "planner-research", source: "planner", target: "research", kind: "strong", message: "Main 正在建立 Planner 到 Research 的路径", content: "research_scope", reason: "按首轮计划启动资料研究", duration: 400 },
    { at: 4400, type: "main:create-agent", agentId: "experiment", name: "Experiment Agent", nodeType: "experiment", color: "teal", description: "执行基线、指标和实验验证。", reason: "用实验检验关键假设", position: { x: 672, y: 426 }, duration: 440 },
    { at: 4950, type: "main:create-edge", edgeId: "planner-experiment", source: "planner", target: "experiment", kind: "strong", message: "Main 正在建立 Planner 到 Experiment 的路径", content: "experiment_scope", reason: "按首轮计划并行验证假设", duration: 400 },
    { at: 5500, type: "main:create-agent", agentId: "analysis", name: "Analysis Agent", nodeType: "analysis", color: "amber", description: "汇总研究和实验结果，形成初步结论。", reason: "需要统一判断第一轮结果", position: { x: 888, y: 250 }, duration: 440 },
    { at: 6050, type: "main:create-edge", edgeId: "research-analysis", source: "research", target: "analysis", kind: "strong", message: "Main 正在建立 Research 到 Analysis 的路径", content: "research_evidence", reason: "把研究证据交给 Analysis 汇总", duration: 400 },
    { at: 6500, type: "main:create-edge", edgeId: "experiment-analysis", source: "experiment", target: "analysis", kind: "strong", message: "Main 正在建立 Experiment 到 Analysis 的路径", content: "experiment_result", reason: "让 Analysis 对照实验与研究结果", duration: 400 },
    { at: 6950, type: "main:create-agent", agentId: "writer", name: "Writing Agent", nodeType: "writer", color: "violet", description: "将第一轮结论组织为科研叙事。", reason: "为通过验证的结论预留写作路径", position: { x: 1104, y: 95 }, duration: 440 },
    { at: 7500, type: "main:create-edge", edgeId: "analysis-writer", source: "analysis", target: "writer", kind: "strong", message: "Main 正在建立 Analysis 到 Writing 的路径", content: "draft_outline", reason: "第一轮方案假设 Analysis 可直接进入写作", duration: 400 },
    { at: 7950, type: "main:create-agent", agentId: "reviewer", name: "Review Agent", nodeType: "reviewer", color: "rose", description: "核验论证、引用和交付质量。", reason: "为最终交付设置独立质量闸门", position: { x: 1320, y: 425 }, duration: 440 },
    { at: 8500, type: "main:create-edge", edgeId: "writer-reviewer", source: "writer", target: "reviewer", kind: "strong", message: "Main 正在建立 Writing 到 Review 的路径", content: "draft_context", reason: "写作完成后必须进入质量复核", duration: 400 },
    { at: 8950, type: "main:replace-termination", agentId: "reviewer", message: "Main 正在指定 v1 的结束入口", reason: "Review 通过后才允许进入结束节点", duration: 400 },

    { at: 9300, type: "agent:start", agentId: "planner", message: "Planner Agent 正在拆解首轮执行计划", data: "execution_plan" },
    { at: 9850, type: "agent:complete", agentId: "planner", message: "Planner Agent 已分派研究与实验任务", data: "planned_tasks", dispatchTo: ["research", "experiment"] },
    { at: 10100, type: "parallel:start", agentIds: ["research", "experiment"], message: "Main 正在并行执行 Research 与 Experiment", dataByAgent: { research: "research_scope", experiment: "experiment_scope" } },
    { at: 11200, type: "agent:complete", agentId: "research", message: "Research Agent 返回初步证据", data: "research_evidence", dispatchTo: ["analysis"] },
    { at: 11600, type: "agent:complete", agentId: "experiment", message: "Experiment Agent 返回不稳定的实验结果", data: "experiment_result", dispatchTo: ["analysis"], status: "failed", result: "基线方差 18%", resultTone: "warning" },
    { at: 12000, type: "agent:start", agentId: "analysis", message: "Analysis Agent 正在汇总研究与实验结果", data: "combined_findings" },
    { at: 13000, type: "agent:complete", agentId: "analysis", message: "Analysis Agent 判断当前结论无法进入交付", data: "analysis_report", status: "failed", result: "3 项关键结论无法交叉确认", resultTone: "warning" },
    { at: 13400, type: "main:observe-results", message: "Main 正在读取 Analysis Agent 的汇总结果", content: "实验方差过高；3 项关键结论无法交叉确认", reason: "当前 v1 Workflow 不满足进入写作与复核的条件", duration: 1000 },

    { at: 14500, type: "main:update-agent-config", agentId: "research", kind: "prompt", message: "Main 正在更新 Research Agent Prompt", resource: "优先交叉验证来源，标记无法确认的结论，并输出可追溯证据等级", reason: "先提高下一轮研究证据的可靠性", duration: 1050 },
    { at: 15700, type: "main:remove-agent", agentId: "planner", message: "Main 正在移除 Planner Agent", content: "首轮规划粒度不足，改由 Main 直接编排验证路径", reason: "Main 需要直接掌控下一轮动态分流", duration: 720 },
    { at: 16500, type: "main:create-edge", edgeId: "main-research", source: "main", target: "research", kind: "weak", message: "Main 正在建立 Main 到 Research 的新调度线", content: "revised_execution_plan", reason: "移除 Planner 后由 Main 直接启动 v2", duration: 400 },
    { at: 17000, type: "main:remove-agent", agentId: "experiment", message: "Main 正在移除 Experiment Agent", content: "基线方差 18%，当前实验分支不再采用", reason: "删除低可靠实验路径及其关联边", duration: 820 },
    { at: 17900, type: "main:create-agent", agentId: "source-check", name: "Source Check Agent", nodeType: "custom", color: "teal", description: "交叉验证来源、引用和证据链。", reason: "补足 v1 缺失的来源核验能力", position: { x: 672, y: 250 }, duration: 440 },
    { at: 18400, type: "main:create-edge", edgeId: "research-source-check", source: "research", target: "source-check", kind: "weak", message: "Main 正在建立 Research 到 Source Check 的路径", content: "source_candidates", reason: "让来源核验独立于原有 Analysis", duration: 400 },
    { at: 18850, type: "main:create-agent", agentId: "data-validation", name: "Data Validation Agent", nodeType: "custom", color: "blue", description: "检查数据完整性、异常值和可复现条件。", reason: "以独立数据验证替代不稳定实验分支", position: { x: 672, y: 440 }, duration: 440 },
    { at: 19350, type: "main:create-edge", edgeId: "research-data-validation", source: "research", target: "data-validation", kind: "weak", message: "Main 正在建立 Research 到 Data Validation 的路径", content: "dataset_context", reason: "把数据质量检查加入新的验证阶段", duration: 400 },
    { at: 19800, type: "main:create-agent", agentId: "evidence-merge", name: "Evidence Merge Agent", nodeType: "custom", color: "green", description: "汇聚多路验证结果并确认可交付证据。", reason: "把汇总职责从 Analysis 拆分为独立质量闸门", position: { x: 888, y: 250 }, duration: 440 },
    { at: 20300, type: "main:create-edge", edgeId: "analysis-merge", source: "analysis", target: "evidence-merge", kind: "strong", message: "Main 正在建立 Analysis 汇聚边", content: "analysis_result", reason: "保留可追溯的分析结论", duration: 380 },
    { at: 20750, type: "main:create-edge", edgeId: "source-check-merge", source: "source-check", target: "evidence-merge", kind: "strong", message: "Main 正在建立 Source Check 汇聚边", content: "verified_sources", reason: "把来源核验作为独立证据输入", duration: 380 },
    { at: 21200, type: "main:create-edge", edgeId: "data-validation-merge", source: "data-validation", target: "evidence-merge", kind: "strong", message: "Main 正在建立 Data Validation 汇聚边", content: "validated_data", reason: "把数据验证作为独立证据输入", duration: 380 },
    { at: 21650, type: "main:remove-edge", edgeId: "analysis-writer", message: "Main 正在收回 Analysis 到 Writing 的旧路径", content: "Analysis 不能再直接进入写作", reason: "写作必须等待 Evidence Merge 完成质量汇聚", duration: 620 },
    { at: 22300, type: "main:create-edge", edgeId: "merge-writer", source: "evidence-merge", target: "writer", kind: "strong", message: "Main 正在建立 Evidence Merge 到 Writing 的路径", content: "merged_evidence", reason: "只让通过质量闸门的证据进入写作", duration: 400 },
    { at: 22800, type: "main:strengthen-edge", edgeIds: ["analysis-merge", "source-check-merge", "data-validation-merge"], message: "Main 正在确认 v2 的三路验证输入", reason: "保留分析、来源和数据三类互补证据", duration: 460 },
    { at: 23400, type: "main:move-agents", message: "Main 正在重排 v2 验证链", content: "Research、Analysis、Writing、Review 移入新的汇聚布局", reason: "让新旧节点、三路验证和最终交付路径保持可读", duration: 900, moves: [
      { agentId: "research", position: { x: 456, y: 250 } },
      { agentId: "analysis", position: { x: 672, y: 60 } },
      { agentId: "writer", position: { x: 1104, y: 250 } },
      { agentId: "reviewer", position: { x: 1320, y: 250 } }
    ] },

    { at: 24450, type: "agent:start", agentId: "research", message: "Research Agent 正在按 Prompt v2 重新检索证据", data: "revised_execution_plan" },
    { at: 25050, type: "agent:complete", agentId: "research", message: "Research Agent 返回已分级的证据清单", data: "verified_research", dispatchTo: ["analysis", "source-check", "data-validation"], result: "证据已标注可追溯等级", resultTone: "success" },
    { at: 25200, type: "parallel:start", agentIds: ["analysis", "source-check", "data-validation"], message: "Main 正在并行执行 v2 三路验证", dataByAgent: { analysis: "verified_research", "source-check": "source_candidates", "data-validation": "dataset_context" } },
    { at: 26150, type: "agent:complete", agentId: "analysis", message: "Analysis Agent 返回可追溯结论边界", data: "analysis_result", dispatchTo: ["evidence-merge"], result: "结论边界已确认", resultTone: "success" },
    { at: 26450, type: "agent:complete", agentId: "source-check", message: "Source Check Agent 完成来源交叉验证", data: "verified_sources", dispatchTo: ["evidence-merge"], result: "来源交叉验证通过", resultTone: "success" },
    { at: 26750, type: "agent:complete", agentId: "data-validation", message: "Data Validation Agent 完成数据验证", data: "validated_data", dispatchTo: ["evidence-merge"], result: "数据完整性通过", resultTone: "success" },
    { at: 26900, type: "agent:start", agentId: "evidence-merge", message: "Evidence Merge Agent 正在汇聚三路结果", data: "validation_bundle" },
    { at: 27400, type: "agent:complete", agentId: "evidence-merge", message: "Evidence Merge Agent 确认证据链可交付", data: "merged_evidence", dispatchTo: ["writer"], result: "证据置信度 91%", resultTone: "success" },
    { at: 27600, type: "agent:start", agentId: "writer", message: "Writing Agent 正在组织可追溯科研叙事", data: "merged_evidence" },
    { at: 28000, type: "agent:complete", agentId: "writer", message: "Writing Agent 返回结构化科研草稿", data: "draft_context", dispatchTo: ["reviewer"], result: "草稿已包含证据边界", resultTone: "success" },
    { at: 28200, type: "agent:start", agentId: "reviewer", message: "Review Agent 正在进行最终质量复核", data: "draft_context" },
    { at: 28700, type: "agent:complete", agentId: "reviewer", message: "Review Agent 通过最终交付复核", data: "approved_delivery", dispatchTo: ["end"], result: "交付质量通过", resultTone: "success" },
    { at: 30000, type: "run:complete", message: "三阶段动态 Workflow Demo 执行完成" }
  ];

  function demoEventsForDuration(duration) {
    var scale = duration / DEMO_BASE_DURATION;
    return DEMO_STORY_EVENTS.map(function (event) {
      var copy = clone(event);
      copy.at = Math.round(event.at * scale);
      if (Number.isFinite(Number(event.duration))) copy.duration = Math.round(Number(event.duration) * scale);
      return copy;
    });
  }

  var QUICK_EVENTS = demoEventsForDuration(30000);
  var FULL_EVENTS = demoEventsForDuration(60000);

  var DEMO_SCENARIOS = {
    quick: { id: "quick", label: "30s 快速演示", duration: 30000, events: QUICK_EVENTS },
    full: { id: "full", label: "60s 完整演示", duration: 60000, events: FULL_EVENTS }
  };

  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // Convert captured RGBA frames to a deterministic 3-3-2 palette. The actual
  // GIF stream is written by the vendored, tested omggif encoder.
  function GifEncoder(width, height, loop) {
    if (typeof window.GifWriter !== "function") throw new Error("GIF 编码器未加载，请刷新页面后重试");
    this.width = width;
    this.height = height;
    this.palette = [];
    for (var index = 0; index < 256; index += 1) {
      var red = Math.round(((index >> 5) & 7) * 255 / 7);
      var green = Math.round(((index >> 2) & 7) * 255 / 7);
      var blue = Math.round((index & 3) * 255 / 3);
      this.palette.push((red << 16) | (green << 8) | blue);
    }
    var estimatedSize = Math.max(1024, width * height * 2 + 65536);
    this.buffer = new Uint8Array(estimatedSize);
    this.writer = new window.GifWriter(this.buffer, width, height, { loop: loop === false ? null : 0, palette: this.palette });
  }

  GifEncoder.prototype.ensureCapacity = function () {
    var required = this.writer.getOutputBufferPosition() + this.width * this.height * 2 + 65536;
    if (required <= this.buffer.length) return;
    var nextLength = Math.max(required, this.buffer.length * 2);
    var nextBuffer = new Uint8Array(nextLength);
    nextBuffer.set(this.buffer.subarray(0, this.writer.getOutputBufferPosition()));
    this.buffer = nextBuffer;
    this.writer.setOutputBuffer(this.buffer);
  };

  GifEncoder.prototype.addFrame = function (imageData, delayMs) {
    if (!imageData || !imageData.data) return;
    this.ensureCapacity();
    var pixels = imageData.data;
    var indices = new Uint8Array(this.width * this.height);
    for (var i = 0, pixel = 0; i < indices.length; i += 1, pixel += 4) {
      indices[i] = ((pixels[pixel] >> 5) << 5) | ((pixels[pixel + 1] >> 5) << 2) | (pixels[pixel + 2] >> 6);
    }
    this.writer.addFrame(0, 0, this.width, this.height, indices, {
      delay: Math.max(1, Math.round(Number(delayMs || 100) / 10)),
      disposal: 1
    });
  };

  GifEncoder.prototype.blob = function () {
    var end = this.writer.end();
    return new Blob([this.buffer.subarray(0, end)], { type: "image/gif" });
  }

  function createUndoSnapshot(label) {
    return {
      label: label || "上一步操作",
      workflow: clone(workflow),
      viewport: clone(viewport),
      selected: selected,
      selectedEdge: selectedEdge,
      currentSavedId: currentSavedId,
      activeSavedId: activeSavedId,
      dirty: dirty,
      routeLock: routeLock ? clone(routeLock) : null
    };
  }

  function updateUndoControl() {
    if (!undoButton) return;
    undoButton.disabled = !undoState || layoutBusy;
    undoButton.title = layoutBusy ? "布局调整进行中" : undoState ? "撤销：" + undoState.label : "没有可撤销的操作";
    undoButton.setAttribute("aria-label", undoButton.title);
  }

  function setUndoSnapshot(snapshot) {
    undoState = snapshot || null;
    updateUndoControl();
  }

  function pushUndo(label) {
    activeInputUndoTarget = null;
    activeInputUndoCaptured = false;
    setUndoSnapshot(createUndoSnapshot(label));
  }

  function clearUndo() {
    setUndoSnapshot(null);
  }

  function captureInputUndo(target, label) {
    if (activeInputUndoTarget !== target) {
      activeInputUndoTarget = target;
      activeInputUndoCaptured = false;
    }
    if (activeInputUndoCaptured) return;
    setUndoSnapshot(createUndoSnapshot(label));
    activeInputUndoCaptured = true;
  }

  function restoreUndo() {
    if (!undoState) return;
    var snapshot = undoState;
    clearUndo();
    drag = null;
    pan = null;
    cancelConnection();
    workflow = normalizeWorkflow(snapshot.workflow);
    viewport = clone(snapshot.viewport);
    selected = snapshot.selected && getNode(snapshot.selected) ? snapshot.selected : getNode("input") ? "input" : workflow.nodes[0] && workflow.nodes[0].id;
    selectedEdge = snapshot.selectedEdge && workflow.edges.some(function (edge) { return edge.id === snapshot.selectedEdge; }) ? snapshot.selectedEdge : null;
    currentSavedId = snapshot.currentSavedId;
    activeSavedId = snapshot.activeSavedId;
    routeLock = snapshot.routeLock ? clone(snapshot.routeLock) : null;
    activeInputUndoTarget = null;
    activeInputUndoCaptured = false;
    changed(snapshot.dirty);
    renderSaved();
    render();
    showToast("已撤销：" + snapshot.label);
  }

  function html(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function initials(value) {
    return (Array.from(String(value)).filter(function (character) { return character.trim(); }).slice(0, 2).join("") || "AG").toUpperCase();
  }

  function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    var seen = {};
    return value.map(function (entry) { return String(entry == null ? "" : entry).trim(); }).filter(function (entry) {
      if (!entry || seen[entry]) return false;
      seen[entry] = true;
      return true;
    }).slice(0, 32);
  }

  function normalizeMcpServers(value) {
    if (!Array.isArray(value)) return [];
    var seen = {};
    return value.map(function (entry) {
      if (!entry || typeof entry !== "object") return null;
      var name = String(entry.name == null ? "" : entry.name).trim();
      var url = String(entry.url == null ? "" : entry.url).trim();
      if (!name || !url) return null;
      return { name: name.slice(0, 120), url: url.slice(0, 2048) };
    }).filter(function (entry) {
      if (!entry) return false;
      var key = entry.name.toLowerCase() + "\u0000" + entry.url;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 32);
  }

  function normalizePermission(value, fallback) {
    var permission = String(value == null ? "" : value).trim();
    if (permission === "workspace" || permission === "compute" || permission === "yolo") return permission;
    var defaultPermission = String(fallback == null ? "workspace" : fallback);
    return defaultPermission === "workspace" || defaultPermission === "compute" || defaultPermission === "yolo" ? defaultPermission : "workspace";
  }

  function permissionInfo(permission) {
    return PERMISSION_OPTIONS.find(function (option) { return option.id === permission; }) || PERMISSION_OPTIONS[0];
  }

  function makeNode(id, type, name, _legacyLabel, model, color, x, y, description) {
    var runtime = DEFAULT_AGENT_RUNTIME[id] || {};
    var isMain = id === "main" || type === "main";
    var isInput = id === "input" || type === "input";
    var isEnd = id === "end" || type === "end";
    return {
      id: id,
      type: type,
      name: name,
      model: model,
      color: color,
      x: x,
      y: y,
      description: description,
      instructions: "",
      choicePrompt: "",
      skills: Array.isArray(runtime.skills) ? runtime.skills.slice() : [],
      autoSkills: Array.isArray(runtime.autoSkills) ? runtime.autoSkills.slice() : [],
      mcpServers: [],
      permission: normalizePermission(runtime.permission, isMain ? "yolo" : "workspace"),
      // These are front-end orchestration settings. Main is always persistent;
      // ordinary child Agents start with a fresh session by default.
      sessionPersistence: isMain ? true : false,
      decisionBy: "main",
      system: isMain || isInput || isEnd,
      fixed: false
    };
  }

  function makeEndNode(x, y) {
    var node = makeNode("end", "end", "结束", DIRECT_EDGE_MODE ? "终止节点" : "终止模块", DIRECT_EDGE_MODE ? "system" : "control", "rose", x == null ? 1240 : x, y == null ? 210 : y, DIRECT_EDGE_MODE ? "被指定的结束 Agent 完成后进入这里。" : "只有被选中的结束 Agent 才能通过 Main 的判断进入这里；可按锚点模式固定或移动。" );
    node.fixed = false;
    if (!DIRECT_EDGE_MODE) {
      node.selectorLabel = "结束 / Main";
      node.allowReturnToMain = true;
    }
    node.instructions = DIRECT_EDGE_MODE ? "满足终止条件后结束工作流。" : "Main 判断终止条件是否满足。";
    return node;
  }

  function makeSelectorNode(id, name, x, y, description, color) {
    var node = makeNode(id, "selector", name || "选择器", "Main 决策选择", "control", color || "amber", x == null ? 540 : x, y == null ? 210 : y, description || "由 Main 从多个候选 Agent 中选择下一步。" );
    node.selectorLabel = "Main 选择";
    node.system = false;
    node.fixed = false;
    return node;
  }

  function makeMainSelectorNode(x, y) {
    var node = makeSelectorNode("selector-main", "Main 常驻选择器", x == null ? 500 : x, y == null ? 210 : y, "所有返回 Main 的补充输入、异常和中途回流，都由 Main 通过这里选择下一步。", "green");
    node.system = true;
    node.selectorLabel = "Main 总控选择";
    return node;
  }

  function makeTerminationEdge(source, previous) {
    var edge = previous && typeof previous === "object" ? clone(previous) : {};
    edge.id = edge.id || "termination-edge";
    edge.source = source;
    edge.target = "end";
    // A termination candidate is a third edge semantic. It enters the
    // terminal gate for final acceptance and is not an optional Agent path.
    edge.kind = "termination";
    edge.termination = true;
    edge.sourcePort = validPortSide(edge.sourcePort) ? edge.sourcePort : "right";
    edge.targetPort = validPortSide(edge.targetPort) ? edge.targetPort : "left";
    edge.sourcePortPinned = Boolean(previous && previous.sourcePortPinned);
    edge.targetPortPinned = Boolean(previous && previous.targetPortPinned);
    return edge;
  }

  function directStarter() {
    var input = makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 260, "用户提交的任务、约束和已有资料。" );
    var main = makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 245, 260, "理解目标，并从多条候选研究路径中选择下一步。" );
    return {
      schemaVersion: 7,
      edgeModel: "direct",
      anchorMode: "free",
      viewLayout: "free",
      name: "科研协作 · 扇出汇聚",
      mainAgentId: "main",
      inputTarget: "main",
      terminationAgentId: "reviewer",
      terminationCondition: "质量审查通过，结果已经满足科研交付条件。",
      nodes: [
        input,
        main,
        makeNode("research", "research", "Research Agent", "资料研究", "gpt-5.6-sol", "blue", 490, 70, "检索资料、建立问题边界和证据清单。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验设计", "gpt-5.6-sol", "teal", 490, 260, "制定数据、基线、指标和消融方案。"),
        makeNode("analysis", "analysis", "Analysis Agent", "数据分析", "gpt-5.6-terra", "amber", 490, 450, "检查结果、归纳发现并形成证据结论。"),
        makeNode("writer", "writer", "Writing Agent", "证据整合", "gpt-5.6-sol", "violet", 735, 260, "汇聚多条研究路径，将证据组织为完整叙事。"),
        makeNode("reviewer", "reviewer", "Review Agent", "质量审查", "gpt-5.6-sol", "rose", 490, 620, "核验论证、结果和交付质量。"),
        makeEndNode(735, 620)
      ],
      edges: [
        { id: "input-edge", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "main-research", source: "main", target: "research", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "main-experiment", source: "main", target: "experiment", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "main-analysis", source: "main", target: "analysis", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "research-writer", source: "research", target: "writer", kind: "strong", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "experiment-writer", source: "experiment", target: "writer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "analysis-writer", source: "analysis", target: "writer", kind: "strong", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "bottom", targetPort: "right", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directReviewLoopShowcase() {
    return {
      schemaVersion: 7,
      edgeModel: "direct",
      anchorMode: "free",
      viewLayout: "free",
      name: "论文质量 · 审查闭环",
      mainAgentId: "main",
      inputTarget: "main",
      terminationAgentId: "reviewer",
      terminationCondition: "Review Agent 确认内容、证据与格式全部通过。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 70, "论文主题、材料与交付约束。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 20, 300, "组织论文生成与质量闭环。"),
        makeNode("research", "research", "Research Agent", "文献研究", "gpt-5.6-sol", "blue", 245, 300, "建立论点与引用证据。"),
        makeNode("writer", "writer", "Writing Agent", "初稿写作", "gpt-5.6-sol", "violet", 470, 70, "根据证据完成论文初稿或修订稿。"),
        makeNode("analysis", "analysis", "Analysis Agent", "论证核验", "gpt-5.6-terra", "amber", 470, 530, "复核数据、推理链与结论边界。"),
        makeNode("reviewer", "reviewer", "Review Agent", "质量审查", "gpt-5.6-sol", "rose", 715, 300, "决定返修写作、补充核验或结束。"),
        makeEndNode(960, 300)
      ],
      edges: [
        { id: "loop-input-main", source: "input", target: "main", kind: "strong", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-main-research", source: "main", target: "research", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-research-writer", source: "research", target: "writer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-analysis-reviewer", source: "analysis", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-reviewer-writer", source: "reviewer", target: "writer", kind: "weak", sourcePort: "top", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "loop-reviewer-analysis", source: "reviewer", target: "analysis", kind: "weak", sourcePort: "bottom", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directPipelineShowcase() {
    return {
      schemaVersion: 7,
      edgeModel: "direct",
      anchorMode: "free",
      viewLayout: "free",
      name: "实验研发 · 全链路",
      mainAgentId: "main",
      inputTarget: "planner",
      terminationAgentId: "reviewer",
      terminationCondition: "实验结果和最终报告均通过复核。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 56, "需求直接进入 Planner Agent。"),
        makeNode("planner", "planner", "Planner Agent", "任务规划", "gpt-5.6-sol", "green", 245, 56, "拆解目标、约束和验收标准。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 470, 56, "接收规划结果并调度执行链。"),
        makeNode("research", "research", "Research Agent", "资料研究", "gpt-5.6-sol", "blue", 695, 56, "准备数据、基线与相关资料。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验执行", "gpt-5.6-sol", "teal", 695, 276, "执行实验并记录可复现结果。"),
        makeNode("analysis", "analysis", "Analysis Agent", "结果分析", "gpt-5.6-terra", "amber", 470, 276, "解释指标、误差与消融结果。"),
        makeNode("writer", "writer", "Writing Agent", "报告生成", "gpt-5.6-sol", "violet", 470, 496, "形成结构化研究报告。"),
        makeNode("reviewer", "reviewer", "Review Agent", "交付复核", "gpt-5.6-sol", "rose", 695, 496, "检查实验与报告的一致性。"),
        makeEndNode(920, 496)
      ],
      edges: [
        { id: "pipe-input-planner", source: "input", target: "planner", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-planner-main", source: "planner", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-main-research", source: "main", target: "research", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-research-experiment", source: "research", target: "experiment", kind: "strong", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-experiment-analysis", source: "experiment", target: "analysis", kind: "strong", sourcePort: "left", targetPort: "right", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-analysis-writer", source: "analysis", target: "writer", kind: "strong", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipe-writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directAdaptiveShowcase() {
    return {
      schemaVersion: 7,
      edgeModel: "direct",
      anchorMode: "free",
      viewLayout: "free",
      name: "自适应研发 · 双层决策",
      mainAgentId: "main",
      inputTarget: "main",
      terminationAgentId: "validator",
      terminationCondition: "独立验证通过并形成可交付结果。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 70, "用户目标、上下文与约束。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 20, 300, "选择首轮专业执行路径。"),
        makeNode("planner", "planner", "Planner Agent", "方案规划", "gpt-5.6-sol", "green", 245, 70, "形成可执行方案。"),
        makeNode("research", "research", "Research Agent", "资料研究", "gpt-5.6-sol", "blue", 245, 300, "补充事实与证据。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验验证", "gpt-5.6-sol", "teal", 245, 530, "用实验检验关键假设。"),
        makeNode("analysis", "analysis", "Analysis Agent", "证据汇聚", "gpt-5.6-terra", "amber", 490, 300, "汇总路径结果并选择交付方式。"),
        makeNode("writer", "writer", "Writing Agent", "报告输出", "gpt-5.6-sol", "violet", 735, 130, "生成结构化说明与结论。"),
        makeNode("reviewer", "reviewer", "Review Agent", "技术复核", "gpt-5.6-sol", "rose", 735, 470, "进行严格的技术审查。"),
        makeNode("validator", "custom", "Validator", "独立验证", "custom", "teal", 960, 300, "对不同输出路径执行统一验收。"),
        makeEndNode(960, 570)
      ],
      edges: [
        { id: "adaptive-input-main", source: "input", target: "main", kind: "strong", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-main-planner", source: "main", target: "planner", kind: "weak", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-main-research", source: "main", target: "research", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-main-experiment", source: "main", target: "experiment", kind: "weak", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-planner-analysis", source: "planner", target: "analysis", kind: "strong", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-research-analysis", source: "research", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-experiment-analysis", source: "experiment", target: "analysis", kind: "strong", sourcePort: "top", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-analysis-writer", source: "analysis", target: "writer", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-analysis-reviewer", source: "analysis", target: "reviewer", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-writer-validator", source: "writer", target: "validator", kind: "strong", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "adaptive-reviewer-validator", source: "reviewer", target: "validator", kind: "strong", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("validator", { sourcePort: "bottom", sourcePortPinned: true })
      ]
    };
  }

  // Refreshed direct-mode showcases. Keep these as separate builders so the
  // template catalog can evolve without rewriting user-created saved flows.
  function directShowcaseDispatchDesk() {
    var input = makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 250, "研究目标、已有资料和交付约束。" );
    var main = makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 260, 250, "把研究任务拆成路径，并在每轮选择一个子 Agent。" );
    var analysis = makeNode("analysis", "analysis", "Analysis Agent", "证据分析", "gpt-5.6-terra", "amber", 560, 80, "比较证据质量、实验结果和结论边界。" );
    analysis.choicePrompt = "根据证据完整度和交付风险，在写作或质量复核之间选择下一步。";
    analysis.decisionBy = "agent";
    var reviewer = makeNode("reviewer", "reviewer", "Review Agent", "质量审查", "gpt-5.6-sol", "rose", 1120, 250, "核验论证、引用和最终交付质量。" );
    reviewer.sessionPersistence = true;
    return {
      schemaVersion: 10, edgeModel: "direct", viewLayout: "free",
      name: "科研情报 · Main 分流台", mainAgentId: "main", inputTarget: "main",
      terminationAgentId: "reviewer", weakDecisionBy: { analysis: "agent" },
      sessionPersistence: { reviewer: true },
      terminationCondition: "证据链完整、关键结论可追溯，且交付格式满足任务要求。",
      nodes: [
        input, main,
        makeNode("research", "research", "Research Agent", "文献检索", "gpt-5.6-sol", "blue", 560, 300, "检索资料并建立证据清单。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验验证", "gpt-5.6-sol", "teal", 560, 520, "制定基线、指标和可复现实验。"),
        analysis,
        makeNode("writer", "writer", "Writing Agent", "科研写作", "gpt-5.6-sol", "violet", 840, 80, "把证据组织为清晰的科研叙事。"),
        reviewer, makeEndNode(1400, 250)
      ],
      edges: [
        { id: "dispatch-input-main", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "dispatch-research-analysis", source: "research", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "dispatch-experiment-analysis", source: "experiment", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "dispatch-analysis-writer", source: "analysis", target: "writer", kind: "weak", sourcePort: "top", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "dispatch-analysis-reviewer", source: "analysis", target: "reviewer", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "dispatch-writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directShowcaseReviewGate() {
    var reviewer = makeNode("reviewer", "reviewer", "Review Agent", "质量审查", "gpt-5.6-sol", "rose", 1020, 260, "决定返修、补充核验或提交终止候选。" );
    reviewer.choicePrompt = "发现缺口时回到写作或核验；全部通过时提交终止候选。";
    return {
      schemaVersion: 10, edgeModel: "direct", viewLayout: "free",
      name: "论文交付 · 返修闭环", mainAgentId: "main", inputTarget: "research",
      terminationAgentId: "reviewer",
      terminationCondition: "正文、引用、图表和格式均通过质量审查，没有未处理的返修意见。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 260, "论文主题、材料和交付约束。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 250, 500, "协调资料、写作和质量审查的回流。"),
        makeNode("research", "research", "Research Agent", "文献研究", "gpt-5.6-sol", "blue", 250, 260, "建立论点、引用和证据清单。"),
        makeNode("writer", "writer", "Writing Agent", "初稿写作", "gpt-5.6-sol", "violet", 520, 260, "根据证据完成初稿或修订稿。"),
        makeNode("analysis", "analysis", "Analysis Agent", "论证核验", "gpt-5.6-terra", "amber", 760, 500, "复核数据、推理链和结论边界。"),
        reviewer, makeEndNode(1300, 260)
      ],
      edges: [
        { id: "gate-input-research", source: "input", target: "research", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "gate-research-writer", source: "research", target: "writer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "gate-writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "gate-reviewer-writer", source: "reviewer", target: "writer", kind: "weak", sourcePort: "top", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "gate-reviewer-analysis", source: "reviewer", target: "analysis", kind: "weak", sourcePort: "bottom", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "gate-analysis-reviewer", source: "analysis", target: "reviewer", kind: "strong", sourcePort: "left", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directShowcaseResearchPipeline() {
    var experiment = makeNode("experiment", "experiment", "Experiment Agent", "实验执行", "gpt-5.6-sol", "teal", 690, 270, "执行实验并记录可复现结果。" );
    experiment.sessionPersistence = true;
    var analysis = makeNode("analysis", "analysis", "Analysis Agent", "结果分析", "gpt-5.6-terra", "amber", 930, 270, "解释指标、误差和消融结果。" );
    analysis.sessionPersistence = true;
    return {
      schemaVersion: 10, edgeModel: "direct", viewLayout: "free",
      name: "实验研发 · 数据到结论", mainAgentId: "main", inputTarget: "planner",
      terminationAgentId: "reviewer", sessionPersistence: { experiment: true, analysis: true },
      terminationCondition: "实验结果可复现、关键指标有解释，且最终结论通过交付复核。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 270, "实验目标、数据和验收标准。"),
        makeNode("planner", "planner", "Planner Agent", "实验规划", "gpt-5.6-sol", "green", 260, 270, "拆解假设、变量、基线和验收标准。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 500, 520, "协调实验链路和异常回流。"),
        makeNode("research", "research", "Research Agent", "资料准备", "gpt-5.6-sol", "blue", 500, 70, "准备数据来源、相关工作和基线资料。"),
        experiment, analysis,
        makeNode("writer", "writer", "Writing Agent", "报告生成", "gpt-5.6-sol", "violet", 1170, 270, "形成结构化研究报告。"),
        makeNode("reviewer", "reviewer", "Review Agent", "交付复核", "gpt-5.6-sol", "rose", 1410, 270, "检查实验与报告的一致性。"),
        makeEndNode(1670, 270)
      ],
      edges: [
        { id: "pipeline-input-planner", source: "input", target: "planner", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipeline-planner-research", source: "planner", target: "research", kind: "strong", sourcePort: "top", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipeline-research-experiment", source: "research", target: "experiment", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipeline-experiment-analysis", source: "experiment", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipeline-analysis-writer", source: "analysis", target: "writer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "pipeline-writer-reviewer", source: "writer", target: "reviewer", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("reviewer", { sourcePort: "right", sourcePortPinned: true })
      ]
    };
  }

  function directShowcaseQualityGate() {
    var planner = makeNode("planner", "planner", "Planner Agent", "路径规划", "gpt-5.6-sol", "green", 500, 270, "在资料研究和实验验证之间选择路径。" );
    planner.choicePrompt = "结合任务约束，选择先做资料研究还是先做实验验证。";
    var analysis = makeNode("analysis", "analysis", "Analysis Agent", "证据汇聚", "gpt-5.6-terra", "amber", 990, 270, "汇总路径结果并选择交付方式。" );
    analysis.choicePrompt = "根据证据完整度和风险，在报告输出或技术复核之间选择下一步。";
    analysis.decisionBy = "agent";
    var validator = makeNode("validator", "custom", "Validator", "质量闸门", "custom", "teal", 1460, 270, "对不同输出路径执行统一验收。" );
    validator.sessionPersistence = true;
    return {
      schemaVersion: 10, edgeModel: "direct", viewLayout: "free",
      name: "多 Agent · 质量闸门", mainAgentId: "main", inputTarget: "main",
      terminationAgentId: "validator", weakDecisionBy: { planner: "main", analysis: "agent" },
      sessionPersistence: { validator: true },
      terminationCondition: "输出经过独立验证，关键指标和证据链达到可交付标准。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 270, "用户目标、上下文和约束。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 260, 270, "协调多条专业路径并掌握最终质量判断。"),
        planner,
        makeNode("research", "research", "Research Agent", "资料研究", "gpt-5.6-sol", "blue", 760, 90, "补充事实、证据和相关工作。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验验证", "gpt-5.6-sol", "teal", 760, 450, "检验关键假设和边界条件。"),
        analysis,
        makeNode("writer", "writer", "Writing Agent", "报告输出", "gpt-5.6-sol", "violet", 1220, 90, "生成结构化说明和结论。"),
        makeNode("reviewer", "reviewer", "Review Agent", "技术复核", "gpt-5.6-sol", "rose", 1220, 450, "进行严格的技术与交付审查。"),
        validator, makeEndNode(1720, 270)
      ],
      edges: [
        { id: "quality-input-main", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-main-planner", source: "main", target: "planner", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-planner-research", source: "planner", target: "research", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-planner-experiment", source: "planner", target: "experiment", kind: "weak", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-research-analysis", source: "research", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-experiment-analysis", source: "experiment", target: "analysis", kind: "strong", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-analysis-writer", source: "analysis", target: "writer", kind: "weak", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-analysis-reviewer", source: "analysis", target: "reviewer", kind: "weak", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-writer-validator", source: "writer", target: "validator", kind: "strong", sourcePort: "right", targetPort: "top", sourcePortPinned: true, targetPortPinned: true },
        { id: "quality-reviewer-validator", source: "reviewer", target: "validator", kind: "strong", sourcePort: "right", targetPort: "bottom", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("validator", { sourcePort: "bottom", sourcePortPinned: true })
      ]
    };
  }

  function builtinWorkflowRecords() {
    if (!DIRECT_EDGE_MODE) return [{ id: "starter-template", name: "科研协作模板", builtin: true, flow: starter() }];
    return [
      { id: "showcase-main-dispatch-v2", name: "科研情报 · Main 分流台", builtin: true, flow: directShowcaseDispatchDesk() },
      { id: "showcase-review-gate-v2", name: "论文交付 · 返修闭环", builtin: true, flow: directShowcaseReviewGate() },
      { id: "showcase-research-pipeline-v2", name: "实验研发 · 数据到结论", builtin: true, flow: directShowcaseResearchPipeline() },
      { id: "showcase-quality-gate-v2", name: "多 Agent · 质量闸门", builtin: true, flow: directShowcaseQualityGate() }
    ];
  }

  function blankWorkflow(name) {
    if (!DIRECT_EDGE_MODE) {
      var selectorFlow = starter();
      selectorFlow.name = name || "未命名流程";
      return selectorFlow;
    }
    return {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      edgeModel: "direct",
      viewLayout: "free",
      name: name || "未命名流程",
      mainAgentId: "main",
      inputTarget: null,
      terminationAgentId: null,
      weakDecisionBy: {},
      sessionPersistence: {},
      terminationCondition: "结束 Agent 的结果已经满足交付条件。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 20, 210, "用户提交的任务、约束和已有资料。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 300, 210, "理解目标、协调上下文，并在每轮选择一个子 Agent。"),
        makeEndNode(550, 210)
      ],
      edges: [
        { id: "input-edge", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("main", { id: "termination-main", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true })
      ]
    };
  }

  function starter() {
    if (DIRECT_EDGE_MODE) return directStarter();
    var input = makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 28, 210, "用户提交的任务、约束和已有资料。可按工作流锚点模式固定或移动。" );
    var main = makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 252, 210, "统一判断选择器候选，并协调所有子 Agent 的执行轨迹。" );
    return {
      schemaVersion: 6,
      anchorMode: "free",
      name: "科研协作工作流",
      mainAgentId: "main",
      inputTarget: "main",
      terminationAgentId: "reviewer",
      terminationCondition: "Main 判断结束 Agent 的结果已经满足交付条件。",
      nodes: [
        input,
        main,
        makeMainSelectorNode(500, 210),
        makeNode("research", "research", "Research Agent", "资料研究", "gpt-5.6-sol", "blue", 760, 54, "检索资料、建立问题边界和证据清单。"),
        makeNode("experiment", "experiment", "Experiment Agent", "实验设计", "gpt-5.6-sol", "teal", 760, 210, "制定数据、基线、指标和消融方案。"),
        makeNode("analysis", "analysis", "Analysis Agent", "数据分析", "gpt-5.6-terra", "amber", 760, 366, "检查结果、归纳发现并形成证据结论。"),
        makeNode("writer", "writer", "Writing Agent", "论文写作", "gpt-5.6-sol", "violet", 1010, 210, "将证据组织为完整、清晰的科研叙事。"),
        makeNode("reviewer", "reviewer", "Review Agent", "质量审查", "gpt-5.6-sol", "rose", 1260, 210, "核验论证、结果和交付质量。"),
        makeEndNode(1260, 210)
      ],
      edges: [
        { id: "input-edge", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left" },
        { id: "e2", source: "main", target: "selector-main", kind: "strong", selectorEntry: true, sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        { id: "e3", source: "selector-main", target: "research", kind: "weak" },
        { id: "e4", source: "selector-main", target: "experiment", kind: "weak" },
        { id: "e5", source: "selector-main", target: "analysis", kind: "weak" },
        { id: "e5b", source: "research", target: "writer", kind: "strong" },
        { id: "e6", source: "experiment", target: "writer", kind: "strong" },
        { id: "e7", source: "analysis", target: "writer", kind: "strong" },
        { id: "e8", source: "writer", target: "reviewer", kind: "strong" },
        makeTerminationEdge("reviewer")
      ]
    };
  }

  function isEndNode(item) {
    return Boolean(item) && (item.id === "end" || item.type === "end");
  }

  function isSelectorNode(item) {
    return Boolean(item) && (item.type === "selector" || (!DIRECT_EDGE_MODE && isEndNode(item)));
  }

  function isSystemSelectorNode(item) {
    return Boolean(item) && item.type === "selector" && (item.system === true || item.id === "selector-main");
  }

  function isChoiceOutputEdge(edge) {
    return !DIRECT_EDGE_MODE && Boolean(edge) && edge.kind === "weak" && edge.selector === true && !isTerminationEdge(edge);
  }

  function isTerminationEdge(edge) {
    return Boolean(edge) && (edge.termination === true || edge.target === "end");
  }

  function isOrdinaryWeakEdge(edge) {
    return Boolean(edge) && edge.kind === "weak" && !isTerminationWorkflowEdge(edge);
  }

  function isMainDispatchEdge(edge) {
    return Boolean(edge) && edge.source === "main" && edge.fixed === true && edge.systemRoute === "main-dispatch";
  }

  function rejectMainDispatchEdit(edge) {
    if (!isMainDispatchEdge(edge)) return false;
    showToast("Main 固定调度边由系统维护，不能编辑或删除");
    return true;
  }

  function businessWorkflowEdges() {
    return workflow.edges.filter(function (edge) { return !isMainDispatchEdge(edge); });
  }

  function ordinaryAgentIds() {
    var ids = {};
    workflow.nodes.forEach(function (item) {
      if (item && item.id !== "main" && item.type !== "main" && item.id !== "input" && !isEndNode(item) && item.type !== "selector") ids[item.id] = true;
    });
    return ids;
  }

  // Main's fixed dispatch set is derived from the current ordinary Agent set.
  // Keeping this in one place makes add/remove/import/clear paths converge on
  // the same invariant and prevents user actions from deleting a route.
  function syncMainDispatchEdges() {
    if (!DIRECT_EDGE_MODE) return false;
    // The runtime Demo owns its in-memory topology for the entire run,
    // including the completed state while the final graph is being inspected.
    // Do not turn Main's animated demo edges into editor-owned dispatch rails;
    // that would hide the transaction being demonstrated and would also
    // mutate the demo graph on every render. A stopped run clears hasRun and
    // returns to the normal editor invariant below.
    if (demoRun.hasRun) return false;
    var ids = ordinaryAgentIds();
    var changedRoutes = false;
    var seen = {};
    workflow.edges = workflow.edges.filter(function (edge) {
      if (edge.source !== "main") return true;
      // Demo startup intentionally uses Main -> End as a temporary
      // termination path. It is a real termination edge, not a dispatch
      // route, so keep it while Main decides how to expand the graph.
      if (isTerminationWorkflowEdge(edge)) return true;
      if (!ids[edge.target]) {
        changedRoutes = true;
        return false;
      }
      if (seen[edge.target]) {
        changedRoutes = true;
        return false;
      }
      seen[edge.target] = true;
      if (edge.kind !== "weak" || !edge.fixed || edge.systemRoute !== "main-dispatch") changedRoutes = true;
      edge.kind = "weak";
      edge.fixed = true;
      edge.systemRoute = "main-dispatch";
      edge.sourcePort = "right";
      edge.targetPort = "left";
      edge.sourcePortPinned = true;
      edge.targetPortPinned = true;
      return true;
    });
    Object.keys(ids).forEach(function (targetId) {
      if (seen[targetId]) return;
      workflow.edges.push({
        id: "main-fixed-" + targetId,
        source: "main",
        target: targetId,
        kind: "weak",
        fixed: true,
        systemRoute: "main-dispatch",
        sourcePort: "right",
        targetPort: "left",
        sourcePortPinned: true,
        targetPortPinned: true
      });
      changedRoutes = true;
    });
    return changedRoutes;
  }

  function syncRouteSettings() {
    if (!DIRECT_EDGE_MODE) return;
    var ids = ordinaryAgentIds();
    workflow.weakDecisionBy = workflow.weakDecisionBy && typeof workflow.weakDecisionBy === "object" ? workflow.weakDecisionBy : {};
    workflow.sessionPersistence = workflow.sessionPersistence && typeof workflow.sessionPersistence === "object" ? workflow.sessionPersistence : {};
    Object.keys(ids).forEach(function (id) {
      var item = getNode(id);
      if (!item) return;
      item.decisionBy = item.decisionBy === "agent" || workflow.weakDecisionBy[id] === "agent" ? "agent" : "main";
      item.sessionPersistence = Boolean(Object.prototype.hasOwnProperty.call(workflow.sessionPersistence, id) ? workflow.sessionPersistence[id] : item.sessionPersistence);
      workflow.weakDecisionBy[id] = item.decisionBy;
      workflow.sessionPersistence[id] = item.sessionPersistence;
    });
    Object.keys(workflow.weakDecisionBy).forEach(function (id) { if (!ids[id]) delete workflow.weakDecisionBy[id]; });
    Object.keys(workflow.sessionPersistence).forEach(function (id) { if (!ids[id]) delete workflow.sessionPersistence[id]; });
  }

  function syncDirectWorkflowMetadata() {
    if (!DIRECT_EDGE_MODE || !workflow) return;
    syncMainDispatchEdges();
    syncRouteSettings();
    var main = workflow.nodes.find(function (item) { return item.id === "main"; });
    if (main) {
      main.type = "main";
      main.name = "Main Agent";
      main.system = true;
      main.sessionPersistence = true;
    }
    var inputEdge = workflow.edges.find(function (edge) { return edge.source === "input"; });
    var terminationEdge = workflow.edges.find(function (edge) {
      return isTerminationWorkflowEdge(edge) && (!demoRun.active || demoRun.removedEdgeIds.indexOf(edge.id) < 0);
    });
    workflow.mainAgentId = "main";
    workflow.inputTarget = inputEdge ? inputEdge.target : null;
    workflow.terminationAgentId = terminationEdge ? terminationEdge.source : null;
    workflow.schemaVersion = WORKFLOW_SCHEMA_VERSION;
  }

  function validWorkflowNode(nodes, id, allowInput, allowEnd) {
    return nodes.some(function (item) {
      return item.id === id && (allowInput || item.type !== "input") && (allowEnd || !isEndNode(item));
    });
  }

  function normalizeDirectWorkflow(raw) {
    var source = raw && typeof raw === "object" ? clone(raw) : blankWorkflow("未命名流程");
    var legacySchemaVersion = Number(source.schemaVersion) || 0;
    if (!Array.isArray(source.nodes)) source.nodes = [];
    if (!Array.isArray(source.edges)) source.edges = [];

    var idMap = {};
    source.nodes.forEach(function (item) {
      if (!item || !item.id) return;
      if (item.id === "coordinator") idMap.coordinator = "main";
      if (item.id === "intake") idMap.intake = "input";
      if (item.id === "finish" || item.type === "end") idMap[item.id] = "end";
    });
    source.nodes.forEach(function (item) {
      if (!item || !item.id) return;
      item.id = idMap[item.id] || item.id;
    });
    source.edges.forEach(function (edge) {
      if (!edge) return;
      edge.source = idMap[edge.source] || edge.source;
      edge.target = idMap[edge.target] || edge.target;
    });

    // A selector draft can be opened on this branch without keeping any M
    // cards: collapse source -> selector -> targets into direct weak edges.
    var selectorIds = {};
    source.nodes.forEach(function (item) {
      if (item && item.type === "selector") selectorIds[item.id] = true;
    });
    var collapsed = [];
    Object.keys(selectorIds).forEach(function (selectorId) {
      var incoming = source.edges.filter(function (edge) { return edge && edge.target === selectorId && !selectorIds[edge.source]; });
      var outgoing = source.edges.filter(function (edge) { return edge && edge.source === selectorId && !selectorIds[edge.target]; });
      incoming.forEach(function (entry) {
        outgoing.forEach(function (exit) {
          collapsed.push({
            id: uid("edge"),
            source: entry.source,
            target: exit.target,
            kind: "weak",
            sourcePort: validPortSide(entry.sourcePort) ? entry.sourcePort : undefined,
            targetPort: validPortSide(exit.targetPort) ? exit.targetPort : undefined,
            sourcePortPinned: Boolean(entry.sourcePortPinned),
            targetPortPinned: Boolean(exit.targetPortPinned)
          });
        });
      });
    });
    source.nodes = source.nodes.filter(function (item) { return item && item.id && item.type !== "selector"; });
    source.edges = source.edges.filter(function (edge) {
      return edge && edge.source && edge.target && !selectorIds[edge.source] && !selectorIds[edge.target] && edge.source !== "end";
    }).concat(collapsed);

    var main = source.nodes.find(function (item) { return item.id === "main" || item.type === "main"; });
    if (!main) {
      main = makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 300, 210, "理解目标、协调上下文，并在每轮选择一个子 Agent。" );
      source.nodes.unshift(main);
    }
    main.id = "main";
    main.type = "main";
    main.name = "Main Agent";
    main.model = main.model || "gpt-5.6-sol";
    main.color = "green";
    main.system = true;
    main.sessionPersistence = true;
    main.fixed = false;
    source.nodes = source.nodes.filter(function (item) {
      return item === main || (item && item.id !== "main" && item.type !== "main");
    });

    var input = source.nodes.find(function (item) { return item.id === "input" || item.type === "input"; });
    if (!input) {
      input = makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 28, 210, "用户提交的任务、约束和已有资料。" );
      source.nodes.unshift(input);
    }
    input.id = "input";
    input.type = "input";
    input.name = "用户输入";
    input.model = "input";
    input.system = true;
    input.fixed = false;
    source.nodes = source.nodes.filter(function (item) { return item.type !== "input" || item === input; });

    var end = source.nodes.find(isEndNode);
    if (!end) {
      end = makeEndNode();
      source.nodes.push(end);
    }
    end.id = "end";
    end.type = "end";
    end.name = "结束";
    end.model = "system";
    end.color = "rose";
    end.system = true;
    end.sessionPersistence = false;
    end.fixed = false;
    delete end.selectorLabel;
    delete end.allowReturnToMain;
    source.nodes = source.nodes.filter(function (item) { return !isEndNode(item) || item === end; });

    source.nodes.forEach(function (item) {
      item.instructions = item.instructions || "";
      item.choicePrompt = item.choicePrompt || item.routingPrompt || "";
      item.description = item.description || item.role || "";
      var hasSkills = Array.isArray(item.skills);
      var hasAutoSkills = Array.isArray(item.autoSkills);
      var hasMcpServers = Array.isArray(item.mcpServers);
      var legacyCapabilities = normalizeStringList(item.capabilities);
      item.skills = normalizeStringList(item.skills);
      item.autoSkills = normalizeStringList(item.autoSkills).filter(function (skill) { return item.skills.indexOf(skill) < 0; });
      item.mcpServers = normalizeMcpServers(item.mcpServers);
      // Defaults are only for older drafts that do not have the runtime
      // fields. An explicit empty array means the user intentionally cleared
      // that part of the Agent configuration.
      if (!hasSkills && DEFAULT_AGENT_RUNTIME[item.id]) item.skills = DEFAULT_AGENT_RUNTIME[item.id].skills.slice();
      if (!hasAutoSkills && DEFAULT_AGENT_RUNTIME[item.id]) item.autoSkills = DEFAULT_AGENT_RUNTIME[item.id].autoSkills.slice();
      if (!hasMcpServers) item.mcpServers = DEFAULT_AGENT_RUNTIME[item.id] && DEFAULT_AGENT_RUNTIME[item.id].mcpServers ? DEFAULT_AGENT_RUNTIME[item.id].mcpServers.slice() : [];
      // Migrate the former capability list to the current single permission
      // field. The old experiment capability is the closest equivalent to
      // openfars' Compute permission; all other legacy values use workspace.
      var defaultPermission = DEFAULT_AGENT_RUNTIME[item.id] && DEFAULT_AGENT_RUNTIME[item.id].permission || (item.id === "main" ? "yolo" : "workspace");
      item.permission = normalizePermission(item.permission, legacyCapabilities.indexOf("experiment.run") >= 0 ? "compute" : defaultPermission);
      delete item.capabilities;
      delete item.role;
      delete item.routingPrompt;
      var systemNode = item.id === "main" || item.id === "input" || isEndNode(item);
      item.system = systemNode;
      item.sessionPersistence = item.id === "main" ? true : Boolean(item.sessionPersistence);
      item.decisionBy = item.decisionBy === "agent" ? "agent" : "main";
      item.fixed = false;
      item.x = Number.isFinite(Number(item.x)) ? Number(item.x) : 80;
      item.y = Number.isFinite(Number(item.y)) ? Number(item.y) : 160;
    });

    // Keep exactly one copy of each reserved system node. The first copy wins;
    // ordinary Agents can never claim a reserved identity.
    var systemSeen = {};
    source.nodes = source.nodes.filter(function (item) {
      if (!item || !item.id) return false;
      if (item.id === "main" || item.id === "input" || item.id === "end") {
        if (systemSeen[item.id]) return false;
        systemSeen[item.id] = true;
      }
      return true;
    });

    var validIds = {};
    source.nodes.forEach(function (item) { validIds[item.id] = true; });

    // Schema 7 and earlier stored entry/end selections outside the graph.
    // Convert those fields once, then let real canvas edges be the source of
    // truth. New blank canvases intentionally keep both system edges absent.
    var hasInputEdge = source.edges.some(function (edge) { return edge && edge.source === "input"; });
    var legacyInputTarget = source.inputTarget;
    if (legacySchemaVersion < 8 && !hasInputEdge && validIds[legacyInputTarget] && legacyInputTarget !== "input" && legacyInputTarget !== "end") {
      source.edges.unshift({
        id: "input-edge",
        source: "input",
        target: legacyInputTarget,
        kind: "strong",
        sourcePort: "right",
        targetPort: "left",
        sourcePortPinned: true,
        targetPortPinned: true
      });
    }
    var hasEndEdge = source.edges.some(function (edge) { return edge && isTerminationEdge(edge); });
    var legacyTerminal = source.terminationAgentId;
    if (legacySchemaVersion < 8 && !hasEndEdge && validIds[legacyTerminal] && legacyTerminal !== "input" && legacyTerminal !== "end") {
      source.edges.push(makeTerminationEdge(legacyTerminal));
    }

    var normalized = source.edges.filter(function (edge) {
      return edge && validIds[edge.source] && validIds[edge.target] && edge.source !== "end" && edge.target !== "input";
    }).map(function (edge) {
      edge.id = edge.id || uid("edge");
      // Migrate legacy end edges that were persisted as weak choices. End
      // edges keep their own semantic so they never participate in Agent
      // strong/weak compatibility checks.
      if (edge.target === "end" || edge.termination === true) {
        edge.kind = "termination";
        edge.termination = true;
      } else {
        edge.kind = edge.source === "input" ? "strong" : edge.kind === "weak" ? "weak" : "strong";
      }
      if (!validPortSide(edge.sourcePortPreference) && validPortSide(edge.sourcePort)) edge.sourcePortPreference = edge.sourcePort;
      if (!validPortSide(edge.targetPortPreference) && validPortSide(edge.targetPort)) edge.targetPortPreference = edge.targetPort;
      delete edge.selector;
      delete edge.selectorEntry;
      delete edge.endChoice;
      edge.fixed = Boolean(edge.fixed || edge.systemRoute === "main-dispatch");
      if (!isTerminationEdge(edge)) delete edge.termination;
      return edge;
    });

    var seenPair = {};
    var seenId = {};
    var strongSeen = {};
    var inputSeen = false;
    var endSeen = false;
    source.edges = normalized.filter(function (edge) {
      if (seenId[edge.id]) edge.id = uid("edge");
      seenId[edge.id] = true;
      var pair = edge.source + "\u0000" + edge.target;
      if (seenPair[pair]) return false;
      seenPair[pair] = true;
      if (edge.source === "input") {
        if (inputSeen || edge.target === "end") return false;
        inputSeen = true;
        edge.kind = "strong";
        return true;
      }
      if (isTerminationWorkflowEdge(edge)) {
        if (endSeen) return false;
        endSeen = true;
        edge.kind = "termination";
        edge.termination = true;
        return true;
      }
      // Weak self-loops are valid retry choices; strong self-loops are not.
      if (edge.source === edge.target && edge.kind !== "weak") return false;
      if (edge.kind === "strong") {
        if (strongSeen[edge.source]) return false;
        strongSeen[edge.source] = true;
      }
      return true;
    });

    if (legacySchemaVersion < 8) {
      source.nodes.forEach(function (item) {
        if (item.type === "input" || isEndNode(item) || String(item.choicePrompt || "").trim()) return;
        var hasWeakChoice = source.edges.some(function (edge) { return edge.source === item.id && isOrdinaryWeakEdge(edge); });
        if (hasWeakChoice) item.choicePrompt = "根据当前任务状态、候选 Agent 的职责和已有结果，选择最适合的下一步执行路径。";
      });
    }

    // Main's dispatch coverage is a system-maintained set. Any old Main
    // business edges are converted to fixed weak routes, while invalid
    // Main -> system/self edges are discarded.
    var ordinaryIds = {};
    source.nodes.forEach(function (item) {
      if (item.id !== "main" && item.type !== "main" && item.id !== "input" && !isEndNode(item) && item.type !== "selector") ordinaryIds[item.id] = true;
    });
    source.edges = source.edges.filter(function (edge) {
      if (edge.source !== "main") return true;
      // The initial Main -> End route is a real termination edge, not a
      // dispatch rail. Preserve it until Main explicitly replaces it during
      // the dynamic demo (or a user changes the terminal Agent in the editor).
      if (isTerminationWorkflowEdge(edge)) return true;
      if (!ordinaryIds[edge.target]) return false;
      edge.kind = "weak";
      edge.fixed = true;
      edge.systemRoute = "main-dispatch";
      edge.sourcePort = "right";
      edge.targetPort = "left";
      edge.sourcePortPinned = true;
      edge.targetPortPinned = true;
      return true;
    });
    var mainPairs = {};
    source.edges.forEach(function (edge) {
      if (edge.source === "main" && ordinaryIds[edge.target]) mainPairs[edge.target] = edge;
    });
    Object.keys(ordinaryIds).forEach(function (targetId) {
      var edge = mainPairs[targetId];
      if (!edge) {
        edge = {
          id: "main-fixed-" + targetId,
          source: "main",
          target: targetId,
          kind: "weak",
          fixed: true,
          systemRoute: "main-dispatch",
          sourcePort: "right",
          targetPort: "left",
          sourcePortPinned: true,
          targetPortPinned: true
        };
        source.edges.push(edge);
      }
      edge.kind = "weak";
      edge.fixed = true;
      edge.systemRoute = "main-dispatch";
      edge.sourcePort = "right";
      edge.targetPort = validPortSide(edge.targetPort) ? edge.targetPort : "left";
      edge.sourcePortPinned = true;
      edge.targetPortPinned = true;
    });

    // A terminal Agent may continue through weak candidates, but never via a
    // strong ordinary edge. Imported invalid strong exits are downgraded so
    // the saved canvas remains editable and honors the invariant.
    var terminalEdge = source.edges.find(function (edge) { return isTerminationWorkflowEdge(edge); });
    if (terminalEdge && ordinaryIds[terminalEdge.source]) {
      source.edges.forEach(function (edge) {
        if (edge.source === terminalEdge.source && !isTerminationWorkflowEdge(edge) && edge.kind === "strong") edge.kind = "weak";
      });
    }

    var storedWeakDecisionBy = source.weakDecisionBy && typeof source.weakDecisionBy === "object" ? source.weakDecisionBy : {};
    var storedSessionMap = source.sessionPersistence && typeof source.sessionPersistence === "object" ? source.sessionPersistence : {};
    var weakDecisionBy = {};
    var sessionMap = {};
    Object.keys(ordinaryIds).forEach(function (id) {
      var node = source.nodes.find(function (item) { return item.id === id; });
      var decision = node && node.decisionBy === "agent" ? "agent" : storedWeakDecisionBy[id] === "agent" ? "agent" : "main";
      if (node) {
        node.decisionBy = decision;
        node.sessionPersistence = Object.prototype.hasOwnProperty.call(storedSessionMap, id) ? Boolean(storedSessionMap[id]) : Boolean(node.sessionPersistence);
      }
      weakDecisionBy[id] = decision;
      sessionMap[id] = Boolean(node && node.sessionPersistence);
    });
    source.weakDecisionBy = weakDecisionBy;
    source.sessionPersistence = sessionMap;
    source.mainAgentId = "main";
    var inputEdge = source.edges.find(function (edge) { return edge.source === "input"; });
    source.inputTarget = inputEdge ? inputEdge.target : null;
    source.terminationAgentId = terminalEdge && terminalEdge.source || null;
    source.terminationCondition = source.terminationCondition || "结束 Agent 的结果已经满足交付条件。";
    source.edgeModel = "direct";
    source.schemaVersion = WORKFLOW_SCHEMA_VERSION;
    delete source.anchorMode;
    delete source.endAllowReturnToMain;
    source.name = source.name || "未命名工作流";
    return source;
  }

  function normalizeWorkflow(raw) {
    if (DIRECT_EDGE_MODE) return normalizeDirectWorkflow(raw);
    var source = raw && typeof raw === "object" ? clone(raw) : starter();
    source.anchorMode = "free";
    if (!Array.isArray(source.nodes)) source.nodes = [];
    if (!Array.isArray(source.edges)) source.edges = [];
    var idMap = {};
    source.nodes.forEach(function (item) {
      if (!item || !item.id) return;
      if (item.id === "coordinator") idMap.coordinator = "main";
      if (item.id === "intake") idMap.intake = "input";
      if (item.id === "finish" || item.type === "end") idMap[item.id] = "end";
    });
    source.nodes.forEach(function (item) {
      if (!item || !item.id) return;
      item.id = idMap[item.id] || item.id;
      if (item.id === "main") {
        item.type = "main";
        item.name = "Main Agent";
        item.fixed = false;
      }
      if (item.id === "input") {
        item.type = "input";
        item.name = "用户输入";
        item.model = "input";
        item.fixed = false;
      }
      if (item.id === "end") {
        item.type = "end";
        item.name = "结束";
        item.model = "control";
        item.color = item.color || "rose";
        item.fixed = false;
      }
      if (item.type === "selector") {
        item.model = "control";
        item.color = item.color || "amber";
        item.selectorLabel = item.selectorLabel || "Main 选择";
        item.system = item.system === true || item.id === "selector-main";
        item.fixed = false;
      }
      item.instructions = item.instructions || "";
      item.description = item.description || item.role || "";
      delete item.role;
      item.x = Number.isFinite(Number(item.x)) ? Number(item.x) : 80;
      item.y = Number.isFinite(Number(item.y)) ? Number(item.y) : 160;
    });
    var main = source.nodes.find(function (item) { return item.id === source.mainAgentId || item.type === "main"; });
    if (!main) {
      main = makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 252, 210, "统一判断弱边候选，并协调所有子 Agent 的执行轨迹。" );
      source.nodes.unshift(main);
    }
    main.id = "main";
    main.type = "main";
    main.name = "Main Agent";
    main.fixed = false;
    source.mainAgentId = "main";
    var input = source.nodes.find(function (item) { return item.id === "input" || item.type === "input"; });
    if (!input) {
      input = makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 28, 210, "用户提交的任务、约束和已有资料。" );
      source.nodes.unshift(input);
    }
    input.id = "input";
    input.type = "input";
    input.name = "用户输入";
    input.model = "input";
    input.fixed = false;
    var end = source.nodes.find(function (item) { return isEndNode(item); });
    if (!end) {
      end = makeEndNode();
      source.nodes.push(end);
    }
    end.id = "end";
    end.type = "end";
    end.name = "结束";
    end.model = "control";
    end.color = end.color || "rose";
    end.fixed = false;
    source.nodes = source.nodes.filter(function (item) { return !isEndNode(item) || item === end; });

    // Main always has one resident decision selector. It is a system node,
    // cannot be deleted, and is the shared return point for user follow-ups,
    // agent errors, retries, and any other runtime hand-back to Main.
    var mainSelector = source.nodes.find(function (item) { return item.id === "selector-main" && item.type === "selector"; });
    if (!mainSelector) {
      mainSelector = makeMainSelectorNode(main.x + 248, main.y);
      source.nodes.push(mainSelector);
    }
    mainSelector.id = "selector-main";
    mainSelector.type = "selector";
    mainSelector.name = "Main 常驻选择器";
    mainSelector.model = "control";
    mainSelector.color = mainSelector.color || "green";
    mainSelector.selectorLabel = "Main 总控选择";
    mainSelector.description = "所有返回 Main 的补充输入、异常和中途回流，都由 Main 通过这里选择下一步。";
    mainSelector.system = true;
    mainSelector.fixed = false;
    if (!source.edges.some(function (edge) { return edge && edge.source === "main" && edge.target === "selector-main"; })) {
      source.edges.unshift({ id: "main-selector-entry", source: "main", target: "selector-main", kind: "strong", selectorEntry: true, sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true });
    }
    var mainSelectorEntry = source.edges.find(function (edge) { return edge && edge.source === "main" && edge.target === "selector-main"; });
    if (mainSelectorEntry) {
      mainSelectorEntry.kind = "strong";
      mainSelectorEntry.selectorEntry = true;
      mainSelectorEntry.sourcePort = "right";
      mainSelectorEntry.targetPort = "left";
      mainSelectorEntry.sourcePortPinned = true;
      mainSelectorEntry.targetPortPinned = true;
    }

    // Migrate the previous direct weak-edge model. A weak fan-out from an
    // Agent becomes one strong entry edge to a selector plus weak selector
    // output edges. This keeps old drafts usable while enforcing the new
    // invariant that ordinary Agents never originate weak edges.
    var legacyWeakGroups = {};
    source.edges.forEach(function (edge) {
      if (!edge || edge.kind !== "weak" || isTerminationEdge(edge)) return;
      var sourceNode = source.nodes.find(function (item) { return item.id === edge.source; });
      if (!sourceNode || sourceNode.type === "selector" || isEndNode(sourceNode)) return;
      if (!legacyWeakGroups[edge.source]) legacyWeakGroups[edge.source] = [];
      legacyWeakGroups[edge.source].push(edge);
    });
    Object.keys(legacyWeakGroups).forEach(function (sourceId) {
      var sourceNode = source.nodes.find(function (item) { return item.id === sourceId; });
      var weakEdges = legacyWeakGroups[sourceId];
      if (!sourceNode || !weakEdges.length) return;
      var selectorId = "selector-" + sourceId;
      var selector = source.nodes.find(function (item) { return item.id === selectorId && item.type === "selector"; });
      if (!selector) {
        var averageY = weakEdges.reduce(function (sum, edge) {
          var target = source.nodes.find(function (item) { return item.id === edge.target; });
          return sum + (target ? target.y : sourceNode.y);
        }, 0) / weakEdges.length;
        selector = makeSelectorNode(selectorId, "选择器", sourceNode.x + 250, averageY, "由 Main 从候选 Agent 中选择下一步。", "amber");
        source.nodes.push(selector);
      }
      source.edges = source.edges.filter(function (edge) { return weakEdges.indexOf(edge) < 0; });
      source.edges.push({ id: "selector-entry-" + sourceId, source: sourceId, target: selector.id, kind: "strong", selectorEntry: true });
      weakEdges.forEach(function (edge) {
        edge.source = selector.id;
        edge.kind = "weak";
        edge.selector = true;
        source.edges.push(edge);
      });
    });
    var normalizedEdges = source.edges.filter(function (edge) {
      return edge && edge.source && edge.target;
    }).map(function (edge, index) {
      edge.source = idMap[edge.source] || edge.source;
      edge.target = idMap[edge.target] || edge.target;
      edge.id = edge.id || uid("edge");
      var sourceNode = source.nodes.find(function (item) { return item.id === edge.source; });
      var selectorSource = sourceNode && (sourceNode.type === "selector" || sourceNode.id === "end");
      edge.kind = isTerminationEdge(edge) ? "weak" : selectorSource ? "weak" : "strong";
      edge.selector = !isTerminationEdge(edge) && selectorSource;
      if (edge.source === "end" && edge.kind === "weak" && edge.selector) {
        edge.endChoice = edge.target === "main" ? "return-main" : (edge.endChoice || "agent-candidate");
      }
      if (edge.source === edge.target && edge.kind === "weak") {
        // Selector self-loops are allowed as a retry choice. Ordinary Agent
        // self-loops were already converted above and cannot remain here.
        edge.sourcePort = validPortSide(edge.sourcePort) ? edge.sourcePort : "right";
        edge.targetPort = validPortSide(edge.targetPort) ? edge.targetPort : "top";
      }
      return edge;
    }).filter(function (edge) {
      return edge.source !== edge.target || (edge.kind === "weak" && edge.selector);
    });
    var oldInputEdge = normalizedEdges.find(function (edge) { return edge.source === "input" && !isTerminationEdge(edge); });
    var oldTerminationEdge = normalizedEdges.find(isTerminationEdge);
    var strongSourceSeen = {};
    source.edges = normalizedEdges.filter(function (edge) {
      if (isTerminationEdge(edge)) return edge.source !== "input" && edge.target === "end" && validWorkflowNode(source.nodes, edge.source, false);
      if (edge.source === "end" && edge.target === "main" && edge.endChoice === "return-main") return true;
      if (!validWorkflowNode(source.nodes, edge.source, true) || !validWorkflowNode(source.nodes, edge.target, false)) return false;
      // Keep historical drafts within the same invariant enforced by the
      // editor: ordinary sources, including Main, have at most one strong
      // continuation. Selector sources may still fan out with weak choices.
      var sourceNode = source.nodes.find(function (item) { return item.id === edge.source; });
      if (edge.kind === "strong" && edge.source !== "input" && sourceNode && sourceNode.type !== "selector" && !isEndNode(sourceNode)) {
        if (strongSourceSeen[edge.source]) return false;
        strongSourceSeen[edge.source] = true;
      }
      return true;
    });
    var hasInputTargetField = Object.prototype.hasOwnProperty.call(source, "inputTarget");
    var inputTarget = hasInputTargetField ? source.inputTarget : (oldInputEdge && oldInputEdge.target) || "main";
    inputTarget = idMap[inputTarget] || inputTarget;
    if (inputTarget && !validWorkflowNode(source.nodes, inputTarget, false)) inputTarget = "main";
    source.inputTarget = inputTarget;
    source.edges = source.edges.filter(function (edge) { return edge.source !== "input"; });
    if (inputTarget) {
      var inputSourcePort = oldInputEdge && validPortSide(oldInputEdge.sourcePort) ? oldInputEdge.sourcePort : "right";
      var inputTargetPort = oldInputEdge && validPortSide(oldInputEdge.targetPort) ? oldInputEdge.targetPort : "left";
      source.edges.unshift({ id: "input-edge", source: "input", target: inputTarget, kind: "strong", sourcePort: inputSourcePort, targetPort: inputTargetPort, sourcePortPinned: true, targetPortPinned: true });
    }
    var terminal = idMap[source.terminationAgentId] || source.terminationAgentId;
    if (!validWorkflowNode(source.nodes, terminal, false)) {
      var noOutgoing = source.nodes.filter(function (item) {
        return item.type !== "input" && !isEndNode(item) && !source.edges.some(function (edge) { return edge.source === item.id && !isTerminationEdge(edge); });
      });
      var reviewer = source.nodes.find(function (item) { return item.id === "reviewer"; });
      terminal = (reviewer || noOutgoing[noOutgoing.length - 1] || source.nodes.find(function (item) { return item.type !== "input" && !isEndNode(item) && item.id !== "main"; }) || main).id;
    }
    source.terminationAgentId = terminal;
    source.edges = source.edges.filter(function (edge) { return !isTerminationEdge(edge); });
    source.edges.push(makeTerminationEdge(terminal, oldTerminationEdge && oldTerminationEdge.source === terminal ? oldTerminationEdge : null));
    // The end selector may optionally return control to Main. Keep this as a
    // real weak selector edge so it participates in the same hover/reveal and
    // save/export semantics as every other choice branch.
    var hasReturnMain = source.edges.some(function (edge) {
      return edge.source === "end" && edge.target === "main" && edge.endChoice === "return-main";
    });
    // The end selector always exposes both system outcomes: finish, which is
    // represented by the selector itself, and return to Main. User-added
    // candidate edges are kept alongside this required Main edge.
    source.endAllowReturnToMain = true;
    if (!hasReturnMain) {
      source.edges.push({ id: "end-return-main", source: "end", target: "main", kind: "weak", selector: true, endChoice: "return-main", sourcePort: "top", targetPort: "top", sourcePortPinned: true, targetPortPinned: true });
    }
    var endReturnEdge = source.edges.find(function (edge) { return edge.source === "end" && edge.target === "main" && edge.endChoice === "return-main"; });
    if (endReturnEdge) {
      endReturnEdge.kind = "weak";
      endReturnEdge.selector = true;
      endReturnEdge.sourcePort = validPortSide(endReturnEdge.sourcePort) ? endReturnEdge.sourcePort : "top";
      endReturnEdge.targetPort = validPortSide(endReturnEdge.targetPort) ? endReturnEdge.targetPort : "bottom";
      endReturnEdge.sourcePortPinned = true;
      endReturnEdge.targetPortPinned = true;
    }
    source.terminationCondition = source.terminationCondition || "Main 判断结束 Agent 的结果已经满足交付条件。";
    source.schemaVersion = 6;
    source.name = source.name || "未命名工作流";
    return source;
  }

  function stored(key) {
    if (RUNTIME_MODE) return null;
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (error) { return null; }
  }

  function normalizeAgentTemplate(entry, index, usedIds) {
    if (!entry || typeof entry !== "object") return null;
    var legacy = Array.isArray(entry);
    var name = String(legacy ? entry[1] || "" : entry.name || "").trim();
    if (!name) return null;
    var id = String(legacy ? entry[0] || "agent-template-" + index : entry.id || "agent-template-" + index).trim() || uid("agent-template");
    if (usedIds[id]) id = uid("agent-template");
    usedIds[id] = true;
    var legacyDescription = legacy ? String(entry[4] || entry[2] || "") : String(entry.description || "");
    var model = String(legacy ? entry[3] || "gpt-5.6-sol" : entry.model || "gpt-5.6-sol");
    var color = legacy ? entry[5] : entry.color;
    var runtime = DEFAULT_AGENT_RUNTIME[id] || DEFAULT_AGENT_RUNTIME[entry.id] || {};
    var legacyCapabilities = normalizeStringList(entry.capabilities);
    var defaultPermission = runtime.permission || (id === "main" ? "yolo" : "workspace");
    return {
      id: id,
      type: legacy ? undefined : entry.type === "main" ? "main" : undefined,
      builtin: !legacy && entry.builtin === true,
      name: name.slice(0, 32),
      model: model,
      description: legacyDescription.trim().slice(0, 180) || "负责工作流中的专业任务。",
      color: Object.prototype.hasOwnProperty.call(PALETTE, color) ? color : "violet",
      skills: normalizeStringList(entry.skills || runtime.skills),
      autoSkills: normalizeStringList(entry.autoSkills || runtime.autoSkills),
      mcpServers: normalizeMcpServers(entry.mcpServers),
      permission: normalizePermission(entry.permission, legacyCapabilities.indexOf("experiment.run") >= 0 ? "compute" : defaultPermission),
      sessionPersistence: Boolean(entry.sessionPersistence),
      decisionBy: entry.decisionBy === "agent" ? "agent" : "main"
    };
  }

  function loadAgentLibrary() {
    var storedLibrary = stored(AGENT_LIBRARY_KEY);
    var source = Array.isArray(storedLibrary) ? storedLibrary : AGENTS;
    var usedIds = {};
    var result = source.map(function (entry, index) {
      return normalizeAgentTemplate(entry, index, usedIds);
    }).filter(function (entry) {
      return Boolean(entry) && (!DIRECT_EDGE_MODE || (entry.id !== "main" && entry.type !== "main"));
    });
    if (!DIRECT_EDGE_MODE && !result.some(function (entry) { return entry.id === "main"; })) {
      result.unshift(normalizeAgentTemplate(AGENTS[0], -1, usedIds));
    }
    return result;
  }

  function saveAgentLibrary() {
    try { localStorage.setItem(AGENT_LIBRARY_KEY, JSON.stringify(agentLibrary)); } catch (error) {}
  }

  function rebuildAgentTemplates() {
    templates = {};
    agentLibrary.forEach(function (entry) { templates[entry.id] = entry; });
  }

  function renderLibrary() {
    rebuildAgentTemplates();
    library.innerHTML = agentLibrary.map(function (item) {
      var colors = PALETTE[item.color] || PALETTE.violet;
      var canDelete = DIRECT_EDGE_MODE || !item.builtin;
      var deleteButton = canDelete ? '<button class="library-delete" type="button" title="从常驻 Agent 删除" aria-label="从常驻 Agent 删除 ' + html(item.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="m19 6-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path></svg></button>' : '';
      return '<div class="library-item" data-template="' + html(item.id) + '" style="--agent-color:' + colors[0] + ";--agent-soft:" + colors[1] + ';"><span class="agent-avatar">' + html(initials(item.name)) + '</span><span class="library-copy"><strong>' + html(item.name) + "</strong><small>" + html(item.description) + '</small></span><button class="library-add" type="button" title="添加到画布" aria-label="添加 ' + html(item.name) + ' 到画布">+</button>' + deleteButton + '</div>';
    }).join("") || '<p class="library-empty">暂无常驻 Agent，点击右上角 + 新建。</p>';
  }

  function templatePrefs() {
    var value = stored(TEMPLATE_PREFS_KEY);
    if (!value || typeof value !== "object") value = {};
    return {
      hiddenBuiltinIds: Array.isArray(value.hiddenBuiltinIds) ? value.hiddenBuiltinIds.map(String) : [],
      builtinNames: value.builtinNames && typeof value.builtinNames === "object" ? value.builtinNames : {},
      // Built-in templates remain in the catalog, while user edits are kept
      // as an override keyed by the stable built-in ID. This lets a save
      // update the original row instead of creating a second local record.
      builtinOverrides: value.builtinOverrides && typeof value.builtinOverrides === "object" ? value.builtinOverrides : {}
    };
  }

  function saveTemplatePrefs(value) {
    try { localStorage.setItem(TEMPLATE_PREFS_KEY, JSON.stringify(value)); } catch (error) {}
  }

  agentLibrary = loadAgentLibrary();
  rebuildAgentTemplates();

  var rawWorkflow = stored(DRAFT_KEY);
  var workflow = normalizeWorkflow(rawWorkflow || (DIRECT_EDGE_MODE ? blankWorkflow("未命名流程") : starter()));
  var firstAgent = workflow.nodes.find(function (item) { return item.type !== "input" && !isEndNode(item); });
  var selected = firstAgent && firstAgent.id || workflow.nodes[0] && workflow.nodes[0].id;
  var linking = null;
  if (DIRECT_EDGE_MODE) {
    var initialOutgoing = workflow.edges.filter(function (edge) { return edge.source === selected && !isTerminationWorkflowEdge(edge); });
    if (initialOutgoing.length) directEdgeKind = initialOutgoing[0].kind;
  }

  // 旧版本在手动连线时已经保存了端口名称，但没有保存固定标记。
  // 手动布局中的这些端口应继续按用户的选择显示。
  if (workflow.viewLayout === "free") {
    workflow.edges.forEach(function (edge) {
      if (edge.sourcePortPinned == null && validPortSide(edge.sourcePort)) edge.sourcePortPinned = true;
      if (edge.targetPortPinned == null && validPortSide(edge.targetPort)) edge.targetPortPinned = true;
    });
  }

  function saveDraft() {
    if (RUNTIME_MODE) return;
    syncDirectWorkflowMetadata();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(workflow)); } catch (error) {}
  }

  // Persist schema repairs immediately so legacy drafts cannot reintroduce an
  // invalid strong exit from the terminal Agent on every reload.
  saveDraft();

  function saved() {
    var prefs = templatePrefs();
    var hiddenBuiltinIds = {};
    prefs.hiddenBuiltinIds.forEach(function (id) { hiddenBuiltinIds[id] = true; });
    var builtins = builtinWorkflowRecords().filter(function (entry) {
      return !hiddenBuiltinIds[entry.id];
    }).map(function (entry) {
      var override = prefs.builtinOverrides[entry.id];
      // Accept both the current raw-flow shape and the short-lived wrapped
      // shape so a partially migrated preference value cannot hide a template.
      var overrideFlow = override && typeof override === "object" && override.flow && typeof override.flow === "object"
        ? override.flow
        : override;
      if (overrideFlow && typeof overrideFlow === "object" && Array.isArray(overrideFlow.nodes)) {
        entry.flow = normalizeWorkflow(overrideFlow);
        var overrideName = String(entry.flow.name || "").trim();
        if (overrideName) entry.name = overrideName;
      }
      var renamed = String(prefs.builtinNames[entry.id] || "").trim();
      if (renamed) {
        entry.name = renamed;
        entry.flow.name = renamed;
      }
      entry.flow = normalizeWorkflow(entry.flow);
      return entry;
    });
    var builtinIds = {};
    builtins.forEach(function (entry) { builtinIds[entry.id] = true; });
    var list = stored(SAVED_KEY);
    if (!Array.isArray(list)) list = [];
    var userRecords = list.filter(function (entry) {
      return entry && entry.flow && !entry.builtin && !builtinIds[entry.id] && !(DIRECT_EDGE_MODE && entry.id === "starter-template");
    }).map(function (entry) {
      if (!entry || !entry.flow) return entry;
      entry.flow = normalizeWorkflow(entry.flow);
      return entry;
    }).filter(Boolean);
    return builtins.concat(userRecords);
  }

  function saveSaved(list) {
    var userRecords = (Array.isArray(list) ? list : []).filter(function (entry) { return entry && !entry.builtin; });
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(userRecords)); } catch (error) {}
  }

  function getNode(id) {
    return workflow.nodes.find(function (item) { return item.id === id; });
  }

  function agentNodes() {
    return workflow.nodes.filter(function (item) { return item.type !== "input" && !isEndNode(item) && item.type !== "selector"; });
  }

  function ordinaryAgentNodes() {
    var ids = ordinaryAgentIds();
    return workflow.nodes.filter(function (item) { return Boolean(ids[item.id]); });
  }

  function connectableNodes() {
    return workflow.nodes.filter(function (item) { return item.type !== "input" && !isEndNode(item); });
  }

  function isMainNode(item) {
    return Boolean(item) && item.type === "main";
  }

  function isAnchorNode(item) {
    if (!item) return false;
    if (DIRECT_EDGE_MODE) return item.id === "input" || item.id === "main" || isEndNode(item);
    return item.id === "input" || isMainNode(item) || isEndNode(item) || isSystemSelectorNode(item);
  }

  function anchorMode() {
    return "free";
  }

  function anchorsLocked() {
    return false;
  }

  function isAnchorLocked(item) {
    return isAnchorNode(item) && anchorsLocked();
  }

  function enforceFixedAnchors() {
    if (!DIRECT_EDGE_MODE) {
      var main = workflow.nodes.find(function (item) {
        return item.id === workflow.mainAgentId || item.type === "main";
      });
      if (main) {
        workflow.mainAgentId = main.id;
        main.type = "main";
        main.fixed = false;
      }
    }
    var input = workflow.nodes.find(function (item) {
      return item.id === "input" || item.type === "input";
    });
    if (input) {
      input.id = "input";
      input.type = "input";
      input.fixed = false;
    }
    if (DIRECT_EDGE_MODE) {
      var directMain = workflow.nodes.find(function (item) { return item.id === "main" || item.type === "main"; });
      if (directMain) {
        directMain.id = "main";
        directMain.type = "main";
        directMain.name = "Main Agent";
        directMain.model = directMain.model || "gpt-5.6-sol";
        directMain.color = "green";
        directMain.system = true;
        directMain.sessionPersistence = true;
        directMain.fixed = false;
      }
    }
    var end = workflow.nodes.find(function (item) { return isEndNode(item); });
    if (end) {
      end.id = "end";
      end.type = "end";
      end.fixed = false;
    }
    var mainSelector = workflow.nodes.find(function (item) { return isSystemSelectorNode(item); });
    if (mainSelector) mainSelector.fixed = false;
  }

  function syncEndNodePosition(updateDom) {
    // The end module used to follow the selected terminal Agent on every
    // render. That made a manually placed end node jump back unexpectedly.
    // Both supported anchor modes own the end position explicitly: top mode
    // lays it out with the other two anchors, while free mode leaves it where
    // the user put it.
    return false;
  }

  function endNodeOutsideCanvas() {
    var endElement = nodeElement("end");
    if (!endElement) return true;
    var canvasRect = canvas.getBoundingClientRect();
    var endRect = endElement.getBoundingClientRect();
    var margin = 18;
    return endRect.left < canvasRect.left + margin ||
      endRect.top < canvasRect.top + margin ||
      endRect.right > canvasRect.right - margin ||
      endRect.bottom > canvasRect.bottom - margin;
  }

  function edgeLabel(kind) {
    if (kind === "parallel") return "并行";
    if (kind === "termination") return DIRECT_EDGE_MODE ? "终止候选" : "结束判断";
    if (kind === "end-choice") return "结束候选";
    if (kind === "main-dispatch") return "固定弱边";
    return kind === "weak" ? (DIRECT_EDGE_MODE ? "弱边" : "候选") : "强边";
  }

  function edgeLabelForEdge(edge) {
    if (edge && edge.endChoice === "return-main") return "回到 Main";
    return edgeLabel(edgeDisplayKind(edge));
  }

  function edgeHelp(kind) {
    if (kind === "parallel") return "并行入口：进入协作组时，向所有连接的节点并行分发任务。";
    if (kind === "termination") return DIRECT_EDGE_MODE ? "终止候选：结果进入终止闸门；满足验收条件则结束，不满足时回到源 Agent 的普通后续路径。" : "Main 判断结束条件；只有当前选中的结束 Agent 才能进入结束模块。";
    if (kind === "end-choice") return "结束选择器候选：Main 在结束、回到 Main 或额外候选之间判断。";
    return kind === "weak" ? (DIRECT_EDGE_MODE ? "弱边：当前 Agent 完成后，从可选路径中选择下一步。" : "选择器候选：Main 从这个选择器的候选 Agent 中选择下一步。") : "强边：当前 Agent 完成后直接进入目标 Agent。";
  }

  function isTerminationWorkflowEdge(edge) {
    return isTerminationEdge(edge) || edge && edge.target === "end";
  }

  function isMainSelectorEntry(edge) {
    return Boolean(edge) && edge.selectorEntry === true && edge.source === "main" && edge.target === "selector-main";
  }

  function outgoingAgentEdges(source) {
    return workflow.edges.filter(function (edge) {
      return edge.source === source && !isTerminationWorkflowEdge(edge) && !isMainDispatchEdge(edge);
    });
  }

  function hasStrongOutgoing(source, ignoreEdgeId) {
    return workflow.edges.some(function (edge) {
      return edge.source === source && edge.id !== ignoreEdgeId && !isTerminationWorkflowEdge(edge) && !isMainDispatchEdge(edge) && edge.kind === "strong";
    });
  }

  function canBeTerminationAgent(id) {
    var item = getNode(id);
    return Boolean(item) && item.id !== "main" && item.type !== "main" && validWorkflowNode(workflow.nodes, id, false, false) && !hasStrongOutgoing(id);
  }

  function hasTerminationOutgoing(source, ignoreEdgeId) {
    return workflow.edges.some(function (edge) {
      return edge.source === source && edge.id !== ignoreEdgeId && isTerminationWorkflowEdge(edge);
    });
  }

  function syncTerminationEdge() {
    if (DIRECT_EDGE_MODE) return false;
    var terminal = getNode(workflow.terminationAgentId);
    var end = getNode("end");
    if (!terminal || !end || isEndNode(terminal)) return false;
    var previous = workflow.edges.find(function (edge) {
      return isTerminationWorkflowEdge(edge);
    });
    workflow.edges = workflow.edges.filter(function (edge) {
      return !isTerminationWorkflowEdge(edge);
    });
    workflow.edges.push(makeTerminationEdge(terminal.id, previous && previous.source === terminal.id ? previous : null));
    return true;
  }

  // Direct mode stores the finish relationship as the single real edge into
  // `end`. Keep a small explicit mutator so the End inspector and drag-to-End
  // interaction can replace or clear that source without exposing the system
  // edge to ordinary edge editing controls.
  function setDirectTerminationAgent(agentId, silent) {
    if (!DIRECT_EDGE_MODE) return false;
    agentId = agentId || null;
    if (agentId) {
      var candidate = getNode(agentId);
      if (!candidate || candidate.id === "main" || candidate.id === "input" || isEndNode(candidate) || candidate.type === "selector") return false;
      if (!canBeTerminationAgent(agentId)) return false;
    }
    var previous = workflow.edges.find(isTerminationWorkflowEdge);
    var previousSource = previous && previous.source;
    if ((previousSource || null) === agentId && (agentId == null || previous)) return true;
    if (!silent) pushUndo("修改结束 Agent");
    if (!agentId) {
      workflow.edges = workflow.edges.filter(function (edge) { return !isTerminationWorkflowEdge(edge); });
      workflow.terminationAgentId = null;
    } else {
      workflow.edges = workflow.edges.filter(function (edge) { return !isTerminationWorkflowEdge(edge); });
      workflow.edges.push(makeTerminationEdge(agentId, previous && previous.source === agentId ? previous : null));
      workflow.terminationAgentId = agentId;
    }
    if (silent) return true;
    clearRouteLock();
    workflow.viewLayout = "free";
    changed();
    render();
    var target = agentId && getNode(agentId);
    showToast(target ? "结束 Agent 已设置为 " + target.name : previousSource ? "结束 Agent 已移除" : "结束节点暂未连接");
    return true;
  }

  function edgeDisplayKind(edge) {
    if (isTerminationWorkflowEdge(edge)) return "termination";
    if (edge && edge.source === "end" && edge.kind === "weak" && edge.selector) return "end-choice";
    return edge && edge.kind;
  }

  function edgeDashOffset(id) {
    var hash = 0;
    String(id || "edge").split("").forEach(function (character) {
      hash = (hash * 31 + character.charCodeAt(0)) % 97;
    });
    return -(hash % 13);
  }

  function flowPathId(edgeId) {
    return "workflow-edge-path-" + String(edgeId || "edge").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function flowParticleDuration(displayKind, edgeKind) {
    if (displayKind === "termination" || displayKind === "end-choice") return "2.65s";
    return edgeKind === "weak" ? "2.9s" : "2.35s";
  }

  function edgeFocusState(edge, focusedNodeId, focusMode) {
    if (!focusedNodeId) return { className: "", showParticle: false };
    var outgoing = edge.source === focusedNodeId;
    var incoming = edge.target === focusedNodeId;
    if (!outgoing && !incoming) return { className: " is-unrelated-muted", showParticle: false };
    if (focusMode === "hover") {
      return outgoing
        ? { className: " is-outgoing-highlight", showParticle: !isMainDispatchEdge(edge), direction: "outgoing" }
        : { className: " is-incoming-context", showParticle: !isMainDispatchEdge(edge), direction: "incoming" };
    }
    return {
      className: " is-related-highlight",
      showParticle: !isMainDispatchEdge(edge),
      direction: outgoing ? "outgoing" : "incoming"
    };
  }

  function syncFlowParticles(records) {
    if (!flowParticleLayer) return;
    var existing = {};
    flowParticleLayer.querySelectorAll("[data-flow-edge]").forEach(function (particle) {
      existing[particle.getAttribute("data-flow-edge")] = particle;
    });

    records.forEach(function (record) {
      var edgeId = String(record.edge.id);
      var particle = existing[edgeId];
      if (!particle) {
        particle = document.createElementNS("http://www.w3.org/2000/svg", "g");
        particle.setAttribute("data-flow-edge", edgeId);
        particle.setAttribute("aria-hidden", "true");
        var tailLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        tailLine.setAttribute("class", "flow-particle-tail-line");
        tailLine.setAttribute("x1", "-21");
        tailLine.setAttribute("x2", "-4");
        tailLine.setAttribute("y1", "0");
        tailLine.setAttribute("y2", "0");
        var tail = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        tail.setAttribute("class", "flow-particle-tail");
        tail.setAttribute("r", "2.7");
        tail.setAttribute("cx", "-13");
        tail.setAttribute("cy", "0");
        var halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        halo.setAttribute("class", "flow-particle-halo");
        halo.setAttribute("r", "11.5");
        halo.setAttribute("cx", "0");
        halo.setAttribute("cy", "0");
        var core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        core.setAttribute("class", "flow-particle-core");
        core.setAttribute("r", "5.1");
        core.setAttribute("cx", "0");
        core.setAttribute("cy", "0");
        var glint = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        glint.setAttribute("class", "flow-particle-glint");
        glint.setAttribute("r", "1.25");
        glint.setAttribute("cx", "-1.4");
        glint.setAttribute("cy", "-1.4");
        var motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
        motion.setAttribute("calcMode", "linear");
        motion.setAttribute("repeatCount", "indefinite");
        motion.setAttribute("rotate", "auto");
        var motionPath = document.createElementNS("http://www.w3.org/2000/svg", "mpath");
        motion.appendChild(motionPath);
        particle.appendChild(tailLine);
        particle.appendChild(tail);
        particle.appendChild(halo);
        particle.appendChild(core);
        particle.appendChild(glint);
        particle.appendChild(motion);
        flowParticleLayer.appendChild(particle);
      }
      var motionElement = particle.querySelector("animateMotion");
      var motionPathElement = particle.querySelector("mpath");
      var pathReference = "#" + record.pathId;
      if (motionPathElement.getAttribute("href") !== pathReference) motionPathElement.setAttribute("href", pathReference);
      if (motionPathElement.getAttributeNS("http://www.w3.org/1999/xlink", "href") !== pathReference) {
        motionPathElement.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", pathReference);
      }
      var duration = flowParticleDuration(record.displayKind, record.edge.kind);
      if (motionElement.getAttribute("dur") !== duration) motionElement.setAttribute("dur", duration);
      particle.setAttribute("class", "flow-particle " + record.edge.kind + (record.displayKind !== record.edge.kind ? " " + record.displayKind : "") + " is-" + record.direction + "-flow" + (record.focusMode === "selected" ? " is-related-flow" : "") + (record.focusMode === "runtime" ? " is-runtime-flow" : ""));
      delete existing[edgeId];
    });

    Object.keys(existing).forEach(function (edgeId) {
      existing[edgeId].remove();
    });
  }

  function workflowIssues() {
    var issues = [];
    if (DIRECT_EDGE_MODE) {
      var inputEdges = workflow.edges.filter(function (edge) { return edge.source === "input"; });
      var endEdges = workflow.edges.filter(function (edge) { return edge.target === "end"; });
      if (inputEdges.length > 1) issues.push({ nodeId: "input", message: "用户输入最多只能有一条出边" });
      if (endEdges.length > 1) issues.push({ nodeId: "end", message: "结束节点最多只能有一条入边" });
      if (endEdges.length && !String(workflow.terminationCondition || "").trim()) issues.push({ nodeId: "end", field: "terminationCondition", message: "已配置结束候选，请填写终止验收条件" });
    } else if (!workflow.inputTarget) {
      issues.push({ nodeId: "input", message: "用户输入尚未连接到 Agent" });
    }
    agentNodes().forEach(function (item) {
      var outgoing = workflow.edges.filter(function (edge) { return edge.source === item.id; });
      var routableOutgoing = outgoing.filter(function (edge) { return !isTerminationWorkflowEdge(edge); });
      // Main's system routes are coverage metadata, not a requirement for a
      // worker to expose a user-authored continuation.
      var userOutgoing = routableOutgoing.filter(function (edge) { return !isMainDispatchEdge(edge); });
      if (item.id !== "main" && !outgoing.length) issues.push({ nodeId: item.id, message: item.name + " 没有出口，请连接到 Agent 或结束节点" });
      if (!DIRECT_EDGE_MODE && outgoing.some(function (edge) { return edge.kind !== "strong"; })) issues.push({ nodeId: item.id, message: item.name + " 只能发出强边；可选路径请先连接选择器" });
      if (DIRECT_EDGE_MODE) {
        var kinds = userOutgoing.map(function (edge) { return edge.kind; });
        if (isMainNode(item) && userOutgoing.length) issues.push({ nodeId: item.id, message: "Main Agent 的出边由系统固定维护" });
        if (isTerminationAgent(item.id) && kinds.includes("strong")) issues.push({ nodeId: item.id, message: item.name + " 已连接结束，不能拥有强出边" });
      }
    });
    workflow.nodes.filter(function (item) { return !DIRECT_EDGE_MODE && item.type === "selector"; }).forEach(function (item) {
      if (!workflow.edges.some(function (edge) { return isChoiceOutputEdge(edge) && edge.source === item.id; })) issues.push({ nodeId: item.id, message: item.name + " 尚未配置候选出口" });
    });
    return issues;
  }

  function isTerminationAgent(id) {
    return workflow.edges.some(function (edge) { return isTerminationWorkflowEdge(edge) && edge.source === id; });
  }

  function workflowWarnings() {
    return workflowIssues().map(function (issue) { return issue.message; });
  }

  function workflowValidationHtml() {
    var warnings = workflowWarnings();
    return warnings.length
      ? '<section class="form-section workflow-settings-section"><h3 class="section-title">配置检查</h3><div class="workflow-validation"><strong>需要完善</strong>' + warnings.map(function (warning) { return '<span>' + html(warning) + '</span>'; }).join("") + '</div></section>'
      : '<section class="form-section workflow-settings-section"><h3 class="section-title">配置检查</h3><div class="workflow-validation is-valid"><strong>配置完整</strong><span>入口、结束和所有路径语义均已设置。</span></div></section>';
  }

  function validateWorkflow(action) {
    syncDirectWorkflowMetadata();
    var issue = workflowIssues()[0];
    if (!issue) return true;
    if (issue.nodeId && getNode(issue.nodeId)) {
      selected = issue.nodeId;
      selectedEdge = null;
      render();
      if (issue.field) {
        requestAnimationFrame(function () {
          var field = issue.field === "terminationCondition"
            ? inspector.querySelector("#workflow-termination-condition")
            : inspector.querySelector('[data-field="' + issue.field + '"]');
          if (field) field.focus();
        });
      }
    }
    showToast("无法" + action + "：" + issue.message);
    return false;
  }

  function workflowSettingsHtml() {
    if (DIRECT_EDGE_MODE) return workflowValidationHtml();
    var agents = agentNodes();
    var inputOptions = '<option value=""' + (workflow.inputTarget == null ? " selected" : "") + '>未连接</option>' + agents.map(function (item) {
      return '<option value="' + html(item.id) + '"' + (workflow.inputTarget === item.id ? " selected" : "") + '>' + html(item.name) + '</option>';
    }).join("");
    var terminationOptions = agents.map(function (item) {
      var blocked = hasStrongOutgoing(item.id);
      return '<option value="' + html(item.id) + '"' + (workflow.terminationAgentId === item.id ? " selected" : "") + (blocked ? " disabled" : "") + '>' + html(item.name) + (blocked ? " · 已有强边" : "") + '</option>';
    }).join("");
    var warnings = workflowWarnings();
    return [
      '<section class="form-section workflow-settings-section"><h3 class="section-title">工作流入口与结束</h3>',
      '<label><span>用户输入首先交给</span><select id="workflow-input-target">', inputOptions, '</select></label>',
      '<label><span>结束 Agent</span><select id="workflow-termination-agent">', terminationOptions, '</select></label>',
      '<label><span>' + (DIRECT_EDGE_MODE ? '终止条件' : '终止条件（由 Main 判断）') + '</span><textarea id="workflow-termination-condition" rows="3" maxlength="240">', html(workflow.terminationCondition || ""), '</textarea></label>',
      '<p class="workflow-setting-help">' + (DIRECT_EDGE_MODE ? '直连模式：强边表示必经路径，弱边表示 Agent-to-Agent 的可选路径。终止候选边单独进入结束节点的终止闸门，可以与普通强边或弱边并存。' : '普通 Agent 只允许强边；需要多个可选下一步时，先连接一个普通选择器，再从选择器连接候选 Agent。Main 常驻选择器负责所有特殊回流，结束选择器固定提供“结束”和“回到 Main”两条系统出口。') + '</p>',
      warnings.length ? '<div class="workflow-validation"><strong>配置提示</strong>' + warnings.map(function (warning) { return '<span>' + html(warning) + '</span>'; }).join("") + '</div>' : '<div class="workflow-validation is-valid"><strong>配置状态</strong><span>入口、结束 Agent 和路径语义已设置。</span></div>',
      '</section>'
    ].join("");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = setTimeout(function () { toast.classList.remove("is-visible"); }, 2000);
  }

  function clearRouteLock() {
    routeLock = null;
  }

  function scheduleEdgeDraw() {
    if (edgeDrawFrame != null) return;
    edgeDrawFrame = requestAnimationFrame(function () {
      edgeDrawFrame = null;
      drawEdges();
    });
  }

  function flushEdgeDraw() {
    if (edgeDrawFrame != null) {
      cancelAnimationFrame(edgeDrawFrame);
      edgeDrawFrame = null;
    }
    drawEdges();
  }

  function changed(value) {
    dirty = value !== false;
    saveDraft();
    stateLabel.classList.toggle("is-saved", !dirty);
    stateLabel.innerHTML = "<i></i>" + (dirty ? "未保存" : "已保存");
    // Keep the active saved row in sync with the header state so its local
    // save action appears as soon as any workflow field changes.
    if (savedList) renderSaved();
  }

  function isDemoLocked() {
    return RUNTIME_MODE || Boolean(demoRun.active || demoRun.stagePaused || gifExport.active);
  }

  function blockDemoEdit(message) {
    if (!isDemoLocked()) return false;
    showToast(message || "运行中的 Workflow 已锁定");
    return true;
  }

  function demoStatusText(status) {
    return {
      pending: "等待",
      waiting: "等待",
      queued: "排队中",
      retrying: "重试中",
      interrupted: "已中断",
      running: "执行中",
      completed: "已完成",
      failed: RUNTIME_MODE ? "失败" : "需调整",
      skipped: "已跳过",
      updating: "调整中",
      added: "新增",
      removed: "移除"
    }[status] || "等待";
  }

  function demoStatusClass(status) {
    return status ? " is-runtime-" + String(status).replace(/[^a-z0-9_-]/gi, "") : "";
  }

  function demoFlowForEdge(edgeId) {
    return demoRun.edgeData && demoRun.edgeData[edgeId] ? demoRun.edgeData[edgeId] : null;
  }

  function demoEdgeIsActive(edgeId) {
    return Boolean(demoRun.active && demoFlowForEdge(edgeId));
  }

  function demoNodeIsRunning(id) {
    return demoRun.runningAgentIds.indexOf(id) >= 0;
  }

  function demoCurrentAgentText() {
    var ids = demoRun.runningAgentIds.map(function (id) {
      var item = getNode(id);
      return item ? item.name : id;
    });
    if (ids.length) return ids.join("、");
    var current = demoRun.currentAgentId && getNode(demoRun.currentAgentId);
    return current ? current.name : "--";
  }

  function demoLogHtml(record) {
    return '<div class="run-log-item ' + html(record.type || "event") + '"><time>T+' + (Number(record.at || 0) / 1000).toFixed(1) + 's</time><span>' + html(record.message || "") + '</span></div>';
  }

  function positionDemoFloatingCard() {
    if (!runFloatingUpdate || runFloatingUpdate.hidden || !demoRun.floatingUpdate) return;
    var update = demoRun.floatingUpdate;
    var item = update.agentId && getNode(update.agentId);
    var element = item && nodeElement(item.id);
    var bounds = canvas.getBoundingClientRect();
    var compactViewport = bounds.width <= 590;
    var cardWidth = runFloatingUpdate.offsetWidth || Math.min(324, Math.max(1, bounds.width - 24));
    var cardHeight = runFloatingUpdate.offsetHeight || 158;
    var left = bounds.width * 0.5 - cardWidth * 0.5;
    var top = 62;
    if (element) {
      var rect = element.getBoundingClientRect();
      var targetRect = {
        left: rect.left - bounds.left,
        top: rect.top - bounds.top,
        right: rect.right - bounds.left,
        bottom: rect.bottom - bounds.top
      };
      // On a phone the card is nearly full width, so side placements are not
      // useful. Keep them in the candidate list for desktop, then let the
      // overlap scorer naturally select the top or bottom slot on compact
      // canvases. This keeps the focused node visible during each Main action.
      var candidates = compactViewport ? [
        { left: 12, top: 8 },
        { left: 12, top: bounds.height - cardHeight - 12 }
      ] : [
        { left: targetRect.right + 14, top: targetRect.top - 6 },
        { left: targetRect.left - cardWidth - 14, top: targetRect.top - 6 },
        { left: targetRect.left + (targetRect.right - targetRect.left - cardWidth) * 0.5, top: targetRect.bottom + 14 },
        { left: targetRect.left + (targetRect.right - targetRect.left - cardWidth) * 0.5, top: targetRect.top - cardHeight - 14 },
        { left: bounds.width * 0.5 - cardWidth * 0.5, top: 12 },
        { left: 12, top: bounds.height - cardHeight - 12 }
      ];
      var nodeRects = Array.prototype.map.call(nodeLayer.querySelectorAll(".agent-node"), function (node) {
        var nodeRect = node.getBoundingClientRect();
        return {
          id: node.dataset.node,
          left: nodeRect.left - bounds.left,
          top: nodeRect.top - bounds.top,
          right: nodeRect.right - bounds.left,
          bottom: nodeRect.bottom - bounds.top
        };
      });
      var clampLeft = Math.max(12, bounds.width - cardWidth - 12);
      var clampTop = Math.max(12, bounds.height - cardHeight - 12);
      var best = null;
      candidates.forEach(function (candidate, index) {
        var candidateLeft = Math.max(12, Math.min(clampLeft, candidate.left));
        var candidateTop = Math.max(12, Math.min(clampTop, candidate.top));
        var candidateRect = { left: candidateLeft, top: candidateTop, right: candidateLeft + cardWidth, bottom: candidateTop + cardHeight };
        var overlapScore = 0;
        nodeRects.forEach(function (nodeRect) {
          if (candidateRect.left < nodeRect.right && candidateRect.right > nodeRect.left && candidateRect.top < nodeRect.bottom && candidateRect.bottom > nodeRect.top) {
            // Never cover the focused Agent. Other node overlaps are still
            // penalized, so a card naturally moves below/above the graph when
            // the obvious side placement would obscure a neighboring node.
            overlapScore += nodeRect.id === (item && item.id) ? 1000 : 1;
          }
        });
        var distance = Math.abs(candidateLeft - (targetRect.left + targetRect.right - cardWidth) * 0.5) + Math.abs(candidateTop - targetRect.top) * 0.12;
        var score = overlapScore * 10000 + distance + index * 0.01;
        if (!best || score < best.score) best = { left: candidateLeft, top: candidateTop, score: score };
      });
      if (best) {
        left = best.left;
        top = best.top;
      }
    } else if (compactViewport) {
      left = 12;
      top = 8;
    }
    runFloatingUpdate.style.left = Math.round(left) + "px";
    runFloatingUpdate.style.top = Math.round(top) + "px";
  }

  function positionDemoDispatchNote() {
    if (!runDispatchNote || runDispatchNote.hidden) return;
    var item = demoRun.focusNodeId && getNode(demoRun.focusNodeId);
    var element = item && nodeElement(item.id);
    var bounds = canvas.getBoundingClientRect();
    var left = bounds.width * 0.5 - 84;
    var top = 18;
    if (element) {
      var rect = element.getBoundingClientRect();
      left = rect.left - bounds.left + rect.width * 0.5 - 84;
      top = rect.bottom - bounds.top + 10;
      left = Math.max(12, Math.min(bounds.width - 180, left));
      top = Math.max(12, Math.min(bounds.height - 44, top));
    }
    runDispatchNote.style.left = Math.round(left) + "px";
    runDispatchNote.style.top = Math.round(top) + "px";
  }

  function setDemoEditControlsDisabled(disabled) {
    var ids = [
      "export-button", "save-button", "add-agent-button", "connect-button", "clear-canvas-button", "undo-button",
      "new-agent-button", "new-workflow-button", "fit-button", "layered-layout-button", "fit-viewport-button",
      "layout-menu-button", "workflow-name"
    ];
    ids.forEach(function (id) {
      var control = document.getElementById(id);
      if (control) control.disabled = disabled;
    });
    document.querySelectorAll("[data-edge-type], [data-layout-action], #agent-library button, #saved-workflows button").forEach(function (control) {
      control.disabled = disabled;
    });
    if (inspector) {
      inspector.setAttribute("aria-busy", disabled ? "true" : "false");
      inspector.querySelectorAll("button, input, textarea, select").forEach(function (control) { control.disabled = disabled; });
    }
  }

  function renderDemoUI() {
    if (!demoRunButton || !runStatusBar) return;
    var locked = isDemoLocked();
    var visible = Boolean(demoRun.hasRun);
    if (demoScenarioSelector) {
      demoScenarioSelector.querySelectorAll("[data-demo-scenario]").forEach(function (button) {
        var active = button.dataset.demoScenario === selectedDemoScenarioId;
        button.disabled = locked;
        button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }
    var workspaceElement = document.querySelector(".workspace");
    runStatusBar.hidden = !visible;
    if (runLogPanel) runLogPanel.hidden = !visible;
    if (workspaceElement) workspaceElement.classList.toggle("is-demo-running", locked);
    if (inspector) inspector.classList.toggle("is-collapsed", locked);
    demoRunButton.disabled = locked;
    demoRunButton.classList.toggle("is-running", locked);
    demoRunButton.classList.toggle("is-complete", demoRun.phase === "completed");
    demoRunButton.innerHTML = demoRun.phase === "completed"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2"></path><path d="M4 5v5h5"></path></svg><span>重新运行</span>'
      : locked
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg><span>执行中</span>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"></path></svg><span>开始执行</span>';
    demoRunButton.title = demoRun.phase === "completed" ? "重新播放动态工作流执行 Demo" : locked ? "Demo 执行中" : "播放动态工作流执行 Demo";
    if (demoStageButton) {
      var stagePaused = demoRun.stagePaused;
      var stageComplete = demoRun.phase === "completed" && demoRun.stageMode;
      demoStageButton.disabled = demoRun.active || gifExport.active;
      demoStageButton.classList.toggle("is-paused", stagePaused);
      demoStageButton.classList.toggle("is-complete", stageComplete);
      demoStageButton.innerHTML = stagePaused
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"></path></svg><span>继续第二阶段</span>'
        : stageComplete
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 3-6.2"></path><path d="M4 5v5h5"></path></svg><span>重新分阶段</span>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h12"></path><path d="M6 12h8"></path><path d="M6 19h12"></path><path d="M17 9l3 3-3 3"></path></svg><span>分阶段执行</span>';
      demoStageButton.title = stagePaused ? "继续执行第二阶段和第三阶段" : stageComplete ? "重新分阶段播放动态工作流 Demo" : "先构建 Workflow，再继续执行后续阶段";
    }
    if (gifExportButton) {
      var gifSecondSegmentReady = Boolean(demoRun.stagePaused && demoRun.stageMode && gifExport.segmentReady);
      gifExportButton.disabled = gifExport.active || (isDemoLocked() && !gifSecondSegmentReady);
      gifExportButton.classList.toggle("is-exporting", gifExport.active);
      gifExportButton.innerHTML = gifExport.active
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg><span>录制中</span>'
        : gifSecondSegmentReady
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"></path></svg><span>继续第二段 GIF</span>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 8h4M7 12h3M7 16h2M15 8v8M18 8v8"></path></svg><span>导出第一段 GIF</span>';
      gifExportButton.title = gifExport.active ? "正在录制 GIF" : gifSecondSegmentReady ? "录制执行和修改 Workflow 的第二段 GIF" : "录制编排 Workflow 的第一段 GIF";
    }
    if (runStatusDot) runStatusDot.className = "run-status-dot phase-" + (demoRun.phase || "idle");
    if (runStatusLabel) {
      runStatusLabel.textContent = demoRun.stagePaused ? "第一阶段完成" : demoRun.paused ? "已暂停" : demoRun.phase === "main-adjusting" ? "Main 调整中" : demoRun.phase === "completed" ? "执行完成" : "执行中";
    }
    if (runStatusDetail) runStatusDetail.textContent = gifExport.active
      ? (gifExport.segment === 2 ? "正在录制第二段：执行和修改 Workflow" : "正在录制第一段：编排 Workflow")
      : demoRun.detail || "正在准备运行";
    if (runScenarioLabel) runScenarioLabel.textContent = demoRun.scenarioLabel || (DEMO_SCENARIOS[selectedDemoScenarioId] && DEMO_SCENARIOS[selectedDemoScenarioId].label) || "30s 快速演示";
    if (runCurrentAgent) runCurrentAgent.textContent = "当前：" + demoCurrentAgentText();
    if (runParallelCount) runParallelCount.textContent = "并行：" + (demoRun.runningAgentIds.length || 0);
    if (runVersion) runVersion.textContent = "流程 v" + demoRun.workflowVersion;
    if (runPauseButton) {
      runPauseButton.disabled = !demoRun.active;
      runPauseButton.textContent = demoRun.paused ? "继续" : "暂停";
      runPauseButton.title = demoRun.paused ? "继续 Demo" : "暂停 Demo";
    }
    if (runStopButton) runStopButton.disabled = !locked;
    if (runLogToggle) runLogToggle.textContent = demoRun.logExpanded ? "收起日志" : "展开日志";
    if (runLogList) {
      var records = demoRun.logExpanded ? demoRun.log : demoRun.log.slice(-5);
      runLogList.innerHTML = records.map(demoLogHtml).join("") || '<p class="run-log-empty">运行事件将在这里出现</p>';
      if (demoRun.logExpanded) runLogList.scrollTop = runLogList.scrollHeight;
    }
    if (runFloatingUpdate) {
      var update = demoRun.floatingUpdate;
      runFloatingUpdate.hidden = !update;
      if (update) {
        runFloatingUpdate.className = "run-floating-update is-" + String(update.kind || "prompt");
        runFloatingUpdate.innerHTML = '<div class="run-update-kicker"><span class="run-update-icon">' + html(update.icon || "*") + '</span><span>' + html(update.title || "Main 正在调整") + '</span><b>' + html(update.status || "修改中") + '</b></div><strong>' + html(update.agentName || "Agent") + '</strong><div class="run-update-content">' + html(update.content || "") + '</div><small>' + html(update.reason || "Main Agent 根据执行结果动态调整") + '</small>';
      }
    }
    if (runDispatchNote) {
      runDispatchNote.hidden = !demoRun.dispatchNote;
      runDispatchNote.textContent = demoRun.dispatchNote || "";
    }
    setDemoEditControlsDisabled(locked);
    requestAnimationFrame(function () {
      positionDemoFloatingCard();
      positionDemoDispatchNote();
    });
  }

  function syncDirectEdgeControls() {
    if (!DIRECT_EDGE_MODE) return;
    document.querySelectorAll("[data-edge-type]").forEach(function (button) {
      var active = button.dataset.edgeType === directEdgeKind;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    var selectedOutgoing = selected && !selectedEdge ? outgoingAgentEdges(selected) : [];
    var selectedKind = selectedOutgoing.length ? selectedOutgoing[0].kind : directEdgeKind;
    document.querySelectorAll("[data-new-edge-kind]").forEach(function (button) {
      var active = button.dataset.newEdgeKind === selectedKind;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      if (selected && isTerminationAgent(selected) && button.dataset.newEdgeKind === "strong") {
        button.disabled = true;
        button.title = "结束 Agent 不能拥有强出边";
      }
    });
  }

  function syncAnchorModeControls() {
    // Kept as a compatibility no-op for drafts and selector-branch helpers.
  }

  function renderInspector() {
    var currentBody = inspector.querySelector(".inspector-body");
    var scrollTop = currentBody ? currentBody.scrollTop : 0;
    inspector.innerHTML = inspectorHtml();
    var nextBody = inspector.querySelector(".inspector-body");
    if (nextBody) nextBody.scrollTop = Math.min(scrollTop, nextBody.scrollHeight);
  }

  function setDirectEdgeKind(kind) {
    if (!DIRECT_EDGE_MODE || (kind !== "strong" && kind !== "weak")) return;
    directEdgeKind = kind;
    syncDirectEdgeControls();
    if (linkDrag && linkDrag.lastClientX != null) drawPendingEdge(linkDrag.lastClientX, linkDrag.lastClientY);
    if (selected && !selectedEdge) renderInspector();
  }

  function runtimeGroupHtml(item) {
    if (!RUNTIME_MODE || item.type !== "collaboration") return "";
    var members = item.members || [];
    var actions = item.leaderAgentId ? '<div class="runtime-group-leader">Leader · ' + html(item.leaderAgentId) + '</div>' : '';
    actions += '<div class="runtime-group-actions"><button type="button" data-runtime-action="toggle-group" aria-expanded="' + Boolean(item.expanded) + '" aria-label="' + html((item.expanded ? "收起" : "展开") + item.name + "成员") + '">' + (item.expanded ? "收起成员" : "查看 " + members.length + " 个成员节点") + '</button>';
    if (item.canEnter) actions += '<button type="button" data-runtime-action="navigate-group" data-group-id="' + html(item.groupId) + '" aria-label="' + html("进入" + item.name + "组内运行 Workflow") + '">进入组内</button>';
    actions += "</div>";
    if (!item.expanded) return actions;
    return actions + '<ul class="runtime-group-members" aria-label="' + html(item.name + "成员摘要") + '">' + members.map(function (member) {
      var name = member.groupId && item.canEnter
        ? '<button type="button" data-runtime-action="navigate-group" data-group-id="' + html(member.groupId) + '">' + html(member.name) + '</button>'
        : '<strong>' + html(member.name) + '</strong>';
      return '<li data-member="' + html(member.id) + '">' + name + (member.leader ? '<em>Leader</em>' : '') + '<small data-member-state="' + html(member.state) + '">' + html(member.label) + '</small></li>';
    }).join("") + (members.length ? "" : '<li>暂无成员节点</li>') + "</ul>";
  }

  function nodeHtml(item) {
    var colors = PALETTE[item.color] || PALETTE.green;
    var fixedNode = false;
    var endNode = isEndNode(item);
    var systemNode = item.id === "main" || item.id === "input" || endNode;
    var selectorNode = isSelectorNode(item);
    var systemSelector = isSystemSelectorNode(item);
    var nodeModelLabel = endNode ? (DIRECT_EDGE_MODE ? "工作流结束" : "结束 / Main 判断") : selectorNode ? (item.selectorLabel || "Main 选择") : item.model;
    var anchorClass = isAnchorNode(item) ? (fixedNode ? " is-anchor-locked" : " is-anchor-free") : "";
    var selectorOutputs = workflow.edges.filter(function (edge) { return edge.source === item.id && edge.kind === "weak" && !isTerminationEdge(edge); }).length;
    var selectorRevealed = selectorNode && (selected === item.id || hoveredSelectorId === item.id);
    var terminalNode = workflow.edges.some(function (edge) { return edge.source === item.id && edge.target === "end"; });
    var runtimeStatus = demoRun.hasRun ? (demoRun.nodeStates[item.id] || "pending") : "";
    var runtimeClass = runtimeStatus ? demoStatusClass(runtimeStatus) : "";
    var runtimeAdded = demoRun.addedAgentIds.indexOf(item.id) >= 0 && runtimeStatus !== "added" ? " is-runtime-added" : "";
    var runtimeMoving = demoRun.movingAgentIds.indexOf(item.id) >= 0 ? " is-runtime-moving" : "";
    var runtimeResult = demoRun.nodeResults[item.id];
    var classes = "agent-node" + (RUNTIME_MODE && item.type === "collaboration" ? " is-collaboration" : "") + (item.type === "main" ? " is-main" : "") + (item.type === "input" ? " is-input" : "") + (endNode ? " is-end" : "") + (selectorNode ? " is-selector" : "") + (systemSelector ? " is-system-selector" : "") + (selectorRevealed ? " is-selector-revealed" : "") + anchorClass + (item.type === "main" && fixedNode ? " is-locked-main" : "") + (endNode && fixedNode ? " is-locked-end" : "") + (terminalNode ? " is-terminal" : "") + (selected === item.id ? " is-selected" : "") + (linking === item.id ? " is-connection-source" : "") + runtimeClass + runtimeAdded + runtimeMoving + (demoNodeIsRunning(item.id) ? " is-runtime-current" : "") + (isDemoLocked() ? " is-runtime-locked" : "");
    var fixedBadge = RUNTIME_MODE && item.type === "collaboration" ? '<em class="node-badge">GROUP</em>' : item.type === "main" ? '<em class="node-badge">MAIN</em>' : item.type === "input" ? '<em class="node-badge">INPUT</em>' : endNode ? '<em class="node-badge terminal">' + (DIRECT_EDGE_MODE ? 'END' : 'END SELECTOR') + '</em>' : systemSelector ? '<em class="node-badge main-selector">MAIN SELECTOR</em>' : selectorNode ? '<em class="node-badge selector">SELECTOR</em>' : "";
    var terminalBadge = item.type !== "input" && !endNode && terminalNode ? '<em class="node-badge terminal" title="已连接结束节点">&#10003;</em>' : "";
    var runtimeBadge = runtimeStatus ? '<em class="runtime-status-badge">' + html(demoStatusText(runtimeStatus)) + '</em>' : "";
    var portSides = item.id === "main" && DIRECT_EDGE_MODE ? ["top", "bottom", "left"] : ["top", "right", "bottom", "left"];
    var ports = portSides.map(function (side) {
      var edgeCount = workflow.edges.filter(function (edge) {
        if (isMainDispatchEdge(edge)) return false;
        return (edge.source === item.id && edge.sourcePort === side) || (edge.target === item.id && edge.targetPort === side);
      }).length;
      return '<button class="node-port ' + side + (edgeCount ? ' is-used' : '') + '" type="button" data-port="' + side + '" title="' + PORT_LABELS[side] + '连接点' + (edgeCount ? ' · ' + edgeCount + ' 条连接' : '') + '" aria-label="' + PORT_LABELS[side] + '连接点"></button>';
    }).join("");
    var dispatchPort = item.id === "main" && DIRECT_EDGE_MODE
      ? '<span class="main-dispatch-port" title="系统固定调度出口" aria-hidden="true"><i></i></span>'
      : '';
    return [
      '<article class="', classes, '" data-node="', html(item.id), '" draggable="false" style="left:', item.x, "px;top:", item.y, "px;--agent-color:", colors[0], ";--agent-soft:", colors[1], ';">',
      ports, dispatchPort,
      '<div class="node-avatar">', endNode ? "&#10003;" : selectorNode ? "M" : html(initials(item.name)), "</div>",
      '<div class="node-copy"><div class="node-title-row"><strong>', html(item.name), "</strong>", fixedBadge, terminalBadge, runtimeBadge, '</div><span title="', html(item.description || ""), '">', html(item.description || "未填写职责说明"), "</span><small", runtimeResult ? ' class="node-runtime-result is-' + html(runtimeResult.tone || "neutral") + '" title="' + html(runtimeResult.text) + '"' : "", ">", html(runtimeResult ? runtimeResult.text : nodeModelLabel), runtimeResult ? "" : selectorNode && selectorOutputs ? ' <b class="selector-count">' + selectorOutputs + ' 个候选</b>' : "", "</small>", runtimeGroupHtml(item), "</div>",
      systemNode ? '<span class="node-fixed-mark" title="系统节点">' + (isMainNode(item) ? "&#128274;" : endNode ? "&#10003;" : "&#8226;") + '</span>' : '<button class="node-more" type="button" title="编辑 Agent">&#8942;</button>',
      "</article>"
    ].join("");
  }

  function nodeElement(id) {
    var elements = nodeLayer.children;
    for (var index = 0; index < elements.length; index += 1) {
      if (elements[index].dataset.node === id) return elements[index];
    }
    return null;
  }

  function applyViewport() {
    nodeLayer.style.transform = "translate(" + viewport.x + "px, " + viewport.y + "px) scale(" + viewport.k + ")";
    if (mainControlLayer) mainControlLayer.setAttribute("transform", "translate(" + viewport.x + " " + viewport.y + ") scale(" + viewport.k + ")");
    edgeLayer.setAttribute("transform", "translate(" + viewport.x + " " + viewport.y + ") scale(" + viewport.k + ")");
    if (flowParticleLayer) flowParticleLayer.setAttribute("transform", "translate(" + viewport.x + " " + viewport.y + ") scale(" + viewport.k + ")");
    pendingLayer.setAttribute("transform", "translate(" + viewport.x + " " + viewport.y + ") scale(" + viewport.k + ")");
    var gridSize = 18 * viewport.k;
    canvas.style.backgroundSize = gridSize + "px " + gridSize + "px";
    canvas.style.backgroundPosition = (viewport.x - 4 * viewport.k) + "px " + (viewport.y - 4 * viewport.k) + "px";
    updateZoomControls();
    if (demoRun.hasRun) {
      requestAnimationFrame(function () {
        positionDemoFloatingCard();
        positionDemoDispatchNote();
      });
    }
  }

  function resetViewport() {
    viewport.x = 0;
    viewport.y = 0;
    viewport.k = 1;
    applyViewport();
  }

  function updateZoomControls() {
    var zoomReset = document.getElementById("zoom-reset-button");
    var zoomOut = document.getElementById("zoom-out-button");
    var zoomIn = document.getElementById("zoom-in-button");
    if (zoomReset) zoomReset.textContent = Math.round(viewport.k * 100) + "%";
    if (zoomOut) zoomOut.disabled = viewport.k <= MIN_ZOOM + 0.001;
    if (zoomIn) zoomIn.disabled = viewport.k >= MAX_ZOOM - 0.001;
  }

  function setZoom(nextZoom, clientX, clientY) {
    var next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (Math.abs(next - viewport.k) < 0.001) return;
    var bounds = canvas.getBoundingClientRect();
    var screenX = clientX == null ? bounds.width / 2 : clientX - bounds.left;
    var screenY = clientY == null ? bounds.height / 2 : clientY - bounds.top;
    var worldX = (screenX - viewport.x) / viewport.k;
    var worldY = (screenY - viewport.y) / viewport.k;
    viewport.k = next;
    viewport.x = Math.round(screenX - worldX * next);
    viewport.y = Math.round(screenY - worldY * next);
    applyViewport();
    requestAnimationFrame(function () {
      drawEdges();
      if (linkDrag && linkDrag.lastClientX != null && linkDrag.lastClientY != null) {
        drawPendingEdge(linkDrag.lastClientX, linkDrag.lastClientY);
      }
    });
  }

  function hideAlignmentGuides() {
    if (verticalAlignmentGuide) verticalAlignmentGuide.classList.remove("is-visible");
    if (horizontalAlignmentGuide) horizontalAlignmentGuide.classList.remove("is-visible");
  }

  function showAlignmentGuides(worldX, worldY) {
    if (verticalAlignmentGuide) {
      verticalAlignmentGuide.classList.toggle("is-visible", Number.isFinite(worldX));
      if (Number.isFinite(worldX)) verticalAlignmentGuide.style.left = Math.round(viewport.x + worldX * viewport.k) + "px";
    }
    if (horizontalAlignmentGuide) {
      horizontalAlignmentGuide.classList.toggle("is-visible", Number.isFinite(worldY));
      if (Number.isFinite(worldY)) horizontalAlignmentGuide.style.top = Math.round(viewport.y + worldY * viewport.k) + "px";
    }
  }

  function snapDraggedNode(item, element, proposedX, proposedY) {
    var size = nodeDimensions(element);
    var threshold = 7 / Math.max(viewport.k, 0.01);
    var bestX = null;
    var bestY = null;
    var movingX = [proposedX, proposedX + size.width / 2, proposedX + size.width];
    var movingY = [proposedY, proposedY + size.height / 2, proposedY + size.height];
    workflow.nodes.forEach(function (other) {
      if (other.id === item.id) return;
      var otherSize = nodeDimensions(nodeElement(other.id));
      var otherX = [other.x, other.x + otherSize.width / 2, other.x + otherSize.width];
      var otherY = [other.y, other.y + otherSize.height / 2, other.y + otherSize.height];
      for (var axisIndex = 0; axisIndex < 3; axisIndex += 1) {
        var xDelta = otherX[axisIndex] - movingX[axisIndex];
        if (Math.abs(xDelta) <= threshold && (!bestX || Math.abs(xDelta) < Math.abs(bestX.delta))) {
          bestX = { delta: xDelta, guide: otherX[axisIndex] };
        }
        var yDelta = otherY[axisIndex] - movingY[axisIndex];
        if (Math.abs(yDelta) <= threshold && (!bestY || Math.abs(yDelta) < Math.abs(bestY.delta))) {
          bestY = { delta: yDelta, guide: otherY[axisIndex] };
        }
      }
    });
    var nextX = proposedX + (bestX ? bestX.delta : 0);
    var nextY = proposedY + (bestY ? bestY.delta : 0);
    showAlignmentGuides(bestX && bestX.guide, bestY && bestY.guide);
    return { x: nextX, y: nextY };
  }

  function portVector(side) {
    if (side === "top") return { x: 0, y: -1 };
    if (side === "bottom") return { x: 0, y: 1 };
    if (side === "left") return { x: -1, y: 0 };
    return { x: 1, y: 0 };
  }

  function validPortSide(side) {
    return side === "top" || side === "right" || side === "bottom" || side === "left";
  }

  function pinnedPort(edge, endpoint) {
    var key = endpoint === "source" ? "sourcePort" : "targetPort";
    var pinnedKey = endpoint === "source" ? "sourcePortPinned" : "targetPortPinned";
    return edge[pinnedKey] && validPortSide(edge[key]) ? edge[key] : null;
  }

  function portPreference(edge, endpoint) {
    if (!edge) return null;
    var preferenceKey = endpoint === "source" ? "sourcePortPreference" : "targetPortPreference";
    var portKey = endpoint === "source" ? "sourcePort" : "targetPort";
    if (validPortSide(edge[preferenceKey])) return edge[preferenceKey];
    return validPortSide(edge[portKey]) ? edge[portKey] : null;
  }

  function rememberPortPreference(edge) {
    if (!edge) return;
    if (!validPortSide(edge.sourcePortPreference) && validPortSide(edge.sourcePort)) {
      edge.sourcePortPreference = edge.sourcePort;
    }
    if (!validPortSide(edge.targetPortPreference) && validPortSide(edge.targetPort)) {
      edge.targetPortPreference = edge.targetPort;
    }
  }

  function expectedPortSide(edge, endpoint, layout) {
    var source = getNode(edge.source);
    var target = getNode(edge.target);
    if (!source || !target) return null;
    var sourceColumn = layout && layout.byNode && layout.byNode[source.id];
    var targetColumn = layout && layout.byNode && layout.byNode[target.id];
    var sourceElement = nodeElement(source.id);
    var targetElement = nodeElement(target.id);
    var sourceSize = nodeDimensions(sourceElement);
    var targetSize = nodeDimensions(targetElement);
    var centerDx = target.x + targetSize.width / 2 - (source.x + sourceSize.width / 2);
    var centerDy = target.y + targetSize.height / 2 - (source.y + sourceSize.height / 2);
    if (sourceColumn && targetColumn && sourceColumn.index !== targetColumn.index && Math.abs(centerDx) >= Math.abs(centerDy) * 1.05) {
      if (endpoint === "source") return targetColumn.index > sourceColumn.index ? "right" : "left";
      return sourceColumn.index > targetColumn.index ? "right" : "left";
    }
    var sourceCenterY = source.y + sourceSize.height / 2;
    var targetCenterY = target.y + targetSize.height / 2;
    if (endpoint === "source") return sourceCenterY <= targetCenterY ? "bottom" : "top";
    return targetCenterY <= sourceCenterY ? "bottom" : "top";
  }

  function cubicPortSamples(start, end, sourceSide, targetSide) {
    var controls = curveControlPoints(start, end, sourceSide, targetSide, 0);
    var samples = [];
    for (var index = 0; index <= 18; index += 1) {
      samples.push(cubicPointAt(start, controls.control1, controls.control2, end, index / 18));
    }
    return samples;
  }

  function portPairCost(edge, sourceSide, targetSide, context) {
    var source = getNode(edge.source);
    var target = getNode(edge.target);
    var sourceElement = source && nodeElement(source.id);
    var targetElement = target && nodeElement(target.id);
    if (!source || !target || !sourceElement || !targetElement) return Infinity;
    var sourceSize = nodeDimensions(sourceElement);
    var targetSize = nodeDimensions(targetElement);
    var sourceCenter = { x: source.x + sourceSize.width / 2, y: source.y + sourceSize.height / 2 };
    var targetCenter = { x: target.x + targetSize.width / 2, y: target.y + targetSize.height / 2 };
    var dx = targetCenter.x - sourceCenter.x;
    var dy = targetCenter.y - sourceCenter.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var direction = { x: dx / length, y: dy / length };
    var sourceVector = portVector(sourceSide);
    var targetVector = portVector(targetSide);
    var cost = 0;
    var sourceAlignment = sourceVector.x * direction.x + sourceVector.y * direction.y;
    var targetAlignment = targetVector.x * -direction.x + targetVector.y * -direction.y;
    cost += (1 - Math.max(-1, sourceAlignment)) * 56;
    cost += (1 - Math.max(-1, targetAlignment)) * 56;
    if (sourceAlignment < -0.15) cost += 150;
    if (targetAlignment < -0.15) cost += 150;

    var expectedSource = expectedPortSide(edge, "source", context && context.layout);
    var expectedTarget = expectedPortSide(edge, "target", context && context.layout);
    if (expectedSource && sourceSide !== expectedSource) cost += 26;
    if (expectedTarget && targetSide !== expectedTarget) cost += 26;
    var preferredSource = portPreference(edge, "source");
    var preferredTarget = portPreference(edge, "target");
    if (preferredSource && sourceSide !== preferredSource) cost += 24;
    if (preferredTarget && targetSide !== preferredTarget) cost += 24;

    var counts = context && context.counts || {};
    var sourceLoad = counts[edge.source + ":" + sourceSide] || 0;
    var targetLoad = counts[edge.target + ":" + targetSide] || 0;
    cost += sourceLoad * sourceLoad * 28 + targetLoad * targetLoad * 28;
    if (sourceSide === targetSide) cost += 8;
    if (sourceSide === targetSide && sourceSide !== "top" && sourceSide !== "bottom") cost += 18;

    var start = portAnchor(source, sourceElement, sourceSide);
    var end = portAnchor(target, targetElement, targetSide);
    var samples = cubicPortSamples(start, end, sourceSide, targetSide);
    // Endpoint clearance is handled by the port lead itself. Only unrelated
    // cards are obstacles for port selection; treating the source/target's
    // inflated rectangle as an obstacle would penalize every short straight
    // edge and incorrectly favor a large loop.
    var obstacles = (context && context.obstacles) || workflow.nodes.filter(function (item) {
      return item.id !== edge.source && item.id !== edge.target;
    }).map(function (item) {
      return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP);
    });
    samples.forEach(function (point, index) {
      obstacles.forEach(function (rect) {
        if (!pointInRouteRect(point, rect)) return;
        var ownEndpoint = rect.id === edge.source || rect.id === edge.target;
        var endpointWindow = index < 2 || index > samples.length - 3;
        if (!ownEndpoint || !endpointWindow) cost += 880;
      });
    });
    var chosen = context && context.choices || {};
    Object.keys(chosen).forEach(function (edgeId) {
      if (edgeId === edge.id) return;
      var other = chosen[edgeId];
      if (!other) return;
      var otherEdge = workflow.edges.find(function (candidate) { return candidate.id === edgeId; });
      if (!otherEdge) return;
      var otherSource = getNode(otherEdge.source);
      var otherTarget = getNode(otherEdge.target);
      if (!otherSource || !otherTarget) return;
      var otherStart = portAnchor(otherSource, nodeElement(otherSource.id), other.sourceSide);
      var otherEnd = portAnchor(otherTarget, nodeElement(otherTarget.id), other.targetSide);
      var close = Infinity;
      for (var sampleIndex = 1; sampleIndex < samples.length - 1; sampleIndex += 1) {
        close = Math.min(close, pointToSegmentDistance(samples[sampleIndex], otherStart, otherEnd));
      }
      if (close < 16) cost += 190;
      else if (close < 28) cost += 42;
    });
    // Termination uses its own visual style but should remain a readable outward exit.
    if (isTerminationWorkflowEdge(edge) && sourceSide === targetSide) cost += 42;
    return cost;
  }

  function optimizeWorkflowPorts(options) {
    options = options || {};
    var edges = workflow.edges.filter(function (edge) {
      return edge && !isMainDispatchEdge(edge) && edge.source !== edge.target && getNode(edge.source) && getNode(edge.target);
    });
    if (!edges.length) return {};
    edges.forEach(rememberPortPreference);
    var choices = {};
    edges.forEach(function (edge) {
      choices[edge.id] = {
        sourceSide: validPortSide(edge.sourcePort) ? edge.sourcePort : choosePortSide(getNode(edge.source), getNode(edge.target), nodeElement(edge.source)),
        targetSide: validPortSide(edge.targetPort) ? edge.targetPort : choosePortSide(getNode(edge.target), getNode(edge.source), nodeElement(edge.target))
      };
    });
    var sides = ["right", "left", "bottom", "top"];
    var obstaclesByEdge = {};
    edges.forEach(function (edge) {
      obstaclesByEdge[edge.id] = workflow.nodes.filter(function (item) {
        return item.id !== edge.source && item.id !== edge.target;
      }).map(function (item) {
        return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP);
      });
    });
    for (var pass = 0; pass < 2; pass += 1) {
      var counts = {};
      Object.keys(choices).forEach(function (edgeId) {
        var choice = choices[edgeId];
        var edge = workflow.edges.find(function (candidate) { return candidate.id === edgeId; });
        if (!edge || !choice) return;
        counts[edge.source + ":" + choice.sourceSide] = (counts[edge.source + ":" + choice.sourceSide] || 0) + 1;
        counts[edge.target + ":" + choice.targetSide] = (counts[edge.target + ":" + choice.targetSide] || 0) + 1;
      });
      edges.slice().sort(function (a, b) {
        var aPriority = isTerminationWorkflowEdge(a) ? 2 : a.kind === "strong" ? 1 : 0;
        var bPriority = isTerminationWorkflowEdge(b) ? 2 : b.kind === "strong" ? 1 : 0;
        return bPriority - aPriority || String(a.id).localeCompare(String(b.id));
      }).forEach(function (edge) {
        var existing = choices[edge.id];
        if (!existing) return;
        counts[edge.source + ":" + existing.sourceSide] = Math.max(0, (counts[edge.source + ":" + existing.sourceSide] || 1) - 1);
        counts[edge.target + ":" + existing.targetSide] = Math.max(0, (counts[edge.target + ":" + existing.targetSide] || 1) - 1);
        var context = { layout: options.layout, counts: counts, choices: choices, obstacles: obstaclesByEdge[edge.id] };
        var best = existing;
        var bestCost = portPairCost(edge, existing.sourceSide, existing.targetSide, context);
        sides.forEach(function (sourceSide) {
          sides.forEach(function (targetSide) {
            var cost = portPairCost(edge, sourceSide, targetSide, context);
            if (cost < bestCost - 0.1) {
              best = { sourceSide: sourceSide, targetSide: targetSide };
              bestCost = cost;
            }
          });
        });
        choices[edge.id] = best;
        counts[edge.source + ":" + best.sourceSide] = (counts[edge.source + ":" + best.sourceSide] || 0) + 1;
        counts[edge.target + ":" + best.targetSide] = (counts[edge.target + ":" + best.targetSide] || 0) + 1;
      });
    }
    edges.forEach(function (edge) {
      var choice = choices[edge.id];
      if (!choice) return;
      edge.sourcePort = choice.sourceSide;
      edge.targetPort = choice.targetSide;
      // This is the effective port used by the current layout. The preference
      // fields remain unchanged, so the next整理 can still respect the user's
      // original choice while correcting new congestion.
      edge.sourcePortPinned = true;
      edge.targetPortPinned = true;
    });
    return choices;
  }

  function nodeDimensions(element) {
    return {
      width: element && element.offsetWidth || 194,
      height: element && element.offsetHeight || 92
    };
  }

  function choosePortSide(fromNode, toNode, fromElement) {
    var fromSize = nodeDimensions(fromElement);
    var toElement = nodeElement(toNode.id);
    var toSize = nodeDimensions(toElement);
    var fromCenterX = fromNode.x + fromSize.width / 2;
    var fromCenterY = fromNode.y + fromSize.height / 2;
    var toCenterX = toNode.x + toSize.width / 2;
    var toCenterY = toNode.y + toSize.height / 2;
    var dx = toCenterX - fromCenterX;
    var dy = toCenterY - fromCenterY;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }

  function portAnchor(node, element, side, offset) {
    var size = nodeDimensions(element);
    var requested = Number.isFinite(offset) ? offset : 0;
    if (side === "top" || side === "bottom") {
      var horizontalLimit = Math.max(0, size.width / 2 - 16);
      var horizontalOffset = Math.max(-horizontalLimit, Math.min(horizontalLimit, requested));
      return { x: node.x + size.width / 2 + horizontalOffset, y: side === "top" ? node.y : node.y + size.height };
    }
    var verticalLimit = Math.max(0, size.height / 2 - 16);
    var verticalOffset = Math.max(-verticalLimit, Math.min(verticalLimit, requested));
    if (side === "left") return { x: node.x, y: node.y + size.height / 2 + verticalOffset };
    return { x: node.x + size.width, y: node.y + size.height / 2 + verticalOffset };
  }

  function curvePath(start, end, startSide, endSide, bend) {
    var controls = curveControlPoints(start, end, startSide, endSide, bend);
    return "M " + start.x + " " + start.y +
      " C " + controls.control1.x + " " + controls.control1.y +
      ", " + controls.control2.x + " " + controls.control2.y +
      ", " + end.x + " " + end.y;
  }

  // Keep the rendered edge and its label tied to one geometry calculation.
  // Previously strong edges used a routed midpoint for the label while the
  // visible path was a different cubic/rounded route, which made the label
  // appear to float during a drag. The exact cubic midpoint also gives every
  // strong edge the same smooth visual treatment.
  function curveGeometry(start, end, startSide, endSide, bend) {
    var controls = curveControlPoints(start, end, startSide, endSide, bend);
    return {
      path: "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
        " C " + routeNumber(controls.control1.x) + " " + routeNumber(controls.control1.y) +
        ", " + routeNumber(controls.control2.x) + " " + routeNumber(controls.control2.y) +
        ", " + routeNumber(end.x) + " " + routeNumber(end.y),
      midpoint: cubicPointAt(start, controls.control1, controls.control2, end, 0.5),
      control1: controls.control1,
      control2: controls.control2
    };
  }

  function terminationCurvePath(start, end) {
    // The terminal route often travels from a lower Agent back to the top
    // anchor rail. A normal port cubic overshoots above the rail; use an
    // outer vertical bow that keeps the whole decision path in view.
    var railX = Math.max(start.x, end.x) + 96;
    return "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
      " C " + routeNumber(railX) + " " + routeNumber(start.y) +
      ", " + routeNumber(railX) + " " + routeNumber(end.y) +
      ", " + routeNumber(end.x) + " " + routeNumber(end.y);
  }

  function terminationCurveMidpoint(start, end) {
    var railX = Math.max(start.x, end.x) + 96;
    return cubicPointAt(
      start,
      { x: railX, y: start.y },
      { x: railX, y: end.y },
      end,
      0.5
    );
  }

  function returnMainCurvePath(start, end) {
    var railY = Math.max(start.y, end.y) + 142;
    return "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
      " C " + routeNumber(start.x) + " " + routeNumber(railY) +
      ", " + routeNumber(end.x) + " " + routeNumber(railY) +
      ", " + routeNumber(end.x) + " " + routeNumber(end.y);
  }

  function returnMainCurveMidpoint(start, end) {
    var railY = Math.max(start.y, end.y) + 142;
    return cubicPointAt(start, { x: start.x, y: railY }, { x: end.x, y: railY }, end, 0.5);
  }

  function curveControlPoints(start, end, startSide, endSide, bend) {
    var startVector = portVector(startSide);
    var endVector = portVector(endSide);
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var distance = Math.max(42, Math.min(180, length * 0.42));
    var perpendicular = { x: -dy / length, y: dx / length };
    var offset = bend || 0;
    var control1 = {
      x: start.x + startVector.x * distance + perpendicular.x * offset,
      y: start.y + startVector.y * distance + perpendicular.y * offset
    };
    var control2 = {
      x: end.x + endVector.x * distance + perpendicular.x * offset,
      y: end.y + endVector.y * distance + perpendicular.y * offset
    };
    return { control1: control1, control2: control2 };
  }

  function cubicPointAt(start, control1, control2, end, progress) {
    var t = Math.max(0, Math.min(1, progress));
    var inverse = 1 - t;
    return {
      x: inverse * inverse * inverse * start.x + 3 * inverse * inverse * t * control1.x + 3 * inverse * t * t * control2.x + t * t * t * end.x,
      y: inverse * inverse * inverse * start.y + 3 * inverse * inverse * t * control1.y + 3 * inverse * t * t * control2.y + t * t * t * end.y
    };
  }

  function translatedWeakCurveGeometry(lock, start, end, sourceSide, targetSide, bend) {
    var originalStart = lock.start || start;
    var originalEnd = lock.end || end;
    var controls = lock.weakControls;
    if (!controls) {
      controls = curveControlPoints(originalStart, originalEnd, sourceSide, targetSide, bend);
    }
    var sourceDelta = { x: start.x - originalStart.x, y: start.y - originalStart.y };
    var targetDelta = { x: end.x - originalEnd.x, y: end.y - originalEnd.y };
    // Move each control point mostly with its own endpoint and slightly with
    // the opposite endpoint. This preserves the original arc while allowing
    // the curve to stretch continuously during a drag.
    var control1 = {
      x: controls.control1.x + sourceDelta.x * 0.84 + targetDelta.x * 0.16,
      y: controls.control1.y + sourceDelta.y * 0.84 + targetDelta.y * 0.16
    };
    var control2 = {
      x: controls.control2.x + sourceDelta.x * 0.16 + targetDelta.x * 0.84,
      y: controls.control2.y + sourceDelta.y * 0.16 + targetDelta.y * 0.84
    };
    var midpoint = cubicPointAt(start, control1, control2, end, 0.5);
    return {
      path: "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
      " C " + routeNumber(control1.x) + " " + routeNumber(control1.y) +
      ", " + routeNumber(control2.x) + " " + routeNumber(control2.y) +
      ", " + routeNumber(end.x) + " " + routeNumber(end.y),
      control1: control1,
      control2: control2,
      midpoint: midpoint
    };
  }

  function translatedWeakCurvePath(lock, start, end, sourceSide, targetSide, bend) {
    return translatedWeakCurveGeometry(lock, start, end, sourceSide, targetSide, bend).path;
  }

  // Recompute weak-edge controls from the live endpoints. Keeping the old
  // controls translated from the drag's first frame is tempting, but it also
  // keeps an obsolete upward/downward bow after the target crosses the source.
  // The bend itself is continuous (see weakBendFromGeometry), so this helper
  // gives the dashed route the same smooth live adaptation as strong edges.
  function liveWeakCurveGeometry(start, end, sourceSide, targetSide, bend) {
    var controls = curveControlPoints(start, end, sourceSide, targetSide, bend);
    var midpoint = cubicPointAt(start, controls.control1, controls.control2, end, 0.5);
    return {
      path: "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
        " C " + routeNumber(controls.control1.x) + " " + routeNumber(controls.control1.y) +
        ", " + routeNumber(controls.control2.x) + " " + routeNumber(controls.control2.y) +
        ", " + routeNumber(end.x) + " " + routeNumber(end.y),
      control1: controls.control1,
      control2: controls.control2,
      midpoint: midpoint
    };
  }

  function curveMidpoint(start, end, bend) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    return {
      x: (start.x + end.x) / 2 - dy / length * (bend || 0) * 0.75,
      y: (start.y + end.y) / 2 + dx / length * (bend || 0) * 0.75
    };
  }

  // 将整理阶段的车道位置转换成贝塞尔曲线的垂直偏移。
  // 路由点仍用于适配画布边界，实际绘制使用平滑曲线。
  function smoothLaneBend(start, end, lanePoint) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var perpendicular = { x: -dy / length, y: dx / length };
    var midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    return (lanePoint.x - midpoint.x) * perpendicular.x +
      (lanePoint.y - midpoint.y) * perpendicular.y;
  }

  function boundedLaneBend(start, end, lanePoint) {
    var bend = smoothLaneBend(start, end, lanePoint);
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    // 长距离边最多只使用有限的弧度，避免节点手动移动后出现跨画布的大回环。
    var limit = Math.max(42, Math.min(172, length * 0.36));
    return Math.max(-limit, Math.min(limit, bend));
  }

  function routeBendFromPoints(start, end, points) {
    if (!points || points.length < 3) return 0;
    var best = 0;
    points.forEach(function (point, index) {
      if (index === 0 || index === points.length - 1) return;
      var bend = smoothLaneBend(start, end, point);
      if (Math.abs(bend) > Math.abs(best)) best = bend;
    });
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var limit = Math.max(42, Math.min(172, length * 0.36));
    return Math.max(-limit, Math.min(limit, best));
  }

  function routeNumber(value) {
    return Math.round(value * 10) / 10;
  }

  function routeRect(node, element, gap) {
    var size = nodeDimensions(element);
    return {
      id: node && node.id,
      left: node.x - gap,
      top: node.y - gap,
      right: node.x + size.width + gap,
      bottom: node.y + size.height + gap
    };
  }

  function routePointBlocked(point, obstacles) {
    return obstacles.some(function (rect) {
      return point.x > rect.left + ROUTE_EPSILON && point.x < rect.right - ROUTE_EPSILON &&
        point.y > rect.top + ROUTE_EPSILON && point.y < rect.bottom - ROUTE_EPSILON;
    });
  }

  function routeSegmentBlocked(start, end, obstacles) {
    var horizontal = Math.abs(start.y - end.y) <= ROUTE_EPSILON;
    var vertical = Math.abs(start.x - end.x) <= ROUTE_EPSILON;
    if (!horizontal && !vertical) return true;
    var first = horizontal ? Math.min(start.x, end.x) : Math.min(start.y, end.y);
    var last = horizontal ? Math.max(start.x, end.x) : Math.max(start.y, end.y);
    return obstacles.some(function (rect) {
      if (horizontal) {
        if (start.y <= rect.top + ROUTE_EPSILON || start.y >= rect.bottom - ROUTE_EPSILON) return false;
        return last > rect.left + ROUTE_EPSILON && first < rect.right - ROUTE_EPSILON;
      }
      if (start.x <= rect.left + ROUTE_EPSILON || start.x >= rect.right - ROUTE_EPSILON) return false;
      return last > rect.top + ROUTE_EPSILON && first < rect.bottom - ROUTE_EPSILON;
    });
  }

  function routeCoordinates(values) {
    return values.filter(function (value) { return Number.isFinite(value); }).map(routeNumber).sort(function (a, b) {
      return a - b;
    }).filter(function (value, index, list) {
      return index === 0 || Math.abs(value - list[index - 1]) > ROUTE_EPSILON;
    });
  }

  function routeOverlap(aStart, aEnd, bStart, bEnd) {
    return Math.min(Math.max(aStart, aEnd), Math.max(bStart, bEnd)) -
      Math.max(Math.min(aStart, aEnd), Math.min(bStart, bEnd));
  }

  function routeConflictPenalty(start, end, reserved) {
    if (!reserved.length) return 0;
    var horizontal = Math.abs(start.y - end.y) <= ROUTE_EPSILON;
    var vertical = Math.abs(start.x - end.x) <= ROUTE_EPSILON;
    var penalty = 0;
    reserved.forEach(function (segment) {
      var otherStart = segment.start;
      var otherEnd = segment.end;
      var otherHorizontal = Math.abs(otherStart.y - otherEnd.y) <= ROUTE_EPSILON;
      var otherVertical = Math.abs(otherStart.x - otherEnd.x) <= ROUTE_EPSILON;
      if (horizontal && otherHorizontal) {
        var overlapX = routeOverlap(start.x, end.x, otherStart.x, otherEnd.x);
        if (overlapX > 2) {
          var gapY = Math.abs(start.y - otherStart.y);
          penalty += gapY <= ROUTE_EPSILON ? 18000 : gapY < 18 ? 5200 : 650;
        }
      } else if (vertical && otherVertical) {
        var overlapY = routeOverlap(start.y, end.y, otherStart.y, otherEnd.y);
        if (overlapY > 2) {
          var gapX = Math.abs(start.x - otherStart.x);
          penalty += gapX <= ROUTE_EPSILON ? 18000 : gapX < 18 ? 5200 : 650;
        }
      } else if ((horizontal && otherVertical) || (vertical && otherHorizontal)) {
        var horizontalStart = horizontal ? start : otherStart;
        var horizontalEnd = horizontal ? end : otherEnd;
        var verticalStart = vertical ? start : otherStart;
        var verticalEnd = vertical ? end : otherEnd;
        var crossesX = verticalStart.x >= Math.min(horizontalStart.x, horizontalEnd.x) - ROUTE_EPSILON &&
          verticalStart.x <= Math.max(horizontalStart.x, horizontalEnd.x) + ROUTE_EPSILON;
        var crossesY = horizontalStart.y >= Math.min(verticalStart.y, verticalEnd.y) - ROUTE_EPSILON &&
          horizontalStart.y <= Math.max(verticalStart.y, verticalEnd.y) + ROUTE_EPSILON;
        if (crossesX && crossesY) penalty += 2400;
      }
    });
    return penalty;
  }

  function routePreferencePenalty(start, end, preference) {
    if (!preference) return 0;
    var horizontal = Math.abs(start.y - end.y) <= ROUTE_EPSILON;
    var vertical = Math.abs(start.x - end.x) <= ROUTE_EPSILON;
    var weight = preference.weight == null ? 0.08 : preference.weight;
    if (preference.axis === "y" && horizontal) return Math.abs((start.y + end.y) / 2 - preference.value) * weight;
    if (preference.axis === "x" && vertical) return Math.abs((start.x + end.x) / 2 - preference.value) * weight;
    return 0;
  }

  function findOrthogonalRoute(start, end, obstacles, reserved, preference) {
    var xValues = [start.x, end.x];
    var yValues = [start.y, end.y];
    var minX = Math.min(start.x, end.x);
    var maxX = Math.max(start.x, end.x);
    var minY = Math.min(start.y, end.y);
    var maxY = Math.max(start.y, end.y);
    obstacles.forEach(function (rect) {
      minX = Math.min(minX, rect.left);
      maxX = Math.max(maxX, rect.right);
      minY = Math.min(minY, rect.top);
      maxY = Math.max(maxY, rect.bottom);
      xValues.push(rect.left, rect.right, rect.left - ROUTE_CHANNEL_STEP, rect.right + ROUTE_CHANNEL_STEP);
      yValues.push(rect.top, rect.bottom, rect.top - ROUTE_CHANNEL_STEP, rect.bottom + ROUTE_CHANNEL_STEP);
    });
    xValues.push(minX - ROUTE_OUTER_GAP, maxX + ROUTE_OUTER_GAP);
    yValues.push(minY - ROUTE_OUTER_GAP, maxY + ROUTE_OUTER_GAP);
    if (preference) {
      if (preference.axis === "x") xValues.push(preference.value, preference.value - ROUTE_CHANNEL_STEP, preference.value + ROUTE_CHANNEL_STEP);
      else yValues.push(preference.value, preference.value - ROUTE_CHANNEL_STEP, preference.value + ROUTE_CHANNEL_STEP);
    }
    var xs = routeCoordinates(xValues);
    var ys = routeCoordinates(yValues);
    var startX = xs.findIndex(function (value) { return Math.abs(value - start.x) <= ROUTE_EPSILON; });
    var endX = xs.findIndex(function (value) { return Math.abs(value - end.x) <= ROUTE_EPSILON; });
    var startY = ys.findIndex(function (value) { return Math.abs(value - start.y) <= ROUTE_EPSILON; });
    var endY = ys.findIndex(function (value) { return Math.abs(value - end.y) <= ROUTE_EPSILON; });
    if (startX < 0 || endX < 0 || startY < 0 || endY < 0) return null;

    var valid = [];
    for (var xIndex = 0; xIndex < xs.length; xIndex += 1) {
      valid[xIndex] = [];
      for (var yIndex = 0; yIndex < ys.length; yIndex += 1) {
        valid[xIndex][yIndex] = !routePointBlocked({ x: xs[xIndex], y: ys[yIndex] }, obstacles);
      }
    }
    if (!valid[startX][startY] || !valid[endX][endY]) return null;

    function stateKey(x, y, direction) { return x + ":" + y + ":" + direction; }
    function heuristic(x, y) { return Math.abs(xs[x] - end.x) + Math.abs(ys[y] - end.y); }
    function pushOpen(heap, entry) {
      heap.push(entry);
      var index = heap.length - 1;
      while (index > 0) {
        var parent = Math.floor((index - 1) / 2);
        if (heap[parent].score <= entry.score) break;
        heap[index] = heap[parent];
        index = parent;
      }
      heap[index] = entry;
    }
    function popOpen(heap) {
      var first = heap[0];
      var last = heap.pop();
      if (heap.length) {
        var index = 0;
        while (index * 2 + 1 < heap.length) {
          var child = index * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child += 1;
          if (heap[child].score >= last.score) break;
          heap[index] = heap[child];
          index = child;
        }
        heap[index] = last;
      }
      return first;
    }
    var startState = stateKey(startX, startY, "none");
    var open = [];
    var cameFrom = {};
    var stateInfo = {};
    var gScore = {};
    var fScore = {};
    var closed = {};
    gScore[startState] = 0;
    fScore[startState] = heuristic(startX, startY);
    stateInfo[startState] = { x: startX, y: startY, direction: "none" };
    pushOpen(open, { state: startState, score: fScore[startState] });
    var finalState = null;
    var segmentCache = {};
    function gridSegmentKey(start, end) {
      if (Math.abs(start.y - end.y) <= ROUTE_EPSILON) {
        return "h:" + start.y + ":" + Math.min(start.x, end.x) + ":" + Math.max(start.x, end.x);
      }
      return "v:" + start.x + ":" + Math.min(start.y, end.y) + ":" + Math.max(start.y, end.y);
    }
    var directions = [[1, 0, "horizontal"], [-1, 0, "horizontal"], [0, 1, "vertical"], [0, -1, "vertical"]];
    while (open.length) {
      var openEntry = popOpen(open);
      var currentState = openEntry.state;
      if (closed[currentState] || openEntry.score > (fScore[currentState] == null ? Infinity : fScore[currentState]) + ROUTE_EPSILON) continue;
      closed[currentState] = true;
      var current = stateInfo[currentState];
      if (current.x === endX && current.y === endY) {
        finalState = currentState;
        break;
      }
      directions.forEach(function (direction) {
        var nextX = current.x + direction[0];
        var nextY = current.y + direction[1];
        if (nextX < 0 || nextX >= xs.length || nextY < 0 || nextY >= ys.length || !valid[nextX][nextY]) return;
        var fromPoint = { x: xs[current.x], y: ys[current.y] };
        var toPoint = { x: xs[nextX], y: ys[nextY] };
        var segmentKey = gridSegmentKey(fromPoint, toPoint);
        var segment = segmentCache[segmentKey];
        if (!segment) {
          segment = {
            blocked: routeSegmentBlocked(fromPoint, toPoint, obstacles),
            cost: routeConflictPenalty(fromPoint, toPoint, reserved) + routePreferencePenalty(fromPoint, toPoint, preference)
          };
          segmentCache[segmentKey] = segment;
        }
        if (segment.blocked) return;
        var nextDirection = direction[2];
        var nextState = stateKey(nextX, nextY, nextDirection);
        if (closed[nextState]) return;
        var distance = Math.abs(toPoint.x - fromPoint.x) + Math.abs(toPoint.y - fromPoint.y);
        var bendCost = current.direction !== "none" && current.direction !== nextDirection ?
          (preference && preference.bendCost != null ? preference.bendCost : 84) : 0;
        var tentative = (gScore[currentState] == null ? Infinity : gScore[currentState]) + distance + bendCost + segment.cost;
        if (tentative >= (gScore[nextState] == null ? Infinity : gScore[nextState])) return;
        stateInfo[nextState] = { x: nextX, y: nextY, direction: nextDirection };
        cameFrom[nextState] = currentState;
        gScore[nextState] = tentative;
        fScore[nextState] = tentative + heuristic(nextX, nextY);
        pushOpen(open, { state: nextState, score: fScore[nextState] });
      });
    }
    if (!finalState) return null;
    var points = [];
    var state = finalState;
    while (state) {
      var info = stateInfo[state];
      points.push({ x: xs[info.x], y: ys[info.y] });
      state = cameFrom[state];
    }
    points.reverse();
    return simplifyRoutePoints(points);
  }

  function simplifyRoutePoints(points) {
    var compact = [];
    points.forEach(function (point) {
      var next = { x: routeNumber(point.x), y: routeNumber(point.y) };
      var previous = compact[compact.length - 1];
      if (previous && Math.abs(previous.x - next.x) <= ROUTE_EPSILON && Math.abs(previous.y - next.y) <= ROUTE_EPSILON) return;
      compact.push(next);
      while (compact.length >= 3) {
        var a = compact[compact.length - 3];
        var b = compact[compact.length - 2];
        var c = compact[compact.length - 1];
        var sameHorizontal = Math.abs(a.y - b.y) <= ROUTE_EPSILON && Math.abs(b.y - c.y) <= ROUTE_EPSILON;
        var sameVertical = Math.abs(a.x - b.x) <= ROUTE_EPSILON && Math.abs(b.x - c.x) <= ROUTE_EPSILON;
        if (!sameHorizontal && !sameVertical) break;
        compact.splice(compact.length - 2, 1);
      }
    });
    return compact;
  }

  function fallbackOrthogonalRoute(start, end, obstacles, reserved, preference) {
    var candidates = [
      [start, { x: end.x, y: start.y }, end],
      [start, { x: start.x, y: end.y }, end]
    ];
    var bounds = obstacles.reduce(function (result, rect) {
      result.left = Math.min(result.left, rect.left);
      result.top = Math.min(result.top, rect.top);
      result.right = Math.max(result.right, rect.right);
      result.bottom = Math.max(result.bottom, rect.bottom);
      return result;
    }, { left: start.x, top: start.y, right: end.x, bottom: end.y });
    candidates.push(
      [start, { x: start.x, y: bounds.top - ROUTE_OUTER_GAP }, { x: end.x, y: bounds.top - ROUTE_OUTER_GAP }, end],
      [start, { x: start.x, y: bounds.bottom + ROUTE_OUTER_GAP }, { x: end.x, y: bounds.bottom + ROUTE_OUTER_GAP }, end],
      [start, { x: bounds.left - ROUTE_OUTER_GAP, y: start.y }, { x: bounds.left - ROUTE_OUTER_GAP, y: end.y }, end],
      [start, { x: bounds.right + ROUTE_OUTER_GAP, y: start.y }, { x: bounds.right + ROUTE_OUTER_GAP, y: end.y }, end]
    );
    if (preference && preference.axis === "y") {
      candidates.push([start, { x: start.x, y: preference.value }, { x: end.x, y: preference.value }, end]);
    } else if (preference && preference.axis === "x") {
      candidates.push([start, { x: preference.value, y: start.y }, { x: preference.value, y: end.y }, end]);
    }
    var best = null;
    var bestScore = Infinity;
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = simplifyRoutePoints(candidates[index]);
      var clear = true;
      for (var segmentIndex = 1; segmentIndex < candidate.length; segmentIndex += 1) {
        if (routeSegmentBlocked(candidate[segmentIndex - 1], candidate[segmentIndex], obstacles)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        var length = 0;
        for (var lengthIndex = 1; lengthIndex < candidate.length; lengthIndex += 1) {
          length += Math.abs(candidate[lengthIndex].x - candidate[lengthIndex - 1].x) + Math.abs(candidate[lengthIndex].y - candidate[lengthIndex - 1].y);
        }
        var segments = [];
        for (var segmentScoreIndex = 1; segmentScoreIndex < candidate.length; segmentScoreIndex += 1) {
          segments.push({ start: candidate[segmentScoreIndex - 1], end: candidate[segmentScoreIndex] });
        }
        var conflict = reserved ? segments.reduce(function (sum, segment) {
          return sum + routeConflictPenalty(segment.start, segment.end, reserved);
        }, 0) : 0;
        var preferenceCost = preference ? segments.reduce(function (sum, segment) {
          return sum + routePreferencePenalty(segment.start, segment.end, preference);
        }, 0) : 0;
        if (length + conflict + preferenceCost < bestScore) {
          best = candidate;
          bestScore = length + conflict + preferenceCost;
        }
      }
    }
    return best;
  }

  function roundedRoutePath(points, requestedRadius) {
    if (!points || points.length < 2) return "";
    var compact = simplifyRoutePoints(points);
    if (compact.length < 2) return "";
    var radius = requestedRadius == null ? 10 : requestedRadius;
    var path = "M " + compact[0].x + " " + compact[0].y;
    for (var index = 1; index < compact.length - 1; index += 1) {
      var previous = compact[index - 1];
      var current = compact[index];
      var next = compact[index + 1];
      var firstLength = Math.sqrt(Math.pow(current.x - previous.x, 2) + Math.pow(current.y - previous.y, 2));
      var secondLength = Math.sqrt(Math.pow(next.x - current.x, 2) + Math.pow(next.y - current.y, 2));
      if (firstLength < 1 || secondLength < 1) continue;
      var offset = Math.min(radius, firstLength / 2, secondLength / 2);
      var before = {
        x: current.x + (previous.x - current.x) * offset / firstLength,
        y: current.y + (previous.y - current.y) * offset / firstLength
      };
      var after = {
        x: current.x + (next.x - current.x) * offset / secondLength,
        y: current.y + (next.y - current.y) * offset / secondLength
      };
      path += " L " + routeNumber(before.x) + " " + routeNumber(before.y) +
        " Q " + current.x + " " + current.y + " " + routeNumber(after.x) + " " + routeNumber(after.y);
    }
    var last = compact[compact.length - 1];
    path += " L " + last.x + " " + last.y;
    return path;
  }

  // 将路由器产生的车道关键点转换成连续的贝塞尔曲线。曲线仍经过
  // 每个车道关键点附近，但转角没有折线感，因此可以同时满足避让和
  // 当前画布的平滑视觉风格。
  function smoothRouteGeometry(points) {
    var compact = simplifyRoutePoints(points || []);
    if (compact.length < 2) return { path: "", midpoint: compact[0] || { x: 0, y: 0 }, segments: [], samples: [] };
    var segments = [];
    if (compact.length === 2) {
      var direct = compact[1];
      var first = compact[0];
      var dx = direct.x - first.x;
      var dy = direct.y - first.y;
      segments.push({
        start: first,
        control1: { x: first.x + dx * 0.34, y: first.y + dy * 0.34 },
        control2: { x: first.x + dx * 0.66, y: first.y + dy * 0.66 },
        end: direct
      });
    } else {
      var tension = 0.2;
      for (var index = 0; index < compact.length - 1; index += 1) {
        var current = compact[index];
        var next = compact[index + 1];
        var previous = index > 0 ? compact[index - 1] : current;
        var after = index + 2 < compact.length ? compact[index + 2] : next;
        var control1 = {
          x: current.x + (next.x - previous.x) * tension,
          y: current.y + (next.y - previous.y) * tension
        };
        var control2 = {
          x: next.x - (after.x - current.x) * tension,
          y: next.y - (after.y - current.y) * tension
        };
        // Control points stay within the current segment, preventing a
        // smooth turn from overshooting into a node or another lane.
        var minX = Math.min(current.x, next.x);
        var maxX = Math.max(current.x, next.x);
        var minY = Math.min(current.y, next.y);
        var maxY = Math.max(current.y, next.y);
        control1.x = Math.max(minX, Math.min(maxX, control1.x));
        control1.y = Math.max(minY, Math.min(maxY, control1.y));
        control2.x = Math.max(minX, Math.min(maxX, control2.x));
        control2.y = Math.max(minY, Math.min(maxY, control2.y));
        segments.push({ start: current, control1: control1, control2: control2, end: next });
      }
    }
    var path = "M " + compact[0].x + " " + compact[0].y;
    segments.forEach(function (segment) {
      path += " C " + routeNumber(segment.control1.x) + " " + routeNumber(segment.control1.y) +
        ", " + routeNumber(segment.control2.x) + " " + routeNumber(segment.control2.y) +
        ", " + routeNumber(segment.end.x) + " " + routeNumber(segment.end.y);
    });

    // Sample the exact rendered geometry. The samples are used both for the
    // label midpoint and for collision checks, so the visible path and its
    // routing constraints cannot drift apart.
    var samples = [];
    var totalLength = 0;
    segments.forEach(function (segment, segmentIndex) {
      var previous = segment.start;
      var steps = 18;
      for (var sampleIndex = 0; sampleIndex <= steps; sampleIndex += 1) {
        if (segmentIndex > 0 && sampleIndex === 0) continue;
        var progress = sampleIndex / steps;
        var point = cubicPointAt(segment.start, segment.control1, segment.control2, segment.end, progress);
        if (samples.length) totalLength += Math.sqrt(Math.pow(point.x - previous.x, 2) + Math.pow(point.y - previous.y, 2));
        samples.push({ point: point, length: totalLength });
        previous = point;
      }
    });
    var midpoint = compact[0];
    var midpointTarget = totalLength / 2;
    for (var midpointIndex = 1; midpointIndex < samples.length; midpointIndex += 1) {
      var before = samples[midpointIndex - 1];
      var after = samples[midpointIndex];
      if (after.length >= midpointTarget) {
        var span = after.length - before.length;
        var ratio = span > 0 ? (midpointTarget - before.length) / span : 0;
        midpoint = {
          x: before.point.x + (after.point.x - before.point.x) * ratio,
          y: before.point.y + (after.point.y - before.point.y) * ratio
        };
        break;
      }
    }
    return { path: path, midpoint: midpoint, segments: segments, samples: samples, length: totalLength };
  }

  // Compatibility helper for the emergency obstacle detour. Keep that route
  // in the same smooth cubic visual language as the regular router.
  function catmullRomPath(points) {
    return smoothRouteGeometry(points || []).path;
  }

  function smoothRoutePath(points) {
    return smoothRouteGeometry(points).path;
  }

  // Route lanes are only a planning hint. Rendering a cubic through every
  // orthogonal lane corner makes the curve inherit the router's outer rails
  // (and can send it outside the visible canvas). Build a bounded cubic from
  // the two ports instead, then pick the least conflicting bend.
  function cubicGeometry(start, control1, control2, end, steps) {
    var samples = [];
    var count = steps || 32;
    var length = 0;
    var previous = start;
    for (var index = 0; index <= count; index += 1) {
      var point = cubicPointAt(start, control1, control2, end, index / count);
      if (index) length += Math.sqrt(Math.pow(point.x - previous.x, 2) + Math.pow(point.y - previous.y, 2));
      samples.push({ point: point, length: length, progress: index / count });
      previous = point;
    }
    var midpointTarget = length / 2;
    var midpoint = start;
    for (var midpointIndex = 1; midpointIndex < samples.length; midpointIndex += 1) {
      var before = samples[midpointIndex - 1];
      var after = samples[midpointIndex];
      if (after.length >= midpointTarget) {
        var span = after.length - before.length;
        var ratio = span ? (midpointTarget - before.length) / span : 0;
        midpoint = {
          x: before.point.x + (after.point.x - before.point.x) * ratio,
          y: before.point.y + (after.point.y - before.point.y) * ratio
        };
        break;
      }
    }
    return {
      path: "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
        " C " + routeNumber(control1.x) + " " + routeNumber(control1.y) +
        ", " + routeNumber(control2.x) + " " + routeNumber(control2.y) +
        ", " + routeNumber(end.x) + " " + routeNumber(end.y),
      midpoint: midpoint,
      control1: control1,
      control2: control2,
      samples: samples,
      length: length
    };
  }

  function pointInRouteRect(point, rect) {
    return point.x > rect.left + ROUTE_EPSILON && point.x < rect.right - ROUTE_EPSILON &&
      point.y > rect.top + ROUTE_EPSILON && point.y < rect.bottom - ROUTE_EPSILON;
  }

  function pointToSegmentDistance(point, start, end) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.sqrt(Math.pow(point.x - start.x, 2) + Math.pow(point.y - start.y, 2));
    var progress = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    progress = Math.max(0, Math.min(1, progress));
    var nearest = { x: start.x + dx * progress, y: start.y + dy * progress };
    return Math.sqrt(Math.pow(point.x - nearest.x, 2) + Math.pow(point.y - nearest.y, 2));
  }

  function curveBendLimit(start, end) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.sqrt(dx * dx + dy * dy);
    // Keep a useful separation for parallel edges without allowing the
    // control points to form an oversized loop after a node is moved.
    return Math.max(46, Math.min(136, length * 0.30));
  }

  function curveCollisionScore(geometry, options) {
    var samples = geometry.samples || [];
    var obstacles = options && options.obstacles || [];
    var reserved = options && options.reserved || [];
    var sourceId = options && options.sourceId;
    var targetId = options && options.targetId;
    var bounds = options && options.bounds;
    var hard = 0;
    var outside = 0;
    samples.forEach(function (sample, index) {
      var point = sample.point;
      if (bounds && (point.x < bounds.left - 34 || point.x > bounds.right + 34 || point.y < bounds.top - 34 || point.y > bounds.bottom + 34)) {
        outside += 1;
      }
      obstacles.forEach(function (rect) {
        if (!pointInRouteRect(point, rect)) return;
        // The endpoint itself is a port on the node boundary. Ignore the
        // first/last few samples for its own node, but never ignore another
        // node: an edge must not disappear underneath a card.
        var endpointNode = rect.id === sourceId || rect.id === targetId;
        var endpointWindow = index < 3 || index > samples.length - 4;
        if (!endpointNode || !endpointWindow) hard += 1;
      });
    });
    var proximity = 0;
    reserved.forEach(function (other) {
      var otherSamples = other.samples;
      if (!otherSamples && other.start && other.end) {
        otherSamples = [{ point: other.start }, { point: other.end }];
      }
      if (!otherSamples || !otherSamples.length) return;
      var closeCount = 0;
      samples.forEach(function (sample, index) {
        // Shared port segments and a single crossing are acceptable. Count
        // only the sustained middle overlap as a readability penalty.
        if (index < 4 || index > samples.length - 5) return;
        var nearest = Infinity;
        for (var otherIndex = 1; otherIndex < otherSamples.length; otherIndex += 1) {
          nearest = Math.min(nearest, pointToSegmentDistance(sample.point, otherSamples[otherIndex - 1].point || otherSamples[otherIndex - 1], otherSamples[otherIndex].point || otherSamples[otherIndex]));
        }
        if (nearest < 22) closeCount += 1;
      });
      if (closeCount) {
        proximity += closeCount * 74;
        if (closeCount > samples.length * 0.42) proximity += 9000;
      }
    });
    return hard * 100000 + outside * 1600 + proximity;
  }

  function smoothCurveGeometry(start, end, startSide, endSide, preferredBend, options) {
    var limit = curveBendLimit(start, end);
    var requestedLimit = options && Number(options.maxBend);
    if (Number.isFinite(requestedLimit)) limit = Math.max(limit, requestedLimit);
    var preferred = Number.isFinite(Number(preferredBend)) ? Number(preferredBend) : 0;
    preferred = Math.max(-limit, Math.min(limit, preferred));
    var candidates = [0, preferred, -preferred];
    for (var step = 20; step <= limit + ROUTE_EPSILON; step += 16) {
      candidates.push(step, -step);
    }
    // Stable de-duplication keeps tie-breaking deterministic while dragging.
    var seen = {};
    candidates = candidates.map(function (value) { return Math.round(value * 10) / 10; }).filter(function (value) {
      var key = String(value);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (bend) {
      var controls = curveControlPoints(start, end, startSide, endSide, bend);
      var geometry = cubicGeometry(start, controls.control1, controls.control2, end, 36);
      var collision = curveCollisionScore(geometry, options || {});
      // Lane preference separates parallel choices, while a small curvature
      // cost prevents a harmless route from becoming needlessly theatrical.
      var score = collision + Math.abs(bend - preferred) * 1.25 + Math.abs(bend) * 0.08;
      if (score < bestScore) {
        best = geometry;
        bestScore = score;
        best.bend = bend;
      }
    });
    return best || cubicGeometry(start, curveControlPoints(start, end, startSide, endSide, preferred).control1, curveControlPoints(start, end, startSide, endSide, preferred).control2, end, 36);
  }

  function routedCurveGeometry(record, preferredBend, reserved, bounds, obstacles) {
    var obstacleRects = obstacles || workflow.nodes.map(function (item) {
      return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP);
    });
    return smoothCurveGeometry(record.start, record.end, record.sourceSide, record.targetSide, preferredBend, {
      obstacles: obstacleRects,
      reserved: reserved || [],
      bounds: bounds || routeNodeBounds(),
      sourceId: record.edge && record.edge.source,
      targetId: record.edge && record.edge.target
    });
  }

  function mainDispatchGeometry(edge, index, total) {
    var sourceNode = getNode(edge.source);
    var targetNode = getNode(edge.target);
    var sourceElement = sourceNode && nodeElement(sourceNode.id);
    var targetElement = targetNode && nodeElement(targetNode.id);
    if (!sourceNode || !targetNode || !sourceElement || !targetElement) return null;
    var start = portAnchor(sourceNode, sourceElement, "right");
    var span = Math.max(1, total || 1);
    var center = (span - 1) / 2;
    var laneOffset = (index - center) * 24;
    var end = portAnchor(targetNode, targetElement, "left", Math.max(-24, Math.min(24, laneOffset * 0.45)));
    // Keep the dispatch lane outside Main's right edge. Each target receives a
    // stable vertical offset so hover never changes node positions or routes.
    var control1 = { x: start.x + 62 + Math.abs(laneOffset) * 0.12, y: start.y + laneOffset };
    var control2 = { x: end.x - 48 - Math.abs(laneOffset) * 0.08, y: end.y + laneOffset * 0.42 };
    var geometry = cubicGeometry(start, control1, control2, end, 42);
    return {
      points: [start, control1, control2, end],
      path: geometry.path,
      midpoint: geometry.midpoint,
      sourceSide: "right",
      targetSide: "left",
      bend: laneOffset,
      weakLane: index,
      weakControls: geometry,
      geometry: geometry
    };
  }

  function routeMidpoint(points) {
    var compact = simplifyRoutePoints(points || []);
    if (compact.length < 2) return compact[0] || { x: 0, y: 0 };
    var total = 0;
    for (var index = 1; index < compact.length; index += 1) {
      total += Math.abs(compact[index].x - compact[index - 1].x) + Math.abs(compact[index].y - compact[index - 1].y);
    }
    var target = total / 2;
    var travelled = 0;
    for (var segmentIndex = 1; segmentIndex < compact.length; segmentIndex += 1) {
      var start = compact[segmentIndex - 1];
      var end = compact[segmentIndex];
      var length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
      if (travelled + length >= target) {
        var ratio = length ? (target - travelled) / length : 0;
        return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
      }
      travelled += length;
    }
    return compact[compact.length - 1];
  }

  function outwardPoint(point, side, distance) {
    var vector = portVector(side);
    return { x: point.x + vector.x * distance, y: point.y + vector.y * distance };
  }

  function fanPoint(point, side, outwardDistance, tangentOffset) {
    var vector = portVector(side);
    var tangent = { x: 0, y: 0 };
    if (side === "top" || side === "bottom") tangent.x = tangentOffset || 0;
    else tangent.y = tangentOffset || 0;
    return {
      x: point.x + vector.x * outwardDistance + tangent.x,
      y: point.y + vector.y * outwardDistance + tangent.y
    };
  }

  function edgeRouteKey(edge) {
    return [String(edge.source), String(edge.target)].sort().join("|");
  }

  function layoutColumns() {
    var records = workflow.nodes.map(function (node) {
      var element = nodeElement(node.id);
      var size = nodeDimensions(element);
      return { node: node, width: size.width, height: size.height };
    }).sort(function (a, b) {
      return a.node.x - b.node.x || a.node.y - b.node.y;
    });
    var columns = [];
    records.forEach(function (record) {
      var column = columns[columns.length - 1];
      if (!column || Math.abs(record.node.x - column.x) > 12) {
        column = { x: record.node.x, left: record.node.x, right: record.node.x + record.width, records: [] };
        columns.push(column);
      }
      column.records.push(record);
      column.left = Math.min(column.left, record.node.x);
      column.right = Math.max(column.right, record.node.x + record.width);
    });
    var byNode = {};
    columns.forEach(function (column, index) {
      column.index = index;
      column.records.forEach(function (record) { byNode[record.node.id] = column; });
    });
    return { columns: columns, byNode: byNode };
  }

  function routeNodeBounds() {
    return workflow.nodes.reduce(function (bounds, node) {
      var size = nodeDimensions(nodeElement(node.id));
      bounds.left = Math.min(bounds.left, node.x);
      bounds.top = Math.min(bounds.top, node.y);
      bounds.right = Math.max(bounds.right, node.x + size.width);
      bounds.bottom = Math.max(bounds.bottom, node.y + size.height);
      return bounds;
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }

  function assignRouteFanOffsets(prepared) {
    var endpointGroups = {};
    prepared.forEach(function (record) {
      ["source", "target"].forEach(function (endpoint) {
        var nodeId = endpoint === "source" ? record.edge.source : record.edge.target;
        var side = endpoint === "source" ? record.sourceSide : record.targetSide;
        // 同一物理连接点上的进、出边也必须立即分开；否则双向边会在节点外侧完全叠成一条线。
        var key = nodeId + ":" + side;
        if (!endpointGroups[key]) endpointGroups[key] = [];
        endpointGroups[key].push({ record: record, endpoint: endpoint, side: side });
      });
    });
    Object.keys(endpointGroups).forEach(function (key) {
      var group = endpointGroups[key];
      group.sort(function (a, b) {
        function otherAxis(entry) {
          var record = entry.record;
          var otherNode = entry.endpoint === "source" ? record.targetNode : record.sourceNode;
          var otherElement = entry.endpoint === "source" ? record.targetElement : record.sourceElement;
          var size = nodeDimensions(otherElement);
          return (entry.side === "top" || entry.side === "bottom") ? otherNode.x + size.width / 2 : otherNode.y + size.height / 2;
        }
        var difference = otherAxis(a) - otherAxis(b);
        if (Math.abs(difference) > ROUTE_EPSILON) return difference;
        return a.record.index - b.record.index;
      });
      var element = group[0].endpoint === "source" ? group[0].record.sourceElement : group[0].record.targetElement;
      var size = nodeDimensions(element);
      var sideLength = (group[0].side === "top" || group[0].side === "bottom") ? size.width : size.height;
      var limit = Math.max(0, sideLength / 2 - 16);
      var spacing = group.length > 1 ? Math.min(18, limit * 2 / (group.length - 1)) : 0;
      group.forEach(function (entry, index) {
        var offset = (index - (group.length - 1) / 2) * spacing;
        if (entry.endpoint === "source") entry.record.sourceOffset = offset;
        else entry.record.targetOffset = offset;
      });
    });
  }

  function readableRouteMidpoint(points) {
    var best = null;
    for (var index = 1; index < points.length; index += 1) {
      var start = points[index - 1];
      var end = points[index];
      var length = Math.abs(end.x - start.x);
      if (Math.abs(end.y - start.y) <= ROUTE_EPSILON && (!best || length > best.length)) {
        best = { length: length, x: (start.x + end.x) / 2, y: start.y };
      }
    }
    return best ? { x: best.x, y: best.y } : routeMidpoint(points);
  }

  // Weak branches communicate a decision, so their arc should follow the
  // visual direction of the target. A hard sign(dx * dy) switch makes a curve
  // flip in one frame when a node crosses the source's horizontal axis. Use a
  // continuous, bounded direction factor instead: the bend passes through
  // zero at the axis and therefore stays smooth while the node is dragged.
  function weakBendFromGeometry(start, end, routePoint, lane) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var absDx = Math.abs(dx);
    var absDy = Math.abs(dy);
    var routed = routePoint ? boundedLaneBend(start, end, routePoint) : 0;
    var laneValue = Number(lane) || 0;
    if (absDx >= 36 && absDx >= absDy * 0.42) {
      // Both factors are continuous around zero. The horizontal factor also
      // accounts for a curve travelling from right to left: because the
      // normal's y component changes sign, the product still bows toward the
      // target (down for dy > 0, up for dy < 0).
      var horizontalFactor = dx / (absDx + 72);
      var verticalFactor = dy / (absDy + 72);
      var direction = horizontalFactor * verticalFactor;
      var magnitude = Math.max(38, Math.min(138, 42 + absDy * 0.22 + absDx * 0.075));
      var geometryBend = direction * magnitude * 2.05;
      // Keep parallel weak choices legible when they share the same target
      // height. Lane influence fades as the directional arc becomes strong.
      var laneWeight = Math.max(0.18, 1 - Math.min(0.82, Math.abs(direction)));
      var bend = geometryBend + laneValue * 22 * laneWeight;
      var limit = Math.max(34, Math.min(156, Math.sqrt(dx * dx + dy * dy) * 0.42));
      return Math.max(-limit, Math.min(limit, bend));
    }
    // Mostly vertical links use the router's lateral lane. This avoids a
    // sideways bow being mistaken for an upward/downward branch.
    if (Math.abs(routed) < 12 && laneValue) routed = laneValue * 28;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var limit = Math.max(34, Math.min(148, length * 0.38));
    return Math.max(-limit, Math.min(limit, routed));
  }

  // 整理布局使用全局唯一的车道。每条边都有自己的长水平段和端口外侧轨道，
  // 避免不同跨度、不同方向的边在节点外侧共用一段线。
  function buildDedicatedLaneRoutes(prepared, layout, bounds) {
    edgeRoutes = {};
    if (!prepared.length) return edgeRoutes;
    assignRouteFanOffsets(prepared);
    prepared.forEach(function (record) {
      record.start = portAnchor(record.sourceNode, record.sourceElement, record.sourceSide);
      record.end = portAnchor(record.targetNode, record.targetElement, record.targetSide);
      record.startRoutePoint = fanPoint(record.start, record.sourceSide, ROUTE_PORT_LEAD, record.sourceOffset || 0);
      record.endRoutePoint = fanPoint(record.end, record.targetSide, ROUTE_PORT_LEAD, record.targetOffset || 0);
    });

    var railGroups = {};
    function addRailEntry(record, endpoint, column, side) {
      var key = column.index + ":" + side;
      if (!railGroups[key]) railGroups[key] = { column: column, side: side, entries: [] };
      railGroups[key].entries.push({ record: record, endpoint: endpoint });
    }
    prepared.forEach(function (record) {
      if (record.sourceRank === record.targetRank) return;
      addRailEntry(record, "source", record.sourceColumn, record.sourceSide);
      addRailEntry(record, "target", record.targetColumn, record.targetSide);
    });
    Object.keys(railGroups).forEach(function (key) {
      var group = railGroups[key];
      group.entries.sort(function (a, b) {
        function otherCenter(entry) {
          var node = entry.endpoint === "source" ? entry.record.targetNode : entry.record.sourceNode;
          var element = entry.endpoint === "source" ? entry.record.targetElement : entry.record.sourceElement;
          var size = nodeDimensions(element);
          return node.y + size.height / 2;
        }
        return otherCenter(a) - otherCenter(b) || a.record.index - b.record.index;
      });
      var base = group.side === "right" ?
        group.column.right + ROUTE_PORT_LEAD + CLEAR_RAIL_MARGIN :
        group.column.left - ROUTE_PORT_LEAD - CLEAR_RAIL_MARGIN;
      group.entries.forEach(function (entry, index) {
        var offset = index * CLEAR_RAIL_STEP;
        entry.record[entry.endpoint + "Rail"] = group.side === "right" ? base + offset : base - offset;
      });
    });

    var sameRank = prepared.filter(function (record) { return record.sourceRank === record.targetRank; });
    sameRank.sort(function (a, b) {
      var aValue = (a.startRoutePoint.y + a.endRoutePoint.y) / 2;
      var bValue = (b.startRoutePoint.y + b.endRoutePoint.y) / 2;
      return aValue - bValue || a.index - b.index;
    });
    var sameRankGroups = {};
    sameRank.forEach(function (record) {
      var key = String(record.sourceColumn.index);
      if (!sameRankGroups[key]) sameRankGroups[key] = [];
      sameRankGroups[key].push(record);
    });
    Object.keys(sameRankGroups).forEach(function (key) {
      var group = sameRankGroups[key];
      var column = group[0].sourceColumn;
      group.forEach(function (record, index) {
        record.laneX = column.right + ROUTE_PORT_LEAD + CLEAR_RAIL_MARGIN + index * CLEAR_RAIL_STEP;
      });
    });

    var adjacent = prepared.filter(function (record) {
      return Math.abs(record.targetRank - record.sourceRank) === 1;
    });
    var outerForward = prepared.filter(function (record) {
      return record.targetRank > record.sourceRank + 1;
    });
    var outerBackward = prepared.filter(function (record) {
      return record.sourceRank > record.targetRank + 1;
    });

    // 相邻列的边在列间隙中就地分轨。这样主链保持短直线，只有跨越多列的边
    // 才绕到画布外侧，不会把每一条普通连接都拉成很大的回路。
    var adjacentGroups = {};
    adjacent.forEach(function (record) {
      var key = String(Math.min(record.sourceRank, record.targetRank));
      if (!adjacentGroups[key]) adjacentGroups[key] = [];
      adjacentGroups[key].push(record);
    });
    Object.keys(adjacentGroups).forEach(function (key) {
      var group = adjacentGroups[key];
      group.sort(function (a, b) {
        var aValue = (a.startRoutePoint.y + a.endRoutePoint.y) / 2;
        var bValue = (b.startRoutePoint.y + b.endRoutePoint.y) / 2;
        return aValue - bValue || a.index - b.index;
      });
      group.forEach(function (record, index) {
        var midpoint = (record.startRoutePoint.y + record.endRoutePoint.y) / 2;
        record.laneY = midpoint + (index - (group.length - 1) / 2) * CLEAR_LANE_STEP;
      });
    });

    // 跨列边和回边使用独立的外侧车道，并按边编号留出稳定间距。
    outerForward.sort(function (a, b) { return a.index - b.index; });
    outerBackward.sort(function (a, b) { return a.index - b.index; });
    outerForward.forEach(function (record, index) {
      record.laneY = bounds.top - CLEAR_OUTER_GAP - index * CLEAR_LANE_STEP;
    });
    outerBackward.forEach(function (record, index) {
      record.laneY = bounds.bottom + CLEAR_OUTER_GAP + index * CLEAR_LANE_STEP;
    });
    var laneRecords = adjacent.concat(outerForward, outerBackward);

    var dedicatedReserved = [];
    function setRoute(record, points) {
      var compact = simplifyRoutePoints(points);
      var lanePoint = record.sourceRank === record.targetRank ? {
        x: record.laneX,
        y: (record.start.y + record.end.y) / 2
      } : {
        x: (record.start.x + record.end.x) / 2,
        y: record.laneY
      };
      var bend = record.edge.kind === "weak"
        ? weakBendFromGeometry(record.start, record.end, lanePoint, record.lane)
        : boundedLaneBend(record.start, record.end, lanePoint);
      var geometry = routedCurveGeometry(record, bend, dedicatedReserved, bounds);
      edgeRoutes[record.edge.id] = {
        points: compact,
        path: geometry.path,
        midpoint: geometry.midpoint,
        sourceSide: record.sourceSide,
        targetSide: record.targetSide,
        bend: bend,
        weakLane: Number(record.lane) || 0,
        weakControls: record.edge.kind === "weak" ? curveGeometry(record.start, record.end, record.sourceSide, record.targetSide, bend) : null,
        geometry: geometry
      };
      dedicatedReserved.push({ samples: geometry.samples });
    }
    laneRecords.forEach(function (record) {
      setRoute(record, [
        record.start,
        record.startRoutePoint,
        { x: record.sourceRail, y: record.startRoutePoint.y },
        { x: record.sourceRail, y: record.laneY },
        { x: record.targetRail, y: record.laneY },
        { x: record.targetRail, y: record.endRoutePoint.y },
        record.endRoutePoint,
        record.end
      ]);
    });
    sameRank.forEach(function (record) {
      setRoute(record, [
        record.start,
        record.startRoutePoint,
        { x: record.laneX, y: record.startRoutePoint.y },
        { x: record.laneX, y: record.endRoutePoint.y },
        record.endRoutePoint,
        record.end
      ]);
    });
    return edgeRoutes;
  }

  function buildClearLayoutEdgeRoutes() {
    edgeRoutes = {};
    var layout = layoutColumns();
    var bounds = routeNodeBounds();
    var prepared = businessWorkflowEdges().slice().sort(function (a, b) {
      var sourceOrder = String(a.source).localeCompare(String(b.source));
      if (sourceOrder) return sourceOrder;
      var targetOrder = String(a.target).localeCompare(String(b.target));
      if (targetOrder) return targetOrder;
      return String(a.id).localeCompare(String(b.id));
    }).map(function (edge, index) {
      var sourceNode = getNode(edge.source);
      var targetNode = getNode(edge.target);
      var sourceElement = nodeElement(edge.source);
      var targetElement = nodeElement(edge.target);
      var sourceColumn = layout.byNode[edge.source];
      var targetColumn = layout.byNode[edge.target];
      if (!sourceNode || !targetNode || !sourceElement || !targetElement || !sourceColumn || !targetColumn) return null;
      var pinnedSource = pinnedPort(edge, "source");
      var pinnedTarget = pinnedPort(edge, "target");
      var sourceSide = pinnedSource || choosePortSide(sourceNode, targetNode, sourceElement);
      var targetSide = pinnedTarget || choosePortSide(targetNode, sourceNode, targetElement);
      if (sourceColumn.index < targetColumn.index) {
        if (!pinnedSource) sourceSide = "right";
        if (!pinnedTarget) targetSide = "left";
      } else if (sourceColumn.index > targetColumn.index) {
        if (!pinnedSource) sourceSide = "left";
        if (!pinnedTarget) targetSide = "right";
      } else {
        var sourceSize = nodeDimensions(sourceElement);
        var targetSize = nodeDimensions(targetElement);
        var sourceCenterY = sourceNode.y + sourceSize.height / 2;
        var targetCenterY = targetNode.y + targetSize.height / 2;
        if (!pinnedSource) sourceSide = sourceCenterY <= targetCenterY ? "bottom" : "top";
        if (!pinnedTarget) {
          var oppositeSide = { top: "bottom", right: "left", bottom: "top", left: "right" };
          targetSide = oppositeSide[sourceSide] || (sourceCenterY <= targetCenterY ? "top" : "bottom");
        }
      }
      return {
        edge: edge,
        index: index,
        sourceNode: sourceNode,
        targetNode: targetNode,
        sourceElement: sourceElement,
        targetElement: targetElement,
        sourceColumn: sourceColumn,
        targetColumn: targetColumn,
        sourceRank: sourceColumn.index,
        targetRank: targetColumn.index,
        sourceSide: sourceSide,
        targetSide: targetSide
      };
    }).filter(Boolean);
    if (!prepared.length) return edgeRoutes;

    return buildDedicatedLaneRoutes(prepared, layout, bounds);

    assignRouteFanOffsets(prepared);
    prepared.forEach(function (record) {
      record.start = portAnchor(record.sourceNode, record.sourceElement, record.sourceSide);
      record.end = portAnchor(record.targetNode, record.targetElement, record.targetSide);
      record.startRoutePoint = fanPoint(record.start, record.sourceSide, ROUTE_PORT_LEAD, record.sourceOffset || 0);
      record.endRoutePoint = fanPoint(record.end, record.targetSide, ROUTE_PORT_LEAD, record.targetOffset || 0);
    });

    var corridors = layout.columns.slice(0, -1).map(function (column, index) {
      return {
        index: index,
        leftColumn: column,
        rightColumn: layout.columns[index + 1],
        leftEntries: [],
        rightEntries: []
      };
    });
    function addRail(corridorIndex, side, record, endpoint) {
      var corridor = corridors[corridorIndex];
      if (!corridor) return false;
      corridor[side === "left" ? "leftEntries" : "rightEntries"].push({ record: record, endpoint: endpoint });
      return true;
    }
    var directGroups = {};
    var forwardOuter = [];
    var backwardOuter = [];
    var sameRankOuter = [];
    var fallback = [];
    prepared.forEach(function (record) {
      if (record.targetRank === record.sourceRank) {
        sameRankOuter.push(record);
        return;
      }
      if (record.targetRank === record.sourceRank + 1) {
        if (addRail(record.sourceRank, "left", record, "source") && addRail(record.sourceRank, "right", record, "target")) {
          var directKey = String(record.sourceRank);
          if (!directGroups[directKey]) directGroups[directKey] = [];
          directGroups[directKey].push(record);
          return;
        }
      }
      if (record.targetRank > record.sourceRank + 1) {
        if (addRail(record.sourceRank, "left", record, "source") && addRail(record.targetRank - 1, "right", record, "target")) {
          forwardOuter.push(record);
          return;
        }
      }
      if (record.targetRank < record.sourceRank) {
        if (addRail(record.sourceRank - 1, "right", record, "source") && addRail(record.targetRank, "left", record, "target")) {
          backwardOuter.push(record);
          return;
        }
      }
      fallback.push(record);
    });

    corridors.forEach(function (corridor) {
      function sortEntries(entries) {
        entries.sort(function (a, b) {
          var aOther = a.endpoint === "source" ? a.record.targetRoutePoint || a.record.endRoutePoint : a.record.startRoutePoint;
          var bOther = b.endpoint === "source" ? b.record.targetRoutePoint || b.record.endRoutePoint : b.record.startRoutePoint;
          return aOther.y - bOther.y || a.record.index - b.record.index;
        });
      }
      sortEntries(corridor.leftEntries);
      sortEntries(corridor.rightEntries);
      corridor.leftEntries.forEach(function (entry, index) {
        entry.record[entry.endpoint + "Rail"] = corridor.leftColumn.right + ROUTE_PORT_LEAD + CLEAR_RAIL_MARGIN + index * CLEAR_RAIL_STEP;
      });
      corridor.rightEntries.forEach(function (entry, index) {
        entry.record[entry.endpoint + "Rail"] = corridor.rightColumn.left - ROUTE_PORT_LEAD - CLEAR_RAIL_MARGIN - index * CLEAR_RAIL_STEP;
      });
    });

    function assignLanes(records, centerY) {
      records.sort(function (a, b) {
        var aValue = a.startRoutePoint.y + a.endRoutePoint.y;
        var bValue = b.startRoutePoint.y + b.endRoutePoint.y;
        return aValue - bValue || a.index - b.index;
      });
      records.forEach(function (record, index) {
        record.laneY = centerY + (index - (records.length - 1) / 2) * CLEAR_LANE_STEP;
      });
    }
    Object.keys(directGroups).forEach(function (key) {
      var group = directGroups[key];
      var center = group.reduce(function (sum, record) {
        return sum + (record.startRoutePoint.y + record.endRoutePoint.y) / 2;
      }, 0) / group.length;
      assignLanes(group, center);
    });
    assignLanes(forwardOuter, bounds.top - CLEAR_OUTER_GAP - Math.max(0, forwardOuter.length - 1) * CLEAR_LANE_STEP / 2);
    assignLanes(backwardOuter, bounds.bottom + CLEAR_OUTER_GAP + Math.max(0, backwardOuter.length - 1) * CLEAR_LANE_STEP / 2);
    sameRankOuter.sort(function (a, b) {
      var aValue = (a.startRoutePoint.y + a.endRoutePoint.y) / 2;
      var bValue = (b.startRoutePoint.y + b.endRoutePoint.y) / 2;
      return aValue - bValue || a.index - b.index;
    });
    sameRankOuter.forEach(function (record, index) {
      record.laneX = bounds.right + CLEAR_OUTER_GAP + index * CLEAR_LANE_STEP;
    });

    function setRoute(record, points) {
      var compact = simplifyRoutePoints(points);
      edgeRoutes[record.edge.id] = {
        points: compact,
        path: roundedRoutePath(compact),
        midpoint: readableRouteMidpoint(compact),
        sourceSide: record.sourceSide,
        targetSide: record.targetSide,
        bend: null
      };
    }
    function lanePoints(record) {
      return [
        record.start,
        record.startRoutePoint,
        { x: record.sourceRail, y: record.startRoutePoint.y },
        { x: record.sourceRail, y: record.laneY },
        { x: record.targetRail, y: record.laneY },
        { x: record.targetRail, y: record.endRoutePoint.y },
        record.endRoutePoint,
        record.end
      ];
    }
    Object.keys(directGroups).forEach(function (key) {
      directGroups[key].forEach(function (record) { setRoute(record, lanePoints(record)); });
    });
    forwardOuter.forEach(function (record) { setRoute(record, lanePoints(record)); });
    backwardOuter.forEach(function (record) { setRoute(record, lanePoints(record)); });
    sameRankOuter.forEach(function (record) {
      setRoute(record, [
        record.start,
        record.startRoutePoint,
        { x: record.laneX, y: record.startRoutePoint.y },
        { x: record.laneX, y: record.endRoutePoint.y },
        record.endRoutePoint,
        record.end
      ]);
    });

    var obstacles = workflow.nodes.map(function (item) {
      return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP);
    });
    var reserved = [];
    Object.keys(edgeRoutes).forEach(function (id) {
      var points = edgeRoutes[id].points;
      for (var index = 1; index < points.length; index += 1) {
        reserved.push({ start: points[index - 1], end: points[index] });
      }
    });
    fallback.forEach(function (record, index) {
      var preference = {
        axis: "y",
        value: bounds.bottom + CLEAR_OUTER_GAP + (index + 1) * CLEAR_LANE_STEP,
        weight: 4,
        bendCost: 18
      };
      var route = findOrthogonalRoute(record.startRoutePoint, record.endRoutePoint, obstacles, reserved, preference) ||
        fallbackOrthogonalRoute(record.startRoutePoint, record.endRoutePoint, obstacles, reserved, preference);
      var points = route && route.length ? [record.start, record.startRoutePoint].concat(route.slice(1, -1), [record.endRoutePoint, record.end]) : [record.start, record.end];
      setRoute(record, points);
      var compact = edgeRoutes[record.edge.id].points;
      for (var pointIndex = 1; pointIndex < compact.length; pointIndex += 1) {
        reserved.push({ start: compact[pointIndex - 1], end: compact[pointIndex] });
      }
    });
    return edgeRoutes;
  }

  function captureRouteLock() {
    var snapshot = {};
    businessWorkflowEdges().forEach(function (edge) {
      var route = edgeRoutes[edge.id];
      var sourceNode = getNode(edge.source);
      var targetNode = getNode(edge.target);
      var sourceElement = nodeElement(edge.source);
      var targetElement = nodeElement(edge.target);
      if (!route || !sourceNode || !targetNode || !sourceElement || !targetElement) return;
      var sourceSide = validPortSide(route.sourceSide) ? route.sourceSide : choosePortSide(sourceNode, targetNode, sourceElement);
      var targetSide = validPortSide(route.targetSide) ? route.targetSide : choosePortSide(targetNode, sourceNode, targetElement);
      var start = portAnchor(sourceNode, sourceElement, sourceSide);
      var end = portAnchor(targetNode, targetElement, targetSide);
      var length = Math.max(1, Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)));
      var initialBend = Number.isFinite(route.bend)
        ? route.bend
        : routeBendFromPoints(start, end, route.points || [start, end]);
      var weakControls = edge.kind === "weak"
        ? (route.weakControls || curveControlPoints(start, end, sourceSide, targetSide, initialBend))
        : null;
      var routeSamples = route.geometry && route.geometry.samples || route.weakControls && route.weakControls.samples || [];
      snapshot[edge.id] = {
        path: route.path,
        points: (route.points || [start, end]).map(function (point) { return { x: point.x, y: point.y }; }),
        midpoint: route.midpoint,
        sourceSide: sourceSide,
        targetSide: targetSide,
        bend: Number.isFinite(initialBend) ? initialBend : null,
        weakLane: Number(route.weakLane) || 0,
        weakBend: edge.kind === "weak" && Number.isFinite(initialBend) ? initialBend : null,
        weakControls: weakControls,
        samples: routeSamples.map(function (sample) {
          var point = sample.point || sample;
          return { x: point.x, y: point.y };
        }),
        initialLength: length,
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        sourcePinned: Boolean(pinnedPort(edge, "source")),
        targetPinned: Boolean(pinnedPort(edge, "target")),
        sourceX: sourceNode.x,
        sourceY: sourceNode.y,
        targetX: targetNode.x,
        targetY: targetNode.y
      };
    });
    return snapshot;
  }

  function routePointAtProgress(points, progress) {
    if (!points || !points.length) return { x: 0, y: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y };
    var lengths = [];
    var total = 0;
    for (var index = 1; index < points.length; index += 1) {
      var length = Math.sqrt(Math.pow(points[index].x - points[index - 1].x, 2) + Math.pow(points[index].y - points[index - 1].y, 2));
      lengths.push(length);
      total += length;
    }
    if (!total) return { x: points[0].x, y: points[0].y };
    var target = Math.max(0, Math.min(1, progress)) * total;
    var travelled = 0;
    for (var segment = 1; segment < points.length; segment += 1) {
      var segmentLength = lengths[segment - 1];
      if (travelled + segmentLength >= target) {
        var ratio = segmentLength ? (target - travelled) / segmentLength : 0;
        return {
          x: points[segment - 1].x + (points[segment].x - points[segment - 1].x) * ratio,
          y: points[segment - 1].y + (points[segment].y - points[segment - 1].y) * ratio
        };
      }
      travelled += segmentLength;
    }
    return { x: points[points.length - 1].x, y: points[points.length - 1].y };
  }

  function routeLeadTangent(anchor, lead, side) {
    if (!anchor || !lead) return 0;
    return side === "top" || side === "bottom" ? lead.x - anchor.x : lead.y - anchor.y;
  }

  function elasticRoutePoints(lock, start, end, sourceSide, targetSide) {
    var original = lock.points && lock.points.length ? lock.points : [lock.start || start, lock.end || end];
    if (original.length < 3) {
      var directSourceLead = fanPoint(start, sourceSide, ROUTE_PORT_LEAD, 0);
      var directTargetLead = fanPoint(end, targetSide, ROUTE_PORT_LEAD, 0);
      var directMidpoint = { x: (directSourceLead.x + directTargetLead.x) / 2, y: (directSourceLead.y + directTargetLead.y) / 2 };
      return simplifyRoutePoints([start, directSourceLead, directMidpoint, directTargetLead, end]);
    }
    var originalStart = lock.start || original[0];
    var originalEnd = lock.end || original[original.length - 1];
    var sourceDelta = { x: start.x - originalStart.x, y: start.y - originalStart.y };
    var targetDelta = { x: end.x - originalEnd.x, y: end.y - originalEnd.y };
    var lengths = [];
    var total = 0;
    for (var index = 1; index < original.length; index += 1) {
      var segmentLength = Math.sqrt(Math.pow(original[index].x - original[index - 1].x, 2) + Math.pow(original[index].y - original[index - 1].y, 2));
      lengths.push(segmentLength);
      total += segmentLength;
    }
    var travelled = 0;
    var points = original.map(function (point, pointIndex) {
      if (pointIndex === 0) return { x: start.x, y: start.y };
      if (pointIndex === original.length - 1) return { x: end.x, y: end.y };
      travelled += lengths[pointIndex - 1] || 0;
      var progress = total ? travelled / total : pointIndex / (original.length - 1);
      // Smoothstep keeps the rail near each endpoint stable while the middle
      // of the route follows the moving node continuously.
      var eased = progress * progress * (3 - 2 * progress);
      return {
        x: point.x + sourceDelta.x * (1 - eased) + targetDelta.x * eased,
        y: point.y + sourceDelta.y * (1 - eased) + targetDelta.y * eased
      };
    });
    var sourceLead = original[1];
    var targetLead = original[original.length - 2];
    var sourceOffset = lock.sourceSide === sourceSide ? routeLeadTangent(originalStart, sourceLead, sourceSide) : 0;
    var targetOffset = lock.targetSide === targetSide ? routeLeadTangent(originalEnd, targetLead, targetSide) : 0;
    points[1] = fanPoint(start, sourceSide, ROUTE_PORT_LEAD, sourceOffset);
    points[points.length - 2] = fanPoint(end, targetSide, ROUTE_PORT_LEAD, targetOffset);
    points[0] = { x: start.x, y: start.y };
    points[points.length - 1] = { x: end.x, y: end.y };
    return simplifyRoutePoints(points);
  }

  function adaptiveLockedSide(edge, endpoint, lock, node, otherNode, element, currentSide) {
    if (edge.kind === "weak" && validPortSide(currentSide)) return currentSide;
    var pinned = endpoint === "source" ? lock.sourcePinned || pinnedPort(edge, "source") : lock.targetPinned || pinnedPort(edge, "target");
    if (pinned || !validPortSide(currentSide)) return currentSide;
    var size = nodeDimensions(element);
    var nodeCenter = { x: node.x + size.width / 2, y: node.y + size.height / 2 };
    var otherElement = nodeElement(otherNode.id);
    var otherSize = nodeDimensions(otherElement);
    var otherCenter = { x: otherNode.x + otherSize.width / 2, y: otherNode.y + otherSize.height / 2 };
    var dx = otherCenter.x - nodeCenter.x;
    var dy = otherCenter.y - nodeCenter.y;
    var vector = portVector(currentSide);
    var forward = dx * vector.x + dy * vector.y;
    // Weak branches retain their entry side longer while dragging. A small
    // pointer movement should bend the curve, not make its endpoint jump to
    // another port and reset the dashed route.
    var threshold = edge.kind === "weak"
      ? Math.max(54, Math.max(Math.abs(dx), Math.abs(dy)) * 0.2)
      : Math.max(24, Math.max(Math.abs(dx), Math.abs(dy)) * 0.08);
    if (forward < -threshold) return choosePortSide(node, otherNode, element);
    return currentSide;
  }

  function lockedRouteBend(lock, start, end, points) {
    if (!Number.isFinite(lock.bend)) return 0;
    var lanePoint = routePointAtProgress(points, 0.5);
    var bend = boundedLaneBend(start, end, lanePoint);
    var length = Math.max(1, Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)));
    var limit = Math.max(34, Math.min(128, length * 0.24));
    return Math.max(-limit, Math.min(limit, bend));
  }

  // Weak edges are decision branches. During a node drag they stay on the same
  // port pair and derive their bend from the live endpoint geometry, so a
  // branch can change from above to below without inheriting a stale arc.
  function lockedWeakRouteBend(lock, start, end, points) {
    var routedPoint = routePointAtProgress(lock.points || points || [start, end], 0.5);
    return weakBendFromGeometry(start, end, routedPoint, lock.weakLane || 0);
  }

  function buildLockedEdgeRoutes() {
    var routes = {};
    businessWorkflowEdges().forEach(function (edge) {
      var lock = routeLock && routeLock[edge.id];
      var sourceNode = getNode(edge.source);
      var targetNode = getNode(edge.target);
      var sourceElement = nodeElement(edge.source);
      var targetElement = nodeElement(edge.target);
      if (!lock || !sourceNode || !targetNode || !sourceElement || !targetElement) return;
      var sourceChanged = sourceNode.x !== lock.sourceX || sourceNode.y !== lock.sourceY;
      var targetChanged = targetNode.x !== lock.targetX || targetNode.y !== lock.targetY;
      var endpointMoved = sourceChanged || targetChanged;
      var sourceSide = lock.activeSourceSide || lock.sourceSide;
      var targetSide = lock.activeTargetSide || lock.targetSide;
      if (endpointMoved) {
        sourceSide = adaptiveLockedSide(edge, "source", lock, sourceNode, targetNode, sourceElement, sourceSide);
        targetSide = adaptiveLockedSide(edge, "target", lock, targetNode, sourceNode, targetElement, targetSide);
      }
      lock.activeSourceSide = sourceSide;
      lock.activeTargetSide = targetSide;
      var start = portAnchor(sourceNode, sourceElement, sourceSide);
      var end = portAnchor(targetNode, targetElement, targetSide);
      var lockedStart = lock.start || start;
      var lockedEnd = lock.end || end;
      var changedEndpoint = sourceChanged || targetChanged || start.x !== lockedStart.x || start.y !== lockedStart.y || end.x !== lockedEnd.x || end.y !== lockedEnd.y || sourceSide !== lock.sourceSide || targetSide !== lock.targetSide;
      var draggedNodeMoved = drag && drag.item && (drag.item.x !== drag.x || drag.item.y !== drag.y);
      var blockedByDraggedNode = false;
      if (!changedEndpoint && draggedNodeMoved && edge.source !== drag.item.id && edge.target !== drag.item.id && lock.samples && lock.samples.length) {
        var draggedRect = routeRect(drag.item, drag.element || nodeElement(drag.item.id), ROUTE_NODE_GAP);
        blockedByDraggedNode = lock.samples.some(function (point) { return pointInRouteRect(point, draggedRect); });
      }
      // Selection and unrelated node movement must not send every edge through
      // the live router. Keep the exact path until one of its endpoints moves,
      // or the dragged card would genuinely cover it.
      if (!changedEndpoint && !blockedByDraggedNode && lock.path) {
        var exactSamples = (lock.samples || []).map(function (point) { return { point: { x: point.x, y: point.y } }; });
        routes[edge.id] = {
          points: (lock.points || [start, end]).map(function (point) { return { x: point.x, y: point.y }; }),
          path: lock.path,
          midpoint: lock.midpoint ? { x: lock.midpoint.x, y: lock.midpoint.y } : curveMidpoint(start, end, 0),
          sourceSide: sourceSide,
          targetSide: targetSide,
          bend: Number.isFinite(lock.bend) ? lock.bend : null,
          weakLane: Number(lock.weakLane) || 0,
          weakControls: lock.weakControls || null,
          geometry: exactSamples.length ? { samples: exactSamples } : null
        };
        return;
      }
      var weak = edge.kind === "weak";
      var points = weak
        ? [start, end]
        : (changedEndpoint ? elasticRoutePoints(lock, start, end, sourceSide, targetSide) : (lock.points || [start, end]));
      var bend = weak ? lockedWeakRouteBend(lock, start, end, points) : lockedRouteBend(lock, start, end, points);
      var lockedObstacles = workflow.nodes.map(function (item) { return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP); });
      var geometryOptions = {
        obstacles: lockedObstacles,
        reserved: [],
        bounds: routeNodeBounds(),
        sourceId: edge.source,
        targetId: edge.target,
        // A card intentionally dropped onto an unrelated route may require a
        // wider arc than normal endpoint adaptation. Expand only that edge.
        maxBend: blockedByDraggedNode ? 280 : undefined
      };
      var geometry = smoothCurveGeometry(start, end, sourceSide, targetSide, bend, geometryOptions);
      if (blockedByDraggedNode && curveCollisionScore(geometry, geometryOptions) >= 100000) {
        // A single cubic cannot always pass around a card dropped directly on
        // its middle. Route through a clear outer lane, then smooth that route.
        var obstacleBounds = routeNodeBounds();
        var outerSide = drag && drag.item && drag.item.y <= (start.y + end.y) / 2 ? "bottom" : "top";
        var outerY = outerSide === "bottom"
          ? obstacleBounds.bottom + CLEAR_OUTER_GAP
          : obstacleBounds.top - CLEAR_OUTER_GAP;
        var outerPoints = simplifyRoutePoints([
          start,
          fanPoint(start, sourceSide, ROUTE_PORT_LEAD, 0),
          { x: start.x, y: outerY },
          { x: end.x, y: outerY },
          fanPoint(end, targetSide, ROUTE_PORT_LEAD, 0),
          end
        ]);
        geometry = smoothRouteGeometry(outerPoints, 18);
        // Keep the resulting SVG a single smooth cubic chain even for the
        // emergency detour; the visual language remains curved, not angular.
        geometry.path = catmullRomPath(outerPoints, 0.72);
        geometry.midpoint = routePointAtProgress(outerPoints, 0.5);
        points = outerPoints;
      }
      var path = geometry.path;
      routes[edge.id] = {
        points: points,
        path: path,
        midpoint: geometry.midpoint,
        sourceSide: sourceSide,
        targetSide: targetSide,
        bend: weak || Number.isFinite(lock.bend) ? bend : null,
        weakLane: Number(lock.weakLane) || 0,
        weakControls: weak ? geometry : null,
        geometry: geometry
      };
    });
    edgeRoutes = routes;
    return edgeRoutes;
  }

  function buildEdgeRoutes() {
    var businessEdges = businessWorkflowEdges();
    // 只要存在连线就使用同一套分轨路由，避免旧草稿的 free 状态把旧曲线路由重新显示出来。
    if (routeLock && businessEdges.length) return buildLockedEdgeRoutes();
    if (businessEdges.length) return buildClearLayoutEdgeRoutes();
    edgeRoutes = {};
    var obstacles = workflow.nodes.map(function (item) {
      return routeRect(item, nodeElement(item.id), ROUTE_NODE_GAP);
    });
    var prepared = businessEdges.slice().sort(function (a, b) {
      var sourceOrder = String(a.source).localeCompare(String(b.source));
      if (sourceOrder) return sourceOrder;
      var targetOrder = String(a.target).localeCompare(String(b.target));
      if (targetOrder) return targetOrder;
      return String(a.id).localeCompare(String(b.id));
    }).map(function (edge, index) {
      var sourceNode = getNode(edge.source);
      var targetNode = getNode(edge.target);
      var sourceElement = nodeElement(edge.source);
      var targetElement = nodeElement(edge.target);
      if (!sourceNode || !targetNode || !sourceElement || !targetElement) return null;
      var sourceSide = validPortSide(edge.sourcePort) ? edge.sourcePort : choosePortSide(sourceNode, targetNode, sourceElement);
      var targetSide = validPortSide(edge.targetPort) ? edge.targetPort : choosePortSide(targetNode, sourceNode, targetElement);
      return {
        edge: edge,
        index: index,
        sourceNode: sourceNode,
        targetNode: targetNode,
        sourceElement: sourceElement,
        targetElement: targetElement,
        sourceSide: sourceSide,
        targetSide: targetSide,
        pair: edgeRouteKey(edge)
      };
    }).filter(Boolean);

    var endpointGroups = {};
    prepared.forEach(function (record) {
      ["source", "target"].forEach(function (endpoint) {
        var nodeId = endpoint === "source" ? record.edge.source : record.edge.target;
        var side = endpoint === "source" ? record.sourceSide : record.targetSide;
        var key = nodeId + ":" + side + ":" + endpoint;
        if (!endpointGroups[key]) endpointGroups[key] = [];
        endpointGroups[key].push({ record: record, endpoint: endpoint, side: side });
      });
    });
    Object.keys(endpointGroups).forEach(function (key) {
      var group = endpointGroups[key];
      group.sort(function (a, b) {
        function otherAxis(entry) {
          var record = entry.record;
          var otherNode = entry.endpoint === "source" ? record.targetNode : record.sourceNode;
          var otherElement = entry.endpoint === "source" ? record.targetElement : record.sourceElement;
          var size = nodeDimensions(otherElement);
          return (entry.side === "top" || entry.side === "bottom") ? otherNode.x + size.width / 2 : otherNode.y + size.height / 2;
        }
        var difference = otherAxis(a) - otherAxis(b);
        if (Math.abs(difference) > ROUTE_EPSILON) return difference;
        if (a.endpoint !== b.endpoint) return a.endpoint === "source" ? -1 : 1;
        return a.record.index - b.record.index;
      });
      var element = group[0].endpoint === "source" ? group[0].record.sourceElement : group[0].record.targetElement;
      var size = nodeDimensions(element);
      var sideLength = (group[0].side === "top" || group[0].side === "bottom") ? size.width : size.height;
      var limit = Math.max(0, sideLength / 2 - 16);
      var spacing = group.length > 1 ? Math.min(18, limit * 2 / (group.length - 1)) : 0;
      group.forEach(function (entry, index) {
        var offset = (index - (group.length - 1) / 2) * spacing;
        if (entry.endpoint === "source") entry.record.sourceOffset = offset;
        else entry.record.targetOffset = offset;
      });
    });
    prepared.forEach(function (record) {
      record.start = portAnchor(record.sourceNode, record.sourceElement, record.sourceSide);
      record.end = portAnchor(record.targetNode, record.targetElement, record.targetSide);
      record.startRoutePoint = fanPoint(record.start, record.sourceSide, ROUTE_PORT_LEAD, record.sourceOffset || 0);
      record.endRoutePoint = fanPoint(record.end, record.targetSide, ROUTE_PORT_LEAD, record.targetOffset || 0);
    });

    var groups = {};
    prepared.forEach(function (record) {
      if (!groups[record.pair]) groups[record.pair] = [];
      groups[record.pair].push(record);
    });
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      group.forEach(function (record, index) {
        record.lane = index - (group.length - 1) / 2;
        record.isReciprocal = group.length > 1;
      });
    });
    var outgoingGroups = {};
    prepared.forEach(function (record) {
      var key = record.edge.source + ":" + record.sourceSide;
      if (!outgoingGroups[key]) outgoingGroups[key] = [];
      outgoingGroups[key].push(record);
    });
    Object.keys(outgoingGroups).forEach(function (key) {
      var group = outgoingGroups[key];
      group.sort(function (a, b) { return a.end.y - b.end.y || a.end.x - b.end.x || a.index - b.index; });
      group.forEach(function (record, index) {
        record.lane += (index - (group.length - 1) / 2) * 0.65;
      });
    });

    prepared.sort(function (a, b) {
      var aDistance = Math.abs(a.startRoutePoint.x - a.endRoutePoint.x) + Math.abs(a.startRoutePoint.y - a.endRoutePoint.y);
      var bDistance = Math.abs(b.startRoutePoint.x - b.endRoutePoint.x) + Math.abs(b.startRoutePoint.y - b.endRoutePoint.y);
      return aDistance - bDistance || a.index - b.index;
    });
    var reserved = [];
    prepared.forEach(function (record) {
      var horizontal = Math.abs(record.startRoutePoint.x - record.endRoutePoint.x) >= Math.abs(record.startRoutePoint.y - record.endRoutePoint.y);
      var laneOffset = record.lane * (record.isReciprocal ? 24 : ROUTE_CHANNEL_STEP);
      var preference = {
        axis: horizontal ? "y" : "x",
        value: (horizontal ? record.startRoutePoint.y + record.endRoutePoint.y : record.startRoutePoint.x + record.endRoutePoint.x) / 2 + laneOffset,
        weight: record.isReciprocal ? 6 : 0.08,
        bendCost: record.isReciprocal ? 12 : 84
      };
      var route = findOrthogonalRoute(record.startRoutePoint, record.endRoutePoint, obstacles, reserved, preference) ||
        fallbackOrthogonalRoute(record.startRoutePoint, record.endRoutePoint, obstacles, reserved, preference);
      var points;
      if (route && route.length) {
        points = [record.start, record.startRoutePoint].concat(route.slice(1, -1), [record.endRoutePoint, record.end]);
      } else {
        points = [record.start, record.end];
      }
      points = simplifyRoutePoints(points);
      var routeBend = record.edge.kind === "weak"
        ? weakBendFromGeometry(record.start, record.end, routePointAtProgress(points, 0.5), record.lane)
        : boundedLaneBend(record.start, record.end, routePointAtProgress(points, 0.5));
      var geometry = routedCurveGeometry(record, routeBend, reserved, routeNodeBounds(), obstacles);
      edgeRoutes[record.edge.id] = {
        points: points,
        path: geometry.path,
        midpoint: geometry.midpoint,
        sourceSide: record.sourceSide,
        targetSide: record.targetSide,
        bend: routeBend,
        weakLane: Number(record.lane) || 0,
        weakControls: record.edge.kind === "weak" ? curveGeometry(record.start, record.end, record.sourceSide, record.targetSide, routeBend) : null,
        geometry: geometry
      };
      for (var segmentIndex = 1; segmentIndex < points.length; segmentIndex += 1) {
        reserved.push({ start: points[segmentIndex - 1], end: points[segmentIndex] });
      }
    });
    return edgeRoutes;
  }

  function controlSideForVector(dx, dy, fallback) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fallback || "bottom";
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }

  function controlCurvePath(start, end, startSide, endSide) {
    var startVector = portVector(startSide);
    var endVector = portVector(endSide);
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var distance = Math.max(24, Math.min(120, length * 0.36));
    var control1 = {
      x: start.x + startVector.x * distance,
      y: start.y + startVector.y * distance
    };
    var control2 = {
      x: end.x + endVector.x * distance,
      y: end.y + endVector.y * distance
    };
    return "M " + routeNumber(start.x) + " " + routeNumber(start.y) +
      " C " + routeNumber(control1.x) + " " + routeNumber(control1.y) +
      ", " + routeNumber(control2.x) + " " + routeNumber(control2.y) +
      ", " + routeNumber(end.x) + " " + routeNumber(end.y);
  }

  function controlPointInsideNode(point, node) {
    var element = nodeElement(node.id);
    var size = nodeDimensions(element);
    return point.x > node.x - 12 && point.x < node.x + size.width + 12 &&
      point.y > node.y - 12 && point.y < node.y + size.height + 12;
  }

  function controlHubPoint(records) {
    var points = records.map(function (record) {
      return record.route && record.route.midpoint ? record.route.midpoint : null;
    }).filter(Boolean);
    if (!points.length) return null;
    var point = points.reduce(function (sum, item) {
      return { x: sum.x + item.x, y: sum.y + item.y };
    }, { x: 0, y: 0 });
    point.x /= points.length;
    point.y /= points.length;
    var source = getNode(records[0].edge.source);
    if (source) {
      var sourceElement = nodeElement(source.id);
      var sourceSize = nodeDimensions(sourceElement);
      var sourceCenter = { x: source.x + sourceSize.width / 2, y: source.y + sourceSize.height / 2 };
      var dx = point.x - sourceCenter.x;
      var dy = point.y - sourceCenter.y;
      var length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      // Keep the marker outside the source card. A fixed radius alone is not
      // enough for the 194px cards: a short edge could otherwise put the hub
      // under the Main card and make the hover target unreachable.
      var sourceClearance = Math.max(sourceSize.width, sourceSize.height) / 2 + 28;
      if (length < sourceClearance || controlPointInsideNode(point, source)) {
        var directionX = dx || 1;
        var directionY = dy;
        var directionLength = Math.max(1, Math.sqrt(directionX * directionX + directionY * directionY));
        point.x = sourceCenter.x + directionX / directionLength * sourceClearance;
        point.y = sourceCenter.y + directionY / directionLength * sourceClearance;
      }
    }
    var occupied = workflow.nodes.filter(function (item) { return item.id !== records[0].edge.source; });
    occupied.forEach(function (node) {
      var attempts = 0;
      while (controlPointInsideNode(point, node) && attempts < 4) {
        // Alternate the escape direction so a hub between vertically stacked
        // nodes does not get pushed through the next card indefinitely.
        var direction = attempts % 2 === 0 ? 1 : -1;
        point.y += 30 * direction;
        attempts += 1;
      }
    });
    return point;
  }

  function updateMainControlVisibility() {
    if (!mainControlLayer) return;
    mainControlLayer.querySelectorAll("[data-control-group]").forEach(function (element) {
      var group = element.getAttribute("data-control-group");
      var reveal = mainControlHover || (hoveredControlGroup && hoveredControlGroup === group);
      element.classList.toggle("is-revealed", Boolean(reveal));
    });
  }

  function setMainControlHover(group, active, fromMainNode) {
    // A hub can itself use the key "main" (for Main-origin weak edges), so
    // keep Main-card hover separate from hub hover.
    if (fromMainNode) mainControlHover = active;
    else if (active) hoveredControlGroup = group;
    else if (hoveredControlGroup === group) hoveredControlGroup = null;
    updateMainControlVisibility();
  }

  function selectorBranchesVisible(edge) {
    if (!isChoiceOutputEdge(edge)) return true;
    var source = getNode(edge.source);
    return Boolean(source && (selected === source.id || hoveredSelectorId === source.id || selectedEdge === edge.id));
  }

  function selectorBranchEditable(edge) {
    if (!isChoiceOutputEdge(edge)) return true;
    return selected === edge.source || selectedEdge === edge.id;
  }

  function drawMainControlLinks(routes) {
    if (!mainControlLayer) return;
    // Keep keyed dispatch edge groups alive while refreshing the optional
    // decision controls. Clearing the whole layer made every redraw briefly
    // remove and reinsert visible Main routes.
    Array.prototype.slice.call(mainControlLayer.children).forEach(function (child) {
      if (!child.getAttribute("data-edge-group")) child.remove();
    });
    if (DIRECT_EDGE_MODE) return;
    var main = getNode(workflow.mainAgentId);
    var mainElement = main && nodeElement(main.id);
    if (!main || !mainElement) return;
    var grouped = {};
    workflow.edges.forEach(function (edge) {
      var sourceNode = getNode(edge.source);
      // Selector cards are the visible decision hubs now. Their optional
      // branches stay hidden until the selector/Main is inspected; only the
      // quiet control rail remains in the background.
      if (isChoiceOutputEdge(edge)) return;
      // A weak edge is always a Main decision, including weak choices that
      // originate at Main itself. The old exclusion made the most common
      // Main -> candidate layout look like an ordinary fan-out.
      if (edge.kind !== "weak" || edge.source === "input") return;
      var route = routes && routes[edge.id];
      if (!route) {
        var source = getNode(edge.source);
        var target = getNode(edge.target);
        var sourceElement = source && nodeElement(source.id);
        var targetElement = target && nodeElement(target.id);
        if (!source || !target || !sourceElement || !targetElement) return;
        var sourceSide = validPortSide(edge.sourcePort) ? edge.sourcePort : choosePortSide(source, target, sourceElement);
        var targetSide = validPortSide(edge.targetPort) ? edge.targetPort : choosePortSide(target, source, targetElement);
        var fallbackStart = portAnchor(source, sourceElement, sourceSide);
        var fallbackEnd = portAnchor(target, targetElement, targetSide);
        route = {
          sourceSide: sourceSide,
          targetSide: targetSide,
          midpoint: curveMidpoint(fallbackStart, fallbackEnd, 0)
        };
      }
      if (!grouped[edge.source]) grouped[edge.source] = [];
      grouped[edge.source].push({ edge: edge, route: route });
    });
    var mainSize = nodeDimensions(mainElement);
    var mainCenter = { x: main.x + mainSize.width / 2, y: main.y + mainSize.height / 2 };
    // Each selector is a visible Main decision point. Draw only a quiet rail
    // from Main to that card; the selector's candidate branches are rendered
    // separately and revealed on hover/selection.
    var selectorSources = {};
    workflow.edges.forEach(function (edge) {
      if (!isChoiceOutputEdge(edge)) return;
      var selector = getNode(edge.source);
      if (selector) selectorSources[selector.id] = selector;
    });
    Object.keys(selectorSources).forEach(function (selectorId) {
      var selector = selectorSources[selectorId];
      var selectorElement = nodeElement(selector.id);
      if (!selectorElement) return;
      var selectorSize = nodeDimensions(selectorElement);
      var selectorCenter = { x: selector.x + selectorSize.width / 2, y: selector.y + selectorSize.height / 2 };
      var dx = selectorCenter.x - mainCenter.x;
      var dy = selectorCenter.y - mainCenter.y;
      var mainSide = controlSideForVector(dx, dy, "bottom");
      var selectorSide = controlSideForVector(-dx, -dy, "top");
      var selectorGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      selectorGroup.setAttribute("class", "main-selector-control");
      selectorGroup.setAttribute("data-control-group", selector.id);
      var selectorLink = document.createElementNS("http://www.w3.org/2000/svg", "path");
      selectorLink.setAttribute("class", "main-control-link");
      selectorLink.setAttribute("data-control-group", selector.id);
      selectorLink.setAttribute("d", controlCurvePath(portAnchor(main, mainElement, mainSide), portAnchor(selector, selectorElement, selectorSide), mainSide, selectorSide));
      selectorGroup.appendChild(selectorLink);
      mainControlLayer.appendChild(selectorGroup);
    });
    Object.keys(grouped).forEach(function (groupKey) {
      var records = grouped[groupKey];
      var hub = controlHubPoint(records);
      if (!hub) return;
      var hasTermination = records.some(function (record) { return isTerminationWorkflowEdge(record.edge); });
      var toHubDx = hub.x - mainCenter.x;
      var toHubDy = hub.y - mainCenter.y;
      var mainSide = controlSideForVector(toHubDx, toHubDy, "bottom");
      var hubSide = controlSideForVector(-toHubDx, -toHubDy, "top");
      var mainAnchor = portAnchor(main, mainElement, mainSide);
      var group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("class", "main-control-hub");
      group.setAttribute("data-control-group", groupKey);
      group.setAttribute("data-control-source", records[0].edge.source);
      group.setAttribute("role", "img");
      group.setAttribute("aria-label", hasTermination ? "Main 结束判断汇聚点" : "Main 决策汇聚点");

      var controlLink = document.createElementNS("http://www.w3.org/2000/svg", "path");
      controlLink.setAttribute("class", "main-control-link");
      controlLink.setAttribute("data-control-group", groupKey);
      controlLink.setAttribute("d", controlCurvePath(mainAnchor, hub, mainSide, hubSide));
      group.appendChild(controlLink);

      records.forEach(function (record) {
        var midpoint = record.route.midpoint;
        if (!midpoint) return;
        var branchStartSide = controlSideForVector(midpoint.x - hub.x, midpoint.y - hub.y, "right");
        var branchEndSide = controlSideForVector(hub.x - midpoint.x, hub.y - midpoint.y, "left");
        var branch = document.createElementNS("http://www.w3.org/2000/svg", "path");
        branch.setAttribute("class", "main-control-branch" + (isTerminationWorkflowEdge(record.edge) ? " termination" : ""));
        branch.setAttribute("data-control-group", groupKey);
        branch.setAttribute("d", controlCurvePath(hub, midpoint, branchStartSide, branchEndSide));
        group.appendChild(branch);
      });

      var hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hit.setAttribute("class", "main-control-hub-hit");
      hit.setAttribute("data-control-group", groupKey);
      hit.setAttribute("cx", routeNumber(hub.x));
      hit.setAttribute("cy", routeNumber(hub.y));
      hit.setAttribute("r", "22");
      group.appendChild(hit);
      var ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      ring.setAttribute("class", "main-control-hub-ring");
      ring.setAttribute("data-control-group", groupKey);
      ring.setAttribute("cx", routeNumber(hub.x));
      ring.setAttribute("cy", routeNumber(hub.y));
      ring.setAttribute("r", "14");
      group.appendChild(ring);
      var core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      core.setAttribute("class", "main-control-hub-core");
      core.setAttribute("data-control-group", groupKey);
      core.setAttribute("cx", routeNumber(hub.x));
      core.setAttribute("cy", routeNumber(hub.y));
      core.setAttribute("r", "9");
      group.appendChild(core);
      var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", routeNumber(hub.x));
      label.setAttribute("y", routeNumber(hub.y + 4));
      label.setAttribute("text-anchor", "middle");
      label.textContent = "M";
      group.appendChild(label);
      var caption = document.createElementNS("http://www.w3.org/2000/svg", "text");
      caption.setAttribute("class", "main-control-hub-caption");
      caption.setAttribute("x", routeNumber(hub.x));
      caption.setAttribute("y", routeNumber(hub.y + 27));
      caption.setAttribute("text-anchor", "middle");
      caption.textContent = hasTermination ? "MAIN 结束判断" : "MAIN 决策";
      group.appendChild(caption);
      var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = hasTermination ? "Main 结束判断汇聚点" : "Main 决策汇聚点";
      group.appendChild(title);
      group.addEventListener("mouseenter", function () { setMainControlHover(groupKey, true, false); });
      group.addEventListener("mouseleave", function () { setMainControlHover(groupKey, false, false); });
      group.addEventListener("mousedown", function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
      mainControlLayer.appendChild(group);
    });
    updateMainControlVisibility();
  }

  function drawEdges() {
    // 拖动中和拖动结束后必须使用同一套路由；否则会先显示简单曲线，
    // 松开鼠标后再切换到分轨曲线，造成连线突然跳变。
    var routes = RUNTIME_MODE ? (runtimeRoutes || (runtimeRoutes = buildEdgeRoutes())) : buildEdgeRoutes();
    var dispatchEdges = workflow.edges.filter(isMainDispatchEdge);
    var dispatchIndex = {};
    dispatchEdges.forEach(function (edge, index) {
      var route = mainDispatchGeometry(edge, index, dispatchEdges.length);
      if (route) dispatchIndex[edge.id] = route;
    });
    drawMainControlLinks(routes);
    // Reuse one SVG group per edge. The previous implementation cleared the
    // entire edge layer on every render, which restarted flow particles and
    // CSS draw animations even when only an unrelated node changed.
    var reusableEdges = {};
    Array.prototype.forEach.call(edgeGroup.children, function (child) {
      var id = child.getAttribute && child.getAttribute("data-edge-group");
      if (id) reusableEdges[id] = child;
      else child.remove();
    });
    var reusableDispatch = {};
    if (mainControlLayer) {
      Array.prototype.forEach.call(mainControlLayer.children, function (child) {
        var id = child.getAttribute && child.getAttribute("data-edge-group");
        if (id) reusableDispatch[id] = child;
        else if (child.classList && (child.classList.contains("workflow-edge") || child.classList.contains("edge-label") || child.classList.contains("edge-hit"))) child.remove();
      });
    }
    function ensureSvgChild(group, role, tagName) {
      var child = group.querySelector('[data-edge-role="' + role + '"]');
      if (!child) {
        child = document.createElementNS("http://www.w3.org/2000/svg", tagName);
        child.setAttribute("data-edge-role", role);
        group.appendChild(child);
      }
      return child;
    }
    var focusedNodeId = hoveredNodeId || (!selectedEdge && selected && getNode(selected) ? selected : null);
    var focusMode = hoveredNodeId ? "hover" : (focusedNodeId ? "selected" : null);
    var flowRecords = [];
    workflow.edges.forEach(function (edge) {
      var from = nodeElement(edge.source);
      var to = nodeElement(edge.target);
      var sourceNode = getNode(edge.source);
      var targetNode = getNode(edge.target);
      if (!from || !to || !sourceNode || !targetNode) return;
      var route = routes && routes[edge.id];
      if (isMainDispatchEdge(edge)) route = dispatchIndex[edge.id] || route;
      var sourceSide = route ? route.sourceSide : (validPortSide(edge.sourcePort) ? edge.sourcePort : choosePortSide(sourceNode, targetNode, from));
      var targetSide = route ? route.targetSide : (validPortSide(edge.targetPort) ? edge.targetPort : choosePortSide(targetNode, sourceNode, to));
      var start = portAnchor(sourceNode, from, sourceSide);
      var end = portAnchor(targetNode, to, targetSide);
      var pathData = route && route.path ? route.path : curvePath(start, end, sourceSide, targetSide, 0);
      if (edge.endChoice === "return-main") {
        pathData = returnMainCurvePath(start, end);
      }
      var displayKind = isMainDispatchEdge(edge) ? "main-dispatch" : edgeDisplayKind(edge);
      var branchVisible = DIRECT_EDGE_MODE || selectorBranchesVisible(edge);
      var branchEditable = DIRECT_EDGE_MODE || selectorBranchEditable(edge);
      var flowState = demoFlowForEdge(edge.id);
      var runtimeSkipped = demoRun.skippedEdgeIds.indexOf(edge.id) >= 0;
      var runtimeAdded = demoRun.addedEdgeIds.indexOf(edge.id) >= 0;
      var focusState;
      if (RUNTIME_MODE) {
        var runtimeFocus = { className: " runtime-edge-" + (edge.runtimeState || "configured"), showParticle: edge.runtimeState === "active", direction: "outgoing", focusMode: "runtime" };
        var selectedFocus = edgeFocusState(edge, focusedNodeId, focusMode);
        var relatedToSelection = Boolean(focusedNodeId && (edge.source === focusedNodeId || edge.target === focusedNodeId));
        focusState = {
          className: runtimeFocus.className + (relatedToSelection ? selectedFocus.className : ""),
          showParticle: runtimeFocus.showParticle || (relatedToSelection && selectedFocus.showParticle),
          direction: relatedToSelection && selectedFocus.showParticle ? selectedFocus.direction : runtimeFocus.direction,
          focusMode: relatedToSelection && selectedFocus.showParticle ? selectedFocus.focusMode : runtimeFocus.focusMode
        };
      } else {
        focusState = flowState && demoRun.active
          ? { className: " is-runtime-active", showParticle: true, direction: flowState.direction || "outgoing", focusMode: "runtime" }
          : edgeFocusState(edge, focusedNodeId, focusMode);
      }
      var focusClass = focusState.className;
      var runtimeRemoved = demoRun.removedEdgeIds.indexOf(edge.id) >= 0;
      var runtimeStrengthened = demoRun.updatedEdgeIds.indexOf(edge.id) >= 0;
      var dispatchEdge = isMainDispatchEdge(edge);
      var drawingLayer = dispatchEdge && mainControlLayer ? mainControlLayer : edgeGroup;
      var registry = dispatchEdge && mainControlLayer ? reusableDispatch : reusableEdges;
      var visual = registry[edge.id];
      if (!visual) {
        visual = document.createElementNS("http://www.w3.org/2000/svg", "g");
        visual.setAttribute("data-edge-group", edge.id);
      }
      // Keep an existing group attached to its layer. Re-appending on every
      // redraw would detach/reinsert it and can restart SVG/CSS animations.
      if (visual.parentNode !== drawingLayer) drawingLayer.appendChild(visual);
      delete registry[edge.id];
      var path = ensureSvgChild(visual, "path", "path");
      path.setAttribute("class", "workflow-edge " + edge.kind + (displayKind !== edge.kind ? " " + displayKind : "") + (displayKind === "termination" ? " termination" : "") + (selectedEdge === edge.id ? " is-selected" : "") + focusClass + (runtimeSkipped ? " is-runtime-skipped" : "") + (runtimeAdded ? " is-runtime-added" : "") + (runtimeRemoved ? " is-runtime-removed" : "") + (runtimeStrengthened ? " is-runtime-strengthened" : "") + (!branchVisible ? " is-selector-hidden" : ""));
      path.setAttribute("id", flowPathId(edge.id));
      path.setAttribute("data-edge", edge.id);
      path.setAttribute("data-source", edge.source);
      path.setAttribute("data-target", edge.target);
      if (RUNTIME_MODE) path.setAttribute("data-runtime-state", edge.runtimeState || "configured");
      path.setAttribute("d", pathData);
      if (edge.kind === "weak") path.setAttribute("stroke-dashoffset", String(edgeDashOffset(edge.id)));
      else path.removeAttribute("stroke-dashoffset");
      var hitPath = visual.querySelector('[data-edge-role="hit"]');
      if (!dispatchEdge) {
        if (!hitPath) hitPath = ensureSvgChild(visual, "hit", "path");
        hitPath.setAttribute("class", "edge-hit" + (!branchVisible ? " is-selector-hidden" : "") + (!branchEditable ? " is-selector-preview" : ""));
        hitPath.setAttribute("data-edge-hit", edge.id);
        hitPath.setAttribute("d", pathData);
      } else if (hitPath) {
        hitPath.remove();
      }
      var label = ensureSvgChild(visual, "label", "g");
      label.setAttribute("class", "edge-label " + displayKind + (selectedEdge === edge.id ? " is-selected" : "") + focusClass + (runtimeSkipped ? " is-runtime-skipped" : "") + (runtimeAdded ? " is-runtime-added" : "") + (runtimeRemoved ? " is-runtime-removed" : "") + (runtimeStrengthened ? " is-runtime-strengthened" : "") + (!branchVisible ? " is-selector-hidden" : "") + (!branchEditable ? " is-selector-preview" : ""));
      if (!dispatchEdge) label.setAttribute("data-edge-hit", edge.id);
      else label.removeAttribute("data-edge-hit");
      var midpoint = route && route.midpoint ? route.midpoint : curveMidpoint(start, end, 0);
      if (edge.endChoice === "return-main") {
        midpoint = returnMainCurveMidpoint(start, end);
      }
      label.setAttribute("transform", "translate(" + midpoint.x + " " + (midpoint.y - 8) + ")");
      if (dispatchEdge) {
        label.setAttribute("aria-label", "Main 固定调度");
        label.setAttribute("data-main-dispatch", "true");
        if (!focusClass) label.classList.add("is-dispatch-hidden");
        else label.classList.remove("is-dispatch-hidden");
      } else {
        label.removeAttribute("aria-label");
        label.removeAttribute("data-main-dispatch");
        label.classList.remove("is-dispatch-hidden");
      }
      var labelText = edge.runtimeLabel || (displayKind === "parallel" ? edgeLabelForEdge(edge) : (flowState ? flowState.name : (dispatchEdge ? "Main 固定调度" : edgeLabelForEdge(edge))));
      var box = ensureSvgChild(label, "box", "rect");
      var defaultLabelWidth = dispatchEdge ? 82 : edge.endChoice === "return-main" ? 64 : displayKind === "termination" ? 60 : 40;
      var labelWidth = edge.runtimeLabel || flowState ? Math.max(defaultLabelWidth, Math.min(290, labelText.length * 7 + 18)) : defaultLabelWidth;
      box.setAttribute("x", String(-labelWidth / 2));
      box.setAttribute("y", "-9");
      box.setAttribute("width", String(labelWidth));
      box.setAttribute("height", "17");
      var labelTextNode = ensureSvgChild(label, "text", "text");
      labelTextNode.setAttribute("x", "0");
      labelTextNode.setAttribute("y", "3");
      labelTextNode.setAttribute("text-anchor", "middle");
      if (labelTextNode.textContent !== labelText) labelTextNode.textContent = labelText;
      if (branchVisible && focusState.showParticle && (!dispatchEdge || flowState)) {
        flowRecords.push({
          edge: edge,
          displayKind: displayKind,
          pathId: flowPathId(edge.id),
          direction: focusState.direction,
          focusMode: focusState.focusMode || focusMode
        });
      }
    });
    Object.keys(reusableEdges).forEach(function (id) { reusableEdges[id].remove(); });
    Object.keys(reusableDispatch).forEach(function (id) { reusableDispatch[id].remove(); });
    syncFlowParticles(flowRecords);
  }

  function portOptions(selectedPort) {
    return ["top", "right", "bottom", "left"].map(function (side) {
      return '<option value="' + side + '"' + (selectedPort === side ? " selected" : "") + '>' + PORT_LABELS[side] + '</option>';
    }).join("");
  }

  function skillInfo(skillId) {
    return SKILL_CATALOG.find(function (skill) { return skill.id === skillId; }) || {
      id: skillId,
      name: String(skillId || "未命名 Skill").split(":").pop(),
      description: "来自现有 Agent 配置的 Skill。"
    };
  }

  function agentRuntimeSettingsHtml(item) {
    var skills = normalizeStringList(item.skills);
    var autoSkills = normalizeStringList(item.autoSkills);
    var selectedSkills = skills.concat(autoSkills.filter(function (skill) { return skills.indexOf(skill) < 0; }));
    var skillOptions = SKILL_CATALOG.filter(function (skill) { return selectedSkills.indexOf(skill.id) < 0; }).map(function (skill) {
      return '<option value="' + html(skill.id) + '">' + html(skill.name) + '</option>';
    }).join("");
    var skillRows = selectedSkills.map(function (skillId) {
      var skill = skillInfo(skillId);
      var mode = autoSkills.indexOf(skillId) >= 0 ? "auto" : "fixed";
      return '<div class="runtime-list-row skill-runtime-row"><span class="runtime-row-copy"><strong>' + html(skill.name) + '</strong><small>' + html(skill.description || skill.id) + '</small></span><select data-agent-skill-mode="' + html(skillId) + '" aria-label="' + html(skill.name) + '加载方式"><option value="fixed"' + (mode === "fixed" ? " selected" : "") + '>固定加载</option><option value="auto"' + (mode === "auto" ? " selected" : "") + '>自动选择</option></select><button type="button" class="runtime-remove-button" data-remove-agent-skill="' + html(skillId) + '" title="移除 Skill" aria-label="移除 ' + html(skill.name) + '">&#215;</button></div>';
    }).join("") || '<p class="runtime-empty">尚未配置 Skill</p>';
    var mcpServers = normalizeMcpServers(item.mcpServers);
    var mcpRows = mcpServers.map(function (server, index) {
      return '<div class="runtime-list-row mcp-runtime-row"><div class="runtime-mcp-fields"><input data-mcp-index="' + index + '" data-mcp-field="name" value="' + html(server.name) + '" aria-label="MCP 名称"><input data-mcp-index="' + index + '" data-mcp-field="url" value="' + html(server.url) + '" aria-label="MCP URL"></div><button type="button" class="runtime-remove-button" data-remove-mcp="' + index + '" title="移除 MCP" aria-label="移除 MCP ' + html(server.name) + '">&#215;</button></div>';
    }).join("") || '<p class="runtime-empty">尚未配置 MCP</p>';
    var permission = normalizePermission(item.permission, item.id === "main" ? "yolo" : "workspace");
    var permissionMeta = permissionInfo(permission);
    var permissionOptions = PERMISSION_OPTIONS.map(function (option) {
      return '<option value="' + html(option.id) + '"' + (option.id === permission ? ' selected' : '') + '>' + html(option.name) + '</option>';
    }).join("");
    var permissionWarning = permission === "yolo"
      ? '<div class="permission-warning is-yolo"><strong>最高执行权限</strong><span>YOLO 会绕过 Codex 审批与沙箱限制，请谨慎使用。</span></div>'
      : permission === "compute"
        ? '<div class="permission-warning is-compute"><strong>实验执行权限</strong><span>Compute 保留 Inspire wrapper、Workload ledger 和 compute usage 统计。</span></div>'
        : '';
    return [
      '<section class="form-section agent-runtime-section"><h3 class="section-title"><span>Skill</span><small>', selectedSkills.length, ' 项</small></h3>',
      '<div class="runtime-list">', skillRows, '</div>',
      '<div class="runtime-add-row"><select id="agent-skill-add"', skillOptions ? '' : ' disabled', '><option value="">添加 Skill…</option>', skillOptions, '</select><button type="button" class="runtime-add-button" id="add-agent-skill"', skillOptions ? '' : ' disabled', '>添加</button></div>',
      '<p class="runtime-help">固定加载会在每次调用时加载；自动选择仅在任务需要时启用。</p></section>',
      '<section class="form-section agent-runtime-section"><h3 class="section-title"><span>MCP 工具</span><small>', mcpServers.length, ' 项</small></h3>',
      '<div class="runtime-list">', mcpRows, '</div>',
      '<div class="runtime-mcp-add"><input id="agent-mcp-name" placeholder="名称，例如 datasets" maxlength="120"><input id="agent-mcp-url" placeholder="https://example.com/mcp" maxlength="2048"><button type="button" class="runtime-add-button" id="add-agent-mcp">添加 MCP</button></div>',
      '<p class="runtime-help">MCP 服务使用名称和 HTTP(S) URL 配置，每个 Agent 最多 32 项。</p></section>',
      '<section class="form-section agent-runtime-section permission-section"><h3 class="section-title"><span>运行权限</span><small>三档可选</small></h3>',
      '<label class="permission-field"><span>权限级别</span><select id="agent-permission" data-agent-permission aria-label="' + html(item.name) + '运行权限">', permissionOptions, '</select></label>',
      '<p class="runtime-help permission-description">', html(permissionMeta.description), '</p>', permissionWarning, '</section>'
    ].join("");
  }

  function directEdgeRowsHtml(edges) {
    return edges.map(function (edge) {
      var target = getNode(edge.target);
      var fixed = isMainDispatchEdge(edge);
      var displayKind = fixed ? "main-dispatch" : edgeDisplayKind(edge);
      var termination = displayKind === "termination";
      return [
        '<div class="edge-row', termination ? ' termination-row' : '', fixed ? ' edge-row-system-fixed' : ' has-delete-action', '" data-edge="', html(edge.id), '" style="--edge-color:', fixed ? "#607968" : termination ? "#a65365" : edge.kind === "weak" ? "#b56f17" : "#25714e", ';">',
        '<span class="edge-row-copy"><strong>', html(target ? target.name : "未知 Agent"), "</strong><small>", edgeLabel(displayKind), "</small></span>",
        '<span class="edge-row-kind">', fixed ? "系统固定 · 只读" : termination ? "终止候选" : edge.kind === "weak" ? "弱边 · 可选" : "强边 · 必经", '</span>',
        fixed ? '<span class="edge-row-fixed main-dispatch-fixed">锁定</span>' : '<button class="edge-delete edge-delete-button" type="button" title="删除到 ' + html(target ? target.name : "未知 Agent") + ' 的连接" aria-label="删除到 ' + html(target ? target.name : "未知 Agent") + ' 的连接"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="m19 6-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path></svg><span>删除连接</span></button>', '</div>'
      ].join("");
    }).join("") || '<p class="edge-list-empty">暂无连接，请从画布连接点拖线创建。</p>';
  }

  function directInspectorHtml() {
    var selectedConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
    if (selectedConnection) {
      var source = getNode(selectedConnection.source);
      var target = getNode(selectedConnection.target);
      var termination = isTerminationWorkflowEdge(selectedConnection);
      var systemInputEdge = selectedConnection.source === "input";
      var systemDispatch = isMainDispatchEdge(selectedConnection);
      var edgeKindControl = termination || systemInputEdge || systemDispatch ? "" : [
        '<section class="form-section"><h3 class="section-title">连接类型</h3>',
        '<div class="edge-type-toggle inspector-edge-type"><button class="edge-type-button', selectedConnection.kind === "strong" ? ' active' : '', '" type="button" data-set-edge-kind="strong">强边</button>',
        '<button class="edge-type-button', selectedConnection.kind === "weak" ? ' active' : '', '" type="button" data-set-edge-kind="weak">弱边</button></div>',
        '<p class="edge-type-help">强边一定执行；弱边由源 Agent 根据弱边选择 Prompt 决定下一步。</p></section>'
      ].join("");
      return [
        '<div class="inspector-header"><div class="inspector-title"><h2>', termination ? "结束连接" : "连接配置", '</h2><p>', edgeLabelForEdge(selectedConnection), '</p></div></div>',
        '<div class="inspector-body"><section class="form-section"><h3 class="section-title">连接方向</h3>',
        '<div class="selected-edge-route"><strong>', html(source ? source.name : "未知 Agent"), '</strong><span>&#8594;</span><strong>', html(target ? target.name : "未知 Agent"), '</strong></div></section>',
        '<section class="form-section"><h3 class="section-title">连接点</h3><div class="form-grid">',
        '<label><span>起点连接点</span><select id="selected-edge-source-port"', systemDispatch ? ' disabled' : '', '>', portOptions(validPortSide(selectedConnection.sourcePort) ? selectedConnection.sourcePort : "right"), '</select></label>',
        '<label><span>终点连接点</span><select id="selected-edge-target-port"', systemDispatch ? ' disabled' : '', '>', portOptions(validPortSide(selectedConnection.targetPort) ? selectedConnection.targetPort : "left"), '</select></label>',
        '</div><p class="edge-type-help">可分别调整连线两端使用的连接点。</p></section>',
        edgeKindControl,
        '<section class="form-section"><h3 class="section-title">连接语义</h3><div class="fixed-note ', termination || selectedConnection.kind === "weak" ? "selector-note" : "", '">', termination ? "终止候选边：结果先进入终止闸门，由终止验收条件判断是否结束。" : edgeHelp(selectedConnection.kind), '</div></section>',
        systemDispatch ? '<div class="fixed-note main-selector-note">Main 固定调度边：系统覆盖全部普通 Agent，每轮只选择一个目标。该边不能删除、移动、改目标或改为强边。</div>' : '<button id="delete-selected-edge" class="edge-remove-button" type="button">删除连接</button></div>'
      ].join("");
    }

    var item = getNode(selected);
    if (!item) {
      return '<div class="inspector-header"><div class="inspector-title"><h2>工作流检查</h2><p>画布连接是唯一配置来源</p></div></div><div class="inspector-body">' + workflowValidationHtml() + '<div class="inspector-empty"><div class="inspector-empty-mark">&#9670;</div><strong>选择一个节点或连接</strong><p>选择后可查看属性、连接和路径配置。</p></div></div>';
    }

    if (isEndNode(item)) {
      var incoming = workflow.edges.filter(function (edge) { return edge.target === "end"; });
      var incomingEdge = incoming[0];
      var sourceNode = incomingEdge && getNode(incomingEdge.source);
      var terminationOptions = '<option value=""' + (!sourceNode ? ' selected' : '') + '>未连接</option>' + ordinaryAgentNodes().filter(function (candidate) {
        return candidate.id === (sourceNode && sourceNode.id) || canBeTerminationAgent(candidate.id);
      }).map(function (candidate) {
        return '<option value="' + html(candidate.id) + '"' + (sourceNode && sourceNode.id === candidate.id ? ' selected' : '') + '>' + html(candidate.name) + '</option>';
      }).join("");
      return [
        '<div class="inspector-header"><div class="inspector-title"><h2>结束</h2><p>工作流终止节点 · 只能接收入边</p></div></div>',
        '<div class="inspector-body"><section class="form-section"><h3 class="section-title"><span>终止入口</span><small>', incoming.length, ' / 1</small></h3>',
        incomingEdge ? '<div class="edge-list">' + directEdgeRowsHtml(incoming) + '</div>' : '<p class="edge-list-empty">尚未连接。请从一个 Agent 的连接点拖线到结束节点。</p>',
        DIRECT_EDGE_MODE ? '<label class="termination-agent-picker"><span>结束 Agent</span><select id="workflow-termination-agent">' + terminationOptions + '</select></label><p class="edge-type-help">结束 Agent 只能有弱出边；更换来源会保持结束节点唯一入边。</p>' : '',
        '</section><section class="form-section termination-condition-section"><h3 class="section-title"><span>终止验收条件</span><small>结束节点专属</small></h3>',
        '<label><span>结果满足什么标准后才允许结束工作流</span><textarea id="workflow-termination-condition" rows="5" maxlength="240">', html(workflow.terminationCondition || ""), '</textarea></label>',
        '<p class="edge-type-help">这里负责最终结果验收，不负责选择下一步 Agent；终止候选边进入这里后先判断该条件，不满足时回到源 Agent 的普通后续路径。</p></section>',
        '<div class="fixed-note termination-note">结束节点始终存在且不能删除，可以自由移动；它不能创建任何出边。</div></div>'
      ].join("");
    }

    var outgoing = workflow.edges.filter(function (edge) { return edge.source === item.id; });
    if (item.type === "input") {
      return [
        '<div class="inspector-header"><div class="inspector-title"><h2>用户输入</h2><p>工作流起点 · 只能创建出边</p></div></div>',
        '<div class="inspector-body"><section class="form-section"><h3 class="section-title"><span>输入出口</span><small>', outgoing.length, ' / 1</small></h3>',
        '<div class="edge-list">', directEdgeRowsHtml(outgoing), '</div></section>',
        '<div class="fixed-note">用户输入始终存在且不能删除，最多连接一个目标；目标可以是 Main 或普通 Agent。新建画布默认可以暂时不连接。</div></div>'
      ].join("");
    }

    var terminationOutgoing = outgoing.filter(isTerminationWorkflowEdge);
    var ordinaryOutgoing = outgoing.filter(function (edge) { return !isTerminationWorkflowEdge(edge) && !isMainDispatchEdge(edge); });
    var newEdgeKind = terminationOutgoing.length ? "weak" : directEdgeKind;
    var weakCount = ordinaryOutgoing.filter(function (edge) { return edge.kind === "weak"; }).length;
    var decisionSourceId = item.id;
    var effectiveDecisionBy = weakCount >= 2 && item.decisionBy === "agent" ? "agent" : "main";
    var decisionState = weakCount >= 2 ? (effectiveDecisionBy === "agent" ? "当前 Agent 选择" : "Main Agent 选择") : "至少需要两条弱边";
    var directKindPicker = '<div class="connection-kind-picker"><span>新连接</span><div class="edge-type-toggle"><button class="edge-type-button' + (newEdgeKind === "strong" ? ' active' : '') + '" type="button" data-new-edge-kind="strong"' + (terminationOutgoing.length ? ' disabled title="结束 Agent 不能拥有强出边"' : '') + '>强边</button><button class="edge-type-button' + (newEdgeKind === "weak" ? ' active' : '') + '" type="button" data-new-edge-kind="weak">弱边</button></div></div>';
    var promptSection = item.id !== "main" ? [
      '<section class="form-section weak-choice-prompt"><h3 class="section-title"><span>弱边决策</span><small>', weakCount, ' 条普通弱边</small></h3>',
      '<label><span>选择说明（提供给决策者）</span><textarea data-field="choicePrompt" rows="4" maxlength="600" placeholder="可选：说明如何在候选路径之间选择。">', html(item.choicePrompt || ""), '</textarea></label>',
      '<div class="decision-toggle" role="group" aria-label="弱边决策者" data-decision-source="', html(decisionSourceId), '"><div class="decision-toggle-heading"><span>由谁选择下一步</span><strong class="decision-current">', html(decisionState), '</strong></div><div class="decision-segmented"><button type="button" class="decision-option edge-type-button', effectiveDecisionBy === "main" ? ' is-active active' : '', '" data-decision-by="main" data-decision-source="', html(decisionSourceId), '" aria-pressed="', effectiveDecisionBy === "main" ? 'true' : 'false', '"', weakCount < 2 ? ' disabled title="至少需要两条普通弱边"' : '', '><span class="decision-option-mark" aria-hidden="true"></span><span>Main Agent</span></button><button type="button" class="decision-option edge-type-button', effectiveDecisionBy === "agent" ? ' is-active active' : '', '" data-decision-by="agent" data-decision-source="', html(decisionSourceId), '" aria-pressed="', effectiveDecisionBy === "agent" ? 'true' : 'false', '"', weakCount < 2 ? ' disabled title="至少需要两条普通弱边"' : '', '><span class="decision-option-mark" aria-hidden="true"></span><span>当前 Agent</span></button></div></div>',
      '<p class="edge-type-help">', weakCount < 2 ? '添加第二条普通弱边后即可选择决策者。' : '同一 Agent 的全部普通弱边共用一个决策者；当前设置只保存于画布数据。', '</p></section>'
    ].join("") : "";
    var isMain = item.id === "main";
    var sessionEnabled = Boolean(item.sessionPersistence);
    var sessionSection = isMain ? '<section class="form-section"><h3 class="section-title"><span>运行</span><small>系统设置</small></h3><div class="fixed-note main-selector-note">Main Agent 始终使用持续 session，不能关闭。</div></section>' : '<section class="form-section session-setting"><h3 class="section-title"><span>运行</span><small>当前子 Agent</small></h3><label class="session-card' + (sessionEnabled ? ' is-enabled' : '') + '"><input class="session-input" type="checkbox" data-session-persistence aria-label="持续 session"' + (sessionEnabled ? ' checked' : '') + '><span class="session-card-copy"><strong>持续 session</strong><small>在同一流程的多轮调用中复用该 Agent 的会话。</small></span><span class="session-card-control" aria-hidden="true"><span class="session-state">' + (sessionEnabled ? '已开启' : '未开启') + '</span><span class="session-switch"><i></i></span></span></label><p class="session-card-note">仅保存前端配置，不会在此处创建或恢复 thread。</p></section>';
    return [
      '<div class="inspector-header"><div class="inspector-title"><h2>', html(item.name), '</h2><p>', isMain ? "Main Agent · 系统节点" : "Agent 配置", '</p></div>', isMain ? '' : '<button class="node-remove node-remove-button" type="button" title="从画布删除 ' + html(item.name) + '" aria-label="删除 ' + html(item.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="m19 6-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path></svg><span>删除 Agent</span></button>', '</div>',
      '<div class="inspector-body"><section class="form-section"><h3 class="section-title">基本信息</h3><div class="form-grid">',
      '<label><span>名称</span><input data-field="name" maxlength="32" value="', html(item.name), '"', isMain ? ' disabled aria-disabled="true" title="Main Agent 名称固定"' : '', '></label></div>',
      '<div class="agent-model-row"><select data-field="model"><option value="gpt-5.6-sol"', item.model === "gpt-5.6-sol" ? " selected" : "", '>Nex-N2-pro</option><option value="gpt-5.6-terra"', item.model === "gpt-5.6-terra" ? " selected" : "", '>gpt-5.6-terra</option><option value="custom"', item.model === "custom" ? " selected" : "", '>custom</option></select><span>模型</span></div>',
      '<label><span>职责说明</span><textarea data-field="description" rows="3">', html(item.description || ""), '</textarea></label></section>',
      '<section class="form-section"><h3 class="section-title">Agent 指令</h3><label><span class="sr-only">Agent 指令</span><textarea data-field="instructions" rows="4">', html(item.instructions || ""), '</textarea></label></section>',
      agentRuntimeSettingsHtml(item),
      isMain ? '<section class="form-section"><h3 class="section-title"><span>固定调度路由</span><small>' + outgoing.filter(isMainDispatchEdge).length + ' 个普通 Agent</small></h3><div class="edge-list">' + directEdgeRowsHtml(outgoing.filter(isMainDispatchEdge)) + '</div><div class="fixed-note main-selector-note">系统自动覆盖当前全部普通子 Agent；静态图允许多条固定边，运行时每轮只选择一个目标。</div></section>' : '<section class="form-section"><h3 class="section-title"><span>出边</span><small>' + (ordinaryOutgoing.length + terminationOutgoing.length) + ' 条</small></h3>' + directKindPicker + '<p class="edge-type-help">连接请直接从画布端口拖出；普通边可以删除或切换类型。</p><div class="edge-list">' + directEdgeRowsHtml(ordinaryOutgoing.concat(terminationOutgoing)) + '</div></section>',
      weakCount ? '<div class="route-note"><b>可选路径</b><span>该 Agent 会依据下方 Prompt 从弱边中选择下一步。</span></div>' : '',
      terminationOutgoing.length ? '<div class="route-note termination-note"><b>终止闸门</b><span>终止候选边只负责提交最终结果；满足条件则结束，不满足时回到当前 Agent 的普通后续路径。</span></div>' : '',
      promptSection, sessionSection, '</div>'
    ].join("");
  }

  function inspectorHtml() {
    if (DIRECT_EDGE_MODE) return directInspectorHtml();
    var selectedConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
    if (selectedConnection) {
      var source = getNode(selectedConnection.source);
      var target = getNode(selectedConnection.target);
      var selectedDisplayKind = edgeDisplayKind(selectedConnection);
      var isTerminationConnection = selectedDisplayKind === "termination";
      var selectedSourceNode = source && isSelectorNode(source);
      var isEndReturn = selectedConnection.endChoice === "return-main";
      var selectedSourceIsTerminal = DIRECT_EDGE_MODE && selectedConnection.source === workflow.terminationAgentId;
      var targetPortControl = isTerminationConnection
        ? '<select id="selected-edge-target-port" disabled><option value="left" selected>左侧（固定入口）</option></select>'
        : '<select id="selected-edge-target-port">' + portOptions(validPortSide(selectedConnection.targetPort) ? selectedConnection.targetPort : "left") + '</select>';
      var edgeKindControl = !DIRECT_EDGE_MODE || isTerminationConnection || selectedConnection.source === "input" ? "" : [
        '<section class="form-section"><h3 class="section-title">连接类型</h3>',
        '<div class="edge-type-toggle inspector-edge-type"><button class="edge-type-button', selectedConnection.kind === "strong" ? ' active' : '', '" type="button" data-set-edge-kind="strong"', selectedSourceIsTerminal ? ' disabled title="结束 Agent 不能拥有强边"' : '', '>强边</button>',
        '<button class="edge-type-button', selectedConnection.kind === "weak" ? ' active' : '', '" type="button" data-set-edge-kind="weak">弱边</button></div>',
        '<p class="edge-type-help">', selectedSourceIsTerminal ? '结束连接天然为弱边，因此该 Agent 的其他出边也只能是弱边。' : '强边一定执行；弱边是当前 Agent 的可选下一步。同一 Agent 不能混用两种出边。', '</p></section>'
      ].join("");
      return [
        '<div class="inspector-header"><div class="inspector-title"><h2>', isTerminationConnection ? "结束判断" : "连接配置", '</h2><p>', edgeLabelForEdge(selectedConnection), '</p></div></div>',
        '<div class="inspector-body">', workflowSettingsHtml(), '<section class="form-section"><h3 class="section-title">连接方向</h3>',
        '<div class="selected-edge-route"><strong>', html(source ? source.name : "未知 Agent"), '</strong><span>&#8594;</span><strong>', html(target ? target.name : "未知 Agent"), '</strong></div>',
        '</section><section class="form-section"><h3 class="section-title">连接点</h3><div class="form-grid">',
        '<label><span>起点连接点</span><select id="selected-edge-source-port">', portOptions(validPortSide(selectedConnection.sourcePort) ? selectedConnection.sourcePort : "right"), '</select></label>',
        '<label><span>终点连接点</span>', targetPortControl, '</label>',
        '</div><p class="edge-type-help">', isTerminationConnection ? '结束模块只有左侧固定入口；可调整终止 Agent 一端的连接点。' : '可分别指定这条边从两端 Agent 的哪个连接点出发和到达。', '</p>',
        '</section>', edgeKindControl,
        isTerminationConnection ? '<div class="fixed-note termination-note">结束节点始终存在且不能删除；这是结束 Agent 的固定终止出口。</div>' : '<section class="form-section"><h3 class="section-title">连接语义</h3><div class="fixed-note ' + (selectedConnection.kind === 'weak' ? 'selector-note' : '') + '">' + edgeHelp(selectedConnection.kind) + '</div></section>',
        selectedConnection.source === "input" ? '<div class="fixed-note">入口边可以删除；删除后可从用户输入节点的连接点重新拖到任意 Agent。</div>' : '',
        isTerminationConnection || isEndReturn || isMainSelectorEntry(selectedConnection) ? '<div class="fixed-note ' + (isMainSelectorEntry(selectedConnection) ? 'main-selector-note' : 'termination-note') + '">' + (isTerminationConnection ? (DIRECT_EDGE_MODE ? '结束节点的固定入口不能删除。' : '结束判断由 Main 控制，不能删除。') : isMainSelectorEntry(selectedConnection) ? 'Main 常驻选择器入口是固定系统连接，不能删除。' : '结束选择器回到 Main 是固定系统出口，不能删除。') + '</div>' : '<button id="delete-selected-edge" class="edge-remove-button" type="button">删除连接</button>', '</div>'
      ].join("");
    }
    var item = getNode(selected);
    if (!item) return '<div class="inspector-header"><div class="inspector-title"><h2>工作流设置</h2><p>入口、结束和调度语义</p></div></div><div class="inspector-body">' + workflowSettingsHtml() + '<div class="inspector-empty"><div class="inspector-empty-mark">&#9670;</div><strong>选择一个 Agent</strong><p>选择画布节点后可调整属性和连接。</p></div></div>';
    if (isEndNode(item)) {
      var endSource = workflow.edges.find(function (edge) { return isTerminationWorkflowEdge(edge); });
      var endAgent = endSource && getNode(endSource.source);
      if (DIRECT_EDGE_MODE) {
        return '<div class="inspector-header"><div class="inspector-title"><h2>结束</h2><p>工作流终止节点 · 可自由移动</p></div></div><div class="inspector-body">' + workflowSettingsHtml() + '<section class="form-section"><h3 class="section-title">终止入口</h3><div class="selected-edge-route"><strong>' + html(endAgent ? endAgent.name : "未选择") + '</strong><span>&#8594;</span><strong>结束</strong></div><p class="edge-type-help">指定的结束 Agent 完成并满足终止条件后，工作流从这里结束。</p></section><div class="fixed-note termination-note">结束节点始终存在且不能删除，但可以在画布中自由移动。</div></div>';
      }
      var endChoices = workflow.edges.filter(function (edge) { return edge.source === "end" && !isTerminationWorkflowEdge(edge); });
      var endReturn = endChoices.find(function (edge) { return edge.endChoice === "return-main" && edge.target === "main"; });
      var endExtraChoices = endChoices.filter(function (edge) { return edge !== endReturn; });
      var endOptions = agentNodes().filter(function (target) { return target.id !== "main"; }).map(function (target) {
        return '<option value="' + html(target.id) + '">' + html(target.name) + ' · 结束候选</option>';
      }).join("");
      var endExtraRows = endExtraChoices.map(function (edge) {
        var target = getNode(edge.target);
        return '<div class="edge-row" data-edge="' + html(edge.id) + '" style="--edge-color:#a65365;"><span class="edge-row-copy"><strong>' + html(target ? target.name : "未知 Agent") + '</strong><small>结束候选 · Main 选择</small></span><span class="edge-row-kind">候选</span><button class="edge-delete" type="button" title="删除候选">&#215;</button></div>';
      }).join("");
      return '<div class="inspector-header"><div class="inspector-title"><h2>结束选择器</h2><p>Main 控制的终点 · 可自由移动</p></div></div><div class="inspector-body">' + workflowSettingsHtml() + '<section class="form-section"><h3 class="section-title">入口</h3><div class="selected-edge-route"><strong>' + html(endAgent ? endAgent.name : "未选择") + '</strong><span>&#8594;</span><strong>结束选择器</strong></div><p class="edge-type-help">终止 Agent 进入这里后，由 Main 判断“结束”、“回到 Main”，或选择额外候选。</p></section><section class="form-section"><h3 class="section-title"><span>系统出口</span><small>固定 2 个</small></h3><div class="end-choice-list"><div class="end-choice-row"><span class="choice-dot finish"></span><span><strong>结束</strong><small>满足终止条件后完成工作流</small></span><span class="edge-row-fixed">Main 判断</span></div><div class="end-choice-row"><span class="choice-dot return"></span><span><strong>回到 Main</strong><small>继续由 Main 常驻选择器决定下一步</small></span><span class="edge-row-fixed">已连接</span></div></div></section><section class="form-section"><h3 class="section-title"><span>额外结束候选</span><small>' + endExtraChoices.length + ' 个</small></h3><div class="connection-editor"><select id="connection-target">' + endOptions + '</select><button id="add-connection-from-inspector" class="connection-action" type="button">添加候选</button></div><div class="edge-list">' + (endExtraRows || '<p class="edge-list-empty">暂无额外候选；结束和回到 Main 始终保留。</p>') + '</div></section><div class="fixed-note termination-note">结束选择器不能删除；固定出口为“结束”和“回到 Main”，额外候选只在悬停或选中时显示。</div></div>';
    }
    if (item.type === "selector") {
      var selectorOutgoing = workflow.edges.filter(function (edge) { return edge.source === item.id; });
      var selectorOptions = agentNodes().filter(function (target) { return target.id !== item.id && target.id !== "main"; }).map(function (target) {
        return '<option value="' + html(target.id) + '">' + html(target.name) + ' · 候选</option>';
      }).join("");
      var selectorRows = selectorOutgoing.map(function (edge) {
        var target = getNode(edge.target);
        return '<div class="edge-row" data-edge="' + html(edge.id) + '" style="--edge-color:#b56f17;"><span class="edge-row-copy"><strong>' + html(target ? target.name : "未知 Agent") + '</strong><small>候选 · Main 选择</small></span><span class="edge-row-kind">弱边</span><button class="edge-delete" type="button" title="删除候选">&#215;</button></div>';
      }).join("") || '<p class="edge-list-empty">暂无候选出口</p>';
      var systemSelector = isSystemSelectorNode(item);
      return '<div class="inspector-header"><div class="inspector-title"><h2>' + html(item.name) + '</h2><p>' + (systemSelector ? 'Main 常驻选择器 · 系统节点' : 'Main 选择器 · ' + selectorOutgoing.length + ' 个候选') + '</p></div>' + (systemSelector ? '' : '<button class="node-remove" type="button" title="删除选择器">&#215;</button>') + '</div><div class="inspector-body">' + workflowSettingsHtml() + '<section class="form-section"><h3 class="section-title">选择器信息</h3><label><span>名称</span><input data-field="name" maxlength="32" value="' + html(item.name) + '"></label><label><span>说明</span><textarea data-field="description" rows="3">' + html(item.description) + '</textarea></label><div class="fixed-note ' + (systemSelector ? 'main-selector-note' : 'selector-note') + '">' + (systemSelector ? 'Main 常驻选择器不能删除。用户中途补充输入、Agent 出错、重试或其他特殊情况回到 Main 后，都从这里选择下一步。' : '普通 Agent 只能连强边；这里的出口才是可选候选。候选边平时隐藏，悬停或选中选择器时显示。') + '</div></section><section class="form-section"><h3 class="section-title">候选出口</h3><div class="connection-editor"><select id="connection-target">' + selectorOptions + '</select><button id="add-connection-from-inspector" class="connection-action" type="button">添加候选</button></div><div class="edge-list">' + selectorRows + '</div></section></div>';
    }
    var fixedNode = false;
    var outgoing = workflow.edges.filter(function (edge) { return edge.source === item.id; });
    var terminalForcesWeak = DIRECT_EDGE_MODE && hasTerminationOutgoing(item.id);
    var newEdgeKind = terminalForcesWeak ? "weak" : directEdgeKind;
    var options = connectableNodes().map(function (target) {
      return '<option value="' + html(target.id) + '"' + (target.id === item.id && newEdgeKind !== "weak" ? " disabled" : "") + '>' + html(target.name) + (DIRECT_EDGE_MODE ? "" : isSelectorNode(item) ? " · 候选" : " · 强边") + "</option>";
    }).join("");
    var edges = outgoing.map(function (edge) {
      var target = getNode(edge.target);
      var displayKind = edgeDisplayKind(edge);
      var termination = displayKind === "termination";
      return [
        '<div class="edge-row', termination ? ' termination-row' : '', '" data-edge="', html(edge.id), '" style="--edge-color:', termination || edge.kind === "weak" ? "#b56f17" : "#25714e", ';">',
        '<span class="edge-row-copy"><strong>', html(target ? target.name : "未知 Agent"), "</strong><small>", edgeLabel(displayKind), "</small></span>",
        termination || isMainSelectorEntry(edge) ? '<span class="edge-row-fixed">固定入口</span>' : (DIRECT_EDGE_MODE ? '<span class="edge-row-kind">' + (edge.kind === "weak" ? "弱边 · 可选" : "强边 · 必经") + '</span>' : '<span class="edge-row-kind">' + (isChoiceOutputEdge(edge) ? "候选 · Main 选择" : "强边 · 直接执行") + '</span>'),
        termination || isMainSelectorEntry(edge) ? '' : '<button class="edge-delete" type="button" title="删除连接">&#215;</button>', '</div>'
      ].join("");
    }).join("") || '<p class="edge-list-empty">暂无出边</p>';
    var weak = outgoing.filter(function (edge) { return DIRECT_EDGE_MODE ? edge.kind === "weak" : isChoiceOutputEdge(edge); }).length;
    var directKindPicker = DIRECT_EDGE_MODE && item.type !== "input" ? '<div class="connection-kind-picker"><span>' + (terminalForcesWeak ? '结束 Agent 出边' : '新连接') + '</span><div class="edge-type-toggle"><button class="edge-type-button' + (newEdgeKind === "strong" ? ' active' : '') + '" type="button" data-new-edge-kind="strong"' + (terminalForcesWeak ? ' disabled title="结束 Agent 不能拥有强边"' : '') + '>强边</button><button class="edge-type-button' + (newEdgeKind === "weak" ? ' active' : '') + '" type="button" data-new-edge-kind="weak">弱边</button></div></div>' : '';
    return [
      '<div class="inspector-header"><div class="inspector-title"><h2>', html(item.name), "</h2><p>", item.type === "main" ? "Main Agent · 可自由移动" : item.type === "input" ? "用户输入 · 可自由移动" : isSelectorNode(item) ? "Main 选择器" : "Agent 配置", "</p></div>", isAnchorNode(item) ? "" : '<button class="node-remove" type="button" title="从画布删除">&#215;</button>', '</div>',
      '<div class="inspector-body">', workflowSettingsHtml(),
      '<section class="form-section"><h3 class="section-title">基本信息</h3><div class="form-grid">',
      '<label><span>名称</span><input data-field="name" maxlength="32" value="', html(item.name), '"', item.type === "main" || item.type === "input" ? " disabled" : "", '></label></div>',
      '<div class="agent-model-row"><select data-field="model"', fixedNode ? " disabled" : "", '><option value="gpt-5.6-sol"', item.model === "gpt-5.6-sol" ? " selected" : "", '>Nex-N2-pro</option><option value="gpt-5.6-terra"', item.model === "gpt-5.6-terra" ? " selected" : "", '>gpt-5.6-terra</option><option value="custom"', item.model === "custom" ? " selected" : "", '>custom</option></select><span>模型</span></div>',
      '<label><span>职责说明</span><textarea data-field="description" rows="3"', fixedNode ? " disabled" : "", '>', html(item.description), "</textarea></label></section>",
      item.type === "input" ? '<div class="fixed-note">用户输入始终存在且不能删除；可以自由拖动，也可从连接点重新连接。</div>' : isSelectorNode(item) ? '<div class="fixed-note selector-note">选择器出口全部是候选弱边。平时隐藏，悬停或选中此节点时显示。</div>' : '<section class="form-section"><h3 class="section-title">Agent 指令</h3><label><span class="sr-only">Agent 指令</span><textarea data-field="instructions" rows="4">' + html(item.instructions) + "</textarea></label></section>",
      item.type === "input" ? (outgoing.length ? '<section class="form-section"><h3 class="section-title"><span>入口连接</span><small>1 条</small></h3><div class="edge-list">' + edges + "</div></section>" : '<p class="edge-list-empty">当前未连接入口 Agent</p>') : '<section class="form-section"><h3 class="section-title"><span>出边</span><small>' + outgoing.length + " 条</small></h3>" + directKindPicker + '<div class="connection-editor"><select id="connection-target">' + options + '</select><button id="add-connection-from-inspector" class="connection-action" type="button">添加连接</button></div><div class="edge-list">' + edges + "</div></section>" + (weak ? '<div class="route-note"><b>' + (DIRECT_EDGE_MODE ? "可选路径" : "Main 选择") + '</b><span>' + (DIRECT_EDGE_MODE ? "该 Agent 会从这些弱边中选择一个下一步。" : item.type === "main" ? "Main 将从这些候选路径中选择下一步。" : "该 Agent 完成后会回到 Main，再由 Main 选择候选路径。") + '</span></div>' : ""),
      "</div>"
    ].join("");
  }

  function renderSaved() {
    var list = saved();
    savedCount.textContent = list.length;
    savedList.innerHTML = list.map(function (entry) {
      var isActive = activeSavedId === entry.id;
      var isDirty = isActive && dirty;
      var classes = "saved-item" + (entry.builtin ? " is-builtin" : "") + (isActive ? " is-active" : "") + (isDirty ? " is-dirty" : "");
      var status = entry.builtin ? "内置展示" : "本地保存";
      if (isDirty) status += " · 有未保存修改";
      var saveTitle = "保存修改";
      var saveHint = isActive ? (isDirty ? saveTitle : "当前没有未保存修改") : "请先载入该流程";
      return '<div class="' + classes + '" data-saved="' + html(entry.id) + '"><span class="saved-copy"><strong>' + html(entry.name) + '</strong><small>' + html(status) + '</small></span>' +
        '<button class="saved-save" type="button" title="' + html(saveHint) + '" aria-label="' + html(saveTitle + '：' + entry.name) + '"' + (isActive && isDirty ? '' : ' disabled') + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"></path><path d="M8 4v6h8V4M8 20v-5h8v5"></path></svg></button>' +
        '<button class="saved-rename" type="button" title="修改名称" aria-label="修改 ' + html(entry.name) + ' 的名称">&#9998;</button><button class="saved-load" type="button" title="载入流程" aria-label="载入 ' + html(entry.name) + '">&#8599;</button><button class="saved-delete" type="button" title="删除保存项" aria-label="删除 ' + html(entry.name) + '">&#215;</button></div>';
    }).join("") || '<p class="saved-empty">暂无已保存流程</p>';
  }

  function renderNodeLayer() {
    // Reconcile nodes by id instead of replacing the whole layer. Replacing
    // innerHTML on every topology event restarts arrival/pulse animations for
    // unrelated nodes and reads as a canvas flash to the viewer.
    var existing = {};
    Array.prototype.forEach.call(nodeLayer.children, function (element) {
      if (element.dataset && element.dataset.node) existing[element.dataset.node] = element;
    });
    var cursor = nodeLayer.firstElementChild;
    workflow.nodes.forEach(function (item) {
      var template = document.createElement("template");
      template.innerHTML = nodeHtml(item).trim();
      var next = template.content.firstElementChild;
      if (!next) return;
      var current = existing[item.id];
      if (current) {
        var nextClass = next.getAttribute("class") || "";
        var nextStyle = next.getAttribute("style") || "";
        if (current.getAttribute("class") !== nextClass) current.setAttribute("class", nextClass);
        if (current.getAttribute("style") !== nextStyle) current.setAttribute("style", nextStyle);
        if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
        delete existing[item.id];
      } else {
        current = next;
      }
      // Keep an existing element in place whenever the order is unchanged.
      // insertBefore is only used for a genuinely new/reordered node; it does
      // not detach unrelated nodes on every render.
      if (current !== cursor) nodeLayer.insertBefore(current, cursor);
      cursor = current.nextElementSibling;
    });
    Object.keys(existing).forEach(function (id) { existing[id].remove(); });
    bindNodeMouseEvents();
  }

  function syncNodeSelection() {
    nodeLayer.querySelectorAll(".agent-node").forEach(function (element) {
      element.classList.toggle("is-selected", element.dataset.node === selected);
      element.classList.toggle("is-connection-source", element.dataset.node === linking);
    });
  }

  function setSelectorHover(id, active) {
    if (active) hoveredSelectorId = id;
    else if (hoveredSelectorId === id) hoveredSelectorId = null;
    if (active) hoveredControlGroup = id;
    else if (hoveredControlGroup === id) hoveredControlGroup = null;
    nodeLayer.querySelectorAll(".agent-node.is-selector").forEach(function (element) {
      element.classList.toggle("is-selector-revealed", element.dataset.node === hoveredSelectorId || element.dataset.node === selected);
    });
    updateMainControlVisibility();
    drawEdges();
  }

  function renderCanvasMeta() {
    document.getElementById("canvas-empty").hidden = Boolean(workflow.nodes.length);
    var flowEdges = businessWorkflowEdges().filter(function (edge) { return edge.source !== "input" && !isTerminationWorkflowEdge(edge); });
    var terminationEdge = workflow.edges.find(function (edge) {
      return isTerminationWorkflowEdge(edge) && (!demoRun.active || demoRun.removedEdgeIds.indexOf(edge.id) < 0);
    });
    var strong = flowEdges.filter(function (edge) { return edge.kind === "strong"; }).length;
    var current = getNode(RUNTIME_MODE ? demoRun.currentAgentId : selected);
    var currentConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
    var inputEdge = workflow.edges.find(function (edge) { return edge.source === "input"; });
    var inputNode = inputEdge && getNode(inputEdge.target);
    var terminalNode = RUNTIME_MODE ? getNode(workflow.terminationAgentId) : terminationEdge && getNode(terminationEdge.source);
    var inputLabel = inputNode ? inputNode.name : "未连接";
    var terminationLabel = terminalNode ? terminalNode.name : "未连接";
    if (RUNTIME_MODE && runtimeScopeId) {
      var parallelInputs = workflow.edges.filter(function (edge) { return edge.source === "input"; }).length;
      if (parallelInputs > 1) inputLabel = parallelInputs + " 条并行入口";
      terminationLabel = terminationEdge ? "结束协作组" : "未连接";
    }
    var regularSelectorCount = workflow.nodes.filter(function (item) { return item.type === "selector" && !isSystemSelectorNode(item); }).length;
    var mainSelectorCount = workflow.nodes.filter(isSystemSelectorNode).length;
    var endSelectorCount = workflow.nodes.filter(isEndNode).length;
    document.getElementById("flow-summary").innerHTML = DIRECT_EDGE_MODE
      ? "<strong>" + ordinaryAgentNodes().length + "</strong> 个 Agent &nbsp;·&nbsp; <strong>" + strong + "</strong> 条强边 &nbsp;·&nbsp; <strong>" + flowEdges.filter(function (edge) { return edge.kind === "weak"; }).length + "</strong> 条弱边 &nbsp;·&nbsp; 输入：" + html(inputLabel) + " &nbsp;·&nbsp; 结束：" + html(terminationLabel) + (current ? " &nbsp;·&nbsp; 当前：" + html(current.name) : currentConnection ? " &nbsp;·&nbsp; 当前：" + edgeLabel(isTerminationWorkflowEdge(currentConnection) ? "termination" : currentConnection.kind) : "")
      : "<strong>" + agentNodes().length + "</strong> 个 Agent &nbsp;·&nbsp; 普通选择器 <strong>" + regularSelectorCount + "</strong> &nbsp;·&nbsp; Main 常驻 <strong>" + mainSelectorCount + "</strong> &nbsp;·&nbsp; 结束选择器 <strong>" + endSelectorCount + "</strong> &nbsp;·&nbsp; " + strong + " 条直接路径 &nbsp;·&nbsp; " + flowEdges.filter(function (edge) { return isChoiceOutputEdge(edge); }).length + " 条候选路径 &nbsp;·&nbsp; 输入：" + html(inputNode ? inputNode.name : "未连接") + " &nbsp;·&nbsp; 结束：" + html(terminalNode ? terminalNode.name : "Main Agent") + (terminationEdge ? "（Main 判断）" : "") + (current ? " &nbsp;·&nbsp; 当前：" + html(current.name) : currentConnection ? " &nbsp;·&nbsp; 当前：" + edgeLabel(isTerminationWorkflowEdge(currentConnection) ? "termination" : currentConnection.kind) : "");
    canvas.classList.toggle("is-connecting", Boolean(linking));
    connectButton.classList.toggle("is-connecting", Boolean(linking));
    syncAnchorModeControls();
    syncDirectEdgeControls();
    clearCanvasButton.disabled = DIRECT_EDGE_MODE
      ? ordinaryAgentNodes().length === 0 && businessWorkflowEdges().length === 0
      : !workflow.nodes.some(function (item) { return item.type !== "input" && !isEndNode(item) && !isSystemSelectorNode(item); }) && !workflow.edges.length;
    var linkingNode = linking && getNode(linking);
    connectStatus.textContent = linking ? "从 " + (linkingNode ? linkingNode.name : "节点") + " 连接到… · " + (DIRECT_EDGE_MODE ? edgeLabel(preferredEdgeKind(linking)) : isSelectorNode(linkingNode) ? "候选" : "强边") : "";
  }

  function render() {
    if (!RUNTIME_MODE) {
    enforceFixedAnchors();
    syncMainDispatchEdges();
    syncRouteSettings();
    syncTerminationEdge();
    syncEndNodePosition(false);
    }
    if (selectedEdge && !workflow.edges.some(function (edge) { return edge.id === selectedEdge; })) selectedEdge = null;
    if (!linkDrag) hidePendingEdge();
    nameField.value = workflow.name || "未命名工作流";
    renderNodeLayer();
    if (!RUNTIME_MODE) renderInspector();
    renderCanvasMeta();
    if (!RUNTIME_MODE) renderDemoUI();
    applyViewport();
    requestAnimationFrame(function () {
      drawEdges();
      if (linkDrag && linkDrag.lastClientX != null && linkDrag.lastClientY != null) {
        drawPendingEdge(linkDrag.lastClientX, linkDrag.lastClientY);
      }
    });
  }

  function demoCreateWorkflow() {
    var flow = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      edgeModel: "direct",
      viewLayout: "free",
      name: "动态编排 · 科研协作",
      mainAgentId: "main",
      inputTarget: "main",
      terminationAgentId: "main",
      terminationCondition: "Review Agent 通过质量复核后，结果满足科研交付条件。",
      nodes: [
        makeNode("input", "input", "用户输入", "输入锚点", "input", "blue", 24, 250, "用户提交的任务、约束和已有资料。"),
        makeNode("main", "main", "Main Agent", "主调度", "gpt-5.6-sol", "green", 240, 250, "理解目标，动态创建并调整执行路径。"),
        makeEndNode(456, 250)
      ],
      edges: [
        { id: "input-edge", source: "input", target: "main", kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true },
        makeTerminationEdge("main", { id: "termination-main", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true })
      ]
    };
    return normalizeWorkflow(flow);
  }

  function demoResetRuntimeState(preserveOriginal) {
    var originalWorkflow = preserveOriginal ? demoRun.originalWorkflow : null;
    var originalSelection = preserveOriginal ? demoRun.originalSelection : null;
    var originalSelectedEdge = preserveOriginal ? demoRun.originalSelectedEdge : null;
    var originalViewport = preserveOriginal ? demoRun.originalViewport : null;
    demoRun.active = false;
    demoRun.hasRun = false;
    demoRun.paused = false;
    demoRun.stopped = false;
    demoRun.phase = "idle";
    demoRun.stageMode = false;
    demoRun.stagePaused = false;
    demoRun.stageBoundaryIndex = -1;
    demoRun.startedAt = 0;
    demoRun.elapsed = 0;
    demoRun.currentEventIndex = -1;
    demoRun.workflowVersion = 1;
    demoRun.focusNodeId = null;
    demoRun.currentAgentId = null;
    demoRun.runningAgentIds = [];
    demoRun.completedAgentIds = [];
    demoRun.skippedAgentIds = [];
    demoRun.addedAgentIds = [];
    demoRun.removedAgentIds = [];
    demoRun.addedEdgeIds = [];
    demoRun.removedEdgeIds = [];
    demoRun.updatedEdgeIds = [];
    demoRun.skippedEdgeIds = [];
    demoRun.activeEdgeIds = [];
    demoRun.edgeData = {};
    demoRun.nodeStates = {};
    demoRun.nodeResults = {};
    demoRun.nodeMoves = [];
    demoRun.movingAgentIds = [];
    demoRun.floatingUpdate = null;
    demoRun.dispatchNote = "";
    demoRun.detail = "";
    demoRun.log = [];
    demoRun.logExpanded = false;
    demoRun.pendingRemovals = [];
    demoRun.pendingEdgeRemovals = [];
    demoRun.originalWorkflow = originalWorkflow;
    demoRun.originalSelection = originalSelection;
    demoRun.originalSelectedEdge = originalSelectedEdge;
    demoRun.originalViewport = originalViewport;
  }

  function demoLog(message, type, at) {
    demoRun.log.push({ message: message, type: type || "event", at: at == null ? demoRun.elapsed : at });
    if (demoRun.log.length > 80) demoRun.log.shift();
  }

  function demoEventAgentName(id) {
    var item = id && getNode(id);
    return item ? item.name : id || "Agent";
  }

  function demoSetNodeState(id, status) {
    if (!id) return;
    demoRun.nodeStates[id] = status;
    if (status === "running") {
      if (demoRun.runningAgentIds.indexOf(id) < 0) demoRun.runningAgentIds.push(id);
      demoRun.completedAgentIds = demoRun.completedAgentIds.filter(function (entry) { return entry !== id; });
      demoRun.skippedAgentIds = demoRun.skippedAgentIds.filter(function (entry) { return entry !== id; });
    } else {
      demoRun.runningAgentIds = demoRun.runningAgentIds.filter(function (entry) { return entry !== id; });
      if (status === "completed" && demoRun.completedAgentIds.indexOf(id) < 0) demoRun.completedAgentIds.push(id);
      if (status === "skipped" && demoRun.skippedAgentIds.indexOf(id) < 0) demoRun.skippedAgentIds.push(id);
    }
  }

  function demoRefreshActiveEdges() {
    demoRun.activeEdgeIds = Object.keys(demoRun.edgeData).filter(function (edgeId) {
      return workflow.edges.some(function (edge) { return edge.id === edgeId; });
    });
  }

  function demoAddFlow(edgeIds, name, direction) {
    (edgeIds || []).forEach(function (edgeId) {
      if (!workflow.edges.some(function (edge) { return edge.id === edgeId; })) return;
      demoRun.edgeData[edgeId] = { name: name || "context", direction: direction || "outgoing" };
    });
    demoRefreshActiveEdges();
  }

  function demoRemoveFlow(edgeIds) {
    (edgeIds || []).forEach(function (edgeId) { delete demoRun.edgeData[edgeId]; });
    demoRefreshActiveEdges();
  }

  function demoClearFlows() {
    demoRun.edgeData = {};
    demoRun.activeEdgeIds = [];
  }

  function demoIncomingEdges(agentId) {
    var incoming = workflow.edges.filter(function (edge) {
      return edge.target === agentId && !isTerminationWorkflowEdge(edge) && demoRun.skippedEdgeIds.indexOf(edge.id) < 0;
    });
    var business = incoming.filter(function (edge) { return !isMainDispatchEdge(edge); });
    return business.length ? business : incoming;
  }

  function demoDispatchEdges(sourceId, targetIds) {
    var targets = targetIds || [];
    return workflow.edges.filter(function (edge) {
      return edge.source === sourceId && targets.indexOf(edge.target) >= 0 && demoRun.skippedEdgeIds.indexOf(edge.id) < 0;
    });
  }

  function demoSetNodeResult(id, text, tone) {
    if (!id) return;
    if (!text) {
      delete demoRun.nodeResults[id];
      return;
    }
    demoRun.nodeResults[id] = { text: text, tone: tone || "neutral" };
  }

  function demoStartAgent(id, message, dataName) {
    var item = getNode(id);
    if (!item) return;
    if (id !== "main") demoSetNodeState("main", "completed");
    demoSetNodeResult(id, "");
    var incoming = demoIncomingEdges(id);
    demoSetNodeState(id, "running");
    demoAddFlow(incoming.map(function (edge) { return edge.id; }), dataName || "task_context", "incoming");
    demoRun.focusNodeId = id;
    demoRun.currentAgentId = id;
    demoRun.dispatchNote = "";
    demoRun.detail = message || (item.name + " 正在执行");
    selected = id;
    selectedEdge = null;
  }

  function demoCompleteAgent(event) {
    var item = getNode(event.agentId);
    if (!item) return;
    var incoming = demoIncomingEdges(item.id);
    demoRemoveFlow(incoming.map(function (edge) { return edge.id; }));
    demoSetNodeState(item.id, event.status || "completed");
    demoSetNodeResult(item.id, event.result, event.resultTone);
    var outgoing = demoDispatchEdges(item.id, event.dispatchTo || []);
    demoAddFlow(outgoing.map(function (edge) { return edge.id; }), event.data || (item.id + "_result"), "outgoing");
    demoRun.focusNodeId = item.id;
    demoRun.currentAgentId = item.id;
    demoRun.dispatchNote = outgoing.length ? "dispatch · " + outgoing.map(function (edge) { return demoEventAgentName(edge.target); }).join("、") : "";
    demoRun.detail = event.message || (item.name + " 已完成");
    selected = item.id;
    selectedEdge = null;
  }

  function demoBeginUpdate(event) {
    var item = event.agentId && getNode(event.agentId);
    var kind = event.kind || (event.type === "main:prompt" ? "prompt" : event.type === "main:skill" ? "skill" : event.type === "main:tool" ? "tool" : "mcp");
    var icon = { prompt: "P", skill: "S", tool: "T", mcp: "M" }[kind];
    demoRun.phase = "main-adjusting";
    demoRun.focusNodeId = event.agentId || "main";
    demoRun.currentAgentId = "main";
    demoSetNodeState("main", "updating");
    var previousStatus = item ? (demoRun.nodeStates[item.id] || "pending") : "pending";
    if (item) demoSetNodeState(item.id, "updating");
    demoRun.floatingUpdate = {
      kind: kind,
      icon: icon,
      title: event.message,
      status: "修改中",
      agentId: event.agentId,
      agentName: item ? item.name : "Workflow",
      content: kind === "prompt" ? "" : event.resource,
      fullContent: event.resource || "准备应用运行配置",
      reason: "Main 根据最新执行结果调整运行配置",
      startedAt: demoRun.elapsed,
      duration: Number(event.duration) || (kind === "prompt" ? 1180 : 720),
      expiresAt: Number(event.duration) || (kind === "prompt" ? 1180 : 720),
      event: event,
      applied: false,
      previousStatus: previousStatus
    };
    demoRun.detail = event.message;
    demoRun.dispatchNote = "";
    selected = event.agentId || "main";
  }

  function demoApplyUpdate(update) {
    if (!update || update.applied) return;
    var event = update.event;
    var item = event.agentId && getNode(event.agentId);
    if (item) {
      if (update.kind === "prompt") item.instructions = event.resource || item.instructions;
      if (update.kind === "skill") {
        item.skills = normalizeStringList(item.skills);
        var skillId = event.resourceId || event.resource || "demo:literature-cross-check";
        if (item.skills.indexOf(skillId) < 0) item.skills.push(skillId);
      }
      if (update.kind === "tool") {
        item.tools = Array.isArray(item.tools) ? item.tools.slice() : [];
        if (item.tools.indexOf(event.resource || "arxiv_search") < 0) item.tools.push(event.resource || "arxiv_search");
      }
      if (update.kind === "mcp") {
        item.mcpServers = normalizeMcpServers((item.mcpServers || []).concat([{ name: event.resource || "datasets", url: "https://demo.local/mcp/datasets" }]));
      }
      demoSetNodeState(item.id, update.previousStatus === "added" ? "pending" : (event.afterStatus || update.previousStatus || "pending"));
    }
    demoSetNodeState("main", "completed");
    demoRun.phase = "running";
    demoRun.workflowVersion += 1;
    update.applied = true;
    update.status = "已应用";
    update.content = update.fullContent;
    update.expiresAt = Math.min(update.expiresAt, (demoRun.elapsed - update.startedAt) + 520);
    render();
  }

  function demoTopologyCard(kind, icon, message, agentId, agentName, content, reason, duration) {
    demoRun.phase = "main-adjusting";
    demoRun.currentAgentId = "main";
    demoSetNodeState("main", "updating");
    demoRun.floatingUpdate = {
      kind: kind,
      icon: icon,
      title: message,
      status: "调整中",
      agentId: agentId,
      agentName: agentName,
      content: content,
      fullContent: content,
      reason: reason,
      startedAt: demoRun.elapsed,
      duration: duration || 820,
      expiresAt: (duration || 820) + 560,
      applied: true
    };
    demoRun.detail = message;
    demoRun.dispatchNote = "";
  }

  function demoObserveResults(event) {
    demoClearFlows();
    demoRun.phase = "main-adjusting";
    demoRun.focusNodeId = "main";
    demoRun.currentAgentId = "main";
    demoSetNodeState("main", "updating");
    demoRun.detail = event.message || "Main 正在读取当前运行结果";
    demoRun.dispatchNote = "";
    demoTopologyCard("observe", "!", event.message || "Main 正在读取当前运行结果", "main", "Main Agent", event.content || "当前结果需要重新评估", event.reason || "Main 根据已完成 Agent 的结果判断下一步", event.duration || 900);
    if (demoRun.floatingUpdate) demoRun.floatingUpdate.status = "已识别";
    selected = "main";
  }

  function demoBeginEdgeRemoval(event) {
    var ids = event.edgeIds || (event.edgeId ? [event.edgeId] : []);
    var existing = ids.filter(function (id) {
      return workflow.edges.some(function (edge) { return edge.id === id; });
    });
    if (!existing.length) return;
    var delay = Number(event.duration) || 720;
    existing.forEach(function (id) { demoQueueEdgeRemoval(id, delay * 0.82); });
    demoRun.focusNodeId = "main";
    demoRun.workflowVersion += 1;
    demoTopologyCard("remove", "-", event.message || "Main 正在移除连接", "main", "Workflow connection", event.content || existing.join(" + "), event.reason || "Main 根据运行结果收回旧路径", delay);
    selected = "main";
  }

  function demoBeginNodeMoves(event) {
    var duration = Number(event.duration) || 900;
    var moves = (event.moves || []).map(function (move) {
      var item = getNode(move.agentId);
      var target = move.position || {};
      if (!item || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return null;
      return {
        agentId: item.id,
        fromX: Number(item.x),
        fromY: Number(item.y),
        toX: Number(target.x),
        toY: Number(target.y),
        startedAt: demoRun.elapsed,
        duration: duration
      };
    }).filter(Boolean);
    if (!moves.length) return;
    demoRun.nodeMoves = demoRun.nodeMoves.filter(function (record) {
      return moves.every(function (move) { return move.agentId !== record.agentId; });
    }).concat(moves);
    moves.forEach(function (move) {
      if (demoRun.movingAgentIds.indexOf(move.agentId) < 0) demoRun.movingAgentIds.push(move.agentId);
    });
    demoRun.focusNodeId = "main";
    demoRun.workflowVersion += 1;
    demoTopologyCard("layout", "<> ", event.message || "Main 正在重排 Workflow", "main", "Workflow canvas", event.content || moves.map(function (move) { return demoEventAgentName(move.agentId); }).join("、"), event.reason || "Main 正在为新的执行路径重排画布", duration);
    selected = "main";
  }

  function demoAdvanceNodeMoves() {
    var changed = false;
    var moving = {};
    demoRun.nodeMoves = demoRun.nodeMoves.filter(function (record) {
      var item = getNode(record.agentId);
      if (!item) return false;
      var progress = Math.max(0, Math.min(1, (demoRun.elapsed - record.startedAt) / Math.max(1, record.duration)));
      var eased = 1 - Math.pow(1 - progress, 3);
      var x = record.fromX + (record.toX - record.fromX) * eased;
      var y = record.fromY + (record.toY - record.fromY) * eased;
      if (Math.abs(Number(item.x) - x) > 0.01 || Math.abs(Number(item.y) - y) > 0.01) {
        item.x = Math.round(x * 100) / 100;
        item.y = Math.round(y * 100) / 100;
        changed = true;
      }
      if (progress < 1) {
        moving[record.agentId] = true;
        return true;
      }
      item.x = record.toX;
      item.y = record.toY;
      changed = true;
      return false;
    });
    demoRun.movingAgentIds = Object.keys(moving);
    if (changed) {
      // Existing node and edge DOM remain in place; only their coordinates
      // and paths change during the Main-directed layout transaction.
      renderNodeLayer();
      drawEdges();
    }
  }

  function demoCreateAgent(event) {
    var id = event.agentId;
    if (!id || getNode(id)) return getNode(id);
    var position = event.position || { x: 600, y: 250 };
    var item = makeNode(id, event.nodeType || id, event.name || ({
      planner: "Planner Agent",
      research: "Research Agent",
      analysis: "Analysis Agent",
      experiment: "Experiment Agent",
      "source-check": "Source Check Agent",
      "data-validation": "Data Validation Agent",
      "evidence-merge": "Evidence Merge Agent",
      writer: "Writing Agent",
      reviewer: "Review Agent"
    }[id] || "Agent"), event.role || "", event.model || (id === "analysis" ? "gpt-5.6-terra" : "gpt-5.6-sol"), event.color || ({ planner: "green", analysis: "amber", experiment: "teal", "source-check": "teal", "data-validation": "blue", "evidence-merge": "green", writer: "violet", reviewer: "rose" }[id] || "blue"), position.x, position.y, event.description || "由 Main 动态创建的执行 Agent。");
    item.instructions = event.instructions || item.instructions;
    if (event.skills) item.skills = normalizeStringList(event.skills);
    if (event.tools) item.tools = normalizeStringList(event.tools);
    if (event.mcpServers) item.mcpServers = normalizeMcpServers(event.mcpServers);
    workflow.nodes.push(item);
    if (demoRun.addedAgentIds.indexOf(item.id) < 0) demoRun.addedAgentIds.push(item.id);
    demoSetNodeState(item.id, "added");
    demoRun.focusNodeId = item.id;
    demoRun.workflowVersion += 1;
    if (!event.silent) {
      demoTopologyCard("agent", "+", event.message || ("Main 正在新增 " + item.name), item.id, item.name, event.content || item.description, event.reason || "Main 根据当前结果扩展执行路径", event.duration || 820);
      selected = item.id;
    }
    return item;
  }

  function demoQueueEdgeRemoval(edgeId, delay) {
    if (!edgeId) return;
    if (demoRun.removedEdgeIds.indexOf(edgeId) < 0) demoRun.removedEdgeIds.push(edgeId);
    demoRemoveFlow([edgeId]);
    if (demoRun.pendingEdgeRemovals.every(function (item) { return item.id !== edgeId; })) {
      demoRun.pendingEdgeRemovals.push({ id: edgeId, at: demoRun.elapsed + (delay || 780) });
    }
  }

  function demoCreateEdge(event) {
    if (!event.source || !event.target) return;
    var edge = workflow.edges.find(function (entry) { return entry.source === event.source && entry.target === event.target && !isTerminationWorkflowEdge(entry); });
    if (!edge) {
      edge = {
        id: event.edgeId || uid("demo-edge"),
        source: event.source,
        target: event.target,
        kind: event.kind || "strong",
        sourcePort: event.sourcePort || (event.source === "main" ? "right" : "right"),
        targetPort: event.targetPort || "left",
        sourcePortPinned: true,
        targetPortPinned: true
      };
      workflow.edges.push(edge);
    } else if (event.kind) {
      edge.kind = event.kind;
    }
    if (demoRun.addedEdgeIds.indexOf(edge.id) < 0) demoRun.addedEdgeIds.push(edge.id);
    if (event.data) demoAddFlow([edge.id], event.data, "outgoing");
    var target = getNode(event.target);
    if (target && demoRun.nodeStates[target.id] === "added") demoSetNodeState(target.id, "pending");
    demoRun.focusNodeId = event.target;
    demoRun.workflowVersion += 1;
    if (!event.silent) {
      demoTopologyCard("edge", "->", event.message || "Main 正在建立数据流", event.target, (getNode(event.source) ? getNode(event.source).name : event.source) + " -> " + (target ? target.name : event.target), event.content || event.data || "context", event.reason || "Main 根据执行结果调整连接", event.duration || 820);
      selected = event.target;
    }
    return edge;
  }

  function demoBuildParallelStage(event) {
    [
      { agentId: "analysis", name: "Analysis Agent", nodeType: "analysis", model: "gpt-5.6-terra", color: "amber", description: "分析研究结果并形成证据结论。", position: { x: 672, y: 60 } },
      { agentId: "experiment", name: "Experiment Agent", nodeType: "experiment", model: "gpt-5.6-sol", color: "teal", description: "验证数据、基线、指标和消融方案。", position: { x: 672, y: 250 } },
      { agentId: "source-check", name: "Source Check Agent", nodeType: "custom", model: "gpt-5.6-sol", color: "teal", description: "交叉验证来源、引用和证据链。", position: { x: 672, y: 440 } },
      { agentId: "evidence-merge", name: "Evidence Merge Agent", nodeType: "custom", model: "gpt-5.6-sol", color: "green", description: "汇聚并去重多路研究证据。", position: { x: 888, y: 250 } }
    ].forEach(function (spec) {
      spec.silent = true;
      demoCreateAgent(spec);
    });
    [
      { edgeId: "research-analysis", source: "research", target: "analysis", kind: "weak", data: "research_evidence" },
      { edgeId: "research-experiment", source: "research", target: "experiment", kind: "weak", data: "research_evidence" },
      { edgeId: "research-source-check", source: "research", target: "source-check", kind: "weak", data: "research_evidence" },
      { edgeId: "analysis-merge", source: "analysis", target: "evidence-merge", kind: "weak", data: "analysis_result" },
      { edgeId: "experiment-merge", source: "experiment", target: "evidence-merge", kind: "weak", data: "experiment_plan" },
      { edgeId: "source-check-merge", source: "source-check", target: "evidence-merge", kind: "weak", data: "verified_sources" }
    ].forEach(function (edge) {
      edge.silent = true;
      demoCreateEdge(edge);
    });
    demoRun.focusNodeId = "evidence-merge";
    demoRun.workflowVersion += 1;
    demoTopologyCard("agent", "+", event.message || "Main 正在搭建并行验证与证据汇聚", "evidence-merge", "并行验证框架", "Analysis / Experiment / Source Check -> Evidence Merge", event.reason || "需要同时验证、核验并合并证据", event.duration || 900);
    selected = "main";
  }

  function demoBeginAgentRemoval(event) {
    var item = getNode(event.agentId);
    if (!item) return;
    var related = workflow.edges.filter(function (edge) { return edge.source === item.id || edge.target === item.id; });
    var delay = event.duration || (demoRun.scenarioId === "full" ? 1250 : 760);
    demoSetNodeState(item.id, "removed");
    if (demoRun.removedAgentIds.indexOf(item.id) < 0) demoRun.removedAgentIds.push(item.id);
    related.forEach(function (edge) { demoQueueEdgeRemoval(edge.id, delay * 0.82); });
    demoRun.pendingRemovals.push({ id: item.id, at: demoRun.elapsed + delay });
    demoRun.focusNodeId = item.id;
    demoRun.workflowVersion += 1;
    demoTopologyCard("remove", "-", event.message || ("Main 正在移除 " + item.name), item.id, item.name, event.content || "移除该 Agent 及其相关连接", event.reason || "Main 判断该候选结果不再值得继续保留", delay);
    selected = item.id;
  }

  function demoReplaceTermination(event) {
    var previous = workflow.edges.find(function (edge) { return isTerminationWorkflowEdge(edge) && demoRun.removedEdgeIds.indexOf(edge.id) < 0; });
    var delay = Number(event.duration) || (demoRun.scenarioId === "full" ? 1200 : 720);
    if (previous) demoQueueEdgeRemoval(previous.id, delay * 0.82);
    if (event.agentId) {
      var next = makeTerminationEdge(event.agentId, { id: "termination-" + event.agentId, sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true });
      workflow.edges.unshift(next);
      if (demoRun.addedEdgeIds.indexOf(next.id) < 0) demoRun.addedEdgeIds.push(next.id);
      demoRun.edgeData[next.id] = { name: "approved_delivery", direction: "outgoing" };
      workflow.terminationAgentId = event.agentId;
    } else {
      workflow.terminationAgentId = null;
    }
    demoRun.activeEdgeIds = Object.keys(demoRun.edgeData);
    demoRun.focusNodeId = event.agentId || "main";
    demoRun.workflowVersion += 1;
    demoTopologyCard("edge", event.agentId ? "->" : "-", event.message || "Main 正在切换结束入口", event.agentId || "main", event.agentId ? demoEventAgentName(event.agentId) + " -> 结束" : "Main -> 结束", event.agentId ? "approved_delivery" : "direct_finish", event.reason || "Main 重新确定最终交付路径", delay);
    selected = event.agentId || "main";
  }

  function demoStrengthenEdges(event) {
    var ids = event.edgeIds || [];
    ids.forEach(function (id) {
      var edge = workflow.edges.find(function (entry) { return entry.id === id; });
      if (!edge) return;
      edge.kind = "strong";
      if (demoRun.updatedEdgeIds.indexOf(id) < 0) demoRun.updatedEdgeIds.push(id);
    });
    demoRun.focusNodeId = "evidence-merge";
    demoRun.workflowVersion += 1;
    demoTopologyCard("edge", "↗", event.message || "Main 正在确认保留证据路径", "evidence-merge", "Evidence Merge Agent", ids.join(" + "), event.reason || "Main 保留更可靠的证据输入", event.duration || 820);
    selected = "evidence-merge";
  }

  function demoFinalizePendingChanges() {
    var changedTopology = false;
    demoRun.pendingRemovals = demoRun.pendingRemovals.filter(function (record) {
      if (record.at > demoRun.elapsed) return true;
      workflow.nodes = workflow.nodes.filter(function (item) { return item.id !== record.id; });
      workflow.edges = workflow.edges.filter(function (edge) { return edge.source !== record.id && edge.target !== record.id; });
      delete demoRun.nodeStates[record.id];
      delete demoRun.nodeResults[record.id];
      demoRun.movingAgentIds = demoRun.movingAgentIds.filter(function (id) { return id !== record.id; });
      demoRun.nodeMoves = demoRun.nodeMoves.filter(function (move) { return move.agentId !== record.id; });
      demoRun.runningAgentIds = demoRun.runningAgentIds.filter(function (id) { return id !== record.id; });
      demoRun.completedAgentIds = demoRun.completedAgentIds.filter(function (id) { return id !== record.id; });
      demoRun.skippedAgentIds = demoRun.skippedAgentIds.filter(function (id) { return id !== record.id; });
      if (selected === record.id) selected = "main";
      if (demoRun.focusNodeId === record.id) demoRun.focusNodeId = "main";
      changedTopology = true;
      return false;
    });
    demoRun.pendingEdgeRemovals = demoRun.pendingEdgeRemovals.filter(function (record) {
      if (record.at > demoRun.elapsed) return true;
      workflow.edges = workflow.edges.filter(function (edge) { return edge.id !== record.id; });
      demoRemoveFlow([record.id]);
      changedTopology = true;
      return false;
    });
    if (changedTopology) render();
  }

  function demoStartParallel(event) {
    demoClearFlows();
    demoRun.phase = "running";
    demoRun.focusNodeId = "main";
    demoRun.currentAgentId = "main";
    demoSetNodeState("main", "completed");
    (event.agentIds || []).forEach(function (id) {
      var data = event.dataByAgent && event.dataByAgent[id] || event.data || "task_context";
      demoStartAgent(id, event.message, data);
    });
    demoRun.detail = (event.message || "Main 正在并行调度 Agent") + " · 等待 " + (event.agentIds || []).length + " 个结果";
    demoRun.dispatchNote = "";
    selected = "main";
  }

  function demoHandleEvent(event) {
    if (!demoRun.active || demoRun.stopped) return;
    demoRun.currentEventIndex += 1;
    if (event.type === "run:start") {
      demoRun.phase = "running";
      demoRun.detail = "正在准备固定演示流程";
    } else if (event.type === "agent:start") {
      demoStartAgent(event.agentId, event.message, event.data);
    } else if (event.type === "agent:complete") {
      demoCompleteAgent(event);
    } else if (event.type === "main:thinking") {
      demoClearFlows();
      demoRun.phase = "main-adjusting";
      demoRun.focusNodeId = "main";
      demoRun.currentAgentId = "main";
      demoSetNodeState("main", "updating");
      demoRun.detail = event.message;
      demoRun.dispatchNote = "";
      selected = "main";
    } else if (event.type === "main:observe-results") {
      demoObserveResults(event);
    } else if (event.type === "main:prompt" || event.type === "main:skill" || event.type === "main:tool" || event.type === "main:mcp" || event.type === "main:update-agent-config") {
      demoBeginUpdate(event);
    } else if (event.type === "main:remove-agent") {
      demoBeginAgentRemoval(event);
    } else if (event.type === "main:remove-edge") {
      demoBeginEdgeRemoval(event);
    } else if (event.type === "main:move-agents") {
      demoBeginNodeMoves(event);
    } else if (event.type === "main:create-agent") {
      demoCreateAgent(event);
    } else if (event.type === "main:create-edge") {
      demoCreateEdge(event);
    } else if (event.type === "main:replace-termination") {
      demoReplaceTermination(event);
    } else if (event.type === "main:build-parallel-stage") {
      demoBuildParallelStage(event);
    } else if (event.type === "main:strengthen-edge") {
      demoStrengthenEdges(event);
    } else if (event.type === "parallel:start") {
      demoStartParallel(event);
    } else if (event.type === "run:complete") {
      demoFinalizePendingChanges();
      demoClearFlows();
      demoSetNodeState("end", "completed");
      workflow.nodes.forEach(function (item) {
        if (!demoRun.nodeStates[item.id] || demoRun.nodeStates[item.id] === "pending" || demoRun.nodeStates[item.id] === "updating" || demoRun.nodeStates[item.id] === "added") demoSetNodeState(item.id, "completed");
      });
      demoRun.phase = "completed";
      demoRun.active = false;
      demoRun.currentAgentId = "end";
      demoRun.focusNodeId = "end";
      demoRun.detail = "最终 Workflow 已应用 Main 的全部调整";
      demoRun.dispatchNote = "";
      demoRun.floatingUpdate = null;
      demoRun.workflowVersion += 1;
      selected = "end";
      if (gifExport.active && gifExport.segment === 2) finishGifSegment();
    }
    demoLog(event.message || event.type, event.type, event.at);
    render();
    // In stage mode, stop after Main has finished constructing v1 and routed
    // the first workflow to Review. The current topology remains visible so
    // the second click can continue from the next event.
    if (demoRun.stageMode && !demoRun.stagePaused && event.type === "main:replace-termination" && event.agentId === "reviewer") {
      // Complete the small visual transition attached to the boundary event
      // so the paused canvas shows a stable v1 topology rather than a
      // half-removed termination edge.
      demoRun.elapsed = Number(event.at) || demoRun.elapsed;
      demoRun.pendingEdgeRemovals.forEach(function (record) { record.at = demoRun.elapsed; });
      demoFinalizePendingChanges();
      demoRun.stagePaused = true;
      demoRun.active = false;
      demoRun.phase = "stage-paused";
      demoRun.stageBoundaryIndex = demoRun.currentEventIndex;
      demoRun.currentAgentId = "main";
      demoRun.focusNodeId = "main";
      demoRun.detail = "第一阶段已完成，Workflow v1 已构建完成；点击“继续第二阶段”开始执行";
      demoRun.dispatchNote = "阶段 1/3 完成 · Workflow v1 已就绪";
      demoRun.floatingUpdate = null;
      demoLog("第一阶段完成，等待继续执行", "stage:pause", demoRun.elapsed);
      render();
      if (gifExport.active && gifExport.phase === "stage-one") {
        finishGifSegment();
      }
    }
    // The desktop Demo uses one stable overview frame so each topology
    // transaction lands in place without a camera jump. Phones still follow
    // the active area, but only at meaningful stage changes.
    if (event.type !== "run:complete" && canvas.clientWidth <= 590 &&
        (event.type === "parallel:start" || event.type === "main:remove-agent" || event.type === "main:replace-termination" || event.type === "main:move-agents")) {
      requestAnimationFrame(fitDemoViewport);
    }
    if (event.type === "run:complete") {
      requestAnimationFrame(function () {
        fitDemoViewport();
        // Restore the Inspector first, then center the final topology in the
        // narrower canvas after its layout transition finishes.
        window.setTimeout(function () {
          if (demoRun.hasRun && demoRun.phase === "completed") fitDemoViewport();
        }, 300);
      });
    }
  }

  function demoTick() {
    if (!demoRun.active || demoRun.paused || demoRun.stopped) return;
    demoRun.elapsed = Date.now() - demoRun.startedAt;
    var events = demoRun.events || [];
    while (demoRun.currentEventIndex + 1 < events.length && events[demoRun.currentEventIndex + 1].at <= demoRun.elapsed) {
      demoHandleEvent(events[demoRun.currentEventIndex + 1]);
      if (!demoRun.active) break;
    }
    var update = demoRun.floatingUpdate;
    if (update) {
      var age = demoRun.elapsed - update.startedAt;
      if (update.kind === "prompt" && !update.applied) {
        var length = Math.min(update.fullContent.length, Math.max(0, Math.floor((age / update.duration) * update.fullContent.length)));
        update.content = update.fullContent.slice(0, length) + (length < update.fullContent.length ? "|" : "");
      }
      if (!update.applied && update.event && age >= update.duration) demoApplyUpdate(update);
      if (update.applied && !update.event && age >= update.duration) update.status = "已应用";
      if (age > update.expiresAt) demoRun.floatingUpdate = null;
    }
    demoFinalizePendingChanges();
    demoAdvanceNodeMoves();
    renderDemoUI();
    gifExportMaybeCapture();
    if (demoRun.active) requestAnimationFrame(demoTick);
  }

  function captureStylesheetText() {
    var styles = [];
    Array.prototype.forEach.call(document.styleSheets || [], function (sheet) {
      try {
        Array.prototype.forEach.call(sheet.cssRules || [], function (rule) { styles.push(rule.cssText); });
      } catch (error) {
        // Cross-origin sheets cannot be read; this demo only ships local CSS.
      }
    });
    return styles.join("\n");
  }

  function captureWholeDemoFrame() {
    var root = document.querySelector(".app-shell");
    if (!root) return Promise.reject(new Error("找不到 Demo 页面"));
    if (typeof window.html2canvas !== "function") return Promise.reject(new Error("GIF 截图引擎未加载，请刷新页面后重试"));
    var rect = root.getBoundingClientRect();
    var sourceWidth = Math.max(1, Math.round(rect.width || window.innerWidth));
    var sourceHeight = Math.max(1, Math.round(rect.height || window.innerHeight));
    var maxWidth = 1100;
    var scale = Math.min(1, maxWidth / sourceWidth);
    return window.html2canvas(root, {
      backgroundColor: "#f4f6f1",
      scale: scale,
      useCORS: false,
      allowTaint: false,
      logging: false,
      removeContainer: true,
      width: sourceWidth,
      height: sourceHeight,
      windowWidth: Math.max(sourceWidth, document.documentElement.clientWidth || window.innerWidth),
      windowHeight: Math.max(sourceHeight, document.documentElement.clientHeight || window.innerHeight),
      scrollX: 0,
      scrollY: 0
    }).then(function (canvasElement) {
      var width = canvasElement.width;
      var height = canvasElement.height;
      var context = canvasElement.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("浏览器不支持 Canvas 2D");
      gifExport.canvas = canvasElement;
      gifExport.width = width;
      gifExport.height = height;
      return context.getImageData(0, 0, width, height);
    }).catch(function (error) {
      throw new Error("页面帧捕获失败：" + (error && error.message ? error.message : "DOM 截图失败"));
    });
  }

  function gifExportMaybeCapture(force) {
    if (!gifExport.active) return Promise.resolve();
    if (gifExport.capturePending) return gifExport.capturePromise || Promise.resolve();
    var elapsed = demoRun.elapsed;
    if (!force && elapsed < gifExport.nextCaptureAt) return Promise.resolve();
    gifExport.capturePending = true;
    gifExport.lastCapturedAt = elapsed;
    gifExport.nextCaptureAt = elapsed + gifExport.frameInterval;
    var capturePromise = captureWholeDemoFrame().then(function (imageData) {
      if (!gifExport.active) return;
      if (!gifExport.encoder) gifExport.encoder = new GifEncoder(gifExport.width, gifExport.height, true);
      gifExport.lastImageData = imageData;
      gifExport.encoder.addFrame(imageData, gifExport.frameInterval);
    }).catch(function (error) {
      if (gifExport.active) {
        gifExport.failed = true;
        stopDemoRun();
        showToast(error.message || "GIF 帧捕获失败");
      }
    }).then(function () {
      gifExport.capturePending = false;
      gifExport.capturePromise = null;
    });
    gifExport.capturePromise = capturePromise;
    return capturePromise;
  }

  function downloadGifSegment(segment) {
    if (!gifExport.encoder) throw new Error("没有可导出的 GIF 帧");
    var blob = gifExport.encoder.blob();
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = (workflow.name || "scienceevolve-agent-flow") + (segment === 1 ? "-stage-1-workflow-build.gif" : "-stage-2-execute-adjust.gif");
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  function resetGifSegment(segment) {
    gifExport.segment = segment;
    gifExport.phase = segment === 1 ? "stage-one" : "stage-two";
    gifExport.encoder = null;
    gifExport.canvas = null;
    gifExport.width = 0;
    gifExport.height = 0;
    gifExport.nextCaptureAt = 0;
    gifExport.lastCapturedAt = -1;
    gifExport.capturePending = false;
    gifExport.capturePromise = null;
    gifExport.lastImageData = null;
    gifExport.finalizing = false;
  }

  function finishGifSegment() {
    if (!gifExport.active || gifExport.finalizing) return;
    gifExport.finalizing = true;
    gifExportMaybeCapture(true).then(function () {
      if (gifExport.encoder && gifExport.lastImageData) {
        for (var holdFrame = 0; holdFrame < 5; holdFrame += 1) gifExport.encoder.addFrame(gifExport.lastImageData, gifExport.frameInterval);
      }
      downloadGifSegment(gifExport.segment);
      if (gifExport.segment === 1) {
        gifExport.segmentReady = true;
        gifExport.finalizing = false;
        gifExport.phase = "stage-paused";
        gifExport.encoder = null;
        gifExport.canvas = null;
        gifExport.capturePending = false;
        gifExport.capturePromise = null;
        gifExport.lastImageData = null;
        gifExport.active = false;
        renderDemoUI();
        showToast("第一段 GIF 已导出，点击“继续第二段 GIF”录制执行和修改");
      } else {
        gifExport.active = false;
        gifExport.phase = "idle";
        gifExport.encoder = null;
        gifExport.finalizing = false;
        gifExport.capturePending = false;
        gifExport.failed = false;
        renderDemoUI();
        showToast("第二段 GIF 已导出");
      }
    }).catch(function (error) {
      gifExport.finalizing = false;
      showToast(error.message || "GIF 导出失败");
    });
  }

  function startGifExport() {
    if (gifExport.active || demoRun.active) return;
    if (demoRun.stagePaused && demoRun.stageMode && gifExport.segmentReady) {
      gifExport.active = true;
      resetGifSegment(2);
      gifExport.segmentReady = false;
      showToast("正在录制第二段 GIF：执行和修改 Workflow");
      startStagedDemoRun();
      return;
    }
    if (demoRun.stagePaused) return;
    gifExport.active = true;
    gifExport.segmentReady = false;
    resetGifSegment(1);
    showToast("正在录制第一段 GIF：编排 Workflow");
    startStagedDemoRun();
  }

  function startDemoRun() {
    if (demoRun.active) return;
    var scenario = DEMO_SCENARIOS[selectedDemoScenarioId] || DEMO_SCENARIOS.quick;
    var restartingCompletedDemo = demoRun.phase === "completed" && demoRun.originalWorkflow;
    var originalWorkflow = restartingCompletedDemo ? clone(demoRun.originalWorkflow) : clone(workflow);
    var originalSelection = restartingCompletedDemo ? demoRun.originalSelection : selected;
    var originalSelectedEdge = restartingCompletedDemo ? demoRun.originalSelectedEdge : selectedEdge;
    var originalViewport = restartingCompletedDemo ? clone(demoRun.originalViewport || viewport) : clone(viewport);
    demoResetRuntimeState(false);
    demoRun.originalWorkflow = originalWorkflow;
    demoRun.originalSelection = originalSelection;
    demoRun.originalSelectedEdge = originalSelectedEdge;
    demoRun.originalViewport = originalViewport;
    workflow = demoCreateWorkflow();
    demoRun.active = true;
    demoRun.hasRun = true;
    demoRun.scenarioId = scenario.id;
    demoRun.scenarioLabel = scenario.label;
    demoRun.scenarioDuration = scenario.duration;
    demoRun.events = scenario.events;
    demoRun.startedAt = Date.now();
    demoRun.phase = "running";
    workflow.nodes.forEach(function (item) { demoRun.nodeStates[item.id] = "pending"; });
    selected = "main";
    selectedEdge = null;
    clearUndo();
    cancelConnection();
    if (dialog.open) dialog.close();
    if (flowDialog.open) flowDialog.close();
    demoLog(scenario.label + "已启动，Workflow 编辑已锁定", "run:start", 0);
    render();
    requestAnimationFrame(function () {
      fitDemoOverview();
      requestAnimationFrame(demoTick);
      // The Inspector takes 260ms to collapse, which increases the canvas
      // width after the first paint. Refit once that layout transition ends.
      window.setTimeout(function () {
        if (demoRun.active) fitDemoOverview();
      }, 300);
    });
  }

  function startStagedDemoRun() {
    if (demoRun.active) return;
    // A staged run paused at the v1 boundary resumes with the exact runtime
    // state and event index already rendered on the canvas.
    if (demoRun.stagePaused && demoRun.stageMode) {
      demoRun.stagePaused = false;
      demoRun.active = true;
      demoRun.phase = "running";
      demoRun.startedAt = Date.now() - demoRun.elapsed;
      demoRun.detail = "继续执行第二阶段和第三阶段";
      demoRun.dispatchNote = "阶段 2/3 · 执行 v1 并由 Main 调整为 v2";
      demoLog("继续执行第二阶段和第三阶段", "stage:resume", demoRun.elapsed);
      render();
      requestAnimationFrame(demoTick);
      return;
    }
    var scenario = DEMO_SCENARIOS[selectedDemoScenarioId] || DEMO_SCENARIOS.quick;
    var restartingCompletedDemo = demoRun.phase === "completed" && demoRun.originalWorkflow;
    var originalWorkflow = restartingCompletedDemo ? clone(demoRun.originalWorkflow) : clone(workflow);
    var originalSelection = restartingCompletedDemo ? demoRun.originalSelection : selected;
    var originalSelectedEdge = restartingCompletedDemo ? demoRun.originalSelectedEdge : selectedEdge;
    var originalViewport = restartingCompletedDemo ? clone(demoRun.originalViewport || viewport) : clone(viewport);
    demoResetRuntimeState(false);
    demoRun.stageMode = true;
    demoRun.originalWorkflow = originalWorkflow;
    demoRun.originalSelection = originalSelection;
    demoRun.originalSelectedEdge = originalSelectedEdge;
    demoRun.originalViewport = originalViewport;
    workflow = demoCreateWorkflow();
    demoRun.active = true;
    demoRun.hasRun = true;
    demoRun.scenarioId = scenario.id;
    demoRun.scenarioLabel = scenario.label + " · 分阶段";
    demoRun.scenarioDuration = scenario.duration;
    demoRun.events = scenario.events;
    demoRun.startedAt = Date.now();
    demoRun.phase = "running";
    workflow.nodes.forEach(function (item) { demoRun.nodeStates[item.id] = "pending"; });
    selected = "main";
    selectedEdge = null;
    clearUndo();
    cancelConnection();
    if (dialog.open) dialog.close();
    if (flowDialog.open) flowDialog.close();
    demoLog(scenario.label + "分阶段 Demo 已启动，先构建第一阶段 Workflow", "run:start", 0);
    render();
    requestAnimationFrame(function () {
      fitDemoOverview();
      requestAnimationFrame(demoTick);
      window.setTimeout(function () {
        if (demoRun.active) fitDemoOverview();
      }, 300);
    });
  }

  function stopDemoRun() {
    if (!demoRun.active && !demoRun.stagePaused) return;
    if (gifExport.boundaryTimer) window.clearTimeout(gifExport.boundaryTimer);
    gifExport.active = false;
    gifExport.phase = "idle";
    gifExport.encoder = null;
    gifExport.capturePending = false;
    gifExport.capturePromise = null;
    gifExport.lastImageData = null;
    gifExport.segmentReady = false;
    var originalWorkflow = demoRun.originalWorkflow && clone(demoRun.originalWorkflow);
    var originalSelection = demoRun.originalSelection;
    var originalSelectedEdge = demoRun.originalSelectedEdge;
    var originalViewport = demoRun.originalViewport && clone(demoRun.originalViewport);
    demoResetRuntimeState(false);
    if (originalWorkflow) workflow = normalizeWorkflow(originalWorkflow);
    selected = originalSelection || null;
    selectedEdge = originalSelectedEdge || null;
    if (originalViewport) viewport = originalViewport;
    cancelConnection();
    render();
    showToast("Demo 已停止，已恢复运行前的 Workflow");
  }

  function toggleDemoPause() {
    if (!demoRun.active) return;
    if (!demoRun.paused) {
      demoRun.elapsed = Date.now() - demoRun.startedAt;
      demoRun.paused = true;
      demoRun.detail = "Demo 已暂停，可继续观察当前运行态";
      demoLog("Demo 已暂停", "run:pause", demoRun.elapsed);
    } else {
      demoRun.startedAt = Date.now() - demoRun.elapsed;
      demoRun.paused = false;
      demoRun.detail = "继续播放固定演示流程";
      demoLog("Demo 已继续", "run:resume", demoRun.elapsed);
      requestAnimationFrame(demoTick);
    }
    renderDemoUI();
  }

  function selectDemoScenario(id) {
    if (isDemoLocked()) {
      showToast("Demo 执行中不能切换时长");
      return;
    }
    if (!DEMO_SCENARIOS[id]) return;
    selectedDemoScenarioId = id;
    var scenario = DEMO_SCENARIOS[id];
    demoRun.scenarioId = scenario.id;
    demoRun.scenarioLabel = scenario.label;
    demoRun.scenarioDuration = scenario.duration;
    renderDemoUI();
  }

  function uniqueName(name) {
    var names = workflow.nodes.map(function (item) { return item.name; });
    if (!names.includes(name)) return name;
    var count = 2;
    while (names.includes(name + " " + count)) count += 1;
    return name + " " + count;
  }

  function findOpenAgentPosition() {
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var nodeWidth = 194;
    var nodeHeight = 92;
    var gapX = 30;
    var gapY = 30;
    var clearance = 18;
    var visibleLeft = (20 - viewport.x) / viewport.k;
    var visibleTop = (20 - viewport.y) / viewport.k;
    var visibleRight = (width - 20 - viewport.x) / viewport.k;
    var visibleBottom = (height - 20 - viewport.y) / viewport.k;
    var minX = Math.max(12, visibleLeft);
    var minY = Math.max(12, visibleTop);
    var maxX = Math.max(minX, visibleRight - nodeWidth);
    var maxY = Math.max(minY, visibleBottom - nodeHeight);
    var occupied = workflow.nodes.map(function (item) {
      var size = nodeDimensions(nodeElement(item.id));
      return {
        left: item.x - clearance,
        top: item.y - clearance,
        right: item.x + size.width + clearance,
        bottom: item.y + size.height + clearance
      };
    });

    function available(x, y) {
      var right = x + nodeWidth;
      var bottom = y + nodeHeight;
      return !occupied.some(function (rect) {
        return right > rect.left && x < rect.right && bottom > rect.top && y < rect.bottom;
      });
    }

    var columns = Math.max(1, Math.floor((maxX - minX + gapX) / (nodeWidth + gapX)) + 1);
    var rows = Math.max(1, Math.floor((maxY - minY + gapY) / (nodeHeight + gapY)) + 1);
    for (var row = 0; row < rows; row += 1) {
      for (var column = 0; column < columns; column += 1) {
        var x = Math.min(maxX, minX + column * (nodeWidth + gapX));
        var y = Math.min(maxY, minY + row * (nodeHeight + gapY));
        if (available(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    }

    var lowest = workflow.nodes.reduce(function (value, item) {
      var size = nodeDimensions(nodeElement(item.id));
      return Math.max(value, item.y + size.height);
    }, minY);
    return { x: Math.round(minX), y: Math.round(lowest + gapY) };
  }

  function addAgent(template) {
    if (!template || template.id === "main" || template.type === "main") {
      showToast("Main Agent 是系统节点，不能作为普通 Agent 添加");
      return;
    }
    var openPosition = findOpenAgentPosition();
    pushUndo("添加 Agent");
    var item = makeNode(uid("agent"), template.type || template.id, uniqueName(template.name), "", template.model, template.color, openPosition.x, openPosition.y, template.description);
    item.skills = normalizeStringList(template.skills);
    item.autoSkills = normalizeStringList(template.autoSkills).filter(function (skill) { return item.skills.indexOf(skill) < 0; });
    item.mcpServers = normalizeMcpServers(template.mcpServers);
    item.permission = normalizePermission(template.permission, item.id === "main" ? "yolo" : "workspace");
    item.sessionPersistence = Boolean(template.sessionPersistence);
    item.decisionBy = template.decisionBy === "agent" ? "agent" : "main";
    workflow.nodes.push(item);
    syncMainDispatchEdges();
    syncRouteSettings();
    clearRouteLock();
    workflow.viewLayout = "free";
    selected = item.id;
    selectedEdge = null;
    cancelConnection();
    changed();
    render();
    showToast(item.name + " 已添加到画布");
  }

  function addSelector() {
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var index = workflow.nodes.filter(function (item) { return item.type === "selector"; }).length;
    var screenX = Math.max(12, Math.min(width - 206, 220 + (index % 3) * 78));
    var screenY = Math.max(12, Math.min(height - 104, 170 + (index % 3) * 96));
    var main = getNode(workflow.mainAgentId);
    var mainElement = main && nodeElement(main.id);
    var minAgentY = main && mainElement ? main.y + nodeDimensions(mainElement).height + 48 : 12;
    var worldX = (screenX - viewport.x) / viewport.k;
    var worldY = Math.max(minAgentY, (screenY - viewport.y) / viewport.k);
    var item = makeSelectorNode(uid("selector"), "选择器", worldX, worldY, "由 Main 从候选 Agent 中选择下一步。", "amber");
    workflow.nodes.push(item);
    clearRouteLock();
    workflow.viewLayout = "free";
    selected = item.id;
    selectedEdge = null;
    cancelConnection();
    changed();
    render();
    showToast("选择器已添加到画布");
  }

  function canUseEdgeKind(source, kind, ignoreEdgeId, target) {
    if (DIRECT_EDGE_MODE) {
      if (kind === "termination") {
        var terminalSource = getNode(source);
        if (!terminalSource || terminalSource.id === "main" || terminalSource.type === "main" || terminalSource.type === "input" || isEndNode(terminalSource) || target !== "end" || source === target || hasStrongOutgoing(source, ignoreEdgeId)) return false;
        return !workflow.edges.some(function (edge) {
          return edge.id !== ignoreEdgeId && isTerminationWorkflowEdge(edge);
        });
      }
      if (kind !== "strong" && kind !== "weak") return false;
      if (source === "end" || target === "input") return false;
      if (source === "main") return false;
      if (source === "input") {
        if (kind !== "strong" || target === "input" || target === "end") return false;
        return !workflow.edges.some(function (edge) { return edge.source === "input" && edge.id !== ignoreEdgeId; });
      }
      if (kind === "strong" && hasTerminationOutgoing(source, ignoreEdgeId)) return false;
      if (target === "end") return false;
      if (source === target && kind !== "weak") return false;
      var directKinds = workflow.edges.filter(function (edge) {
        return edge.source === source && edge.id !== ignoreEdgeId && !isTerminationWorkflowEdge(edge) && !isMainDispatchEdge(edge);
      }).map(function (edge) { return edge.kind; });
      if (kind === "strong" && directKinds.includes("strong")) return false;
      // Strong and weak ordinary exits may coexist. A source may have at most
      // one strong continuation; weak exits form one shared candidate group.
      return true;
    }
    var sourceNode = getNode(source);
    var selectorSource = isSelectorNode(sourceNode);
    // Only a selector may originate a weak choice edge. Ordinary Agents,
    // Main and the input anchor always use a strong entry edge.
    if (kind === "weak" && !selectorSource) return false;
    if (kind === "strong" && selectorSource) return false;
    if (source === target) return false;
    var outgoingKinds = workflow.edges.filter(function (edge) {
      return edge.source === source && edge.id !== ignoreEdgeId && !isTerminationWorkflowEdge(edge);
    }).map(function (edge) { return edge.kind; });
    // A normal Agent has one deterministic continuation. Multiple choices
    // must be represented by a selector node, so never allow a second strong
    // edge to leave the same ordinary source.
    if (!selectorSource && kind === "strong" && outgoingKinds.includes("strong")) return false;
    return outgoingKinds.every(function (existingKind) { return existingKind === kind; });
  }

  function setEdgeKind(edge, kind) {
    if (!edge || (kind !== "strong" && kind !== "weak")) return false;
    if (isTerminationWorkflowEdge(edge)) {
      showToast(DIRECT_EDGE_MODE ? "结束连接是固定系统边，不能修改类型" : "结束判断由 Main 控制，不能改成普通边");
      return false;
    }
    if (DIRECT_EDGE_MODE) {
      if (isMainDispatchEdge(edge)) {
        showToast("Main 固定调度边不能修改");
        return false;
      }
      if (edge.source === "input") {
        showToast("用户输入连接固定为强边");
        return false;
      }
      if (edge.kind === kind) return true;
      if (!canUseEdgeKind(edge.source, kind, edge.id, edge.target)) {
        showToast("该 Agent 最多只能有一条强边");
        return false;
      }
      edge.kind = kind;
      delete edge.selector;
      return true;
    }
    var sourceNode = getNode(edge.source);
    var expectedKind = isSelectorNode(sourceNode) ? "weak" : "strong";
    if (kind !== expectedKind) {
      showToast(isSelectorNode(sourceNode) ? "选择器出口固定为弱边" : "普通 Agent 只能连接强边；需要分支时请添加选择器");
      return false;
    }
    if (edge.kind === kind) return true;
    if (edge.source === "input") {
      showToast("用户输入连接固定为直接执行");
      return false;
    }
    if (!canUseEdgeKind(edge.source, kind, edge.id, edge.target)) {
      var source = getNode(edge.source);
      var hasStrong = workflow.edges.some(function (candidate) { return candidate.source === edge.source && candidate.id !== edge.id && candidate.kind === "strong"; });
      showToast(kind === "strong" && hasStrong ? (source ? source.name : "该 Agent") + " 只能有一条强边" : (source ? source.name : "该 Agent") + " 不能同时拥有强边和弱边");
      return false;
    }
    edge.kind = kind;
    return true;
  }

  function updateInputTarget(targetId, silent) {
    targetId = targetId || null;
    if (targetId && !validWorkflowNode(workflow.nodes, targetId, false)) return false;
    if (!silent) pushUndo("修改用户输入入口");
    workflow.inputTarget = targetId;
    var inputEdge = workflow.edges.find(function (edge) { return edge.source === "input"; });
    workflow.edges = workflow.edges.filter(function (edge) { return edge.source !== "input"; });
    if (!targetId) {
      inputEdge = null;
    } else if (!inputEdge) {
      inputEdge = { id: "input-edge", source: "input", target: targetId, kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPreference: "right", targetPortPreference: "left", sourcePortPinned: true, targetPortPinned: true };
      workflow.edges.unshift(inputEdge);
    } else {
      inputEdge.target = targetId;
      inputEdge.kind = "strong";
      inputEdge.sourcePort = "right";
      inputEdge.targetPort = "left";
      inputEdge.sourcePortPreference = "right";
      inputEdge.targetPortPreference = "left";
      inputEdge.sourcePortPinned = true;
      inputEdge.targetPortPinned = true;
      workflow.edges.unshift(inputEdge);
    }
    if (!silent) {
      clearRouteLock();
      workflow.viewLayout = "free";
      changed();
      render();
      var target = getNode(targetId);
      showToast(target ? "用户输入将首先交给 " + target.name : "用户输入连接已移除");
    }
    return true;
  }

  function showConnectionError(message, nodeId) {
    showToast(message);
    var element = nodeId && nodeElement(nodeId);
    if (!element) return;
    element.classList.remove("is-invalid-action");
    // Force a fresh animation when the same invalid operation is repeated.
    void element.offsetWidth;
    element.classList.add("is-invalid-action");
    setTimeout(function () { element.classList.remove("is-invalid-action"); }, 520);
  }

  function addDirectEdge(source, target, kind, sourcePort, targetPort) {
    var sourceNode = getNode(source);
    var targetNode = getNode(target);
    if (!sourceNode || !targetNode) {
      showConnectionError("请选择有效的连接目标", target);
      return;
    }
    if (source === "end" || isEndNode(sourceNode)) {
      showConnectionError("结束节点不能创建出边", source);
      return;
    }
    if (source === "main") {
      showConnectionError("Main Agent 的固定调度边由系统维护，不能手动创建", source);
      return;
    }
    if (target === "input" || targetNode.type === "input") {
      showConnectionError("用户输入节点不能接收入边", target);
      return;
    }
    if (source === "input" && target === "end") {
      showConnectionError("用户输入不能直接连接结束节点，请先添加 Agent", target);
      return;
    }

    var existingPair = workflow.edges.find(function (edge) { return edge.source === source && edge.target === target; });
    if (source === "input") {
      var existingInput = workflow.edges.find(function (edge) { return edge.source === "input"; });
      if (existingInput && existingInput !== existingPair) {
        showConnectionError("用户输入只能有一条出边，请先删除现有连接", source);
        return;
      }
      kind = "strong";
    } else if (target === "end") {
      var existingEnd = workflow.edges.find(function (edge) { return edge.target === "end"; });
      if (existingEnd && existingEnd !== existingPair) {
        showConnectionError("结束节点只能有一条入边，请先删除现有连接", target);
        return;
      }
      if (hasStrongOutgoing(source)) {
        showConnectionError("已有强出边的 Agent 不能连接结束节点；请先删除或改为弱边", source);
        return;
      }
      kind = "termination";
    } else {
      kind = kind === "weak" ? "weak" : "strong";
      if (isTerminationAgent(source) && kind === "strong") {
        showConnectionError("已连接结束的 Agent 不能拥有强出边；其他普通出边必须是弱边", source);
        return;
      }
    }

    if (existingPair) {
      var existingUndo = createUndoSnapshot("调整连接");
      if (isMainDispatchEdge(existingPair)) {
        showConnectionError("Main 固定调度边不能修改", source);
        return;
      }
      if (!isTerminationWorkflowEdge(existingPair) && !setEdgeKind(existingPair, kind)) return;
      setUndoSnapshot(existingUndo);
      if (validPortSide(sourcePort)) {
        existingPair.sourcePort = sourcePort;
        existingPair.sourcePortPreference = sourcePort;
        existingPair.sourcePortPinned = true;
      }
      if (validPortSide(targetPort)) {
        existingPair.targetPort = targetPort;
        existingPair.targetPortPreference = targetPort;
        existingPair.targetPortPinned = true;
      }
    } else {
      if (!canUseEdgeKind(source, kind, null, target)) {
        var hasStrongPath = workflow.edges.some(function (edge) { return edge.source === source && !isTerminationWorkflowEdge(edge) && edge.kind === "strong"; });
        showConnectionError(
          kind === "strong"
            ? "该 Agent 最多只能有一条强边"
            : hasStrongPath
              ? "该 Agent 的普通弱边仍可与强边并存"
              : "该 Agent 的出边类型与现有连接冲突",
          source
        );
        return;
      }
      pushUndo(target === "end" ? "添加结束连接" : source === "input" ? "添加输入连接" : "添加连接");
      var edge = {
        id: uid(target === "end" ? "termination" : source === "input" ? "input" : "edge"),
        source: source,
        target: target,
        kind: kind,
        sourcePort: sourcePort,
        targetPort: targetPort,
        sourcePortPreference: validPortSide(sourcePort) ? sourcePort : undefined,
        targetPortPreference: validPortSide(targetPort) ? targetPort : undefined,
        sourcePortPinned: validPortSide(sourcePort),
        targetPortPinned: validPortSide(targetPort)
      };
      if (target === "end") {
        edge.kind = "termination";
        edge.termination = true;
      }
      workflow.edges.push(edge);
    }
    clearRouteLock();
    workflow.viewLayout = "free";
    selected = source;
    selectedEdge = null;
    cancelConnection();
    changed();
    render();
    showToast(target === "end" ? "已添加终止候选" : source === "input" ? "用户输入已连接到 " + targetNode.name : "已添加" + edgeLabel(kind));
  }

  function addEdge(source, target, kind, sourcePort, targetPort) {
    if (DIRECT_EDGE_MODE) return addDirectEdge(source, target, kind, sourcePort, targetPort);
    var sourceNode = getNode(source);
    var targetNode = getNode(target);
    if (!source || !target || target === "input" || !sourceNode || !targetNode) {
      showToast("请选择有效的连接目标");
      return;
    }
    if (target === "end") {
      showToast(DIRECT_EDGE_MODE ? "结束节点由结束 Agent 自动连接" : "结束选择器的入口由结束 Agent 自动连接");
      return;
    }
    if (DIRECT_EDGE_MODE) {
      kind = source === "input" ? "strong" : (kind === "weak" ? "weak" : "strong");
    }
    if (!DIRECT_EDGE_MODE && isSelectorNode(sourceNode) && source !== "end" && (targetNode.type === "main" || targetNode.type === "selector")) {
      showToast("选择器候选请连接普通 Agent；回到 Main 请从 Agent 直接连接 Main");
      return;
    }
    if (!DIRECT_EDGE_MODE && source === "end") {
      // The end selector always keeps the implicit Finish outcome and the
      // required return-to-Main choice. Additional Agent choices are allowed
      // as ordinary selector outputs and remain hidden until inspection.
      kind = "weak";
    }
    if (!DIRECT_EDGE_MODE && !isSelectorNode(sourceNode) && kind !== "strong") {
      showToast("普通 Agent 只能连接强边；请先添加选择器");
      return;
    }
    if (!DIRECT_EDGE_MODE && isSelectorNode(sourceNode) && source !== "end") kind = "weak";
    if (source === "input") {
      pushUndo("修改用户输入入口");
      updateInputTarget(target, true);
      var inputEdge = workflow.edges.find(function (edge) { return edge.source === "input"; });
      if (inputEdge) {
        inputEdge.sourcePort = validPortSide(sourcePort) ? sourcePort : "right";
        inputEdge.targetPort = validPortSide(targetPort) ? targetPort : "left";
        inputEdge.sourcePortPreference = inputEdge.sourcePort;
        inputEdge.targetPortPreference = inputEdge.targetPort;
        inputEdge.sourcePortPinned = true;
        inputEdge.targetPortPinned = true;
      }
      clearRouteLock();
      workflow.viewLayout = "free";
      selectedEdge = null;
      cancelConnection();
      changed();
      render();
      showToast("用户输入已连接到 " + getNode(target).name);
      return;
    }
    if (source === "end" && target === "main") workflow.endAllowReturnToMain = true;
    var existing = workflow.edges.find(function (edge) { return edge.source === source && edge.target === target; });
    if (existing) {
      var existingUndo = createUndoSnapshot("修改连接");
      if (!setEdgeKind(existing, kind)) return;
      setUndoSnapshot(existingUndo);
      if (validPortSide(sourcePort)) {
        existing.sourcePort = sourcePort;
        existing.sourcePortPreference = sourcePort;
        existing.sourcePortPinned = true;
      }
      if (validPortSide(targetPort)) {
        existing.targetPort = targetPort;
        existing.targetPortPreference = targetPort;
        existing.targetPortPinned = true;
      }
    } else {
      if (!canUseEdgeKind(source, kind, null, target)) {
        var sourceNode = getNode(source);
        var hasStrongPath = workflow.edges.some(function (candidate) { return candidate.source === source && candidate.kind === "strong"; });
        showToast(DIRECT_EDGE_MODE ? (source === workflow.terminationAgentId && kind === "strong" ? "结束连接天然为弱边，结束 Agent 不能再拥有强边" : kind === "strong" ? "该 Agent 最多只能有一条强边，且不能与弱边混用" : "该 Agent 已有强边；删除或改为弱边后才能创建多个弱边") : kind === "strong" && hasStrongPath ? (sourceNode ? sourceNode.name : "该 Agent") + " 只能有一条强边" : (sourceNode && isSelectorNode(sourceNode) ? "选择器候选不能重复" : "普通 Agent 只能连接强边，请先添加选择器"));
        return;
      }
      pushUndo("添加连接");
      workflow.edges.push({
        id: uid("edge"),
        source: source,
        target: target,
        kind: kind,
        selector: DIRECT_EDGE_MODE ? undefined : isSelectorNode(sourceNode),
        endChoice: source === "end" ? (target === "main" ? "return-main" : "agent-candidate") : undefined,
        sourcePort: sourcePort,
        targetPort: targetPort,
        sourcePortPreference: validPortSide(sourcePort) ? sourcePort : undefined,
        targetPortPreference: validPortSide(targetPort) ? targetPort : undefined,
        sourcePortPinned: validPortSide(sourcePort),
        targetPortPinned: validPortSide(targetPort)
      });
    }
    clearRouteLock();
    workflow.viewLayout = "free";
    selectedEdge = null;
    cancelConnection();
    changed();
    render();
    showToast(DIRECT_EDGE_MODE ? "已添加" + edgeLabel(kind) : source === "end" ? "已添加结束选择候选" : isSelectorNode(sourceNode) ? "已添加选择器候选" : "已添加强边");
  }

  function removeNode(id) {
    var item = getNode(id);
    if (!item || isAnchorNode(item) || isSystemSelectorNode(item) || id === "main") {
      showToast(isSystemSelectorNode(item) ? "Main 常驻选择器不能删除" : "Main、用户输入和结束节点不能删除");
      return;
    }
    pushUndo("删除 Agent");
    workflow.nodes = workflow.nodes.filter(function (item) { return item.id !== id; });
    workflow.edges = workflow.edges.filter(function (edge) { return edge.source !== id && edge.target !== id; });
    syncMainDispatchEdges();
    syncRouteSettings();
    if (!DIRECT_EDGE_MODE) {
      if (workflow.terminationAgentId === id) workflow.terminationAgentId = workflow.mainAgentId;
      if (workflow.inputTarget === id) updateInputTarget(workflow.mainAgentId, true);
      syncTerminationEdge();
    }
    clearRouteLock();
    workflow.viewLayout = "free";
    selected = getNode("input") ? "input" : workflow.nodes[0] && workflow.nodes[0].id;
    selectedEdge = null;
    cancelConnection();
    changed();
    render();
    showToast(item.name + " 已从画布删除，可使用撤销恢复");
  }

  function clearCanvas() {
    if (!window.confirm(DIRECT_EDGE_MODE ? "确认清空画布中的 Agent 和所有连接吗？Main、用户输入和结束节点会保留。" : "确认清空画布中的子 Agent 和连接吗？Main Agent、用户输入、Main 常驻选择器和结束模块会保留。")) return;
    pushUndo("清空画布");
    workflow.nodes = workflow.nodes.filter(function (item) { return item.type === "input" || item.id === "main" || isEndNode(item) || (!DIRECT_EDGE_MODE && isSystemSelectorNode(item)); });
    workflow.edges = [];
    if (!DIRECT_EDGE_MODE) workflow.edges.push({ id: "input-edge", source: "input", target: workflow.mainAgentId, kind: "strong", sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true });
    if (!DIRECT_EDGE_MODE) workflow.edges.push({ id: "main-selector-entry", source: "main", target: "selector-main", kind: "strong", selectorEntry: true, sourcePort: "right", targetPort: "left", sourcePortPinned: true, targetPortPinned: true });
    if (!DIRECT_EDGE_MODE) {
      workflow.inputTarget = workflow.mainAgentId;
      workflow.terminationAgentId = workflow.mainAgentId;
      syncTerminationEdge();
      workflow.endAllowReturnToMain = true;
      workflow.edges.push({ id: "end-return-main", source: "end", target: "main", kind: "weak", selector: true, endChoice: "return-main", sourcePort: "top", targetPort: "top", sourcePortPinned: true, targetPortPinned: true });
    }
    syncMainDispatchEdges();
    syncRouteSettings();
    syncEndNodePosition(false);
    clearRouteLock();
    selected = null;
    selectedEdge = null;
    cancelConnection();
    changed();
    // Refit the two fixed anchors and the terminal path together. Resetting
    // only the viewport leaves the end module at its world-space offset,
    // which can place it underneath the inspector after a clear operation.
    fitViewportOnly(true);
    // `fitViewportOnly` redraws geometry without rebuilding the toolbar
    // metadata, so refresh the clear-button state after the graph is empty.
    renderCanvasMeta();
    showToast(DIRECT_EDGE_MODE ? "已清空画布，仅保留 Main、用户输入和结束节点" : "已清除子 Agent，固定节点和结束模块已保留");
  }

  function saveWorkflow() {
    if (!validateWorkflow("保存")) return;
    var list = saved();
    var activeRecord = activeSavedId && list.find(function (item) { return item.id === activeSavedId; });
    if (activeRecord && activeRecord.builtin) {
      var prefs = templatePrefs();
      var defaultRecord = builtinWorkflowRecords().find(function (item) { return item.id === activeRecord.id; });
      var recordName = String(workflow.name || activeRecord.name || "未命名工作流").trim() || activeRecord.name;
      var overrideFlow = clone(workflow);
      overrideFlow.name = recordName;
      prefs.builtinOverrides[activeRecord.id] = overrideFlow;
      // Keep a name edited in the header consistent with the saved row. A
      // return to the stock name removes the unnecessary rename preference.
      if (defaultRecord && recordName === defaultRecord.name) delete prefs.builtinNames[activeRecord.id];
      else prefs.builtinNames[activeRecord.id] = recordName;
      saveTemplatePrefs(prefs);
      currentSavedId = null;
      activeSavedId = activeRecord.id;
      workflow.name = recordName;
      changed(false);
      renderSaved();
      render();
      showToast("流程修改已保存");
      return;
    }
    var record = { id: currentSavedId || uid("flow"), name: (workflow.name || "未命名工作流").trim(), flow: clone(workflow) };
    var index = list.findIndex(function (item) { return item.id === record.id; });
    if (index < 0) list.unshift(record);
    else list[index] = record;
    saveSaved(list);
    currentSavedId = record.id;
    activeSavedId = record.id;
    workflow.name = record.name;
    changed(false);
    renderSaved();
    render();
    showToast("流程已保存到本地");
  }

  function loadSavedRecord(record) {
    if (!record || !record.flow) return;
    clearUndo();
    workflow = normalizeWorkflow(record.flow);
    clearRouteLock();
    currentSavedId = record.builtin ? null : record.id;
    activeSavedId = record.id;
    selected = workflow.nodes.find(function (item) { return item.type !== "input" && !isEndNode(item); }) && workflow.nodes.find(function (item) { return item.type !== "input" && !isEndNode(item); }).id || (getNode("input") ? "input" : workflow.nodes[0] && workflow.nodes[0].id);
    selectedEdge = null;
    cancelConnection();
    resetViewport();
    changed(false);
    renderSaved();
    render();
    requestAnimationFrame(function () { fitViewportOnly(true); });
  }

  function createSavedWorkflow(name) {
    var flow = normalizeWorkflow(blankWorkflow(name));
    var record = { id: uid("flow"), name: name, flow: flow };
    var list = saved();
    list.unshift(record);
    saveSaved(list);
    loadSavedRecord(record);
    showToast("已新建并保存 " + name);
  }

  function renameSavedRecord(id, name) {
    var list = saved();
    var record = list.find(function (item) { return item.id === id; });
    if (!record) return false;
    if (record.builtin) {
      var prefs = templatePrefs();
      prefs.builtinNames[id] = name;
      saveTemplatePrefs(prefs);
    } else {
      record.name = name;
      record.flow.name = name;
      saveSaved(list);
    }
    if (activeSavedId === id) {
      var wasDirty = dirty;
      workflow.name = name;
      changed(wasDirty);
      render();
    }
    renderSaved();
    showToast("流程名称已修改");
    return true;
  }

  function deleteSavedRecord(id) {
    var list = saved();
    var record = list.find(function (item) { return item.id === id; });
    if (!record) return false;
    if (!window.confirm("确认删除已保存流程“" + record.name + "”吗？")) return false;
    if (record.builtin) {
      var prefs = templatePrefs();
      if (!prefs.hiddenBuiltinIds.includes(id)) prefs.hiddenBuiltinIds.push(id);
      delete prefs.builtinNames[id];
      delete prefs.builtinOverrides[id];
      saveTemplatePrefs(prefs);
    } else {
      saveSaved(list.filter(function (item) { return item.id !== id; }));
    }
    if (activeSavedId === id) {
      activeSavedId = null;
      currentSavedId = null;
    }
    renderSaved();
    showToast("已删除 " + record.name);
    return true;
  }

  function pinAnchorsAtTop() {
    return false;
  }

  // Kept as a small compatibility wrapper for older initialization paths.
  function pinMainAtTop() {
    return pinAnchorsAtTop();
  }

  function fitCanvas(silent) {
    if (!workflow.nodes.length) return;
    cancelConnection();
    clearRouteLock();
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var padding = 42;
    var rankGap = workflow.nodes.length > 8 ? 82 : 104;
    var laneGap = workflow.nodes.length > 8 ? 42 : 62;
    var layoutDirection = "grid";
    var nodeOrder = {};
    var outgoing = {};
    var incoming = {};
    var sizes = {};
    var maxNodeWidth = 0;
    var maxNodeHeight = 0;
    workflow.nodes.forEach(function (item, index) {
      nodeOrder[item.id] = index;
      outgoing[item.id] = [];
      incoming[item.id] = [];
      var element = nodeElement(item.id);
      var size = {
        width: element && element.offsetWidth || 194,
        height: element && element.offsetHeight || 92
      };
      sizes[item.id] = size;
      maxNodeWidth = Math.max(maxNodeWidth, size.width);
      maxNodeHeight = Math.max(maxNodeHeight, size.height);
    });
    businessWorkflowEdges().forEach(function (edge) {
      if (edge.endChoice === "return-main") return;
      if (!outgoing[edge.source] || !incoming[edge.target] || edge.source === edge.target) return;
      outgoing[edge.source].push(edge);
      incoming[edge.target].push(edge);
    });
    Object.keys(outgoing).forEach(function (id) {
      outgoing[id].sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === "strong" ? -1 : 1;
        return nodeOrder[a.target] - nodeOrder[b.target];
      });
      incoming[id].sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === "strong" ? -1 : 1;
        return nodeOrder[a.source] - nodeOrder[b.source];
      });
    });

    var indegree = {};
    workflow.nodes.forEach(function (item) { indegree[item.id] = incoming[item.id].length; });
    var queue = workflow.nodes.filter(function (item) { return indegree[item.id] === 0; }).map(function (item) { return item.id; });
    var order = [];
    var processed = {};
    function consumeQueue() {
      while (queue.length) {
        var sourceId = queue.shift();
        if (processed[sourceId]) continue;
        processed[sourceId] = true;
        order.push(sourceId);
        outgoing[sourceId].forEach(function (edge) {
          indegree[edge.target] -= 1;
          if (indegree[edge.target] <= 0 && !processed[edge.target]) queue.push(edge.target);
        });
      }
    }
    consumeQueue();
    workflow.nodes.forEach(function (item) {
      if (processed[item.id]) return;
      queue.push(item.id);
      consumeQueue();
    });

    var orderIndex = {};
    order.forEach(function (id, index) { orderIndex[id] = index; });
    var rank = {};
    workflow.nodes.forEach(function (item) { rank[item.id] = 0; });
    order.forEach(function (sourceId) {
      outgoing[sourceId].forEach(function (edge) {
        if (orderIndex[edge.target] <= orderIndex[sourceId]) return;
        rank[edge.target] = Math.max(rank[edge.target], rank[sourceId] + 1);
      });
    });

    var rankValues = [];
    workflow.nodes.forEach(function (item) {
      if (!rankValues.includes(rank[item.id])) rankValues.push(rank[item.id]);
    });
    rankValues.sort(function (a, b) { return a - b; });
    var compactRank = {};
    rankValues.forEach(function (value, index) { compactRank[value] = index; });
    var layers = rankValues.map(function () { return []; });
    workflow.nodes.forEach(function (item) { layers[compactRank[rank[item.id]]].push(item); });
    layers.forEach(function (layer) {
      layer.sort(function (a, b) { return nodeOrder[a.id] - nodeOrder[b.id]; });
    });

    function reorderByNeighbors(layer, neighborLayer, useIncoming) {
      var positions = {};
      neighborLayer.forEach(function (item, index) { positions[item.id] = index; });
      var currentPositions = {};
      layer.forEach(function (item, index) { currentPositions[item.id] = index; });
      layer.sort(function (a, b) {
        function score(item) {
          var links = useIncoming ? incoming[item.id] : outgoing[item.id];
          var values = links.map(function (edge) {
            var neighborId = useIncoming ? edge.source : edge.target;
            return positions[neighborId];
          }).filter(function (value) { return value != null; });
          if (!values.length) return currentPositions[item.id];
          return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
        }
        var difference = score(a) - score(b);
        return Math.abs(difference) > 0.001 ? difference : nodeOrder[a.id] - nodeOrder[b.id];
      });
    }

    for (var pass = 0; pass < 4; pass += 1) {
      for (var forward = 1; forward < layers.length; forward += 1) reorderByNeighbors(layers[forward], layers[forward - 1], true);
      for (var backward = layers.length - 2; backward >= 0; backward -= 1) reorderByNeighbors(layers[backward], layers[backward + 1], false);
    }

    var layoutEdges = businessWorkflowEdges();
    var hasRanks = layoutEdges.length && layers.length > 1;
    if (hasRanks) {
      var corridorLoads = [];
      layoutEdges.forEach(function (edge) {
        var sourceRank = compactRank[rank[edge.source]];
        var targetRank = compactRank[rank[edge.target]];
        if (sourceRank == null || targetRank == null) return;
        if (sourceRank === targetRank) {
          if (sourceRank < layers.length - 1) corridorLoads[sourceRank] = (corridorLoads[sourceRank] || 0) + 1;
          return;
        }
        var first = Math.min(sourceRank, targetRank);
        var last = Math.max(sourceRank, targetRank);
        for (var corridorIndex = first; corridorIndex < last; corridorIndex += 1) {
          corridorLoads[corridorIndex] = (corridorLoads[corridorIndex] || 0) + 1;
        }
      });
      var maxCorridorLoad = corridorLoads.reduce(function (max, value) { return Math.max(max, value || 0); }, 0);
      // 每条穿过列间隙的边需要一条出轨和一条入轨，留足空间后轨道才不会在中间相撞。
      rankGap = Math.max(rankGap, 2 * (ROUTE_PORT_LEAD + CLEAR_RAIL_MARGIN) + maxCorridorLoad * CLEAR_RAIL_STEP * 2 + 56);
      laneGap = Math.max(laneGap, 54);
    }
    if (!hasRanks) {
      var columns = Math.max(1, Math.ceil(Math.sqrt(workflow.nodes.length * width / Math.max(1, height))));
      columns = Math.min(columns, workflow.nodes.length);
      var rows = Math.ceil(workflow.nodes.length / columns);
      layers = [];
      workflow.nodes.forEach(function (item, index) {
        var x = index % columns;
        var y = Math.floor(index / columns);
        item.x = x * (maxNodeWidth + laneGap);
        item.y = y * (maxNodeHeight + laneGap);
      });
    } else {
      function placeLayers(direction) {
        if (direction === "horizontal") {
          var maxLayerHeight = Math.max.apply(Math, layers.map(function (layer) {
            return layer.length * maxNodeHeight + Math.max(0, layer.length - 1) * laneGap;
          }));
          layers.forEach(function (layer, layerIndex) {
            var layerHeight = layer.length * maxNodeHeight + Math.max(0, layer.length - 1) * laneGap;
            var startY = (maxLayerHeight - layerHeight) / 2;
            layer.forEach(function (item, index) {
              item.x = layerIndex * (maxNodeWidth + rankGap);
              item.y = startY + index * (maxNodeHeight + laneGap);
            });
          });
        } else {
          var maxLayerWidth = Math.max.apply(Math, layers.map(function (layer) {
            return layer.length * maxNodeWidth + Math.max(0, layer.length - 1) * laneGap;
          }));
          layers.forEach(function (layer, layerIndex) {
            var layerWidth = layer.length * maxNodeWidth + Math.max(0, layer.length - 1) * laneGap;
            var startX = (maxLayerWidth - layerWidth) / 2;
            layer.forEach(function (item, index) {
              item.x = startX + index * (maxNodeWidth + laneGap);
              item.y = layerIndex * (maxNodeHeight + rankGap);
            });
          });
        }
      }

      // 工作流始终从左向右展开，分支在上下通道中分流，避免主链在纵向压成一列。
      placeLayers("horizontal");
      layoutDirection = "horizontal";
    }

    // The direct-edge branch always preserves free placement. The old anchor
    // rail is intentionally not applied here.

    // User-selected ports are preferences, not immutable anchors. Once the
    // nodes are placed, score every port pair against direction, congestion
    // and node clearance, then persist the cleanest effective pair.
    optimizeWorkflowPorts({ layout: layoutColumns() });
    workflow.viewLayout = "clear-lanes";
    var fitRoutes = buildClearLayoutEdgeRoutes();
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    workflow.nodes.forEach(function (item) {
      var size = sizes[item.id];
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + size.width);
      maxY = Math.max(maxY, item.y + size.height);
    });
    Object.keys(fitRoutes).forEach(function (id) {
      var routePoints = fitRoutes[id].geometry && fitRoutes[id].geometry.samples
        ? fitRoutes[id].geometry.samples.map(function (sample) { return sample.point; })
        : fitRoutes[id].points;
      routePoints.forEach(function (point) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });
    // Main dispatch rails are excluded from node layout, but their outer
    // geometry must still be inside the fitted viewport.
    var dispatchEdges = workflow.edges.filter(isMainDispatchEdge);
    dispatchEdges.forEach(function (edge, index) {
      var dispatchRoute = mainDispatchGeometry(edge, index, dispatchEdges.length);
      var dispatchPoints = dispatchRoute && dispatchRoute.geometry && dispatchRoute.geometry.samples
        ? dispatchRoute.geometry.samples.map(function (sample) { return sample.point; })
        : dispatchRoute && dispatchRoute.points || [];
      dispatchPoints.forEach(function (point) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });
    var routePadding = businessWorkflowEdges().length ? 28 : 0;
    minX -= routePadding;
    minY -= routePadding;
    maxX += routePadding;
    maxY += routePadding;
    var graphWidth = Math.max(1, maxX - minX);
    var graphHeight = Math.max(1, maxY - minY);
    var availableWidth = Math.max(1, width - padding * 2);
    var availableHeight = Math.max(1, height - padding * 2);
    var fitZoom = Math.min(1.15, availableWidth / graphWidth, availableHeight / graphHeight);
    viewport.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
    viewport.x = Math.round((width - graphWidth * viewport.k) / 2 - minX * viewport.k);
    viewport.y = Math.round((height - graphHeight * viewport.k) / 2 - minY * viewport.k);
    changed();
    render();
    if (silent !== true) showToast("已按分层分轨整理布局");
  }

  // Preserve curated/manual node positions and only center the complete graph.
  // This is used when switching showcase templates so their composition is not
  // replaced by the automatic arranger.
  function fitViewportOnly(silent) {
    if (!workflow.nodes.length) return;
    cancelConnection();
    clearRouteLock();
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var padding = RUNTIME_MODE ? 18 : 48;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    workflow.nodes.forEach(function (item) {
      var size = nodeDimensions(nodeElement(item.id));
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + size.width);
      maxY = Math.max(maxY, item.y + size.height);
    });

    var routes = RUNTIME_MODE ? buildEdgeRoutes() : buildClearLayoutEdgeRoutes();
    Object.keys(routes).forEach(function (id) {
      var route = routes[id];
      var points = route.geometry && route.geometry.samples
        ? route.geometry.samples.map(function (sample) { return sample.point; })
        : route.points || [];
      points.forEach(function (point) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });
    var dispatchEdges = workflow.edges.filter(isMainDispatchEdge);
    dispatchEdges.forEach(function (edge, index) {
      var dispatchRoute = mainDispatchGeometry(edge, index, dispatchEdges.length);
      var dispatchPoints = dispatchRoute && dispatchRoute.geometry && dispatchRoute.geometry.samples
        ? dispatchRoute.geometry.samples.map(function (sample) { return sample.point; })
        : dispatchRoute && dispatchRoute.points || [];
      dispatchPoints.forEach(function (point) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });

    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      resetViewport();
      return;
    }
    var routePadding = businessWorkflowEdges().length ? 24 : 0;
    minX -= routePadding;
    minY -= routePadding;
    maxX += routePadding;
    maxY += routePadding;
    var graphWidth = Math.max(1, maxX - minX);
    var graphHeight = Math.max(1, maxY - minY);
    var availableWidth = Math.max(1, width - padding * 2);
    var availableHeight = Math.max(1, height - padding * 2);
    var fitZoom = Math.min(1.08, availableWidth / graphWidth, availableHeight / graphHeight);
    viewport.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
    viewport.x = Math.round((width - graphWidth * viewport.k) / 2 - minX * viewport.k);
    viewport.y = Math.round((height - graphHeight * viewport.k) / 2 - minY * viewport.k);
    applyViewport();
    drawEdges();
    if (silent !== true) showToast("已适配当前展示视图");
  }

  // The regular fit routine includes Main's long dispatch rails. In the
  // runtime Demo those rails intentionally extend beyond the workflow, so
  // fitting them would make every Agent unreadably small. Keep the Demo view
  // anchored to the Agent composition instead.
  function demoOverviewBounds() {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    function include(x, y, width, height) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (Number.isFinite(width) ? width : 194));
      maxY = Math.max(maxY, y + (Number.isFinite(height) ? height : 92));
    }
    workflow.nodes.forEach(function (item) { include(Number(item.x), Number(item.y)); });
    // Reserve the final curated slots from the event stream. The nodes remain
    // absent until Main creates them, but the camera has room for their
    // arrival from the first frame and does not need to zoom on every event.
    (demoRun.events || []).forEach(function (event) {
      if (event.type === "main:create-agent" && event.position) include(Number(event.position.x), Number(event.position.y));
      if (event.type === "main:move-agents") {
        (event.moves || []).forEach(function (move) {
          if (move && move.position) include(Number(move.position.x), Number(move.position.y));
        });
      }
    });
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function fitDemoOverview() {
    if (!demoRun.hasRun || !workflow.nodes.length) return;
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    if (width <= 590) {
      fitDemoViewport();
      return;
    }
    var bounds = demoOverviewBounds();
    if (!bounds) return;
    var padding = 48;
    var minX = bounds.minX - 24;
    var minY = bounds.minY - 24;
    var maxX = bounds.maxX + 24;
    var maxY = bounds.maxY + 24;
    var graphWidth = Math.max(1, maxX - minX);
    var graphHeight = Math.max(1, maxY - minY);
    var availableWidth = Math.max(1, width - padding * 2);
    var availableHeight = Math.max(1, height - padding * 2);
    var fitZoom = Math.min(0.82, availableWidth / graphWidth, availableHeight / graphHeight);
    viewport.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
    viewport.x = Math.round((width - graphWidth * viewport.k) / 2 - minX * viewport.k);
    viewport.y = Math.round((height - graphHeight * viewport.k) / 2 - minY * viewport.k);
    applyViewport();
    drawEdges();
  }

  function fitDemoViewport() {
    if (!demoRun.hasRun || !workflow.nodes.length) return;
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var compactViewport = width <= 590;
    var padding = compactViewport ? 22 : 48;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    workflow.nodes.forEach(function (item) {
      var size = nodeDimensions(nodeElement(item.id));
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + size.width);
      maxY = Math.max(maxY, item.y + size.height);
    });

    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;

    if (compactViewport) {
      // A phone cannot show this eight-Agent workflow at a useful text size.
      // Follow one Agent during serial work. For a fan-out, fit Main and every
      // active Agent together so the parallelism remains visible.
      var parallelIds = demoRun.runningAgentIds.slice();
      if (parallelIds.length > 1) {
        var parallelItems = workflow.nodes.filter(function (item) {
          return item.id === "main" || parallelIds.indexOf(item.id) >= 0;
        });
        var parallelMinX = Infinity;
        var parallelMinY = Infinity;
        var parallelMaxX = -Infinity;
        var parallelMaxY = -Infinity;
        parallelItems.forEach(function (item) {
          var itemSize = nodeDimensions(nodeElement(item.id));
          parallelMinX = Math.min(parallelMinX, item.x);
          parallelMinY = Math.min(parallelMinY, item.y);
          parallelMaxX = Math.max(parallelMaxX, item.x + itemSize.width);
          parallelMaxY = Math.max(parallelMaxY, item.y + itemSize.height);
        });
        var parallelWidth = Math.max(1, parallelMaxX - parallelMinX);
        var parallelHeight = Math.max(1, parallelMaxY - parallelMinY);
        var parallelZoom = Math.min(0.68, Math.max(MIN_ZOOM, (width - padding * 2) / parallelWidth), Math.max(MIN_ZOOM, (height - padding * 2) / parallelHeight));
        viewport.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, parallelZoom));
        viewport.x = Math.round((width - parallelWidth * viewport.k) / 2 - parallelMinX * viewport.k);
        viewport.y = Math.round((height - parallelHeight * viewport.k) / 2 - parallelMinY * viewport.k);
      } else {
        var focus = getNode(demoRun.focusNodeId || selected || "main") || workflow.nodes[0];
        var focusSize = nodeDimensions(nodeElement(focus.id));
        var focusY = demoRun.floatingUpdate ? 0.73 : 0.5;
        viewport.k = 0.68;
        viewport.x = Math.round(width * 0.5 - (focus.x + focusSize.width * 0.5) * viewport.k);
        viewport.y = Math.round(height * focusY - (focus.y + focusSize.height * 0.5) * viewport.k);
      }
    } else {
      var graphWidth = Math.max(1, maxX - minX);
      var graphHeight = Math.max(1, maxY - minY);
      var availableWidth = Math.max(1, width - padding * 2);
      var availableHeight = Math.max(1, height - padding * 2);
      var fitZoom = Math.min(0.86, availableWidth / graphWidth, availableHeight / graphHeight);
      viewport.k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
      viewport.x = Math.round((width - graphWidth * viewport.k) / 2 - minX * viewport.k);
      viewport.y = Math.round((height - graphHeight * viewport.k) / 2 - minY * viewport.k);
    }

    applyViewport();
    drawEdges();
  }

  function localLayoutSamples(route) {
    if (!route) return [];
    var source = route.geometry && route.geometry.samples || route.samples;
    if (source && source.length) {
      return source.map(function (sample) {
        var point = sample && sample.point ? sample.point : sample;
        return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
      }).filter(Boolean);
    }
    var points = route.points || [];
    if (points.length < 2) return points.map(function (point) { return { x: point.x, y: point.y }; });
    var samples = [];
    for (var index = 1; index < points.length; index += 1) {
      var start = points[index - 1];
      var end = points[index];
      var distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
      var steps = Math.max(2, Math.ceil(distance / 28));
      for (var step = 0; step <= steps; step += 1) {
        if (index > 1 && step === 0) continue;
        var progress = step / steps;
        samples.push({
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress
        });
      }
    }
    return samples;
  }

  function localNodeRect(item, padding) {
    var size = nodeDimensions(nodeElement(item.id));
    var gap = padding == null ? 0 : padding;
    return {
      id: item.id,
      left: item.x - gap,
      top: item.y - gap,
      right: item.x + size.width + gap,
      bottom: item.y + size.height + gap
    };
  }

  function localRectOverlapArea(first, second) {
    var width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
    var height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function localLabelRect(edge, midpoint) {
    var width = edge && edge.endChoice === "return-main" ? 64 : 44;
    var centerY = midpoint.y - 8;
    return {
      id: edge.id,
      left: midpoint.x - width / 2 - 5,
      top: centerY - 10,
      right: midpoint.x + width / 2 + 5,
      bottom: centerY + 10
    };
  }

  function localRouteCloseRatio(first, second) {
    var firstSamples = first.samples || [];
    var secondSamples = second.samples || [];
    if (firstSamples.length < 8 || secondSamples.length < 8) return { ratio: 0, exact: 0 };
    var firstStart = 4;
    var firstEnd = firstSamples.length - 5;
    var secondStart = 4;
    var secondEnd = secondSamples.length - 5;
    if (firstEnd <= firstStart || secondEnd <= secondStart) return { ratio: 0, exact: 0 };
    var close = 0;
    var exact = 0;
    var total = 0;
    for (var index = firstStart; index <= firstEnd; index += 2) {
      var point = firstSamples[index];
      var nearest = Infinity;
      for (var segment = secondStart + 2; segment <= secondEnd; segment += 2) {
        nearest = Math.min(nearest, pointToSegmentDistance(point, secondSamples[segment - 2], secondSamples[segment]));
      }
      total += 1;
      if (nearest < 18) close += 1;
      if (nearest < 6) exact += 1;
    }
    return { ratio: total ? close / total : 0, exact: total ? exact / total : 0 };
  }

  function localRouteLength(samples) {
    var length = 0;
    for (var index = 1; index < samples.length; index += 1) {
      length += Math.sqrt(
        Math.pow(samples[index].x - samples[index - 1].x, 2) +
        Math.pow(samples[index].y - samples[index - 1].y, 2)
      );
    }
    return length;
  }

  function localSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    var firstDx = firstEnd.x - firstStart.x;
    var firstDy = firstEnd.y - firstStart.y;
    var secondDx = secondEnd.x - secondStart.x;
    var secondDy = secondEnd.y - secondStart.y;
    var denominator = firstDx * secondDy - firstDy * secondDx;
    if (Math.abs(denominator) < 0.001) return null;
    var offsetX = secondStart.x - firstStart.x;
    var offsetY = secondStart.y - firstStart.y;
    var firstProgress = (offsetX * secondDy - offsetY * secondDx) / denominator;
    var secondProgress = (offsetX * firstDy - offsetY * firstDx) / denominator;
    // Ignore sample joints. Close/overlapping paths are scored separately,
    // while this detector is only for an unmistakable visual crossing.
    if (firstProgress <= 0.025 || firstProgress >= 0.975 || secondProgress <= 0.025 || secondProgress >= 0.975) return null;
    return {
      x: firstStart.x + firstDx * firstProgress,
      y: firstStart.y + firstDy * firstProgress
    };
  }

  function localRouteCrossing(first, second) {
    var firstSamples = first.samples || [];
    var secondSamples = second.samples || [];
    var sharedEndpoint = first.edge.source === second.edge.source ||
      first.edge.source === second.edge.target ||
      first.edge.target === second.edge.source ||
      first.edge.target === second.edge.target;
    var trim = sharedEndpoint ? 6 : 3;
    if (firstSamples.length <= trim * 2 + 1 || secondSamples.length <= trim * 2 + 1) return null;
    for (var firstIndex = trim + 2; firstIndex < firstSamples.length - trim; firstIndex += 2) {
      var firstStart = firstSamples[firstIndex - 2];
      var firstEnd = firstSamples[firstIndex];
      for (var secondIndex = trim + 2; secondIndex < secondSamples.length - trim; secondIndex += 2) {
        var crossing = localSegmentIntersection(firstStart, firstEnd, secondSamples[secondIndex - 2], secondSamples[secondIndex]);
        if (crossing) return crossing;
      }
    }
    return null;
  }

  function localLayoutReport(originalPositions) {
    var routes = buildEdgeRoutes();
    var nodeRects = {};
    workflow.nodes.forEach(function (item) { nodeRects[item.id] = localNodeRect(item, 6); });
    var conflictNodes = {};
    var stats = {
      nodePairs: 0,
      edgeNodeHits: 0,
      edgeCrossings: 0,
      edgePairs: 0,
      labelPairs: 0,
      labelNodeHits: 0,
      shortEdges: 0,
      alignmentOffsets: 0,
      orderFlips: 0
    };
    var score = 0;
    var nodePressure = {};
    var hardNodes = {};
    var overlapNodes = {};
    function markNode(id) {
      if (id) conflictNodes[id] = true;
    }
    function addPressure(id, amount, hard) {
      if (!id) return;
      nodePressure[id] = (nodePressure[id] || 0) + amount;
      if (hard) hardNodes[id] = true;
      markNode(id);
    }
    var shortNodes = {};
    var shortEdges = [];
    var nodeConflicts = [];
    var edgeNodeConflicts = [];
    var edgePairConflicts = [];
    var alignmentConflicts = [];
    var nodes = workflow.nodes;
    for (var leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      var left = nodes[leftIndex];
      var leftRect = localNodeRect(left, 16);
      var leftSize = nodeDimensions(nodeElement(left.id));
      var leftCenter = { x: left.x + leftSize.width / 2, y: left.y + leftSize.height / 2 };
      for (var rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        var right = nodes[rightIndex];
        var rightRect = localNodeRect(right, 16);
        var rightSize = nodeDimensions(nodeElement(right.id));
        var rightCenter = { x: right.x + rightSize.width / 2, y: right.y + rightSize.height / 2 };
        var area = localRectOverlapArea(leftRect, rightRect);
        if (area) {
          stats.nodePairs += 1;
          score += 95000 + area * 18;
          nodeConflicts.push({ first: left, second: right, area: area });
          overlapNodes[left.id] = true;
          overlapNodes[right.id] = true;
          addPressure(left.id, 90, true);
          addPressure(right.id, 90, true);
        }
        var centerDx = Math.abs(rightCenter.x - leftCenter.x);
        var centerDy = Math.abs(rightCenter.y - leftCenter.y);
        if (centerDx > 0.75 && centerDx <= 14 && centerDy > Math.max(leftSize.height, rightSize.height) * 0.72) {
          stats.alignmentOffsets += 1;
          score += centerDx * 55;
          alignmentConflicts.push({ first: left, second: right, axis: "x", delta: rightCenter.x - leftCenter.x });
          addPressure(right.id, 3, false);
        }
        if (centerDy > 0.75 && centerDy <= 14 && centerDx > Math.max(leftSize.width, rightSize.width) * 0.72) {
          stats.alignmentOffsets += 1;
          score += centerDy * 55;
          alignmentConflicts.push({ first: left, second: right, axis: "y", delta: rightCenter.y - leftCenter.y });
          addPressure(right.id, 3, false);
        }
      }
    }

    var edgeRecords = workflow.edges.map(function (edge) {
      var route = routes && routes[edge.id];
      if (!route) return null;
      var samples = localLayoutSamples(route);
      var midpoint = route.midpoint || routeMidpoint(route.points || samples);
      var start = samples[0] || { x: 0, y: 0 };
      var end = samples[samples.length - 1] || start;
      return {
        edge: edge,
        route: route,
        samples: samples,
        midpoint: midpoint,
        length: localRouteLength(samples),
        endpointDistance: Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2))
      };
    }).filter(Boolean);
    var edgeNodeHitMap = {};
    edgeRecords.forEach(function (record) {
      var edge = record.edge;
      var samples = record.samples;
      var minimumLength = edge.source === edge.target ? TIDY_SELF_EDGE_LENGTH : (isTerminationWorkflowEdge(edge) ? 92 : TIDY_MIN_EDGE_LENGTH);
      var readableLength = edge.source === edge.target ? record.length : Math.min(record.length, record.endpointDistance);
      if (readableLength < minimumLength) {
        var shortfall = minimumLength - readableLength;
        stats.shortEdges += 1;
        score += 14000 + shortfall * 130;
        shortEdges.push({ edge: edge, length: readableLength, minimum: minimumLength });
        shortNodes[edge.source] = true;
        shortNodes[edge.target] = true;
        addPressure(edge.source, 34, false);
        addPressure(edge.target, 34, false);
      }
      var usableStart = Math.min(4, Math.max(0, samples.length - 1));
      var usableEnd = Math.max(usableStart, samples.length - 5);
      for (var sampleIndex = usableStart; sampleIndex <= usableEnd; sampleIndex += 1) {
        var point = samples[sampleIndex];
        nodes.forEach(function (node) {
          if (node.id === edge.source || node.id === edge.target) return;
          if (!pointInRouteRect(point, nodeRects[node.id])) return;
          var key = edge.id + "\u0000" + node.id;
          if (!edgeNodeHitMap[key]) {
            edgeNodeHitMap[key] = { edge: edge, node: node, point: { x: point.x, y: point.y }, samples: 0 };
            edgeNodeConflicts.push(edgeNodeHitMap[key]);
          }
          edgeNodeHitMap[key].samples += 1;
        });
      }
    });
    edgeNodeConflicts.forEach(function (conflict) {
      stats.edgeNodeHits += 1;
      score += 110000 + conflict.samples * 720;
      addPressure(conflict.edge.source, 28, false);
      addPressure(conflict.edge.target, 28, false);
      addPressure(conflict.node.id, 110, true);
    });

    for (var firstEdgeIndex = 0; firstEdgeIndex < edgeRecords.length; firstEdgeIndex += 1) {
      var firstEdge = edgeRecords[firstEdgeIndex];
      for (var secondEdgeIndex = firstEdgeIndex + 1; secondEdgeIndex < edgeRecords.length; secondEdgeIndex += 1) {
        var secondEdge = edgeRecords[secondEdgeIndex];
        if (firstEdge.edge.id === secondEdge.edge.id) continue;
        var crossing = localRouteCrossing(firstEdge, secondEdge);
        if (crossing) {
          stats.edgeCrossings += 1;
          score += 24000;
          edgePairConflicts.push({ first: firstEdge.edge, second: secondEdge.edge, point: crossing, type: "crossing" });
          addPressure(firstEdge.edge.source, 18, false);
          addPressure(firstEdge.edge.target, 18, false);
          addPressure(secondEdge.edge.source, 18, false);
          addPressure(secondEdge.edge.target, 18, false);
        }
        var close = localRouteCloseRatio(firstEdge, secondEdge);
        if (close.ratio < 0.2) continue;
        stats.edgePairs += 1;
        score += 5200 + close.ratio * 7600 + close.exact * 9800;
        if (close.ratio > 0.42) score += 9000;
        edgePairConflicts.push({ first: firstEdge.edge, second: secondEdge.edge, point: null, type: "overlap" });
        addPressure(firstEdge.edge.source, 12, false);
        addPressure(firstEdge.edge.target, 12, false);
        addPressure(secondEdge.edge.source, 12, false);
        addPressure(secondEdge.edge.target, 12, false);
      }
    }

    var labels = edgeRecords.map(function (record) {
      return { edge: record.edge, rect: localLabelRect(record.edge, record.midpoint) };
    });
    labels.forEach(function (label) {
      nodes.forEach(function (node) {
        if (node.id === label.edge.source || node.id === label.edge.target) return;
        var area = localRectOverlapArea(label.rect, nodeRects[node.id]);
        if (!area) return;
        stats.labelNodeHits += 1;
        score += 4800 + area * 8;
        addPressure(label.edge.source, 7, false);
        addPressure(label.edge.target, 7, false);
        addPressure(node.id, 16, false);
      });
    });
    for (var firstLabelIndex = 0; firstLabelIndex < labels.length; firstLabelIndex += 1) {
      for (var secondLabelIndex = firstLabelIndex + 1; secondLabelIndex < labels.length; secondLabelIndex += 1) {
        var labelArea = localRectOverlapArea(labels[firstLabelIndex].rect, labels[secondLabelIndex].rect);
        if (!labelArea) continue;
        stats.labelPairs += 1;
        score += 4200 + labelArea * 10;
        addPressure(labels[firstLabelIndex].edge.source, 6, false);
        addPressure(labels[firstLabelIndex].edge.target, 6, false);
        addPressure(labels[secondLabelIndex].edge.source, 6, false);
        addPressure(labels[secondLabelIndex].edge.target, 6, false);
      }
    }
    stats.hardIssues = stats.nodePairs + stats.edgeNodeHits;
    stats.readabilityIssues = stats.hardIssues + stats.edgeCrossings + stats.edgePairs + stats.labelPairs + stats.labelNodeHits + stats.shortEdges;
    stats.issues = stats.readabilityIssues + stats.alignmentOffsets;
    var movedDistance = 0;
    var movementEnergy = 0;
    if (originalPositions) {
      workflow.nodes.forEach(function (item) {
        var original = originalPositions[item.id];
        if (!original) return;
        var distance = Math.sqrt(Math.pow(item.x - original.x, 2) + Math.pow(item.y - original.y, 2));
        movedDistance += distance;
        movementEnergy += distance * distance;
      });
      for (var firstNodeIndex = 0; firstNodeIndex < nodes.length; firstNodeIndex += 1) {
        var firstNode = nodes[firstNodeIndex];
        var firstOriginal = originalPositions[firstNode.id];
        if (!firstOriginal) continue;
        for (var secondNodeIndex = firstNodeIndex + 1; secondNodeIndex < nodes.length; secondNodeIndex += 1) {
          var secondNode = nodes[secondNodeIndex];
          var secondOriginal = originalPositions[secondNode.id];
          if (!secondOriginal) continue;
          var originalDx = secondOriginal.x - firstOriginal.x;
          var originalDy = secondOriginal.y - firstOriginal.y;
          var currentDx = secondNode.x - firstNode.x;
          var currentDy = secondNode.y - firstNode.y;
          if (Math.abs(originalDx) > 72 && originalDx * currentDx < 0) stats.orderFlips += 1;
          if (Math.abs(originalDy) > 54 && originalDy * currentDy < 0) stats.orderFlips += 1;
        }
      }
    }
    score += stats.orderFlips * 30000;
    return {
      score: score + movedDistance * 16 + movementEnergy * 0.08,
      rawScore: score,
      movedDistance: movedDistance,
      routes: routes,
      stats: stats,
      conflictNodes: conflictNodes,
      nodePressure: nodePressure,
      hardNodes: hardNodes,
      overlapNodes: overlapNodes,
      nodeConflicts: nodeConflicts,
      edgeNodeConflicts: edgeNodeConflicts,
      edgePairConflicts: edgePairConflicts,
      alignmentConflicts: alignmentConflicts,
      shortNodes: shortNodes,
      shortEdges: shortEdges
    };
  }

  function localTidyMoveLimit(item) {
    return item.type === "input" || item.type === "main" || isEndNode(item) ? 56 : 76;
  }

  // Keep the user's composition and make only local corrections. The old
  // arranger rebuilt graph ranks, which was too destructive for an editor.
  function legacyTidyCanvas(silent) {
    if (!workflow.nodes.length) return;
    var initialUndo = createUndoSnapshot("微调布局");
    cancelConnection();
    clearRouteLock();
    var originalPositions = {};
    workflow.nodes.forEach(function (item) {
      originalPositions[item.id] = { x: item.x, y: item.y };
    });
    var report = localLayoutReport(originalPositions);
    var initialIssues = report.stats.issues;
    var accepted = 0;
    var movedIds = {};
    var directions = [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
    ];
    var diagonalDirections = [
      { x: 0.7, y: 0.7 }, { x: -0.7, y: 0.7 }, { x: 0.7, y: -0.7 }, { x: -0.7, y: -0.7 }
    ];
    var steps = [12, 24, 36, 48];
    for (var pass = 0; pass < 3; pass += 1) {
      var conflictList = Object.keys(report.conflictNodes).map(function (id) { return getNode(id); }).filter(Boolean);
      if (!conflictList.length) break;
      conflictList.sort(function (a, b) {
        var aMoved = movedIds[a.id] ? 1 : 0;
        var bMoved = movedIds[b.id] ? 1 : 0;
        var aShort = report.shortNodes && report.shortNodes[a.id] ? 1 : 0;
        var bShort = report.shortNodes && report.shortNodes[b.id] ? 1 : 0;
        return bShort - aShort || aMoved - bMoved || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
      });
      var acceptedThisPass = false;
      conflictList.forEach(function (item) {
        var currentX = item.x;
        var currentY = item.y;
        var currentScore = report.score;
        var best = null;
        var currentOffset = originalPositions[item.id] || { x: currentX, y: currentY };
        var moveLimit = localTidyMoveLimit(item);
        var guidedDirections = [];
        (report.shortEdges || []).forEach(function (record) {
          var edge = record.edge;
          if (edge.source !== item.id && edge.target !== item.id) return;
          var other = getNode(edge.source === item.id ? edge.target : edge.source);
          var otherElement = other && nodeElement(other.id);
          var itemElement = nodeElement(item.id);
          if (!other || !otherElement || !itemElement) return;
          var itemSize = nodeDimensions(itemElement);
          var otherSize = nodeDimensions(otherElement);
          var itemCenter = { x: item.x + itemSize.width / 2, y: item.y + itemSize.height / 2 };
          var otherCenter = { x: other.x + otherSize.width / 2, y: other.y + otherSize.height / 2 };
          var dx = itemCenter.x - otherCenter.x;
          var dy = itemCenter.y - otherCenter.y;
          var distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 0.01) {
            dx = edge.source === item.id ? 1 : -1;
            dy = 0;
            distance = 1;
          }
          dx /= distance;
          dy /= distance;
          guidedDirections.push({ x: dx, y: dy });
          // A perpendicular trial often opens a short vertical branch while
          // keeping the main row intact.
          guidedDirections.push({ x: -dy, y: dx });
          guidedDirections.push({ x: dy, y: -dx });
        });
        function testDirections(directionList, stepList) {
          directionList.forEach(function (direction) {
            stepList.forEach(function (step) {
              var nextX = currentX + direction.x * step;
              var nextY = currentY + direction.y * step;
              if (nextX < 8 || nextY < 8) return;
              var totalOffset = Math.sqrt(Math.pow(nextX - currentOffset.x, 2) + Math.pow(nextY - currentOffset.y, 2));
              if (totalOffset > moveLimit + 0.01) return;
              item.x = nextX;
              item.y = nextY;
              var candidate = localLayoutReport(originalPositions);
              item.x = currentX;
              item.y = currentY;
              if (candidate.score >= currentScore - 10) return;
              if (!best || candidate.score < best.score) {
                best = { x: nextX, y: nextY, score: candidate.score, report: candidate };
              }
            });
          });
        }
        if (guidedDirections.length) testDirections(guidedDirections, [12, 24, 36, 48, 60, 72]);
        testDirections(directions, steps);
        if (!best) testDirections(diagonalDirections, [16, 32, 48]);
        if (!best) return;
        item.x = Math.round(best.x);
        item.y = Math.round(best.y);
        report = localLayoutReport(originalPositions);
        accepted += 1;
        acceptedThisPass = true;
        movedIds[item.id] = true;
      });
      if (!acceptedThisPass) break;
    }

    workflow.nodes.forEach(function (item) {
      item.x = Math.round(item.x);
      item.y = Math.round(item.y);
    });
    if (!accepted) {
      // The trial scorer mutates the in-memory route cache. Restore the
      // visible geometry even though no node position was accepted.
      drawEdges();
      if (silent !== true) showToast("当前布局没有需要调整的冲突");
      return;
    }
    setUndoSnapshot(initialUndo);
    workflow.viewLayout = "free";
    changed();
    render();
    if (silent !== true) {
      var remaining = localLayoutReport(originalPositions).stats.issues;
      var fixed = Math.max(0, initialIssues - remaining);
      showToast("已微调 " + Object.keys(movedIds).length + " 个节点" + (fixed ? "，减少 " + fixed + " 处遮挡" : ""));
    }
  }

  function setLayoutBusy(value) {
    layoutBusy = Boolean(value);
    if (layoutControl) layoutControl.classList.toggle("is-busy", layoutBusy);
    if (canvas) canvas.classList.toggle("is-layout-busy", layoutBusy);
    var primary = document.getElementById("fit-button");
    if (primary) primary.setAttribute("aria-busy", layoutBusy ? "true" : "false");
    updateUndoControl();
  }

  function closeLayoutMenu() {
    if (!layoutMenu || !layoutMenuButton) return;
    layoutMenu.hidden = true;
    layoutMenuButton.setAttribute("aria-expanded", "false");
  }

  function updateLayoutControlMode() {
    if (!canvasToolbar || !toolbarLeadGroup || !toolbarRightGroup || !layoutControl) return;
    // Measure the real toolbar contents in their expanded state. This follows
    // the center canvas width, including changes caused by either side panel.
    layoutControl.classList.remove("is-collapsed");
    function intrinsicGroupWidth(group) {
      var groupStyle = window.getComputedStyle(group);
      var gap = parseFloat(groupStyle.columnGap || groupStyle.gap) || 0;
      var visibleChildren = Array.prototype.filter.call(group.children, function (child) {
        var style = window.getComputedStyle(child);
        return style.display !== "none" && style.position !== "absolute";
      });
      return visibleChildren.reduce(function (total, child) {
        var style = window.getComputedStyle(child);
        var margins = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
        return total + Math.max(child.scrollWidth, child.getBoundingClientRect().width) + margins;
      }, Math.max(0, visibleChildren.length - 1) * gap);
    }
    var toolbarStyle = window.getComputedStyle(canvasToolbar);
    var horizontalPadding = parseFloat(toolbarStyle.paddingLeft) + parseFloat(toolbarStyle.paddingRight);
    var toolbarGap = parseFloat(toolbarStyle.columnGap || toolbarStyle.gap) || 0;
    var requiredWidth = intrinsicGroupWidth(toolbarLeadGroup) + intrinsicGroupWidth(toolbarRightGroup) + horizontalPadding + toolbarGap;
    var shouldCollapse = requiredWidth > canvasToolbar.clientWidth - 2;
    layoutControl.classList.toggle("is-collapsed", shouldCollapse);
    if (!shouldCollapse || layoutMenuButton.getAttribute("aria-expanded") !== "true") closeLayoutMenu();
  }

  function layoutPositionMap() {
    var positions = {};
    workflow.nodes.forEach(function (item) {
      positions[item.id] = { x: Number(item.x) || 0, y: Number(item.y) || 0 };
    });
    return positions;
  }

  function optimizePortsForTargets(targets) {
    if (!targets) return {};
    var originals = layoutPositionMap();
    workflow.nodes.forEach(function (item) {
      var target = targets[item.id];
      if (!target) return;
      item.x = Number(target.x) || 0;
      item.y = Number(target.y) || 0;
    });
    var choices = optimizeWorkflowPorts({ layout: layoutColumns() });
    workflow.nodes.forEach(function (item) {
      var original = originals[item.id];
      if (!original) return;
      item.x = original.x;
      item.y = original.y;
    });
    return choices;
  }

  function workflowPortSignature() {
    return workflow.edges.slice().sort(function (a, b) {
      return String(a.id).localeCompare(String(b.id));
    }).map(function (edge) {
      return [edge.id, edge.sourcePort || "", edge.targetPort || ""].join(":");
    }).join("|");
  }

  function workflowEffectivePortState() {
    var state = {};
    workflow.edges.forEach(function (edge) {
      state[edge.id] = {
        sourcePort: edge.sourcePort,
        targetPort: edge.targetPort,
        sourcePortPinned: Boolean(edge.sourcePortPinned),
        targetPortPinned: Boolean(edge.targetPortPinned)
      };
    });
    return state;
  }

  function applyWorkflowEffectivePortState(state) {
    if (!state) return;
    workflow.edges.forEach(function (edge) {
      var ports = state[edge.id];
      if (!ports) return;
      if (validPortSide(ports.sourcePort)) edge.sourcePort = ports.sourcePort;
      else delete edge.sourcePort;
      if (validPortSide(ports.targetPort)) edge.targetPort = ports.targetPort;
      else delete edge.targetPort;
      edge.sourcePortPinned = Boolean(ports.sourcePortPinned);
      edge.targetPortPinned = Boolean(ports.targetPortPinned);
    });
  }

  function workflowPortChangeCount(first, second) {
    var ids = {};
    Object.keys(first || {}).forEach(function (id) { ids[id] = true; });
    Object.keys(second || {}).forEach(function (id) { ids[id] = true; });
    return Object.keys(ids).reduce(function (count, id) {
      var before = first && first[id] || {};
      var after = second && second[id] || {};
      return count + (before.sourcePort !== after.sourcePort || before.targetPort !== after.targetPort ||
        Boolean(before.sourcePortPinned) !== Boolean(after.sourcePortPinned) ||
        Boolean(before.targetPortPinned) !== Boolean(after.targetPortPinned) ? 1 : 0);
    }, 0);
  }

  function layoutNodeSize(item) {
    return nodeDimensions(nodeElement(item.id));
  }

  function layoutMetric(item, positions) {
    var size = layoutNodeSize(item);
    var position = positions[item.id] || item;
    return {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
      centerX: position.x + size.width / 2,
      centerY: position.y + size.height / 2
    };
  }

  function limitTidyPosition(id, positions, originals, maxDistance) {
    var position = positions[id];
    var original = originals[id];
    if (!position || !original) return;
    var dx = position.x - original.x;
    var dy = position.y - original.y;
    var distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxDistance) {
      position.x = original.x + dx / distance * maxDistance;
      position.y = original.y + dy / distance * maxDistance;
    }
    position.x = Math.max(12, position.x);
    position.y = Math.max(12, position.y);
  }

  function moveTidyTarget(id, dx, dy, positions, originals, maxDistance) {
    var position = positions[id];
    if (!position) return false;
    var beforeX = position.x;
    var beforeY = position.y;
    position.x += dx;
    position.y += dy;
    limitTidyPosition(id, positions, originals, maxDistance == null ? 60 : maxDistance);
    return Math.abs(position.x - beforeX) > 0.1 || Math.abs(position.y - beforeY) > 0.1;
  }

  function separateTidyCollisions(positions, originals, iterations, maxDistance, collisionGap) {
    var corrected = 0;
    var gap = collisionGap == null ? 28 : collisionGap;
    var distanceLimit = maxDistance == null ? 60 : maxDistance;
    for (var pass = 0; pass < iterations; pass += 1) {
      var changedThisPass = false;
      for (var leftIndex = 0; leftIndex < workflow.nodes.length; leftIndex += 1) {
        var left = workflow.nodes[leftIndex];
        var leftMetric = layoutMetric(left, positions);
        for (var rightIndex = leftIndex + 1; rightIndex < workflow.nodes.length; rightIndex += 1) {
          var right = workflow.nodes[rightIndex];
          var rightMetric = layoutMetric(right, positions);
          var overlapX = (leftMetric.width + rightMetric.width) / 2 + gap - Math.abs(rightMetric.centerX - leftMetric.centerX);
          var overlapY = (leftMetric.height + rightMetric.height) / 2 + gap - Math.abs(rightMetric.centerY - leftMetric.centerY);
          if (overlapX <= 0 || overlapY <= 0) continue;
          var moveAlongX = overlapX <= overlapY;
          var direction;
          var amount;
          if (moveAlongX) {
            direction = rightMetric.centerX === leftMetric.centerX ? (rightIndex > leftIndex ? 1 : -1) : (rightMetric.centerX > leftMetric.centerX ? 1 : -1);
            amount = overlapX / 2 + 1;
            moveTidyTarget(left.id, -direction * amount, 0, positions, originals, distanceLimit);
            moveTidyTarget(right.id, direction * amount, 0, positions, originals, distanceLimit);
          } else {
            direction = rightMetric.centerY === leftMetric.centerY ? (rightIndex > leftIndex ? 1 : -1) : (rightMetric.centerY > leftMetric.centerY ? 1 : -1);
            amount = overlapY / 2 + 1;
            moveTidyTarget(left.id, 0, -direction * amount, positions, originals, distanceLimit);
            moveTidyTarget(right.id, 0, direction * amount, positions, originals, distanceLimit);
          }
          corrected += 1;
          changedThisPass = true;
          leftMetric = layoutMetric(left, positions);
        }
      }
      if (!changedThisPass) break;
    }
    return corrected;
  }

  function layoutPortPoint(item, side, positions) {
    var metric = layoutMetric(item, positions);
    if (side === "top") return { x: metric.centerX, y: metric.y };
    if (side === "bottom") return { x: metric.centerX, y: metric.y + metric.height };
    if (side === "left") return { x: metric.x, y: metric.centerY };
    return { x: metric.x + metric.width, y: metric.centerY };
  }

  function tidyShiftGroup(edge, positions, horizontal, direction, linearWorkflow) {
    var ids = {};
    if (linearWorkflow) {
      var queue = [edge.target];
      while (queue.length) {
        var id = queue.shift();
        if (ids[id]) continue;
        ids[id] = true;
        businessWorkflowEdges().forEach(function (candidate) {
          if (candidate.source === id && candidate.target !== candidate.source && !ids[candidate.target]) queue.push(candidate.target);
        });
      }
      return ids;
    }
    var target = getNode(edge.target);
    var targetMetric = target && layoutMetric(target, positions);
    if (!targetMetric) return ids;
    workflow.nodes.forEach(function (item) {
      var metric = layoutMetric(item, positions);
      if (horizontal) {
        if ((direction > 0 && metric.centerX >= targetMetric.centerX - 8) || (direction < 0 && metric.centerX <= targetMetric.centerX + 8)) ids[item.id] = true;
      } else if ((direction > 0 && metric.centerY >= targetMetric.centerY - 8) || (direction < 0 && metric.centerY <= targetMetric.centerY + 8)) {
        ids[item.id] = true;
      }
    });
    return ids;
  }

  function localReportIsBetter(candidate, current, minimumImprovement) {
    if (!candidate || !current) return false;
    if (candidate.stats.hardIssues !== current.stats.hardIssues) {
      return candidate.stats.hardIssues < current.stats.hardIssues;
    }
    if (candidate.stats.orderFlips > current.stats.orderFlips) return false;
    return candidate.score < current.score - (minimumImprovement == null ? 24 : minimumImprovement);
  }

  function buildSmartTidyPlan() {
    var originalPositions = layoutPositionMap();
    var originalPorts = workflowEffectivePortState();
    var report = localLayoutReport(originalPositions);
    var initialReport = report;
    var acceptedMoves = 0;

    function tryPortOptimization(currentReport) {
      if (!workflow.edges.length) return { report: currentReport, changed: false };
      var before = workflowEffectivePortState();
      optimizeWorkflowPorts({ layout: layoutColumns() });
      var after = workflowEffectivePortState();
      if (!workflowPortChangeCount(before, after)) return { report: currentReport, changed: false };
      var candidate = localLayoutReport(originalPositions);
      if (localReportIsBetter(candidate, currentReport, 180)) {
        return { report: candidate, changed: true };
      }
      applyWorkflowEffectivePortState(before);
      return { report: currentReport, changed: false };
    }

    var firstPortPass = tryPortOptimization(report);
    report = firstPortPass.report;

    function nodeCenter(item) {
      var size = nodeDimensions(nodeElement(item.id));
      return { x: item.x + size.width / 2, y: item.y + size.height / 2 };
    }

    function addDirection(list, seen, dx, dy) {
      var length = Math.sqrt(dx * dx + dy * dy);
      if (length < 0.01) return;
      var direction = { x: dx / length, y: dy / length };
      var key = Math.round(direction.x * 100) + ":" + Math.round(direction.y * 100);
      if (seen[key]) return;
      seen[key] = true;
      list.push(direction);
    }

    function adaptiveMoveLimit(item, currentReport) {
      var systemNode = item.type === "input" || item.type === "main" || isEndNode(item);
      var limit = systemNode ? 68 : 88;
      var pressure = currentReport.nodePressure[item.id] || 0;
      if (pressure >= 60) limit += 24;
      if (currentReport.overlapNodes[item.id]) limit += systemNode ? 64 : 88;
      else if (currentReport.hardNodes[item.id]) limit += systemNode ? 16 : 24;
      return Math.min(204, limit);
    }

    function downstreamGroup(edge) {
      var ids = {};
      var queue = [edge.target];
      while (queue.length) {
        var id = queue.shift();
        if (ids[id]) continue;
        if (id === edge.source) return [];
        ids[id] = true;
        businessWorkflowEdges().forEach(function (candidate) {
          if (candidate.source === id && candidate.target !== id && !ids[candidate.target]) queue.push(candidate.target);
        });
      }
      return Object.keys(ids);
    }

    function improveShortEdgesAsGroups(currentReport) {
      var changed = false;
      (currentReport.shortEdges || []).slice().forEach(function (record) {
        var edge = record.edge;
        var source = getNode(edge.source);
        var target = getNode(edge.target);
        var groupIds = source && target ? downstreamGroup(edge) : [];
        if (!source || !target || !groupIds.length || groupIds.length === workflow.nodes.length) return;
        var sourceCenter = nodeCenter(source);
        var targetCenter = nodeCenter(target);
        var dx = targetCenter.x - sourceCenter.x;
        var dy = targetCenter.y - sourceCenter.y;
        var length = Math.sqrt(dx * dx + dy * dy);
        if (length < 0.01) {
          dx = 1;
          dy = 0;
          length = 1;
        }
        dx /= length;
        dy /= length;
        var starts = {};
        groupIds.forEach(function (id) {
          var node = getNode(id);
          if (node) starts[id] = { x: node.x, y: node.y };
        });
        var best = null;
        [16, 32, 52, 72].forEach(function (step) {
          var valid = groupIds.every(function (id) {
            var node = getNode(id);
            var start = starts[id];
            var original = originalPositions[id];
            if (!node || !start || !original) return false;
            var nextX = start.x + dx * step;
            var nextY = start.y + dy * step;
            var systemNode = node.type === "input" || node.type === "main" || isEndNode(node);
            var limit = systemNode ? 104 : 144;
            return nextX >= 12 && nextY >= 12 && Math.sqrt(Math.pow(nextX - original.x, 2) + Math.pow(nextY - original.y, 2)) <= limit;
          });
          if (!valid) return;
          groupIds.forEach(function (id) {
            var node = getNode(id);
            node.x = starts[id].x + dx * step;
            node.y = starts[id].y + dy * step;
          });
          var candidate = localLayoutReport(originalPositions);
          groupIds.forEach(function (id) {
            var node = getNode(id);
            node.x = starts[id].x;
            node.y = starts[id].y;
          });
          if (!localReportIsBetter(candidate, currentReport, 40)) return;
          if (!best || candidate.score < best.report.score) best = { step: step, report: candidate };
        });
        if (!best) return;
        groupIds.forEach(function (id) {
          var node = getNode(id);
          node.x = Math.round(starts[id].x + dx * best.step);
          node.y = Math.round(starts[id].y + dy * best.step);
        });
        currentReport = localLayoutReport(originalPositions);
        acceptedMoves += 1;
        changed = true;
      });
      return { report: currentReport, changed: changed };
    }

    var groupPass = improveShortEdgesAsGroups(report);
    report = groupPass.report;
    if (groupPass.changed) {
      var groupPortPass = tryPortOptimization(report);
      report = groupPortPass.report;
    }

    function candidatePositions(item, currentReport, moveLimit) {
      var current = { x: item.x, y: item.y };
      var original = originalPositions[item.id] || current;
      var center = nodeCenter(item);
      var direct = [];
      var directions = [];
      var directionKeys = {};
      var candidateKeys = {};
      var candidates = [];

      function addCandidate(x, y) {
        x = Math.round(x);
        y = Math.round(y);
        if (x < 12 || y < 12) return;
        var distance = Math.sqrt(Math.pow(x - original.x, 2) + Math.pow(y - original.y, 2));
        if (distance > moveLimit + 0.1) return;
        var key = x + ":" + y;
        if (candidateKeys[key] || (x === current.x && y === current.y)) return;
        candidateKeys[key] = true;
        candidates.push({ x: x, y: y });
      }

      (currentReport.alignmentConflicts || []).forEach(function (conflict) {
        if (conflict.second.id === item.id) {
          if (conflict.axis === "x") direct.push({ x: current.x - conflict.delta, y: current.y });
          else direct.push({ x: current.x, y: current.y - conflict.delta });
        } else if (conflict.first.id === item.id) {
          if (conflict.axis === "x") direct.push({ x: current.x + conflict.delta, y: current.y });
          else direct.push({ x: current.x, y: current.y + conflict.delta });
        }
      });

      (currentReport.nodeConflicts || []).forEach(function (conflict) {
        var other = conflict.first.id === item.id ? conflict.second : conflict.second.id === item.id ? conflict.first : null;
        if (!other) return;
        var otherCenter = nodeCenter(other);
        var dx = center.x - otherCenter.x;
        var dy = center.y - otherCenter.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) dx = item.id.localeCompare(other.id) >= 0 ? 1 : -1;
        var itemRect = localNodeRect(item, 16);
        var otherRect = localNodeRect(other, 16);
        var overlapX = Math.min(itemRect.right, otherRect.right) - Math.max(itemRect.left, otherRect.left);
        var overlapY = Math.min(itemRect.bottom, otherRect.bottom) - Math.max(itemRect.top, otherRect.top);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX <= overlapY) direct.push({ x: current.x + (dx >= 0 ? overlapX + 4 : -overlapX - 4), y: current.y });
          else direct.push({ x: current.x, y: current.y + (dy >= 0 ? overlapY + 4 : -overlapY - 4) });
        }
        addDirection(directions, directionKeys, dx, dy);
        addDirection(directions, directionKeys, dx >= 0 ? 1 : -1, 0);
        addDirection(directions, directionKeys, 0, dy >= 0 ? 1 : -1);
      });

      (currentReport.shortEdges || []).forEach(function (record) {
        var edge = record.edge;
        if (edge.source !== item.id && edge.target !== item.id) return;
        var other = getNode(edge.source === item.id ? edge.target : edge.source);
        if (!other) return;
        var otherCenter = nodeCenter(other);
        var dx = center.x - otherCenter.x;
        var dy = center.y - otherCenter.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) dx = edge.source === item.id ? -1 : 1;
        var distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
        var shortfall = Math.max(12, record.minimum - record.length + 6);
        direct.push({ x: current.x + dx / distance * shortfall, y: current.y + dy / distance * shortfall });
        addDirection(directions, directionKeys, dx, dy);
        addDirection(directions, directionKeys, -dy, dx);
        addDirection(directions, directionKeys, dy, -dx);
      });

      (currentReport.edgeNodeConflicts || []).forEach(function (conflict) {
        if (conflict.node.id === item.id) {
          addDirection(directions, directionKeys, center.x - conflict.point.x, center.y - conflict.point.y);
          var source = getNode(conflict.edge.source);
          var target = getNode(conflict.edge.target);
          if (source && target) {
            var sourceCenter = nodeCenter(source);
            var targetCenter = nodeCenter(target);
            var edgeDx = targetCenter.x - sourceCenter.x;
            var edgeDy = targetCenter.y - sourceCenter.y;
            addDirection(directions, directionKeys, -edgeDy, edgeDx);
            addDirection(directions, directionKeys, edgeDy, -edgeDx);
          }
        } else if (conflict.edge.source === item.id || conflict.edge.target === item.id) {
          var blockerCenter = nodeCenter(conflict.node);
          addDirection(directions, directionKeys, center.x - blockerCenter.x, center.y - blockerCenter.y);
        }
      });

      (currentReport.edgePairConflicts || []).forEach(function (conflict) {
        [conflict.first, conflict.second].forEach(function (edge) {
          if (edge.source !== item.id && edge.target !== item.id) return;
          var other = getNode(edge.source === item.id ? edge.target : edge.source);
          if (!other) return;
          var otherCenter = nodeCenter(other);
          var dx = otherCenter.x - center.x;
          var dy = otherCenter.y - center.y;
          addDirection(directions, directionKeys, -dy, dx);
          addDirection(directions, directionKeys, dy, -dx);
        });
      });

      direct.forEach(function (position) { addCandidate(position.x, position.y); });
      [
        { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
        { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }
      ].forEach(function (direction) { addDirection(directions, directionKeys, direction.x, direction.y); });
      var steps = [16, 40, 72, 112, 160, 200];
      directions.slice(0, 7).forEach(function (direction) {
        steps.forEach(function (step) {
          if (candidates.length >= 20) return;
          addCandidate(current.x + direction.x * step, current.y + direction.y * step);
        });
      });
      return candidates;
    }

    var maximumPasses = report.stats.hardIssues ? 3 : 2;
    for (var pass = 0; pass < maximumPasses; pass += 1) {
      var conflictList = Object.keys(report.conflictNodes).map(function (id) { return getNode(id); }).filter(Boolean);
      conflictList.sort(function (first, second) {
        var pressureDifference = (report.nodePressure[second.id] || 0) - (report.nodePressure[first.id] || 0);
        return pressureDifference || first.y - second.y || first.x - second.x || first.id.localeCompare(second.id);
      });
      var acceptedThisPass = false;
      conflictList.slice(0, 12).forEach(function (item) {
        var currentX = item.x;
        var currentY = item.y;
        var best = null;
        var candidates = candidatePositions(item, report, adaptiveMoveLimit(item, report));
        candidates.forEach(function (position) {
          item.x = position.x;
          item.y = position.y;
          var candidate = localLayoutReport(originalPositions);
          item.x = currentX;
          item.y = currentY;
          if (!localReportIsBetter(candidate, report, 24)) return;
          if (!best || candidate.score < best.report.score) {
            best = { x: position.x, y: position.y, report: candidate };
          }
        });
        if (!best) return;
        item.x = best.x;
        item.y = best.y;
        report = localLayoutReport(originalPositions);
        acceptedMoves += 1;
        acceptedThisPass = true;
      });
      var portPass = tryPortOptimization(report);
      report = portPass.report;
      if (!acceptedThisPass && !portPass.changed) break;
    }

    // The scorer intentionally limits normal corrections so a tidy action
    // preserves the user's composition. A severely stacked import can need a
    // wider radius than that local budget allows, so finish unresolved card
    // collisions with a geometry-only pass. This branch is never entered for
    // an already readable canvas.
    if (report.stats.nodePairs) {
      var beforeCollisionPositions = layoutPositionMap();
      var collisionTargets = layoutPositionMap();
      var collisionMoveLimit = Math.max(420, Math.ceil(Math.sqrt(workflow.nodes.length)) * 180);
      separateTidyCollisions(collisionTargets, originalPositions, 56, collisionMoveLimit, 34);
      workflow.nodes.forEach(function (item) {
        var target = collisionTargets[item.id];
        if (!target) return;
        item.x = Math.round(target.x);
        item.y = Math.round(target.y);
      });
      var collisionReport = localLayoutReport(originalPositions);
      if (collisionReport.stats.nodePairs < report.stats.nodePairs) {
        acceptedMoves += 1;
        report = collisionReport;
        var collisionPortPass = tryPortOptimization(report);
        report = collisionPortPass.report;
      } else {
        workflow.nodes.forEach(function (item) {
          var previous = beforeCollisionPositions[item.id];
          if (!previous) return;
          item.x = previous.x;
          item.y = previous.y;
        });
      }
    }

    workflow.nodes.forEach(function (item) {
      item.x = Math.round(item.x);
      item.y = Math.round(item.y);
    });
    report = localLayoutReport(originalPositions);
    var finalPositions = layoutPositionMap();
    var finalPorts = workflowEffectivePortState();
    var movedIds = workflow.nodes.filter(function (item) {
      var original = originalPositions[item.id];
      var target = finalPositions[item.id];
      return original && target && (Math.abs(original.x - target.x) > 0.5 || Math.abs(original.y - target.y) > 0.5);
    }).map(function (item) { return item.id; });
    var portChanges = workflowPortChangeCount(originalPorts, finalPorts);

    workflow.nodes.forEach(function (item) {
      var original = originalPositions[item.id];
      if (!original) return;
      item.x = original.x;
      item.y = original.y;
    });
    applyWorkflowEffectivePortState(originalPorts);

    return {
      targets: finalPositions,
      ports: finalPorts,
      movedIds: movedIds,
      portChanges: portChanges,
      acceptedMoves: acceptedMoves,
      initialReport: initialReport,
      finalReport: report,
      changed: Boolean(movedIds.length || portChanges)
    };
  }

  function stableLayoutNodeOrder() {
    var sourceOrder = {};
    workflow.nodes.forEach(function (item, index) { sourceOrder[item.id] = index; });
    return workflow.nodes.slice().sort(function (a, b) {
      if (a.type === "input" && b.type !== "input") return -1;
      if (b.type === "input" && a.type !== "input") return 1;
      if (isEndNode(a) && !isEndNode(b)) return 1;
      if (isEndNode(b) && !isEndNode(a)) return -1;
      return a.x - b.x || a.y - b.y || sourceOrder[a.id] - sourceOrder[b.id];
    });
  }

  function anchorLayoutTargets(targets) {
    var originalMinX = Math.min.apply(Math, workflow.nodes.map(function (item) { return item.x; }));
    var originalMinY = Math.min.apply(Math, workflow.nodes.map(function (item) { return item.y; }));
    var targetValues = Object.keys(targets).map(function (id) { return targets[id]; });
    var targetMinX = Math.min.apply(Math, targetValues.map(function (position) { return position.x; }));
    var targetMinY = Math.min.apply(Math, targetValues.map(function (position) { return position.y; }));
    var offsetX = Math.max(18, originalMinX) - targetMinX;
    var offsetY = Math.max(18, originalMinY) - targetMinY;
    Object.keys(targets).forEach(function (id) {
      targets[id].x = Math.round(targets[id].x + offsetX);
      targets[id].y = Math.round(targets[id].y + offsetY);
    });
    return targets;
  }

  function fallbackLayeredTargets() {
    var ordered = stableLayoutNodeOrder();
    var ranks = {};
    ordered.forEach(function (item) { ranks[item.id] = 0; });
    var eligible = businessWorkflowEdges().filter(function (edge) {
      var source = getNode(edge.source);
      var target = getNode(edge.target);
      if (!source || !target || source.id === target.id) return false;
      return source.type === "input" || isEndNode(target) || source.x <= target.x + 8;
    });
    for (var pass = 0; pass < ordered.length; pass += 1) {
      var changedRank = false;
      eligible.forEach(function (edge) {
        var nextRank = Math.min(ordered.length - 1, ranks[edge.source] + 1);
        if (nextRank > ranks[edge.target]) {
          ranks[edge.target] = nextRank;
          changedRank = true;
        }
      });
      if (!changedRank) break;
    }
    var layers = {};
    ordered.forEach(function (item) {
      var rank = ranks[item.id] || 0;
      if (!layers[rank]) layers[rank] = [];
      layers[rank].push(item);
    });
    var rankKeys = Object.keys(layers).map(Number).sort(function (a, b) { return a - b; });
    var maxHeight = 0;
    rankKeys.forEach(function (rank) {
      var height = layers[rank].reduce(function (sum, item) { return sum + layoutNodeSize(item).height; }, 0) + Math.max(0, layers[rank].length - 1) * 62;
      maxHeight = Math.max(maxHeight, height);
      layers[rank].sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    });
    var targets = {};
    var cursorX = 0;
    rankKeys.forEach(function (rank) {
      var layer = layers[rank];
      var layerWidth = Math.max.apply(Math, layer.map(function (item) { return layoutNodeSize(item).width; }));
      var layerHeight = layer.reduce(function (sum, item) { return sum + layoutNodeSize(item).height; }, 0) + Math.max(0, layer.length - 1) * 62;
      var cursorY = (maxHeight - layerHeight) / 2;
      layer.forEach(function (item) {
        targets[item.id] = { x: cursorX, y: cursorY };
        cursorY += layoutNodeSize(item).height + 62;
      });
      cursorX += layerWidth + 124;
    });
    return anchorLayoutTargets(targets);
  }

  function portAwareChainTargets() {
    if (workflow.nodes.length < 2) return null;
    var outgoing = {};
    var incoming = {};
    workflow.nodes.forEach(function (item) {
      outgoing[item.id] = [];
      incoming[item.id] = [];
    });
    businessWorkflowEdges().forEach(function (edge) {
      if (edge.source === edge.target || !outgoing[edge.source] || !incoming[edge.target]) return;
      outgoing[edge.source].push(edge);
      incoming[edge.target].push(edge);
    });
    if (workflow.nodes.some(function (item) { return outgoing[item.id].length > 1 || incoming[item.id].length > 1; })) return null;
    var starts = workflow.nodes.filter(function (item) { return incoming[item.id].length === 0; });
    if (starts.length !== 1) return null;
    var ordered = [starts[0]];
    var chainEdges = [];
    var seen = {};
    seen[starts[0].id] = true;
    while (outgoing[ordered[ordered.length - 1].id].length) {
      var edge = outgoing[ordered[ordered.length - 1].id][0];
      var next = getNode(edge.target);
      if (!next || seen[next.id]) return null;
      chainEdges.push(edge);
      ordered.push(next);
      seen[next.id] = true;
    }
    if (ordered.length !== workflow.nodes.length || chainEdges.length !== workflow.nodes.length - 1) return null;
    var targets = {};
    targets[ordered[0].id] = { x: 0, y: 0 };
    chainEdges.forEach(function (edge, index) {
      var source = ordered[index];
      var target = ordered[index + 1];
      var sourceSize = layoutNodeSize(source);
      var targetSize = layoutNodeSize(target);
      var sourcePosition = targets[source.id];
      var sourceSide = validPortSide(edge.sourcePort) ? edge.sourcePort : "right";
      var targetSide = validPortSide(edge.targetPort) ? edge.targetPort : "left";
      var gap = 78;
      var nextPosition;
      if (sourceSide === "right" && targetSide === "left") {
        nextPosition = { x: sourcePosition.x + sourceSize.width + gap, y: sourcePosition.y + (sourceSize.height - targetSize.height) / 2 };
      } else if (sourceSide === "left" && targetSide === "right") {
        nextPosition = { x: sourcePosition.x - targetSize.width - gap, y: sourcePosition.y + (sourceSize.height - targetSize.height) / 2 };
      } else if (sourceSide === "bottom" && targetSide === "top") {
        nextPosition = { x: sourcePosition.x + (sourceSize.width - targetSize.width) / 2, y: sourcePosition.y + sourceSize.height + gap };
      } else if (sourceSide === "top" && targetSide === "bottom") {
        nextPosition = { x: sourcePosition.x + (sourceSize.width - targetSize.width) / 2, y: sourcePosition.y - targetSize.height - gap };
      } else if (sourceSide === "bottom" || targetSide === "top") {
        nextPosition = { x: sourcePosition.x + sourceSize.width + gap, y: sourcePosition.y + sourceSize.height + gap };
      } else if (sourceSide === "top" || targetSide === "bottom") {
        nextPosition = { x: sourcePosition.x + sourceSize.width + gap, y: sourcePosition.y - targetSize.height - gap };
      } else {
        nextPosition = { x: sourcePosition.x + sourceSize.width + gap, y: sourcePosition.y + (sourceSize.height - targetSize.height) / 2 };
      }
      targets[target.id] = nextPosition;
    });
    return anchorLayoutTargets(targets);
  }

  function placeSystemLayoutNodes(targets) {
    var input = getNode("input");
    var end = getNode("end");
    var positioned = workflow.nodes.filter(function (item) { return targets[item.id]; });
    function bounds() {
      if (!positioned.length) return { left: 0, right: 0, top: 0, bottom: 0 };
      return positioned.reduce(function (result, item) {
        var size = layoutNodeSize(item);
        var position = targets[item.id];
        result.left = Math.min(result.left, position.x);
        result.right = Math.max(result.right, position.x + size.width);
        result.top = Math.min(result.top, position.y);
        result.bottom = Math.max(result.bottom, position.y + size.height);
        return result;
      }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    }
    function positionBeside(item, peer, side, gap) {
      var itemSize = layoutNodeSize(item);
      var peerSize = layoutNodeSize(peer);
      var peerPosition = targets[peer.id];
      if (side === "top") return { x: peerPosition.x + (peerSize.width - itemSize.width) / 2, y: peerPosition.y - itemSize.height - gap };
      if (side === "bottom") return { x: peerPosition.x + (peerSize.width - itemSize.width) / 2, y: peerPosition.y + peerSize.height + gap };
      if (side === "left") return { x: peerPosition.x - itemSize.width - gap, y: peerPosition.y + (peerSize.height - itemSize.height) / 2 };
      return { x: peerPosition.x + peerSize.width + gap, y: peerPosition.y + (peerSize.height - itemSize.height) / 2 };
    }
    function clearSystemPosition(item, desired, side) {
      var itemSize = layoutNodeSize(item);
      function collides(position) {
        return positioned.some(function (other) {
          var otherPosition = targets[other.id];
          if (!otherPosition) return false;
          var otherSize = layoutNodeSize(other);
          var gap = 24;
          return position.x < otherPosition.x + otherSize.width + gap &&
            position.x + itemSize.width + gap > otherPosition.x &&
            position.y < otherPosition.y + otherSize.height + gap &&
            position.y + itemSize.height + gap > otherPosition.y;
        });
      }
      if (!collides(desired)) return desired;
      var horizontalDock = side === "left" || side === "right";
      var step = horizontalDock ? itemSize.height + 34 : itemSize.width + 34;
      for (var ring = 1; ring <= 7; ring += 1) {
        var before = horizontalDock ? { x: desired.x, y: desired.y - ring * step } : { x: desired.x - ring * step, y: desired.y };
        var after = horizontalDock ? { x: desired.x, y: desired.y + ring * step } : { x: desired.x + ring * step, y: desired.y };
        if (!collides(before)) return before;
        if (!collides(after)) return after;
      }
      return desired;
    }
    if (input) {
      var inputEdge = workflow.edges.find(function (edge) { return edge.source === input.id && targets[edge.target]; });
      if (inputEdge) {
        var inputPeer = getNode(inputEdge.target);
        var targetSide = validPortSide(inputEdge.targetPort) ? inputEdge.targetPort : "left";
        targets[input.id] = clearSystemPosition(input, positionBeside(input, inputPeer, targetSide, 72), targetSide);
      } else {
        var inputBounds = bounds();
        var inputSize = layoutNodeSize(input);
        targets[input.id] = { x: inputBounds.left - inputSize.width - 72, y: (inputBounds.top + inputBounds.bottom - inputSize.height) / 2 };
      }
      positioned.push(input);
    }
    if (end) {
      var terminationEdge = workflow.edges.find(function (edge) { return edge.target === end.id && targets[edge.source]; });
      if (terminationEdge) {
        var endPeer = getNode(terminationEdge.source);
        var sourceSide = validPortSide(terminationEdge.sourcePort) ? terminationEdge.sourcePort : "right";
        targets[end.id] = clearSystemPosition(end, positionBeside(end, endPeer, sourceSide, 72), sourceSide);
      } else {
        var endBounds = bounds();
        var endSize = layoutNodeSize(end);
        targets[end.id] = { x: endBounds.right + 72, y: (endBounds.top + endBounds.bottom - endSize.height) / 2 };
      }
      positioned.push(end);
    }
    return targets;
  }

  function elkLayeredTargets() {
    if (!layoutEngine) return Promise.resolve(fallbackLayeredTargets());
    var ordered = stableLayoutNodeOrder();
    // Input and End participate in the same graph. Docking them after ELK ran
    // prevented the crossing minimizer from seeing the real first/last edges.
    var layoutNodes = ordered.slice();
    if (!layoutNodes.length) {
      var emptyTargets = {};
      var input = getNode("input");
      var end = getNode("end");
      if (input) emptyTargets[input.id] = { x: 0, y: 0 };
      if (end) emptyTargets[end.id] = { x: input ? layoutNodeSize(input).width + 96 : 0, y: 0 };
      return Promise.resolve(anchorLayoutTargets(emptyTargets));
    }
    var validIds = {};
    layoutNodes.forEach(function (item) { validIds[item.id] = true; });
    var graph = {
      id: "workflow-root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "SPLINES",
        "elk.padding": "[top=24,left=24,bottom=24,right=24]",
        "elk.spacing.nodeNode": "56",
        "elk.spacing.componentComponent": "88",
        "elk.separateConnectedComponents": "false",
        "elk.layered.spacing.nodeNodeBetweenLayers": "104",
        "elk.layered.spacing.edgeNodeBetweenLayers": "38",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
        "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
        "elk.layered.cycleBreaking.strategy": "GREEDY",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
        "elk.layered.nodePlacement.favorStraightEdges": "true",
        "elk.layered.feedbackEdges": "true",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.thoroughness": "30",
        "elk.randomSeed": "1"
      },
      children: layoutNodes.map(function (item) {
        var size = layoutNodeSize(item);
        var child = { id: item.id, width: size.width, height: size.height };
        if (item.type === "input") {
          child.layoutOptions = { "elk.layered.layering.layerConstraint": "FIRST" };
        } else if (isEndNode(item)) {
          child.layoutOptions = { "elk.layered.layering.layerConstraint": "LAST" };
        }
        return child;
      }),
      edges: businessWorkflowEdges().slice().sort(function (a, b) {
        var sourceOrder = String(a.source).localeCompare(String(b.source));
        if (sourceOrder) return sourceOrder;
        var targetOrder = String(a.target).localeCompare(String(b.target));
        if (targetOrder) return targetOrder;
        return String(a.id).localeCompare(String(b.id));
      }).filter(function (edge) {
        return edge.source !== edge.target && validIds[edge.source] && validIds[edge.target];
      }).map(function (edge) {
        return {
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
          priority: edge.kind === "strong" ? 10 : isTerminationWorkflowEdge(edge) ? 8 : 2
        };
      })
    };
    return layoutEngine.layout(graph).then(function (result) {
      var targets = {};
      (result.children || []).forEach(function (child) {
        if (Number.isFinite(child.x) && Number.isFinite(child.y)) targets[child.id] = { x: child.x, y: child.y };
      });
      if (Object.keys(targets).length !== layoutNodes.length) return fallbackLayeredTargets();
      return anchorLayoutTargets(targets);
    });
  }

  function animateViewportToGraph(duration, done) {
    var start = clone(viewport);
    fitViewportOnly(true);
    var target = clone(viewport);
    viewport = start;
    applyViewport();
    var startedAt = null;
    function frame(timestamp) {
      if (startedAt == null) startedAt = timestamp;
      var progress = duration ? Math.min(1, (timestamp - startedAt) / duration) : 1;
      var eased = 1 - Math.pow(1 - progress, 3);
      viewport.x = start.x + (target.x - start.x) * eased;
      viewport.y = start.y + (target.y - start.y) * eased;
      viewport.k = start.k + (target.k - start.k) * eased;
      applyViewport();
      if (progress < 1) {
        layoutAnimationFrame = requestAnimationFrame(frame);
      } else {
        viewport = target;
        applyViewport();
        layoutAnimationFrame = null;
        if (done) done();
      }
    }
    layoutAnimationFrame = requestAnimationFrame(frame);
  }

  function animateViewportToVisibleNodes(duration, done) {
    if (!workflow.nodes.length) {
      if (done) done();
      return;
    }
    var start = clone(viewport);
    var target = clone(viewport);
    var bounds = workflow.nodes.reduce(function (result, item) {
      var size = layoutNodeSize(item);
      result.left = Math.min(result.left, item.x);
      result.top = Math.min(result.top, item.y);
      result.right = Math.max(result.right, item.x + size.width);
      result.bottom = Math.max(result.bottom, item.y + size.height);
      return result;
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    var width = canvas.clientWidth || 850;
    var height = canvas.clientHeight || 600;
    var margin = 30;
    var graphWidth = (bounds.right - bounds.left) * target.k;
    var graphHeight = (bounds.bottom - bounds.top) * target.k;
    if (graphWidth <= width - margin * 2) {
      var minX = target.x + bounds.left * target.k;
      var maxX = target.x + bounds.right * target.k;
      if (minX < margin) target.x += margin - minX;
      else if (maxX > width - margin) target.x -= maxX - (width - margin);
    }
    if (graphHeight <= height - margin * 2) {
      var minY = target.y + bounds.top * target.k;
      var maxY = target.y + bounds.bottom * target.k;
      if (minY < margin) target.y += margin - minY;
      else if (maxY > height - margin) target.y -= maxY - (height - margin);
    }
    if (Math.abs(target.x - start.x) < 0.5 && Math.abs(target.y - start.y) < 0.5) {
      if (done) done();
      return;
    }
    var startedAt = null;
    function frame(timestamp) {
      if (startedAt == null) startedAt = timestamp;
      var progress = duration ? Math.min(1, (timestamp - startedAt) / duration) : 1;
      var eased = 1 - Math.pow(1 - progress, 3);
      viewport.x = start.x + (target.x - start.x) * eased;
      viewport.y = start.y + (target.y - start.y) * eased;
      applyViewport();
      if (progress < 1) {
        layoutAnimationFrame = requestAnimationFrame(frame);
      } else {
        viewport.x = target.x;
        viewport.y = target.y;
        applyViewport();
        layoutAnimationFrame = null;
        if (done) done();
      }
    }
    layoutAnimationFrame = requestAnimationFrame(frame);
  }

  function animateLayoutTargets(targets, options) {
    options = options || {};
    if (layoutBusy || !targets) return;
    var initialUndo = options.initialUndo || createUndoSnapshot(options.label || "整理布局");
    var currentPorts = workflowEffectivePortState();
    var portChanges = options.targetPorts ? workflowPortChangeCount(currentPorts, options.targetPorts) : 0;
    var moved = workflow.nodes.filter(function (item) {
      var target = targets[item.id];
      return target && (Math.abs(target.x - item.x) > 0.5 || Math.abs(target.y - item.y) > 0.5);
    });
    if (!moved.length && !portChanges) {
      if (options.silent !== true) showToast(options.emptyMessage || "当前布局已经清晰，无需调整");
      if (typeof options.onComplete === "function") options.onComplete({ moved: 0, portChanges: 0 });
      return;
    }
    if (portChanges) applyWorkflowEffectivePortState(options.targetPorts);
    if (!moved.length) {
      cancelConnection();
      hideAlignmentGuides();
      clearRouteLock();
      workflow.viewLayout = options.viewLayout || "free";
      setUndoSnapshot(initialUndo);
      changed();
      render();
      if (options.silent !== true) showToast(options.message || "已优化连接点，节点位置保持不变");
      if (typeof options.onComplete === "function") options.onComplete({ moved: 0, portChanges: portChanges });
      return;
    }
    var starts = layoutPositionMap();
    var duration = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : (options.duration || 300);
    cancelConnection();
    hideAlignmentGuides();
    clearRouteLock();
    setLayoutBusy(true);
    var startedAt = null;

    function finish() {
      setLayoutBusy(false);
      if (options.silent !== true) showToast(options.message || "布局已整理");
      if (typeof options.onComplete === "function") options.onComplete({ moved: moved.length, portChanges: portChanges });
    }

    function frame(timestamp) {
      if (startedAt == null) startedAt = timestamp;
      var progress = duration ? Math.min(1, (timestamp - startedAt) / duration) : 1;
      var eased = 1 - Math.pow(1 - progress, 3);
      moved.forEach(function (item) {
        var start = starts[item.id];
        var target = targets[item.id];
        item.x = start.x + (target.x - start.x) * eased;
        item.y = start.y + (target.y - start.y) * eased;
        var element = nodeElement(item.id);
        if (element) {
          element.style.left = item.x + "px";
          element.style.top = item.y + "px";
        }
      });
      drawEdges();
      if (progress < 1) {
        layoutAnimationFrame = requestAnimationFrame(frame);
        return;
      }
      moved.forEach(function (item) {
        item.x = Math.round(targets[item.id].x);
        item.y = Math.round(targets[item.id].y);
      });
      layoutAnimationFrame = null;
      workflow.viewLayout = options.viewLayout || "free";
      setUndoSnapshot(initialUndo);
      changed();
      render();
      requestAnimationFrame(function () {
        if (options.fit) animateViewportToGraph(220, finish);
        else if (options.keepVisible) animateViewportToVisibleNodes(170, finish);
        else finish();
      });
    }
    layoutAnimationFrame = requestAnimationFrame(frame);
  }

  function tidyCanvas(silent, options) {
    options = options || {};
    if (!workflow.nodes.length || layoutBusy) return;
    closeLayoutMenu();
    cancelConnection();
    clearRouteLock();
    var initialUndo = options.initialUndo || createUndoSnapshot("智能整理布局");
    setLayoutBusy(true);
    requestAnimationFrame(function () {
      var result;
      try {
        result = buildSmartTidyPlan();
      } catch (error) {
        setLayoutBusy(false);
        drawEdges();
        var errorMessage = options.errorMessage || "智能整理未完成，请重试";
        if (silent !== true) showToast(errorMessage);
        console.error(error);
        if (typeof options.onComplete === "function") options.onComplete({ changed: false, error: true, message: errorMessage, moved: 0, portChanges: 0, issueReduction: 0 });
        return;
      }
      setLayoutBusy(false);
      if (!result.changed) {
        drawEdges();
        var emptyMessage = options.emptyMessage || "当前布局已经清晰，无需调整";
        if (silent !== true) showToast(emptyMessage);
        if (typeof options.onComplete === "function") options.onComplete({ changed: false, error: false, message: emptyMessage, moved: 0, portChanges: 0, issueReduction: 0 });
        return;
      }
      var issueReduction = Math.max(0, result.initialReport.stats.issues - result.finalReport.stats.issues);
      var details = [];
      if (result.movedIds.length) details.push(result.movedIds.length + " 个节点");
      if (result.portChanges) details.push(result.portChanges + " 条连线端口");
      var message = options.actionLabel ? options.actionLabel + "，并自动优化 " + details.join("、") : "已优化 " + details.join("、");
      if (issueReduction) message += "，减少 " + issueReduction + " 处可读性冲突";
      animateLayoutTargets(result.targets, {
        label: "智能整理布局",
        initialUndo: initialUndo,
        targetPorts: result.ports,
        duration: 320,
        silent: silent,
        keepVisible: options.keepVisible !== false,
        viewLayout: "free",
        emptyMessage: "当前布局已经清晰，无需调整",
        message: message,
        onComplete: function () {
          if (typeof options.onComplete === "function") {
            options.onComplete({
              changed: true,
              error: false,
              message: message,
              moved: result.movedIds.length,
              portChanges: result.portChanges,
              issueReduction: issueReduction
            });
          }
        }
      });
    });
  }

  function tidyAfterLayeredLayout(layoutUndo, silent) {
    // Treat all three stages as one command. The shared snapshot restores
    // node positions, ports, and the viewport with a single Undo action.
    setUndoSnapshot(layoutUndo);
    tidyCanvas(true, {
      initialUndo: layoutUndo,
      keepVisible: false,
      errorMessage: "分层重排已完成，但智能整理未完成",
      onComplete: function (result) {
        setLayoutBusy(true);
        animateViewportToGraph(240, function () {
          setLayoutBusy(false);
          if (silent === true) return;
          if (result && result.error) {
            showToast("已完成分层重排和适应画布，但智能整理未完成");
            return;
          }
          var message = "已依次完成分层重排、智能整理和适应画布";
          var details = [];
          if (result && result.moved) details.push(result.moved + " 个节点");
          if (result && result.portChanges) details.push(result.portChanges + " 条连线端口");
          if (details.length) message += "；优化 " + details.join("、");
          if (result && result.issueReduction) message += "，减少 " + result.issueReduction + " 处可读性冲突";
          showToast(message);
        });
      }
    });
  }

  function arrangeCanvas(silent) {
    if (!workflow.nodes.length || layoutBusy) return;
    closeLayoutMenu();
    cancelConnection();
    clearRouteLock();
    setLayoutBusy(true);
    var layoutUndo = createUndoSnapshot("分层重排");
    var signature = workflow.nodes.map(function (item) { return item.id + ":" + item.x + ":" + item.y; }).join("|") + "/" + workflow.edges.map(function (edge) { return edge.id; }).join("|");
    elkLayeredTargets().then(function (targets) {
      var currentSignature = workflow.nodes.map(function (item) { return item.id + ":" + item.x + ":" + item.y; }).join("|") + "/" + workflow.edges.map(function (edge) { return edge.id; }).join("|");
      setLayoutBusy(false);
      if (signature !== currentSignature) return;
      // Evaluate ports against the positions ELK actually produced. Restore
      // the current coordinates before the animation starts so the first
      // frame does not teleport any card.
      var beforePorts = workflowPortSignature();
      optimizePortsForTargets(targets);
      var portsChanged = beforePorts !== workflowPortSignature();
      var targetsMove = workflow.nodes.some(function (item) {
        var target = targets[item.id];
        return target && (Math.abs(target.x - item.x) > 0.5 || Math.abs(target.y - item.y) > 0.5);
      });
      if (!targetsMove && portsChanged) {
        workflow.viewLayout = "clear-lanes";
        setUndoSnapshot(layoutUndo);
        changed();
        render();
        tidyAfterLayeredLayout(layoutUndo, silent);
        return;
      }
      animateLayoutTargets(targets, {
        label: "分层重排",
        duration: 340,
        silent: true,
        fit: false,
        initialUndo: layoutUndo,
        viewLayout: "clear-lanes",
        message: "已按执行方向完成分层重排",
        onComplete: function () { tidyAfterLayeredLayout(layoutUndo, silent); }
      });
    }).catch(function () {
      setLayoutBusy(false);
      var fallbackTargets = fallbackLayeredTargets();
      var beforePorts = workflowPortSignature();
      optimizePortsForTargets(fallbackTargets);
      var portsChanged = beforePorts !== workflowPortSignature();
      var targetsMove = workflow.nodes.some(function (item) {
        var target = fallbackTargets[item.id];
        return target && (Math.abs(target.x - item.x) > 0.5 || Math.abs(target.y - item.y) > 0.5);
      });
      if (!targetsMove && portsChanged) {
        workflow.viewLayout = "clear-lanes";
        setUndoSnapshot(layoutUndo);
        changed();
        render();
        tidyAfterLayeredLayout(layoutUndo, silent);
        return;
      }
      animateLayoutTargets(fallbackTargets, {
        label: "分层重排",
        duration: 340,
        silent: true,
        fit: false,
        initialUndo: layoutUndo,
        viewLayout: "clear-lanes",
        message: "已按执行方向完成分层重排",
        onComplete: function () { tidyAfterLayeredLayout(layoutUndo, silent); }
      });
    });
  }

  function preferredEdgeKind(source, target) {
    if (DIRECT_EDGE_MODE) {
      if (source === "input") return "strong";
      if (target === "end") return "termination";
      if (isTerminationAgent(source)) return "weak";
      var existing = outgoingAgentEdges(source)[0];
      return existing ? existing.kind : directEdgeKind;
    }
    var sourceNode = getNode(source);
    return isSelectorNode(sourceNode) ? "weak" : "strong";
  }

  function hidePendingEdge() {
    pendingEdge.setAttribute("hidden", "");
    pendingEdge.removeAttribute("d");
  }

  function cancelConnection() {
    linking = null;
    linkDrag = null;
    hidePendingEdge();
    nodeLayer.querySelectorAll(".is-link-target, .is-link-invalid").forEach(function (element) {
      element.classList.remove("is-link-target");
      element.classList.remove("is-link-invalid");
    });
  }

  function screenToWorld(clientX, clientY) {
    var bounds = canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - viewport.x) / viewport.k,
      y: (clientY - bounds.top - viewport.y) / viewport.k
    };
  }

  function nearestPortSide(element, clientX, clientY) {
    var rect = element.getBoundingClientRect();
    var distances = {
      top: Math.abs(clientY - rect.top),
      right: Math.abs(clientX - rect.right),
      bottom: Math.abs(clientY - rect.bottom),
      left: Math.abs(clientX - rect.left)
    };
    return Object.keys(distances).sort(function (a, b) { return distances[a] - distances[b]; })[0];
  }

  function drawPendingEdge(clientX, clientY) {
    if (!linkDrag) {
      hidePendingEdge();
      return;
    }
    linkDrag.lastClientX = clientX;
    linkDrag.lastClientY = clientY;
    var source = nodeElement(linkDrag.source);
    if (!source) {
      cancelConnection();
      return;
    }
    var sourceNode = getNode(linkDrag.source);
    var start = portAnchor(sourceNode, source, linkDrag.sourceSide);
    var target = linkDrag.target && getNode(linkDrag.target);
    var targetElement = target && nodeElement(target.id);
    var opposite = { top: "bottom", right: "left", bottom: "top", left: "right" };
    var endSide = targetElement && validPortSide(linkDrag.targetSide) ? linkDrag.targetSide : opposite[linkDrag.sourceSide];
    var end = target && targetElement ? portAnchor(target, targetElement, endSide) : screenToWorld(clientX, clientY);
    pendingEdge.setAttribute("class", "pending-edge " + preferredEdgeKind(linkDrag.source, linkDrag.target));
    pendingEdge.setAttribute("d", curvePath(start, end, linkDrag.sourceSide, endSide, 0));
    pendingEdge.removeAttribute("hidden");
  }

  function interactionMoved(state, event) {
    return Math.abs(event.clientX - state.startX) > 3 || Math.abs(event.clientY - state.startY) > 3;
  }

  function startLink(event, sourceId, sourceSide) {
    if (DIRECT_EDGE_MODE && sourceId === "main") {
      showConnectionError("Main Agent 的调度出口由系统维护，不能手动创建连接", sourceId);
      return;
    }
    if (DIRECT_EDGE_MODE && sourceId === "end") {
      showConnectionError("结束节点不能创建出边", sourceId);
      return;
    }
    if (DIRECT_EDGE_MODE && sourceId === "input" && workflow.edges.some(function (edge) { return edge.source === "input"; })) {
      showConnectionError("用户输入只能有一条出边，请先删除现有连接", sourceId);
      return;
    }
    if (sourceId === "end") {
      // The end module is itself a selector: it may expose the optional
      // return-to-Main branch, while its incoming termination edge remains
      // system-managed.
    } else if (isEndNode(getNode(sourceId))) {
      showToast("结束模块只能由当前结束 Agent 自动连接");
      return;
    }
    selectedEdge = null;
    linking = sourceId;
    selected = sourceId;
    linkDrag = {
      source: sourceId,
      sourceSide: validPortSide(sourceSide) ? sourceSide : "right",
      startX: event.clientX,
      startY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      moved: false,
      clickMode: true,
      target: null,
      targetSide: null
    };
    render();
    requestAnimationFrame(function () { drawPendingEdge(event.clientX, event.clientY); });
  }

  function connectionTargetAt(clientX, clientY) {
    var element = document.elementFromPoint(clientX, clientY);
    var port = element && element.closest(".node-port");
    var node = (port && port.closest("[data-node]")) || (element && element.closest("[data-node]"));
    if (!node) return null;
    var item = getNode(node.dataset.node);
    if (!item) return null;
    if (linkDrag && item.id === linkDrag.source) {
      var sameNodeSide = port && validPortSide(port.dataset.port) ? port.dataset.port : nearestPortSide(node, clientX, clientY);
      // A self-loop must leave through one port and return through another;
      // hovering the source port itself is still treated as an empty target.
      if (sameNodeSide === linkDrag.sourceSide) return null;
    }
    return {
      item: item,
      port: port,
      side: port && validPortSide(port.dataset.port) ? port.dataset.port : nearestPortSide(node, clientX, clientY)
    };
  }

  function updateLinkTarget(clientX, clientY) {
    if (!linkDrag) return null;
    var target = connectionTargetAt(clientX, clientY);
    var targetId = target && (target.item.id !== linkDrag.source || target.side !== linkDrag.sourceSide) ? target.item.id : null;
    if (targetId === linkDrag.target && (!target || target.side === linkDrag.targetSide)) return target;
    linkDrag.target = targetId;
    linkDrag.targetSide = target ? target.side : null;
    nodeLayer.querySelectorAll(".agent-node").forEach(function (element) {
      element.classList.toggle("is-link-target", element.dataset.node === targetId);
      var invalid = target && element.dataset.node === targetId && (
        target.item.type === "input" ||
        (target.item.id === "end" && workflow.edges.some(function (edge) { return edge.target === "end" && (!linkDrag || edge.source !== linkDrag.source); }))
      );
      element.classList.toggle("is-link-invalid", Boolean(invalid));
    });
    return target;
  }

  library.addEventListener("click", function (event) {
    if (blockDemoEdit()) return;
    var target = event.target.closest("[data-template]");
    if (!target) return;
    var template = templates[target.dataset.template];
    if (!template) return;
    if (event.target.closest(".library-delete")) {
      if (template.builtin && !DIRECT_EDGE_MODE) {
        showToast("Main Agent 是内置模板，不能从 Agent 库删除");
        return;
      }
      if (!window.confirm("确认从常驻 Agent 中删除“" + template.name + "”吗？画布中已有的节点不会受影响。")) return;
      agentLibrary = agentLibrary.filter(function (entry) { return entry.id !== template.id; });
      saveAgentLibrary();
      renderLibrary();
      showToast(template.name + " 已从常驻 Agent 删除");
      return;
    }
    addAgent(template);
  });

  function handleNodeMouseDown(event) {
    if (isDemoLocked() && !RUNTIME_MODE) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      var readOnlyItem = getNode(event.currentTarget.dataset.node);
      if (readOnlyItem) {
        selected = readOnlyItem.id;
        selectedEdge = null;
        syncNodeSelection();
        if (RUNTIME_MODE) window.parent.postMessage({ type: "scienceevolve.workflow.runtime.select", nodeId: selected, scopeId: runtimeScopeId }, window.location.origin);
      }
      return;
    }
    if (RUNTIME_MODE) {
      if (event.button !== 0 || layoutBusy) return;
      event.stopPropagation();
      event.preventDefault();
      var runtimeElement = event.currentTarget;
      var runtimeItem = getNode(runtimeElement.dataset.node);
      if (!runtimeItem || event.target.closest("button")) return;
      selectedEdge = null;
      selected = runtimeItem.id;
      syncNodeSelection();
      drawEdges();
      window.parent.postMessage({ type: "scienceevolve.workflow.runtime.select", nodeId: selected, scopeId: runtimeScopeId }, window.location.origin);
      hideAlignmentGuides();
      drag = {
        item: runtimeItem,
        element: runtimeElement,
        startX: event.clientX,
        startY: event.clientY,
        x: runtimeItem.x,
        y: runtimeItem.y,
        moved: false,
        initialRouteLock: null,
        initialUndo: null
      };
      runtimeElement.classList.add("is-selected");
      runtimeElement.classList.add("is-dragging");
      runtimeRoutes = null;
      routeLock = captureRouteLock();
      drag.initialRouteLock = routeLock;
      return;
    }
    if (layoutBusy) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    // Prevent the browser's native HTML drag from taking over the canvas
    // interaction. Node movement is handled by the window-level pointer loop.
    event.preventDefault();
    var element = event.currentTarget;
    var item = getNode(element.dataset.node);
    if (!item) return;
    var port = event.target.closest(".node-port");
    if (linkDrag) {
      var target = connectionTargetAt(event.clientX, event.clientY);
      if (target && (target.item.id !== linkDrag.source || target.side !== linkDrag.sourceSide)) {
        linkDrag.moved = true;
        updateLinkTarget(event.clientX, event.clientY);
        drawPendingEdge(event.clientX, event.clientY);
        event.preventDefault();
        return;
      }
    }
    if (port && (!isEndNode(item) || item.id === "end")) {
      startLink(event, item.id, port.dataset.port);
      event.preventDefault();
      return;
    }
    selectedEdge = null;
    selected = item.id;
    if (isSelectorNode(item)) {
      hoveredSelectorId = item.id;
      hoveredControlGroup = item.id;
      updateMainControlVisibility();
    } else if (hoveredSelectorId) {
      hoveredSelectorId = null;
      if (!mainControlHover) hoveredControlGroup = null;
      updateMainControlVisibility();
    }
    syncNodeSelection();
    if (isAnchorLocked(item)) {
      // System nodes are freely movable; their connection ports remain active.
      renderInspector();
      return;
    }
    if (event.target.closest(".node-more")) {
      render();
      event.preventDefault();
      return;
    }
    if (event.target.closest("button")) return;
    hideAlignmentGuides();
    drag = {
      item: item,
      element: element,
      startX: event.clientX,
      startY: event.clientY,
      x: item.x,
      y: item.y,
      moved: false,
      initialRouteLock: null,
      initialUndo: createUndoSnapshot("移动 " + item.name)
    };
    element.classList.add("is-selected");
    element.classList.add("is-dragging");
    renderInspector();
    drawEdges();
    routeLock = captureRouteLock();
    drag.initialRouteLock = routeLock;
  }

  function bindNodeMouseEvents() {
    nodeLayer.querySelectorAll(".agent-node").forEach(function (element) {
      if (element.dataset.eventsBound === "true") return;
      element.dataset.eventsBound = "true";
      element.addEventListener("mousedown", handleNodeMouseDown);
      var item = getNode(element.dataset.node);
      element.addEventListener("mouseenter", function () {
        hoveredNodeId = element.dataset.node;
        drawEdges();
      });
      element.addEventListener("mouseleave", function () {
        if (hoveredNodeId === element.dataset.node) hoveredNodeId = null;
        drawEdges();
      });
      if (item && isSelectorNode(item)) {
        element.addEventListener("mouseenter", function () { setSelectorHover(item.id, true); });
        element.addEventListener("mouseleave", function () { setSelectorHover(item.id, false); });
      }
      if (element.dataset.node === workflow.mainAgentId) {
        element.addEventListener("mouseenter", function () { setMainControlHover("main", true, true); });
        element.addEventListener("mouseleave", function () { setMainControlHover("main", false, true); });
      }
    });
  }

  function handleWindowMouseMove(event) {
    if (drag) {
      if (isAnchorLocked(drag.item)) {
        drag.element.classList.remove("is-dragging");
        drag = null;
        clearRouteLock();
        return;
      }
      var width = canvas.clientWidth || 800;
      var height = canvas.clientHeight || 600;
      var nodeWidth = drag.element.offsetWidth || 194;
      var nodeHeight = drag.element.offsetHeight || 92;
      var minX = (8 - viewport.x) / viewport.k;
      var minY = (8 - viewport.y) / viewport.k;
      if (anchorMode() === "top" && !isAnchorNode(drag.item)) {
        var mainNode = getNode(workflow.mainAgentId);
        var mainElement = mainNode && nodeElement(mainNode.id);
        if (mainNode && mainElement && drag.item.id !== mainNode.id) {
          minY = Math.max(minY, mainNode.y + nodeDimensions(mainElement).height + 48);
        }
      }
      var maxX = Math.max(minX, (width - 8 - viewport.x) / viewport.k - nodeWidth);
      var maxY = Math.max(minY, (height - 8 - viewport.y) / viewport.k - nodeHeight);
      var proposedX = Math.max(minX, Math.min(maxX, drag.x + (event.clientX - drag.startX) / viewport.k));
      var proposedY = Math.max(minY, Math.min(maxY, drag.y + (event.clientY - drag.startY) / viewport.k));
      var snapped = snapDraggedNode(drag.item, drag.element, proposedX, proposedY);
      drag.item.x = Math.round(Math.max(minX, Math.min(maxX, snapped.x)));
      drag.item.y = Math.round(Math.max(minY, Math.min(maxY, snapped.y)));
      drag.moved = drag.moved || interactionMoved(drag, event);
      if (RUNTIME_MODE) {
        runtimeLayoutOverrides[drag.item.id] = { x: drag.item.x, y: drag.item.y };
        runtimeRoutes = null;
      }
      drag.element.style.left = drag.item.x + "px";
      drag.element.style.top = drag.item.y + "px";
      scheduleEdgeDraw();
      return;
    }
    if (linkDrag) {
      linkDrag.moved = linkDrag.moved || interactionMoved(linkDrag, event);
      if (linkDrag.moved) linkDrag.clickMode = false;
      updateLinkTarget(event.clientX, event.clientY);
      drawPendingEdge(event.clientX, event.clientY);
      return;
    }
    if (pan) {
      pan.moved = pan.moved || interactionMoved(pan, event);
      viewport.x = Math.round(pan.x + event.clientX - pan.startX);
      viewport.y = Math.round(pan.y + event.clientY - pan.startY);
      applyViewport();
    }
  }

  function finishMouseInteraction(event, cancelled) {
    hideAlignmentGuides();
    if (drag) {
      if (isAnchorLocked(drag.item)) {
        drag.item.x = drag.x;
        drag.item.y = drag.y;
        drag.element.classList.remove("is-dragging");
        drag = null;
        clearRouteLock();
        return;
      }
      if (RUNTIME_MODE && !cancelled && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && interactionMoved(drag, event)) {
        handleWindowMouseMove(event);
        hideAlignmentGuides();
      }
      flushEdgeDraw();
      var completedDrag = drag;
      selected = completedDrag.item.id;
      completedDrag.element.classList.remove("is-dragging");
      var movedNode = completedDrag.moved;
      if (!movedNode) {
        completedDrag.item.x = completedDrag.x;
        completedDrag.item.y = completedDrag.y;
        completedDrag.element.style.left = completedDrag.x + "px";
        completedDrag.element.style.top = completedDrag.y + "px";
      }
      drag = null;
      if (movedNode) {
        if (!RUNTIME_MODE) setUndoSnapshot(completedDrag.initialUndo);
        workflow.viewLayout = "free";
        if (!RUNTIME_MODE) changed();
        // 以拖动结束时的路径作为下一次交互的基准，保证后续重绘仍保持同一拓扑。
        routeLock = captureRouteLock();
      } else {
        routeLock = completedDrag.initialRouteLock;
      }
      // 拖动结束时保留最后一次 mousemove 已绘制的 SVG 路径。完整 render 会重建
      // 节点层并在下一帧再次路由，容易让用户看到一瞬间的连线跳变。
      syncNodeSelection();
      renderInspector();
      renderCanvasMeta();
      if (!movedNode) drawEdges();
      return;
    }
    if (pan) {
      var movedCanvas = pan.moved;
      pan = null;
      canvas.classList.remove("is-panning");
      if (!movedCanvas && !cancelled) {
        selected = null;
        selectedEdge = null;
        render();
      }
      return;
    }
    if (!linkDrag) return;
    if (cancelled || event.clientX == null || event.clientY == null) {
      cancelConnection();
      render();
      return;
    }
    var target = updateLinkTarget(event.clientX, event.clientY);
    var sourceId = linkDrag.source;
    var sourceSide = linkDrag.sourceSide;
    var targetSide = linkDrag.targetSide;
    var clickMode = linkDrag.clickMode;
    var targetItem = target && target.item;
    cancelConnection();
    if (!cancelled && targetItem && (targetItem.id !== sourceId || targetSide !== sourceSide)) {
      addEdge(sourceId, targetItem.id, preferredEdgeKind(sourceId, targetItem.id), sourceSide, targetSide);
      return;
    }
    // 单击连接点后保留连接状态，后续移动鼠标或再次点击目标连接点都可以继续完成连线。
    // 按住拖动但松开在空白处仍会取消，避免误留下悬空连接。
    if (!cancelled && clickMode) {
      linkDrag = {
        source: sourceId,
        sourceSide: sourceSide,
        startX: event.clientX,
        startY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        moved: false,
        clickMode: true,
        target: null,
        targetSide: null
      };
      linking = sourceId;
      render();
      if (event.clientX != null && event.clientY != null) drawPendingEdge(event.clientX, event.clientY);
      return;
    }
    render();
  }

  function handleWindowMouseUp(event) {
    finishMouseInteraction(event, false);
  }
  window.addEventListener("mousemove", handleWindowMouseMove);
  window.addEventListener("mouseup", handleWindowMouseUp);
  window.addEventListener("blur", function () {
    finishMouseInteraction({}, true);
  });
  window.addEventListener("dragstart", function (event) {
    event.preventDefault();
  });

  edgeLayer.addEventListener("mousedown", function (event) {
    if (isDemoLocked()) {
      event.preventDefault();
      return;
    }
    var target = event.target.closest("[data-edge-hit]");
    if (!target || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancelConnection();
    selected = null;
    selectedEdge = target.getAttribute("data-edge-hit");
    render();
  });

  canvas.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || event.target.closest("[data-node], [data-edge-hit], button, input, textarea, select")) return;
    var wasConnecting = Boolean(linking || linkDrag);
    cancelConnection();
    pan = {
      startX: event.clientX,
      startY: event.clientY,
      x: viewport.x,
      y: viewport.y,
      moved: false
    };
    canvas.classList.add("is-panning");
    if (wasConnecting) render();
    event.preventDefault();
  });

  canvas.addEventListener("wheel", function (event) {
    event.preventDefault();
    var factor = event.deltaY < 0 ? 1.1 : 0.9;
    setZoom(viewport.k * factor, event.clientX, event.clientY);
    if (linkDrag) drawPendingEdge(event.clientX, event.clientY);
  }, { passive: false });

  connectButton.addEventListener("click", function () {
    if (blockDemoEdit()) return;
    cancelConnection();
    render();
    showToast("请从任意连接点拖到另一个 Agent 的连接点或卡片边缘");
  });

  inspector.addEventListener("input", function (event) {
    if (blockDemoEdit()) {
      event.preventDefault();
      renderInspector();
      return;
    }
    if (event.target.id === "workflow-termination-condition") {
      captureInputUndo(event.target, "修改终止条件");
      workflow.terminationCondition = event.target.value;
      changed();
      return;
    }
    var mcpIndex = event.target.dataset.mcpIndex;
    var mcpField = event.target.dataset.mcpField;
    var mcpItem = getNode(selected);
    if (mcpIndex != null && mcpField && mcpItem && Array.isArray(mcpItem.mcpServers) && mcpItem.mcpServers[Number(mcpIndex)]) {
      mcpItem.mcpServers[Number(mcpIndex)][mcpField] = event.target.value;
      changed();
      return;
    }
    var key = event.target.dataset.field;
    var item = getNode(selected);
    if (!key || !item) return;
    if (item.id === "main" && key === "name") {
      event.target.value = "Main Agent";
      return;
    }
    captureInputUndo(event.target, key === "description" ? "修改职责说明" : key === "instructions" ? "修改 Agent 指令" : key === "choicePrompt" ? "修改弱边选择 Prompt" : "修改 Agent 名称");
    item[key] = event.target.value;
    if (key === "choicePrompt") {
      var missingPrompt = !String(item.choicePrompt || "").trim();
      var promptSection = event.target.closest(".weak-choice-prompt");
      if (promptSection) promptSection.classList.toggle("is-required-missing", missingPrompt);
      event.target.setAttribute("aria-invalid", missingPrompt ? "true" : "false");
    }
    if (key === "name" || key === "description") clearRouteLock();
    changed();
    if (key === "name" || key === "description") {
      renderNodeLayer();
      drawEdges();
    }
  });

  inspector.addEventListener("change", function (event) {
    if (blockDemoEdit()) {
      event.preventDefault();
      renderInspector();
      return;
    }
    if (event.target.matches("[data-agent-permission]")) {
      var permissionItem = getNode(selected);
      if (!permissionItem) {
        render();
        return;
      }
      var nextPermission = normalizePermission(event.target.value, permissionItem.id === "main" ? "yolo" : "workspace");
      if (permissionItem.permission === nextPermission) return;
      pushUndo("修改运行权限");
      permissionItem.permission = nextPermission;
      changed();
      render();
      showToast(permissionItem.name + " 已切换为" + permissionInfo(nextPermission).name);
      return;
    }
    if (event.target.matches("[data-session-persistence]")) {
      var sessionItem = getNode(selected);
      if (!sessionItem || sessionItem.id === "main") {
        render();
        return;
      }
      pushUndo("修改持续 session");
      sessionItem.sessionPersistence = Boolean(event.target.checked);
      workflow.sessionPersistence = workflow.sessionPersistence || {};
      workflow.sessionPersistence[selected] = sessionItem.sessionPersistence;
      changed();
      render();
      return;
    }
    if (event.target.dataset.agentSkillMode) {
      var skillItem = getNode(selected);
      var skillId = event.target.dataset.agentSkillMode;
      if (!skillItem) return;
      pushUndo("修改 Skill 加载方式");
      skillItem.skills = normalizeStringList(skillItem.skills).filter(function (skill) { return skill !== skillId; });
      skillItem.autoSkills = normalizeStringList(skillItem.autoSkills).filter(function (skill) { return skill !== skillId; });
      (event.target.value === "auto" ? skillItem.autoSkills : skillItem.skills).push(skillId);
      changed();
      render();
      return;
    }
    if (event.target.id === "workflow-input-target") {
      updateInputTarget(event.target.value);
      return;
    }
    if (event.target.id === "workflow-termination-agent") {
      if (DIRECT_EDGE_MODE) {
        if (event.target.value && !validWorkflowNode(workflow.nodes, event.target.value, false)) return;
        if (!setDirectTerminationAgent(event.target.value || null, false)) {
          showToast("该 Agent 不能作为结束 Agent：请确保它没有强出边");
          render();
        }
        return;
      }
      if (!validWorkflowNode(workflow.nodes, event.target.value, false)) return;
      if (DIRECT_EDGE_MODE && !canBeTerminationAgent(event.target.value)) {
        showToast("该 Agent 已有强边，需先删除或改成弱边才能设为结束 Agent");
        render();
        return;
      }
      pushUndo("修改结束 Agent");
      workflow.terminationAgentId = event.target.value;
      syncTerminationEdge();
      syncEndNodePosition(false);
      clearRouteLock();
      changed();
      render();
      showToast("结束 Agent 已设置为 " + getNode(event.target.value).name);
      return;
    }
    if (event.target.id === "selected-edge-source-port" || event.target.id === "selected-edge-target-port") {
      var portConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
      if (!portConnection || !validPortSide(event.target.value)) return;
      if (rejectMainDispatchEdit(portConnection)) {
        render();
        return;
      }
      pushUndo("调整连接点");
      if (event.target.id === "selected-edge-source-port") {
        portConnection.sourcePort = event.target.value;
        portConnection.sourcePortPreference = event.target.value;
        portConnection.sourcePortPinned = true;
      } else {
        portConnection.targetPort = event.target.value;
        portConnection.targetPortPreference = event.target.value;
        portConnection.targetPortPinned = true;
      }
      clearRouteLock();
      workflow.viewLayout = "free";
      changed();
      render();
      return;
    }
    if (event.target.id === "selected-edge-kind") {
      var selectedConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
      if (!selectedConnection) return;
      var edgeKindUndo = createUndoSnapshot("修改连接类型");
      if (!setEdgeKind(selectedConnection, event.target.value)) {
        render();
        return;
      }
      setUndoSnapshot(edgeKindUndo);
      clearRouteLock();
      changed();
      render();
      return;
    }
    if (event.target.dataset.field === "model") {
      pushUndo("修改模型");
      getNode(selected).model = event.target.value;
      clearRouteLock();
      changed();
      render();
      return;
    }
    var row = event.target.closest("[data-edge]");
    if (row && event.target.classList.contains("edge-kind-choice")) {
      var rowEdge = workflow.edges.find(function (edge) { return edge.id === row.dataset.edge; });
      var rowKindUndo = createUndoSnapshot("修改连接类型");
      if (!setEdgeKind(rowEdge, event.target.value)) {
        render();
        return;
      }
      setUndoSnapshot(rowKindUndo);
      clearRouteLock();
      changed();
      render();
    }
  });

  inspector.addEventListener("click", function (event) {
    if (blockDemoEdit()) {
      event.preventDefault();
      return;
    }
    var decisionButton = event.target.closest("[data-decision-by]");
    if (decisionButton) {
      event.preventDefault();
      var decisionSourceId = decisionButton.dataset.decisionSource || selected;
      var decisionItem = getNode(decisionSourceId);
      var weakCount = decisionItem ? workflow.edges.filter(function (edge) {
        return edge.source === decisionSourceId && edge.kind === "weak" && !isTerminationWorkflowEdge(edge) && !isMainDispatchEdge(edge);
      }).length : 0;
      if (!decisionItem || decisionItem.id === "main" || weakCount < 2) {
        showToast("至少需要两条弱边才能更改决策者");
        render();
        return;
      }
      var nextDecision = decisionButton.dataset.decisionBy === "agent" ? "agent" : "main";
      selected = decisionSourceId;
      selectedEdge = null;
      if (decisionItem.decisionBy === nextDecision) {
        showToast("当前已由" + (nextDecision === "agent" ? "当前 Agent" : "Main Agent") + "选择");
        render();
        return;
      }
      pushUndo("修改弱边决策者");
      decisionItem.decisionBy = nextDecision;
      workflow.weakDecisionBy = workflow.weakDecisionBy || {};
      workflow.weakDecisionBy[decisionSourceId] = nextDecision;
      changed();
      render();
      showToast("弱边将由" + (nextDecision === "agent" ? "当前 Agent" : "Main Agent") + "选择");
      return;
    }
    var addSkillButton = event.target.closest("#add-agent-skill");
    if (addSkillButton) {
      var skillItem = getNode(selected);
      var skillSelect = document.getElementById("agent-skill-add");
      var skillId = skillSelect && skillSelect.value;
      if (!skillItem || !skillId) return;
      pushUndo("添加 Skill");
      skillItem.skills = normalizeStringList(skillItem.skills);
      skillItem.autoSkills = normalizeStringList(skillItem.autoSkills).filter(function (skill) { return skillItem.skills.indexOf(skill) < 0; });
      if (skillItem.skills.indexOf(skillId) < 0 && skillItem.autoSkills.indexOf(skillId) < 0) skillItem.skills.push(skillId);
      changed();
      render();
      showToast("已添加 Skill：" + skillInfo(skillId).name);
      return;
    }
    var removeSkillButton = event.target.closest("[data-remove-agent-skill]");
    if (removeSkillButton) {
      var removeSkillItem = getNode(selected);
      var removeSkillId = removeSkillButton.dataset.removeAgentSkill;
      if (!removeSkillItem) return;
      pushUndo("移除 Skill");
      removeSkillItem.skills = normalizeStringList(removeSkillItem.skills).filter(function (skill) { return skill !== removeSkillId; });
      removeSkillItem.autoSkills = normalizeStringList(removeSkillItem.autoSkills).filter(function (skill) { return skill !== removeSkillId; });
      changed();
      render();
      return;
    }
    var addMcpButton = event.target.closest("#add-agent-mcp");
    if (addMcpButton) {
      var mcpItem = getNode(selected);
      var mcpNameField = document.getElementById("agent-mcp-name");
      var mcpUrlField = document.getElementById("agent-mcp-url");
      var mcpName = mcpNameField && mcpNameField.value.trim();
      var mcpUrl = mcpUrlField && mcpUrlField.value.trim();
      if (!mcpItem || !mcpName || !mcpUrl) {
        showToast("请填写 MCP 名称和 URL");
        return;
      }
      try {
        var parsedMcpUrl = new URL(mcpUrl);
        if (parsedMcpUrl.protocol !== "http:" && parsedMcpUrl.protocol !== "https:") throw new Error("protocol");
      } catch (error) {
        showToast("MCP URL 仅支持 http:// 或 https://");
        return;
      }
      mcpItem.mcpServers = normalizeMcpServers(mcpItem.mcpServers);
      if (mcpItem.mcpServers.length >= 32) {
        showToast("每个 Agent 最多可配置 32 个 MCP");
        return;
      }
      if (mcpItem.mcpServers.some(function (server) { return server.name.toLowerCase() === mcpName.toLowerCase(); })) {
        showToast("MCP 名称不能重复");
        return;
      }
      pushUndo("添加 MCP");
      mcpItem.mcpServers.push({ name: mcpName.slice(0, 120), url: mcpUrl.slice(0, 2048) });
      changed();
      render();
      showToast("已添加 MCP：" + mcpName);
      return;
    }
    var removeMcpButton = event.target.closest("[data-remove-mcp]");
    if (removeMcpButton) {
      var removeMcpItem = getNode(selected);
      var removeMcpIndex = Number(removeMcpButton.dataset.removeMcp);
      if (!removeMcpItem || !Array.isArray(removeMcpItem.mcpServers) || !removeMcpItem.mcpServers[removeMcpIndex]) return;
      pushUndo("移除 MCP");
      removeMcpItem.mcpServers.splice(removeMcpIndex, 1);
      changed();
      render();
      return;
    }
    var newKindButton = event.target.closest("[data-new-edge-kind]");
    if (newKindButton) {
      setDirectEdgeKind(newKindButton.dataset.newEdgeKind);
      return;
    }
    var selectedKindButton = event.target.closest("[data-set-edge-kind]");
    if (selectedKindButton) {
      var selectedKindEdge = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
      var selectedKindUndo = createUndoSnapshot("修改连接类型");
      if (!selectedKindEdge || !setEdgeKind(selectedKindEdge, selectedKindButton.dataset.setEdgeKind)) {
        render();
        return;
      }
      setUndoSnapshot(selectedKindUndo);
      directEdgeKind = selectedKindEdge.kind;
      clearRouteLock();
      changed();
      render();
      return;
    }
    if (event.target.closest("#add-end-return")) {
      addEdge("end", "main", "weak", "top", "top");
      return;
    }
    if (event.target.closest("#delete-selected-edge")) {
      var deletingConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
      if (rejectMainDispatchEdit(deletingConnection)) {
        render();
        return;
      }
      if (!DIRECT_EDGE_MODE && (isTerminationWorkflowEdge(deletingConnection) || (deletingConnection && deletingConnection.endChoice === "return-main") || isMainSelectorEntry(deletingConnection))) {
        showToast(isMainSelectorEntry(deletingConnection) ? "Main 常驻选择器入口是固定连接，不能删除" : deletingConnection && deletingConnection.endChoice === "return-main" ? "结束选择器回到 Main 是固定出口，不能删除" : "结束判断由 Main 控制，不能删除");
        return;
      }
      pushUndo("删除连接");
      workflow.edges = workflow.edges.filter(function (edge) { return edge.id !== selectedEdge; });
      if (!DIRECT_EDGE_MODE && deletingConnection && deletingConnection.source === "input") workflow.inputTarget = null;
      if (deletingConnection && deletingConnection.endChoice === "return-main") workflow.endAllowReturnToMain = false;
      clearRouteLock();
      selectedEdge = null;
      changed();
      render();
      showToast("连接已删除，可使用撤销恢复");
      return;
    }
    if (event.target.closest(".node-remove")) return removeNode(selected);
    if (event.target.closest("#add-connection-from-inspector")) {
      var inspectorTarget = document.getElementById("connection-target").value;
      return addEdge(selected, inspectorTarget, preferredEdgeKind(selected, inspectorTarget));
    }
    var row = event.target.closest("[data-edge]");
    if (row && event.target.closest(".edge-delete")) {
      var deletingRowEdge = workflow.edges.find(function (edge) { return edge.id === row.dataset.edge; });
      if (rejectMainDispatchEdit(deletingRowEdge)) {
        render();
        return;
      }
      if (!DIRECT_EDGE_MODE && (isTerminationWorkflowEdge(deletingRowEdge) || (deletingRowEdge && deletingRowEdge.endChoice === "return-main") || isMainSelectorEntry(deletingRowEdge))) {
        showToast(isMainSelectorEntry(deletingRowEdge) ? "Main 常驻选择器入口是固定连接，不能删除" : deletingRowEdge && deletingRowEdge.endChoice === "return-main" ? "结束选择器回到 Main 是固定出口，不能删除" : "结束判断由 Main 控制，不能删除");
        return;
      }
      pushUndo("删除连接");
      workflow.edges = workflow.edges.filter(function (edge) { return edge.id !== row.dataset.edge; });
      if (!DIRECT_EDGE_MODE && deletingRowEdge && deletingRowEdge.source === "input") workflow.inputTarget = null;
      if (deletingRowEdge && deletingRowEdge.endChoice === "return-main") workflow.endAllowReturnToMain = false;
      clearRouteLock();
      if (selectedEdge === row.dataset.edge) selectedEdge = null;
      changed();
      render();
      showToast("连接已删除，可使用撤销恢复");
    }
  });

  savedList.addEventListener("click", function (event) {
    if (blockDemoEdit()) return;
    var row = event.target.closest("[data-saved]");
    if (!row) return;
    var id = row.dataset.saved;
    if (event.target.closest(".saved-save")) {
      if (activeSavedId !== id) {
        showToast("请先载入该流程，再保存它的修改");
        return;
      }
      if (!dirty) {
        showToast("当前流程没有未保存修改");
        return;
      }
      saveWorkflow();
      return;
    }
    if (event.target.closest(".saved-rename")) {
      openFlowDialog("rename", id);
      return;
    }
    if (event.target.closest(".saved-delete")) {
      deleteSavedRecord(id);
      return;
    }
    var record = saved().find(function (item) { return item.id === id; });
    if (record) {
      loadSavedRecord(record);
      showToast("已载入 " + record.name);
    }
  });

  nameField.addEventListener("input", function () {
    if (blockDemoEdit()) {
      nameField.value = workflow.name || "未命名工作流";
      return;
    }
    captureInputUndo(nameField, "修改流程名称");
    workflow.name = nameField.value;
    changed();
  });
  document.getElementById("save-button").addEventListener("click", function () { if (!blockDemoEdit()) saveWorkflow(); });
  clearCanvasButton.addEventListener("click", function () { if (!blockDemoEdit()) clearCanvas(); });
  document.getElementById("fit-button").addEventListener("click", function () { if (!blockDemoEdit()) tidyCanvas(false); });
  document.getElementById("layered-layout-button").addEventListener("click", function () { if (!blockDemoEdit()) arrangeCanvas(false); });
  document.getElementById("fit-viewport-button").addEventListener("click", function () { if (RUNTIME_MODE || !blockDemoEdit()) fitViewportOnly(false); });
  if (layoutMenuButton && layoutMenu) {
    layoutMenuButton.addEventListener("click", function (event) {
      event.stopPropagation();
      var willOpen = layoutMenu.hidden;
      layoutMenu.hidden = !willOpen;
      layoutMenuButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) {
        var firstItem = layoutMenu.querySelector("[role=menuitem]");
        if (firstItem) requestAnimationFrame(function () { firstItem.focus(); });
      }
    });
    layoutMenu.addEventListener("click", function (event) {
      var action = event.target.closest("[data-layout-action]");
      if (!action) return;
      if (blockDemoEdit()) return;
      var value = action.dataset.layoutAction;
      closeLayoutMenu();
      if (value === "layered") arrangeCanvas(false);
      else if (value === "viewport") fitViewportOnly(false);
      else tidyCanvas(false);
    });
    document.addEventListener("click", function (event) {
      if (!event.target.closest("#layout-control")) closeLayoutMenu();
    });
  }
  if (undoButton) undoButton.addEventListener("click", restoreUndo);
  if (demoRunButton) demoRunButton.addEventListener("click", startDemoRun);
  if (demoStageButton) demoStageButton.addEventListener("click", startStagedDemoRun);
  if (gifExportButton) gifExportButton.addEventListener("click", startGifExport);
  if (demoScenarioSelector) demoScenarioSelector.addEventListener("click", function (event) {
    var button = event.target.closest("[data-demo-scenario]");
    if (button) selectDemoScenario(button.dataset.demoScenario);
  });
  if (runPauseButton) runPauseButton.addEventListener("click", toggleDemoPause);
  if (runStopButton) runStopButton.addEventListener("click", stopDemoRun);
  if (runLogToggle) runLogToggle.addEventListener("click", function () {
    demoRun.logExpanded = !demoRun.logExpanded;
    renderDemoUI();
  });
  document.getElementById("zoom-out-button").addEventListener("click", function () { setZoom(viewport.k / 1.2); });
  document.getElementById("zoom-in-button").addEventListener("click", function () { setZoom(viewport.k * 1.2); });
  document.getElementById("zoom-reset-button").addEventListener("click", function () { setZoom(1); });
  document.getElementById("export-button").addEventListener("click", function () {
    if (blockDemoEdit()) return;
    if (!validateWorkflow("下载配置")) return;
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" }));
    link.download = (workflow.name || "agent-flow") + ".json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  function openDialog(mode) {
    agentDialogMode = mode === "library" ? "library" : "canvas";
    dialogForm.reset();
    document.getElementById("agent-dialog-title").textContent = agentDialogMode === "library" ? "新建常驻 Agent" : "新建并添加 Agent";
    document.getElementById("agent-dialog-submit").textContent = agentDialogMode === "library" ? "加入常驻 Agent" : "加入并添加到画布";
    dialog.showModal();
    requestAnimationFrame(function () { dialogForm.elements.name.focus(); });
  }

  function openFlowDialog(mode, id) {
    flowDialogMode = mode === "rename" ? "rename" : "new";
    editingSavedId = flowDialogMode === "rename" ? id : null;
    var record = editingSavedId && saved().find(function (item) { return item.id === editingSavedId; });
    if (flowDialogMode === "rename" && !record) return;
    flowForm.reset();
    document.getElementById("flow-dialog-title").textContent = flowDialogMode === "rename" ? "修改流程名称" : "新建流程";
    document.getElementById("flow-dialog-submit").textContent = flowDialogMode === "rename" ? "保存名称" : "创建流程";
    document.getElementById("flow-dialog-name").value = record ? record.name : "未命名流程";
    flowDialog.showModal();
    requestAnimationFrame(function () {
      var input = document.getElementById("flow-dialog-name");
      input.focus();
      input.select();
    });
  }

  document.getElementById("new-agent-button").addEventListener("click", function () { if (!blockDemoEdit()) openDialog("library"); });
  document.getElementById("add-agent-button").addEventListener("click", function () { if (!blockDemoEdit()) openDialog("canvas"); });
  document.getElementById("empty-add-button").addEventListener("click", function () { if (!blockDemoEdit()) openDialog("canvas"); });
  document.getElementById("new-workflow-button").addEventListener("click", function () { if (!blockDemoEdit()) openFlowDialog("new"); });
  var addSelectorButton = document.getElementById("add-selector-button");
  var addSelectorLibraryButton = document.getElementById("add-selector-library-button");
  if (addSelectorButton) addSelectorButton.addEventListener("click", function () { if (!blockDemoEdit()) addSelector(); });
  if (addSelectorLibraryButton) addSelectorLibraryButton.addEventListener("click", function () { if (!blockDemoEdit()) addSelector(); });
  document.querySelectorAll("[data-edge-type]").forEach(function (button) {
    button.addEventListener("click", function () { if (!blockDemoEdit()) setDirectEdgeKind(button.dataset.edgeType); });
  });
  document.querySelectorAll("[data-close-dialog]").forEach(function (button) {
    button.addEventListener("click", function () { dialog.close(); });
  });
  dialogForm.addEventListener("submit", function (event) {
    if (blockDemoEdit()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    var values = new FormData(dialogForm);
    var name = String(values.get("name") || "").trim();
    var description = String(values.get("description") || "").trim();
    if (!name || !description) return;
    var template = {
      id: uid("agent-template"),
      name: name,
      model: "gpt-5.6-sol",
      description: description,
      color: "violet"
    };
    agentLibrary.push(template);
    saveAgentLibrary();
    renderLibrary();
    if (agentDialogMode === "canvas") addAgent(template);
    else showToast(name + " 已加入常驻 Agent");
    dialog.close();
  });
  document.querySelectorAll("[data-close-flow-dialog]").forEach(function (button) {
    button.addEventListener("click", function () { flowDialog.close(); });
  });
  flowForm.addEventListener("submit", function (event) {
    if (blockDemoEdit()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    var name = String(new FormData(flowForm).get("name") || "").trim();
    if (!name) return;
    if (flowDialogMode === "rename") renameSavedRecord(editingSavedId, name);
    else createSavedWorkflow(name);
    flowDialog.close();
  });

  document.addEventListener("keydown", function (event) {
    if (isDemoLocked() && ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" || event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      showToast("运行中的 Workflow 已锁定");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z" && !event.target.closest("input, textarea, select") && undoState && !layoutBusy) {
      event.preventDefault();
      restoreUndo();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedEdge && !event.target.closest("input, textarea, select")) {
      event.preventDefault();
      var deletingConnection = workflow.edges.find(function (edge) { return edge.id === selectedEdge; });
      if (rejectMainDispatchEdit(deletingConnection)) {
        render();
        return;
      }
      if (!DIRECT_EDGE_MODE && (isTerminationWorkflowEdge(deletingConnection) || (deletingConnection && deletingConnection.endChoice === "return-main") || isMainSelectorEntry(deletingConnection))) {
        showToast(isMainSelectorEntry(deletingConnection) ? "Main 常驻选择器入口是固定连接，不能删除" : deletingConnection && deletingConnection.endChoice === "return-main" ? "结束选择器回到 Main 是固定出口，不能删除" : "结束判断由 Main 控制，不能删除");
        return;
      }
      pushUndo("删除连接");
      workflow.edges = workflow.edges.filter(function (edge) { return edge.id !== selectedEdge; });
      if (!DIRECT_EDGE_MODE && deletingConnection && deletingConnection.source === "input") workflow.inputTarget = null;
      if (deletingConnection && deletingConnection.endChoice === "return-main") workflow.endAllowReturnToMain = false;
      clearRouteLock();
      selectedEdge = null;
      changed();
      render();
      showToast("连接已删除");
      return;
    }
    if (event.key === "Escape" && layoutMenu && !layoutMenu.hidden) {
      closeLayoutMenu();
      layoutMenuButton.focus();
      return;
    }
    if (event.key === "Escape" && (linking || linkDrag || selectedEdge)) {
      cancelConnection();
      selectedEdge = null;
      render();
    }
  });
  window.addEventListener("resize", function () {
    if (RUNTIME_MODE) runtimeRoutes = null;
    requestAnimationFrame(function () {
      updateLayoutControlMode();
      drawEdges();
    });
  });
  if (window.ResizeObserver && canvasToolbar) {
    new ResizeObserver(function () { requestAnimationFrame(updateLayoutControlMode); }).observe(canvasToolbar);
  }
  requestAnimationFrame(updateLayoutControlMode);

  // The host supplies the graph and runtime overlay. Never normalize its
  // topology through the demo editor or replay the scripted demo in live mode.
  if (RUNTIME_MODE) {
    var hasRuntimeSnapshot = false;
    // Expanding a card can grow beyond the current view. Pan only enough to
    // reveal that card, preserving the user's zoom and the configured layout.
    function revealRuntimeGroup(nodeId) {
      var element = nodeElement(nodeId);
      if (!element) return;
      var area = canvas.getBoundingClientRect();
      var card = element.getBoundingClientRect();
      if (!area.width || !area.height) return;
      var dx = 0, dy = 0, padding = 18;
      if (card.right > area.right - padding) dx = area.right - padding - card.right;
      else if (card.left < area.left + padding) dx = area.left + padding - card.left;
      if (card.bottom > area.bottom - padding) dy = area.bottom - padding - card.bottom;
      else if (card.top < area.top + padding) dy = area.top + padding - card.top;
      viewport.x += dx;
      viewport.y += dy;
      if (dx || dy) applyViewport();
    }
    window.ScienceEvolveRuntimeCanvas = {
      update: function (snapshot) {
        var nextScopeKey = JSON.stringify([snapshot.projectId, snapshot.scopeId || null]);
        var scopeChanged = nextScopeKey !== runtimeScopeKey;
        if (scopeChanged) {
          if (hasRuntimeSnapshot) runtimeScopeViews[runtimeScopeKey] = {
            viewport: clone(viewport), overrides: runtimeLayoutOverrides, positions: runtimeHostPositions,
            nodeIds: workflow.nodes.map(function (node) { return node.id; }), edgeIds: workflow.edges.map(function (edge) { return edge.id; })
          };
          var savedView = runtimeScopeViews[nextScopeKey];
          runtimeScopeId = snapshot.scopeId || null;
          runtimeScopeKey = nextScopeKey;
          runtimeLayoutOverrides = savedView ? savedView.overrides : Object.create(null);
          runtimeHostPositions = savedView ? savedView.positions : Object.create(null);
          viewport = savedView ? clone(savedView.viewport) : { x: 0, y: 0, k: 1 };
          if (drag) drag.element.classList.remove("is-dragging");
          drag = null;
          pan = null;
          canvas.classList.remove("is-panning");
          hideAlignmentGuides();
          selected = null;
          selectedEdge = null;
          runtimeRoutes = null;
          runtimeGraphKey = "";
          clearRouteLock();
        }
        var knownScope = scopeChanged ? Boolean(savedView) : hasRuntimeSnapshot;
        var previousIds = scopeChanged ? (savedView ? savedView.nodeIds : []) : workflow.nodes.map(function (node) { return node.id; });
        var previousEdgeIds = scopeChanged ? (savedView ? savedView.edgeIds : []) : workflow.edges.map(function (edge) { return edge.id; });
        var movedIds = [];
        var expandedGroups = scopeChanged ? [] : workflow.nodes.filter(function (node) { return node.type === "collaboration" && node.expanded; }).map(function (node) { return node.id; });
        workflow = clone(snapshot.workflow);
        workflow.nodes.forEach(function (node) {
          var previousPosition = runtimeHostPositions[node.id];
          if (previousPosition && (previousPosition.x !== node.x || previousPosition.y !== node.y)) {
            // A new layout from Main supersedes a local drag. Ordinary state
            // snapshots preserve it, including when the user revisits a scope.
            delete runtimeLayoutOverrides[node.id];
            movedIds.push(node.id);
            if (drag && drag.item.id === node.id) {
              drag.element.classList.remove("is-dragging");
              drag = null;
              hideAlignmentGuides();
            }
          }
          runtimeHostPositions[node.id] = { x: node.x, y: node.y };
          var override = runtimeLayoutOverrides[node.id];
          if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) {
            node.x = override.x;
            node.y = override.y;
          }
        });
        Object.keys(runtimeLayoutOverrides).forEach(function (nodeId) {
          if (!workflow.nodes.some(function (node) { return node.id === nodeId; })) delete runtimeLayoutOverrides[nodeId];
        });
        Object.keys(runtimeHostPositions).forEach(function (nodeId) {
          if (!workflow.nodes.some(function (node) { return node.id === nodeId; })) delete runtimeHostPositions[nodeId];
        });
        // A live update replaces node objects even when topology is unchanged.
        // Keep the gesture on the same object used by the current edge router.
        if (drag) {
          var currentDragNode = getNode(drag.item.id);
          if (currentDragNode) drag.item = currentDragNode;
          else {
            drag.element.classList.remove("is-dragging");
            drag = null;
            hideAlignmentGuides();
          }
        }
        var graphKey = JSON.stringify([workflow.nodes.map(function (node) { return [node.id, node.x, node.y, node.type, node.name, node.groupId, node.expanded, (node.members || []).map(function (member) { return [member.id, member.name, member.groupId]; })]; }), workflow.edges.map(function (edge) { return [edge.id, edge.source, edge.target, edge.kind, edge.sourcePort, edge.targetPort, edge.fixed, edge.systemRoute]; })]);
        if (graphKey !== runtimeGraphKey) {
          runtimeRoutes = null;
          runtimeGraphKey = graphKey;
          clearRouteLock();
        }
        demoRun.hasRun = true;
        demoRun.active = snapshot.status === "running";
        demoRun.nodeStates = clone(snapshot.nodeStates);
        demoRun.nodeResults = clone(snapshot.nodeResults);
        demoRun.currentAgentId = snapshot.currentNodeId;
        demoRun.runningAgentIds = Object.keys(snapshot.nodeStates).filter(function (id) { return snapshot.nodeStates[id] === "running" || snapshot.nodeStates[id] === "retrying"; });
        demoRun.addedAgentIds = knownScope ? workflow.nodes.filter(function (node) { return previousIds.indexOf(node.id) < 0; }).map(function (node) { return node.id; }) : [];
        demoRun.addedEdgeIds = knownScope ? workflow.edges.filter(function (edge) { return previousEdgeIds.indexOf(edge.id) < 0; }).map(function (edge) { return edge.id; }) : [];
        demoRun.movingAgentIds = scopeChanged ? [] : movedIds;
        demoRun.edgeData = {};
        workflow.edges.forEach(function (edge) {
          if (edge.runtimeState === "active") demoRun.edgeData[edge.id] = { name: edge.runtimeLabel || "实际执行", direction: "outgoing" };
        });
        selected = snapshot.selectedNodeId || (scopeChanged ? null : selected);
        if (!getNode(selected)) selected = null;
        render();
        if (drag) {
          drag.element = nodeElement(drag.item.id);
          drag.element.classList.add("is-dragging");
        }
        nodeLayer.querySelectorAll(".agent-node").forEach(function (node) {
          node.tabIndex = 0;
          node.setAttribute("role", getNode(node.dataset.node).type === "collaboration" ? "group" : "button");
          node.setAttribute("aria-label", (getNode(node.dataset.node).name || node.dataset.node) + " · " + snapshot.nodeLabels[node.dataset.node]);
        });
        applyViewport();
        if (!knownScope) requestAnimationFrame(function () { if (runtimeScopeKey === nextScopeKey) fitViewportOnly(true); });
        else if (!scopeChanged) workflow.nodes.filter(function (node) {
          return node.type === "collaboration" && node.expanded && expandedGroups.indexOf(node.id) < 0;
        }).forEach(function (node) { requestAnimationFrame(function () { revealRuntimeGroup(node.id); }); });
        hasRuntimeSnapshot = true;
      },
      select: function (nodeId) {
        if (!getNode(nodeId)) return;
        selected = nodeId;
        syncNodeSelection();
        drawEdges();
        window.parent.postMessage({ type: "scienceevolve.workflow.runtime.select", nodeId: nodeId, scopeId: runtimeScopeId }, window.location.origin);
      },
      pan: function (dx, dy) {
        viewport.x += dx;
        viewport.y += dy;
        applyViewport();
      }
    };
    return;
  }

  renderLibrary();
  renderSaved();
  render();
  requestAnimationFrame(function () {
    if (!rawWorkflow) {
      fitViewportOnly(true);
      changed(false);
    } else if (!DIRECT_EDGE_MODE && pinMainAtTop()) {
      // 旧草稿中的 Main 可能仍位于普通节点之间，首次载入时迁移到顶部。
      clearRouteLock();
      workflow.viewLayout = "free";
      fitCanvas(true);
      changed(false);
    }
    // A migrated/older draft may retain a zoom or pan that leaves the newly
    // added end module underneath the inspector. Fit once after the DOM has
    // settled so the terminal path is visible on first load.
    requestAnimationFrame(function () {
      if (endNodeOutsideCanvas()) {
        fitViewportOnly(true);
      }
    });
  });
})();
