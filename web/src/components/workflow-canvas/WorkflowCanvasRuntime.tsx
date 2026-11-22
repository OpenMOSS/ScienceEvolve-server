import { currentScopedGroupRun, scopedGroupDisplayState } from "../../scoped-runtime";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Activity,
  ArrowLeft,
  ExternalLink,
  GitBranch,
  GitGraph,
  GitPullRequest,
  History,
  Maximize,
  Trash2,
  X
} from "lucide-react";
import type { AgentEvent, HarnessCatalogEntry, Project } from "../../types";
import { agentMeta } from "../../lib";
import { Button } from "../Common";
import type { CanvasNodePresentation } from "./CanvasNodes";
import {
  CollaborationActivityFeed,
  FailureAttemptHistory
} from "./CollaborationActivityFeed";
import { ExecutionPreview } from "./ExecutionPreview";
import { CopyableTechnicalValue } from "./CopyableTechnicalValue";
import { GitTreeDialog } from "./GitTreeDialog";
import { RuntimeAgentNodeDetail } from "./RuntimeAgentNodeDetail";
import { RuntimeCanvasSurface, type RuntimeCanvasSurfaceProps } from "./RuntimeCanvasSurface";
import { WorkflowCanvasReplay } from "./WorkflowCanvasReplay";
import { buildScopedRuntimeView, scopedGroupName, scopedReferenceDisplayState } from "./core/scoped-runtime-view";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import {
  COLLABORATION_STATE_LABELS,
  collaborationExecutionState,
  collaborationProgress
} from "./core/collaboration-activity";
import {
  CANVAS_INPUT_NODE_ID,
  type CanvasNode,
  type CanvasPoint
} from "./core/canvas-model";
import type { EdgeGeometry } from "./core/canvas-router";
import { useCanvasRouting } from "./useCanvasRouting";
import {
  buildWorkflowRuntimeState,
  runtimeNodeLabel,
  type WorkflowRuntimeState
} from "./core/workflow-runtime";
import "./workflow-canvas.css";

export interface WorkflowCanvasRuntimeProps {
  project: Project;
  events: AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  /** Optional host-level snapshot shared with the rail and invocation ledger. */
  runtime?: WorkflowRuntimeState;
}

export { RuntimeCanvasSurface, planRuntimeCanvasViewport, runtimeGroupMemberStates } from "./RuntimeCanvasSurface";

function RuntimeNodeDetail({
  node,
  runtime,
  project,
  events = [],
  harnesses,
  resolvePresentation
}: {
  node: CanvasNode;
  runtime: WorkflowRuntimeState;
  project: Project;
  events?: readonly AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  resolvePresentation: (node: CanvasNode) => CanvasNodePresentation;
}) {
  const presentation = resolvePresentation(node);
  const state = runtime.nodeStates[node.id] ?? "waiting";
  if (node.collaboration) {
    return <CollaborationRuntimeDetail node={node} runtime={runtime} project={project} events={events} />;
  }
  return <RuntimeAgentNodeDetail key={node.id} node={node} project={project} title={presentation.title} state={state}
    executionCount={runtime.executionCounts[node.id] ?? 0} reason={runtime.nodeReasons[node.id]}
    invocationId={runtime.currentNodeId === node.id ? runtime.currentInvocationId : undefined} harnesses={harnesses} />;
}

function ScopedCollaborationRuntimeDetail({ node, runtime, project, expanded, onToggle, onEnter }: {
  node: CanvasNode; runtime: WorkflowRuntimeState; project: Project;
  expanded: boolean; onToggle: () => void; onEnter: () => void;
}) {
  const groupId = node.collaboration?.id ?? node.id;
  const group = project.orchestration.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
  const run = currentScopedGroupRun(project, groupId);
  const state = run ? scopedGroupDisplayState(project, groupId) : runtime.nodeStates[node.id] ?? "waiting";
  return <aside className="workflow-runtime-detail collaboration-runtime-detail" aria-label="协作组运行详情" data-collaboration-state={state}>
    <strong>{scopedGroupName(project, groupId)}</strong>
    <span>{runtimeNodeLabel(state)}</span>
    <small>累计执行 {runtime.executionCounts[node.id] ?? 0} 次</small>
    <small>Leader：{run?.leaderAgentId ?? group?.leaderAgentId ?? "未配置"}</small>
    <div className="workflow-runtime-group-actions">
      <button type="button" aria-expanded={expanded} onClick={onToggle}>{expanded ? "收起子节点" : "查看子 Agent"}</button>
      <button type="button" onClick={onEnter}>进入组内运行 Workflow</button>
    </div>
    {expanded && <ul className="workflow-runtime-group-members" aria-label="协作组成员状态">
      {group?.workflow.nodes.map((ref) => <li key={ref.nodeId}>
        {ref.kind === "collaboration" ? scopedGroupName(project, ref.groupId) : agentMeta(ref.agentId,
          project.orchestration.agents.find((agent) => agent.name === ref.agentId)?.template).name}
        <small>{runtimeNodeLabel(scopedReferenceDisplayState(project, groupId, ref.nodeId))}</small>
      </li>)}
    </ul>}
    {run && <details className="workflow-runtime-group-facts"><summary>执行详情</summary>
      {project.git?.enabled ? <>
        <small>分支：{run.groupBranch || "等待创建"}</small>
        <small>目标：{run.integrationTarget || "等待观测"}</small>
      </> : <small>交付方式：项目工作区</small>}
      <small>Workflow revision：{run.workflowRevision}</small>
    </details>}
  </aside>;
}

function CollaborationRuntimeDetail({ node, runtime, project, events }: {
  node: CanvasNode;
  runtime: WorkflowRuntimeState;
  project: Project;
  events: readonly AgentEvent[];
}) {
  const nodeRuns = (project.nodeRuns ?? []).filter((run) => run.node.nodeId === node.id);
  const activeNodeRun = nodeRuns.find((run) => run.id === project.activeNodeRunId) ?? nodeRuns.at(-1);
  const groupRuns = (project.groupRuns ?? []).filter((run) => nodeRuns.some((nodeRun) => nodeRun.id === run.nodeRunId));
  const collaboration = (project.orchestration.collaborations ?? []).find((entry) => entry.id === node.id);
  const progress = collaboration ? collaborationProgress(project, collaboration) : undefined;
  const groupRun = progress?.groupRun
    ?? groupRuns.find((run) => run.nodeRunId === activeNodeRun?.id)
    ?? groupRuns.at(-1);
  const tasks = (project.tasks ?? [])
    .filter((task) => task.groupRunId === groupRun?.id)
    .sort((left, right) => left.queueOrdinal - right.queueOrdinal);
  const executions = (project.executions ?? []).filter((execution) => execution.groupRunId === groupRun?.id);
  const pullRequests = project.pullRequests ?? [];
  const finalPullRequest = pullRequests.find((pull) => pull.id === groupRun?.finalPullRequestId)
    ?? pullRequests.find((pull) => executions.some((execution) => execution.purpose === "final-integration" && execution.id === pull.ownerExecutionId));
  const completed = groupRun?.status === "completed" || activeNodeRun?.status === "completed";
  return <aside
    className="workflow-runtime-detail collaboration-runtime-detail"
    aria-label="协作组运行详情"
    data-collaboration-state={progress?.state ?? "waiting"}
  >
    <header><span>COLLABORATION RUN</span><strong>{node.displayName ?? node.name}</strong><small>{progress?.phaseLabel ?? (completed ? "协作组已完成" : runtimeNodeLabel(runtime.nodeStates[node.id]))}</small></header>
    {groupRun ? <>
      {progress && <div className="collaboration-progress-summary" data-state={progress.state}>
        <strong>成员进度 {progress.completedMembers}/{progress.totalMembers}</strong>
        <span><i style={{ width: `${Math.round(progress.completedMembers / Math.max(1, progress.totalMembers) * 100)}%` }} /></span>
      </div>}
      {groupRun.failureReason && <p className="workflow-runtime-detail-reason">{groupRun.failureReason}</p>}
      <section className="collaboration-task-queue">
        <h3>成员分工</h3>
        {tasks.length ? tasks.map((task) => {
          const rounds = executions.filter((execution) => execution.taskId === task.id);
          return <article key={task.id} data-task-id={task.id}>
            <div><span>#{task.queueOrdinal}</span><strong>{task.assigneeAgentId ?? "等待分配"}</strong><em>{taskStatusLabel(task.status)}</em></div>
            <p>{task.assignment || "未记录分工"}</p>
            {task.waitReason && <small>等待：{task.waitReason}</small>}
            {task.failureReason && <small className="workflow-runtime-detail-reason">故障：{task.failureReason}</small>}
            {rounds.length > 0 && <ol className="collaboration-execution-rounds">
              {rounds.map((execution, index) => {
                const pull = pullRequests.find((entry) => entry.id === execution.pullRequestId);
                const displayState = collaborationExecutionState(project, execution, pull);
                return <li key={execution.id} data-execution-id={execution.id}>
                  <span>第 {index + 1} 轮 · {execution.agentId}</span>
                  <strong data-state={displayState}>{displayState === "waiting"
                    ? executionStatusLabel(execution.status)
                    : COLLABORATION_STATE_LABELS[displayState]}</strong>
                  <small>{execution.purpose === "final-integration" ? "最终集成" : "成员交付"}</small>
                  {execution.waitReason && <small>等待：{execution.waitReason}</small>}
                  {execution.failureReason && <small className="workflow-runtime-detail-reason">{execution.failureReason}</small>}
                  {pull && <a href={pull.htmlUrl} target="_blank" rel="noreferrer">PR #{pull.providerNumber} · {pull.status === "merged" ? "已合并" : pull.status}</a>}
                </li>;
              })}
            </ol>}
          </article>;
        }) : <p>正在拆分任务，成员按队列等待。</p>}
      </section>
      <section className="collaboration-runtime-activity">
        <h3>最近大动作</h3>
        <CollaborationActivityFeed project={project} events={events} groupRunId={groupRun.id} limit={8} />
      </section>
      <section className="collaboration-integration-progress">
        <h3>最终集成</h3>
        <p>{completed
          ? "最终集成已完成，协作组直接进入完成态。"
          : progress?.state === "paused"
            ? "项目已暂停，最终集成不会继续显示为执行中。"
            : progress?.state === "stopping"
              ? "正在安全停止最终集成。"
              : progress?.state === "running" && groupRun.status === "integrating"
                ? "最终集成正在进行。"
                : "等待成员交付与最终集成事实。"}</p>
        {finalPullRequest && <PullRequestFacts pull={finalPullRequest} />}
      </section>
      <details className="collaboration-technical-details">
        <summary>技术详情</summary>
        <dl className="collaboration-run-facts">
          <div><dt>Group Run</dt><dd><CopyableTechnicalValue value={groupRun.id} /></dd></div>
          <div><dt>协调者</dt><dd>{groupRun.leaderAgentId}</dd></div>
          <div><dt>协调轮次</dt><dd>{groupRun.coordinatorEpoch}</dd></div>
          <div><dt>集成分支</dt><dd><CopyableTechnicalValue value={groupRun.groupBranch || "等待创建"} /></dd></div>
          <div><dt>Base</dt><dd><CopyableTechnicalValue value={groupRun.baseCommit || "等待观测"} /></dd></div>
        </dl>
        {tasks.filter((task) => task.predecessorTaskId || task.successorTaskId).map((task) => <div className="collaboration-technical-execution" key={task.id}>
          <strong>{task.assigneeAgentId ?? "未分配成员"} · 任务关系</strong>
          <CopyableTechnicalValue value={task.id} />
          {task.predecessorTaskId && <small>接续自任务：{task.predecessorTaskId}</small>}
          {task.successorTaskId && <small>接续任务：{task.successorTaskId}</small>}
        </div>)}
        {executions.map((execution) => <div className="collaboration-technical-execution" key={execution.id}>
          <strong>{execution.agentId}</strong>
          <CopyableTechnicalValue value={execution.id} />
          <CopyableTechnicalValue value={execution.executionBranch || "等待分支"} />
          <CopyableTechnicalValue value={execution.worktreePath || "等待 worktree"} />
          <small>ownership epoch {execution.ownershipEpoch}</small>
          {execution.predecessorExecutionId && <small>接续自执行：{execution.predecessorExecutionId}</small>}
          {execution.successorExecutionId && <small>故障后接续：{execution.successorExecutionId}</small>}
        </div>)}
      </details>
    </> : <p>等待服务端创建 Group Run 快照。</p>}
  </aside>;
}

function taskStatusLabel(status: NonNullable<Project["tasks"]>[number]["status"]): string {
  return ({ pending: "等待", assigned: "已分配", working: "运行", waiting: "等待", continuation_pending: "等待接续", succeeded: "完成", failed: "故障", cancelled: "取消" } as const)[status];
}

function executionStatusLabel(status: NonNullable<Project["executions"]>[number]["status"]): string {
  return ({ queued: "FIFO 等待", working: "运行", waiting_authorization: "等待授权", waiting_review: "等待 PR 评审", pr_open: "PR 已打开", resolving: "冲突修复中", merged: "已集成", stop_requested: "等待停止", stopped: "已停止", superseded: "已重新分配", succeeded: "完成", failed: "故障", cancelled: "取消" } as const)[status];
}

function PullRequestFacts({ pull }: { pull: NonNullable<Project["pullRequests"]>[number] }) {
  return <div className="pull-request-facts" data-pull-request-id={pull.id}>
    <a href={pull.htmlUrl} target="_blank" rel="noreferrer">PR #{pull.providerNumber} · {pull.status}</a>
    <small>{pull.head} → {pull.base}</small>
    {(pull.headSha || pull.baseSha) && <small>head {pull.headSha ?? "?"} · base {pull.baseSha ?? "?"}</small>}
    <small>可合并性：{pull.mergeable === true ? "可合并" : pull.mergeable === false ? "不可合并" : "尚未确认"} · 观测于 {pull.observedAt}</small>
    {pull.mergeCommitSha && <small>merge commit {pull.mergeCommitSha}</small>}
    {pull.diffUrl && <a href={pull.diffUrl} target="_blank" rel="noreferrer">查看 diff</a>}
    {pull.headCommitUrl && <a href={pull.headCommitUrl} target="_blank" rel="noreferrer">查看 head commit</a>}
    {pull.conflictPaths?.length ? <small className="workflow-runtime-detail-reason">冲突：{pull.conflictPaths.join("、")}</small> : null}
    {pull.blockers?.map((blocker) => <small className="workflow-runtime-detail-reason" key={blocker}>{blocker}</small>)}
    {pull.checks?.map((check) => <span key={check.id}>{check.name} · {check.conclusion ?? check.status}</span>)}
    {pull.reconciliation && <small>事实核对：{pull.reconciliation.status}{pull.reconciliation.message ? ` · ${pull.reconciliation.message}` : ""}</small>}
  </div>;
}

function RuntimeCanvasDialog({
  model,
  geometry,
  runtime,
  project,
  harnesses,
  selectedNodeId,
  events,
  onSelectNode,
  onClose,
  expandedGroupIds,
  onToggleGroup,
  initialReplay = false
}: RuntimeCanvasSurfaceProps & { events: AgentEvent[]; onClose: () => void; initialReplay?: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(initialReplay);
  const [activeScopedGroupId, setActiveScopedGroupId] = useState<string>();
  const [scopeSelections, setScopeSelections] = useState<Record<string, string>>({});
  const scopedView = useMemo(() => activeScopedGroupId && project.orchestration.schemaVersion === 3
    ? buildScopedRuntimeView(project, activeScopedGroupId) : undefined, [project, activeScopedGroupId]);
  const viewModel = scopedView?.model ?? model;
  const scopedGeometry = useCanvasRouting(viewModel.edges, viewModel.nodes, { enabled: Boolean(scopedView) });
  const viewRuntime = scopedView?.runtime ?? runtime;
  const viewSelectedId = scopedView ? scopeSelections[scopedView.group.id] : selectedNodeId;
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedNode = viewModel.nodes.find((node) => node.id === viewSelectedId);
  const selectedGroupId = selectedNode?.collaboration?.id ?? (scopedView ? undefined : selectedNode?.id);
  const selectedScopedGroup = project.orchestration.schemaVersion === 3 &&
    project.orchestration.scopedWorkflow?.groups.find((group) => group.id === selectedGroupId);
  const selectNode = useCallback((node: CanvasNode) => {
    if (scopedView) setScopeSelections((current) => ({ ...current, [scopedView.group.id]: node.id }));
    else onSelectNode?.(node);
  }, [scopedView, onSelectNode]);
  // Main can dissolve the open group or remove a selected reference while live.
  useEffect(() => {
    if (activeScopedGroupId && !scopedView) setActiveScopedGroupId(undefined);
    setScopeSelections((current) => {
      const remaining = Object.entries(current).filter(([groupId, nodeId]) => {
        const group = project.orchestration.scopedWorkflow?.groups.find((entry) => entry.id === groupId);
        return group && (nodeId === "input" || nodeId === "finish" || group.workflow.nodes.some((node) => node.nodeId === nodeId));
      });
      return remaining.length === Object.keys(current).length ? current : Object.fromEntries(remaining);
    });
  }, [project.orchestration.scopedWorkflow, activeScopedGroupId, scopedView?.group.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const resolvePresentation = useCallback((node: CanvasNode): CanvasNodePresentation => {
    if (node.kind === "input") return { title: scopedView ? "进入协作组" : "用户输入", description: "流程输入", modelLabel: "INPUT", color: "#446b9b", softColor: "#eaf0f7" };
    if (node.kind === "finish") return { title: scopedView ? "结束协作组" : "结束", description: "真实终止路径", modelLabel: "END", color: "#a65365", softColor: "#f9eaed" };
    if (node.collaboration) return { title: node.displayName ?? node.name, description: `${node.memberAgentIds?.length ?? 0} 名成员协作`, modelLabel: runtimeNodeLabel(viewRuntime.nodeStates[node.id]), initials: "组", color: "#5c5bd6", softColor: "#eeedff" };
    const definition = project.orchestration.agents.find((entry) => entry.name === node.name);
    const meta = agentMeta(node.name, node.template ?? "general");
    return {
      title: node.name === "main" ? "Main Agent" : meta.name,
      description: definition?.description ?? meta.description,
      modelLabel: runtimeNodeLabel(viewRuntime.nodeStates[node.id]),
      initials: node.name === "main" ? "MA" : meta.shortName.slice(0, 2).toUpperCase(),
      color: node.name === "main" ? "#25714e" : "#526674",
      softColor: node.name === "main" ? "#e7f1e9" : "#eaf0f3"
    };
  }, [project.orchestration.agents, viewRuntime.nodeStates, scopedView]);

  return (
    <div
      className="workflow-runtime-modal-backdrop"
      data-runtime-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="workflow-runtime-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-runtime-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workflow-runtime-dialog-head">
          <div>
            <span className="panel-kicker">RUNTIME WORKFLOW</span>
            <h2 id="workflow-runtime-dialog-title">{replayOpen ? "历史执行回顾" : previewOpen ? "执行速览" : activeScopedGroupId ? "组内运行 Workflow" : "运行 Workflow 画布"}</h2>
            <small>{replayOpen ? "按已保存的执行记录快速回顾 · 可暂停和定位" : previewOpen ? "用户输入 → Agent 执行与输出 → 调度交接" : "动态 Workflow · 当前课题实时执行状态"}</small>
          </div>
          <div className="workflow-runtime-dialog-actions">
          <button type="button" className="workflow-runtime-preview-toggle" aria-pressed={replayOpen} onClick={() => { setReplayOpen(!replayOpen); setPreviewOpen(false); }}>
            <History size={14} />{replayOpen ? "返回实时 Workflow" : "历史回顾"}
          </button>
          <button type="button" className="workflow-runtime-preview-toggle" aria-pressed={previewOpen} onClick={() => { setPreviewOpen(!previewOpen); setReplayOpen(false); }}>
            {previewOpen ? "返回 Workflow" : "执行速览"}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="workflow-runtime-dialog-close"
            aria-label="关闭运行 Workflow 画布"
            title="关闭"
            onClick={onClose}
          ><X size={18} /></button>
          </div>
        </header>
        {previewOpen && <ExecutionPreview project={project} events={events} runtime={runtime} />}
        {replayOpen && <WorkflowCanvasReplay key={project.id} project={project} onClose={onClose} />}
        {scopedView && !previewOpen && !replayOpen && <nav className="scoped-breadcrumbs" aria-label="运行 Workflow 范围路径">
          <button type="button" className="scoped-parent-link" onClick={() => setActiveScopedGroupId(scopedView.group.parentGroupId)}><ArrowLeft size={14} />返回父图</button>
          <button type="button" onClick={() => setActiveScopedGroupId(undefined)}>项目</button>
          {scopedView.path.map((group, index) => <span key={group.id}><span aria-hidden="true">›</span><button type="button" aria-current={index === scopedView.path.length - 1 ? "page" : undefined} onClick={() => setActiveScopedGroupId(group.id)}>{scopedGroupName(project, group.id)}</button></span>)}
        </nav>}
        <div className="workflow-runtime-dialog-canvas" hidden={previewOpen || replayOpen} aria-label={scopedView ? `${scopedGroupName(project, scopedView.group.id)} 组内运行 Workflow` : "项目运行 Workflow"}>
          <RuntimeCanvasSurface
            key={scopedView?.group.id ?? "root"}
            mode="modal"
            model={viewModel}
            geometry={scopedView ? scopedGeometry.geometry : geometry}
            runtime={viewRuntime}
            scopeId={scopedView?.group.id}
            project={project}
            selectedNodeId={selectedNode?.id}
            onSelectNode={selectNode}
            expandedGroupIds={expandedGroupIds}
            onToggleGroup={onToggleGroup}
          />
          {selectedNode && selectedScopedGroup && <ScopedCollaborationRuntimeDetail node={selectedNode} runtime={viewRuntime} project={project}
            expanded={expandedGroupIds?.has(selectedScopedGroup.id) ?? false}
            onToggle={() => onToggleGroup?.(selectedScopedGroup.id)} onEnter={() => setActiveScopedGroupId(selectedScopedGroup.id)} />}
          {selectedNode && !selectedScopedGroup && (
            <RuntimeNodeDetail node={selectedNode} runtime={viewRuntime} project={project} events={events} harnesses={harnesses} resolvePresentation={resolvePresentation} />
          )}
        </div>
        <div className="workflow-runtime-dialog-path" hidden={replayOpen} aria-label="实际执行路径">
          <span>Cycle {project.cycle}</span>
          {viewRuntime.recentInvocationPath.length
            ? viewRuntime.recentInvocationPath.slice(-12).map((entry, index) => (
              <span key={`${entry.invocationId ?? entry.nodeId}-${index}`}>
                {index ? " → " : ""}{entry.nodeId}{entry.state === "completed" ? " ✓" : entry.state === "running" ? " ·" : ""}
              </span>
            ))
            : <span>尚无实际调用</span>}
        </div>
      </div>
    </div>
  );
}

function ProjectGitReadonlyFacts({ project, onOpenGitTree }: { project: Project; onOpenGitTree: () => void }) {
  const git = project.git ?? { enabled: false as const, status: "disabled" as const };
  const statusLabel: Record<string, string> = {
    disabled: "未启用",
    authorizing: "等待 GitHub 授权",
    creating_repository: "正在创建仓库",
    initializing_local: "正在初始化本地仓库",
    pushing_main: "正在推送 main",
    ready: "已就绪",
    waiting_for_github: "等待 GitHub 响应",
    failed: "初始化失败"
  };
  return <section className="project-git-readonly" aria-label="Git 与 Pull Request 只读事实" data-git-readonly="true">
    <header><span><GitBranch size={15} /> GIT / PR</span><strong>{statusLabel[git.status] ?? git.status}</strong><em>只读</em></header>
    {!git.enabled ? <p>此项目创建时未启用 Git。</p> : <>
      {git.account && <dl className="project-git-repository">
        <div><dt>GitHub account</dt><dd>{git.account.login}</dd></div>
        <div><dt>Account binding</dt><dd>{git.account.id}</dd></div>
      </dl>}
      {git.repository && <>
        <dl className="project-git-repository">
          <div><dt>Repository</dt><dd><a href={git.repository.htmlUrl} target="_blank" rel="noreferrer">{git.repository.owner}/{git.repository.name}</a></dd></div>
          <div><dt>Visibility</dt><dd>{git.repository.private ? "Private" : "Public"}</dd></div>
          <div><dt>Default branch</dt><dd>{git.repository.defaultBranch}</dd></div>
        </dl>
        <div className="project-git-external-actions" aria-label="GitHub 仓库快捷入口">
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/tree/${encodeURIComponent(git.repository.defaultBranch)}`} target="_blank" rel="noreferrer"><ExternalLink size={12} />查看代码</a>
          <button type="button" onClick={onOpenGitTree} title="在 ScienceEvolve 查看 Agent 分支、commit 与合并拓扑"><GitGraph size={12} />Git 提交图</button>
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/activity`} target="_blank" rel="noreferrer" title="在 GitHub 查看 push、分支与合并时间线"><Activity size={12} />活动</a>
          <a href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/network`} target="_blank" rel="noreferrer" title="GitHub repository network，包括真正的 Fork 仓库"><GitGraph size={12} />GitHub Network</a>
          <a href={project.pullRequests?.at(-1)?.htmlUrl ?? `${git.repository.htmlUrl.replace(/\/+$/, "")}/pulls`} target="_blank" rel="noreferrer"><GitPullRequest size={12} />查看 PR</a>
          <a className="danger" href={`${git.repository.htmlUrl.replace(/\/+$/, "")}/settings`} target="_blank" rel="noreferrer" title="在 GitHub Settings 的 Danger Zone 中删除仓库"><Trash2 size={12} />前往 GitHub 删除</a>
        </div>
      </>}
      {git.initialization && <div className={`project-git-initialization is-${git.status}`}><strong>初始化 attempt {git.initialization.attempt}</strong><small>Operation {git.initialization.operationId}</small><span>{git.initialization.completedSteps.length ? git.initialization.completedSteps.join(" → ") : "等待首个步骤"}</span>{git.initialization.error && <p>{git.initialization.error}<small>服务端可沿用同一 operationId 原位重试；页面不会创建新的写操作。</small></p>}</div>}
      {git.blockers?.map((blocker) => <p className="workflow-runtime-detail-reason" key={blocker}>{blocker}</p>)}
      {git.capacity && <p>保留 worktree：{git.capacity.retainedWorktreeCount}{git.capacity.warningThreshold !== undefined ? ` / 提醒阈值 ${git.capacity.warningThreshold}` : ""}{git.capacity.warning ? ` · ${git.capacity.warning}` : ""}</p>}
      {git.branches?.length ? <div className="project-git-fact-list"><h3>Branches</h3>{git.branches.map((branch) => <article key={`${branch.name}:${branch.ownerExecutionId ?? "project"}`}><strong>{branch.name}</strong><span>{branch.status}</span>{branch.base && <small>base {branch.base}</small>}{branch.head && <small>head {branch.head}</small>}{branch.retained && <em>retained</em>}</article>)}</div> : null}
      {git.commits?.length ? <div className="project-git-fact-list"><h3>Commits</h3>{git.commits.map((commit) => <article key={commit.sha}><strong>{commit.sha.slice(0, 12)}</strong>{commit.message && <span>{commit.message}</span>}{commit.htmlUrl && <a href={commit.htmlUrl} target="_blank" rel="noreferrer">查看 commit</a>}</article>)}</div> : null}
      {(project.pullRequests?.length ?? 0) > 0 && <div className="project-git-fact-list"><h3>Pull Requests / checks</h3>{project.pullRequests!.map((pull) => <PullRequestFacts pull={pull} key={pull.id} />)}</div>}
      {git.repository && <details className="project-git-technical-details">
        <summary>技术详情</summary>
        <dl className="project-git-repository">
          <div><dt>Local path</dt><dd>{git.repository.localPath}</dd></div>
          {git.branches?.filter((branch) => branch.worktreePath).map((branch) => <div key={`${branch.name}:worktree`}><dt>{branch.name}</dt><dd>{branch.worktreePath}</dd></div>)}
        </dl>
      </details>}
      {git.observedAt && <small>最后观测：{git.observedAt}</small>}
    </>}
  </section>;
}

/** Read-only runtime map with a fixed embedded preview and a large canvas dialog. */
export function WorkflowCanvasRuntime({ project, events, harnesses, runtime: runtimeProp }: WorkflowCanvasRuntimeProps) {
  const derivedRuntime = useMemo(() => buildWorkflowRuntimeState(project, events), [events, project]);
  const runtime = runtimeProp ?? derivedRuntime;
  const model = useMemo(
    () => adaptWorkflowToCanvas(project.orchestration, project.orchestration.canvas),
    [project.orchestration]
  );
  const horizontalExtent = model.nodes.reduce((bounds, node) => ({
    min: Math.min(bounds.min, node.x), max: Math.max(bounds.max, node.x)
  }), { min: Infinity, max: -Infinity });
  const largeCanvas = model.nodes.length > 8 || horizontalExtent.max - horizontalExtent.min > 960;
  const { geometry } = useCanvasRouting(model.edges, model.nodes);
  const [modalOpen, setModalOpen] = useState(false);
  const [initialReplay, setInitialReplay] = useState(false);
  const [gitTreeOpen, setGitTreeOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (selectedNodeId && !model.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(undefined);
  }, [model.nodes, selectedNodeId]);
  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const openModal = useCallback(() => { setInitialReplay(false); setModalOpen(true); }, []);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelectedNodeId(undefined);
  }, []);
  const activeRunNodeId = project.nodeRuns?.find((run) => run.id === project.activeNodeRunId)?.node.nodeId;
  const runningNode = model.nodes.find((node) => ["running", "stopping"].includes(runtime.nodeStates[node.id]));
  const canvasNodeIds = new Set(model.nodes.map((node) => node.id));
  const focusNodeId = [
    runtime.currentNodeId,
    runtime.nodeStates[activeRunNodeId ?? ""] === "running" ? activeRunNodeId : undefined,
    runningNode?.id,
    runtime.queuedNodeId
  ].find((id) => id && canvasNodeIds.has(id))
    ?? [...runtime.recentInvocationPath].reverse().find((entry) => canvasNodeIds.has(entry.nodeId))?.nodeId
    ?? (largeCanvas ? CANVAS_INPUT_NODE_ID : undefined);

  return (
    <>
      <section className="workflow-canvas-runtime" aria-label="运行中 Workflow 画布">
        <div className="workflow-sidebar-card">
          <div className="workflow-sidebar-heading">
            <h3><GitBranch size={15} aria-hidden="true" />运行流程</h3>
            <span>第 {project.cycle} 轮</span>
          </div>
          <div
            role="button"
            tabIndex={0}
            className="workflow-runtime-preview-button"
            aria-label="打开大型运行 Workflow 画布"
            onClick={(event) => {
              if (event.target === event.currentTarget) openModal();
            }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                openModal();
              }
            }}
          >
            <RuntimeCanvasSurface
              model={model}
              geometry={geometry}
              runtime={runtime}
              project={project}
              mode="preview"
              focusNodeId={focusNodeId}
              selectedNodeId={selectedNodeId}
              onSelectNode={(node) => {
                setSelectedNodeId(node.id);
                openModal();
              }}
              onOpen={openModal}
              expandedGroupIds={expandedGroupIds}
              onToggleGroup={toggleGroup}
            />
          </div>
          <div className="workflow-sidebar-actions">
            <Button type="button" variant="ghost" data-size="small" icon={<Maximize size={14} aria-hidden="true" />} onClick={openModal}>打开画布</Button>
            <Button type="button" variant="ghost" data-size="small" icon={<History size={14} aria-hidden="true" />}
              onClick={() => { setInitialReplay(true); setModalOpen(true); }}>历史回顾</Button>
          </div>
        </div>
        {Object.values(runtime.loopStates).length > 0 && (
          <div className="workflow-runtime-loop-summary" aria-label="Loop 运行计数">
            {Object.values(runtime.loopStates).map((loop) => (
              <span key={loop.id} data-loop-phase={loop.phase}>
                <strong>{loop.id}</strong>
                {` batch ${loop.batch} · iteration ${loop.iteration}/${loop.maxIterations} · total ${loop.totalIterations}`}
              </span>
            ))}
          </div>
        )}
        <ProjectGitReadonlyFacts project={project} onOpenGitTree={() => setGitTreeOpen(true)} />
        <FailureAttemptHistory project={project} />
      </section>
      {modalOpen && (
        <RuntimeCanvasDialog
          model={model}
          geometry={geometry}
          runtime={runtime}
          project={project}
          events={events}
          harnesses={harnesses}
          mode="modal"
          selectedNodeId={selectedNodeId}
          onSelectNode={(node) => setSelectedNodeId(node.id)}
          expandedGroupIds={expandedGroupIds}
          onToggleGroup={toggleGroup}
          onClose={closeModal}
          initialReplay={initialReplay}
        />
      )}
      {gitTreeOpen && <GitTreeDialog project={project} onClose={() => setGitTreeOpen(false)} />}
    </>
  );
}

/** Small helper used by browser audits and tests to inspect curve bounds. */
export function runtimeGeometryPoints(geometry: readonly EdgeGeometry[]): CanvasPoint[] {
  return geometry.flatMap((edge) => edge.samples);
}
